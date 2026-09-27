import { describe, it, expect, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { makeTestApp, type TestCtx } from './helpers.js';
import { createSecret } from '../src/repos/secrets.js';
import { upsertDocument } from '../src/repos/documents.js';

let t: TestCtx;
afterEach(async () => {
  await t?.app.close();
});

// A test that needs more than one token (e.g. a scope-denied call alongside an allowed one)
// connects several clients against the same running app — Fastify only accepts one `listen()`
// call per instance, so the address is cached rather than re-requested on every connect().
const listening = new WeakMap<TestCtx['app'], string>();

async function connect(token: string): Promise<Client> {
  let address = listening.get(t.app);
  if (!address) {
    address = await t.app.listen({ port: 0, host: '127.0.0.1' });
    listening.set(t.app, address);
  }
  const transport = new StreamableHTTPClientTransport(new URL(`${address}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

const textOf = (r: Awaited<ReturnType<Client['callTool']>>): string => {
  const c = (r.content as { type: string; text?: string }[])[0];
  return c?.text ?? '';
};

// Plain letters, but broken up before any 32-char run so the secret-value lint
// (which flags long base64/hex-looking runs) doesn't fire — otherwise a big
// body would be rejected by the lint (422) rather than by the schema's size
// cap, confounding the assertion below.
const bigBody = (len: number): string => {
  const chunk = 'x'.repeat(31) + ' ';
  return chunk.repeat(Math.ceil(len / chunk.length)).slice(0, len);
};

describe('mcp', () => {
  it('lists tools without any reveal tool', async () => {
    t = await makeTestApp();
    const client = await connect(t.token(['admin']));
    const names = (await client.listTools()).tools.map((x) => x.name).sort();
    expect(names).toEqual([
      'get_project',
      'list_documents',
      'list_projects',
      'list_secrets',
      'read_document',
      'search',
      'secret_request_link',
      'update_project',
      'upsert_secret_meta',
      'write_document',
    ]);
    expect(names.join(' ')).not.toMatch(/reveal|get_secret|field/);
  });
  it('get_project and list_secrets return meta only; write_document lints', async () => {
    t = await makeTestApp();
    const p = t.project('alpha');
    createSecret(t.db, t.ring, { projectId: p.id, name: 'Staging', description: '', tags: [], fields: [{ key: 'host', value: 'h1' }, { key: 'password', value: 'sekret' }] });
    upsertDocument(t.db, { projectId: p.id, slug: 'context', title: 'Ctx', category: 'context', body_md: 'hello {{secret:Staging}}' });
    const client = await connect(t.token(['projects:read', 'docs:read', 'docs:write', 'secrets:meta', 'secrets:reveal'], ['alpha']));
    const proj = JSON.parse(textOf(await client.callTool({ name: 'get_project', arguments: { slug: 'alpha' } })));
    expect(proj.secrets[0].fields).toEqual([{ key: 'host', sensitive: false, value: 'h1' }, { key: 'password', sensitive: true }]);
    const secrets = textOf(await client.callTool({ name: 'list_secrets', arguments: { project: 'alpha' } }));
    expect(secrets).toContain('Staging');
    expect(secrets).not.toContain('sekret');
    const doc = JSON.parse(textOf(await client.callTool({ name: 'read_document', arguments: { project: 'alpha', slug: 'context' } })));
    expect(doc.body_md).toBe('hello {{secret:Staging}}');
    expect(doc.refs[0].fields).toEqual([{ key: 'host', sensitive: false }, { key: 'password', sensitive: true }]);
    const lint = await client.callTool({ name: 'write_document', arguments: { project: 'alpha', slug: 'notes', title: 'N', category: 'notes', body_md: 'password: Tr0ub4dor&3' } });
    expect(lint.isError).toBe(true);
    expect(textOf(lint)).toContain('lint');
    const ok = await client.callTool({ name: 'write_document', arguments: { project: 'alpha', slug: 'notes', title: 'N', category: 'notes', body_md: 'clean' } });
    expect(ok.isError).toBeFalsy();
    const big = await client
      .callTool({ name: 'write_document', arguments: { project: 'alpha', slug: 'notes', title: 'N', category: 'notes', body_md: bigBody(2_000_001) } })
      .catch((e: unknown) => e);
    expect(big instanceof Error || (big as { isError?: boolean }).isError === true).toBe(true);
    const missing = await client.callTool({ name: 'get_project', arguments: { slug: 'beta' } });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain('not_found');
  });
  it('update_project requires projects:write (spec §1.1/§1.5)', async () => {
    t = await makeTestApp();
    t.project('alpha');
    const noScope = await connect(t.token(['projects:read'], ['alpha']));
    const denied = await noScope.callTool({ name: 'update_project', arguments: { slug: 'alpha', summary: 'nope' } });
    expect(denied.isError).toBe(true);
    expect(textOf(denied)).toMatch(/missing_scope|projects:write/);

    const client = await connect(t.token(['projects:read', 'projects:write'], ['alpha']));
    const res = JSON.parse(
      textOf(
        await client.callTool({
          name: 'update_project',
          arguments: { slug: 'alpha', name: 'Alpha II', status: 'paused', tags: ['x'], summary: 'updated' },
        }),
      ),
    );
    expect(res).toMatchObject({ slug: 'alpha', name: 'Alpha II', status: 'paused', tags: ['x'], summary: 'updated' });

    const missing = await client.callTool({ name: 'update_project', arguments: { slug: 'nope', summary: 'x' } });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain('not_found');
  });

  it('upsert_secret_meta creates non-sensitive fields, patches them, and refuses anything sensitive (spec §1.1/§1.5)', async () => {
    t = await makeTestApp();
    const alpha = t.project('alpha');
    const client = await connect(t.token(['secrets:meta', 'secrets:meta-write'], ['alpha']));

    const created = JSON.parse(
      textOf(
        await client.callTool({
          name: 'upsert_secret_meta',
          arguments: { project: 'alpha', name: 'Staging', description: 'd', tags: ['x'], fields: [{ key: 'host', value: 'h1' }] },
        }),
      ),
    );
    expect(created.name).toBe('Staging');
    expect(created.fields).toEqual([{ key: 'host', sensitive: false, value: 'h1' }]);

    // "password" defaults to sensitive (outside NON_SENSITIVE_KEYS): meta-write may only create
    // non-sensitive fields (spec §1.1), so this is refused rather than silently downgraded.
    const sensitiveCreate = await client.callTool({
      name: 'upsert_secret_meta',
      arguments: { project: 'alpha', name: 'Other', fields: [{ key: 'password', value: 'p' }] },
    });
    expect(sensitiveCreate.isError).toBe(true);
    expect(textOf(sensitiveCreate)).toContain('forbidden');

    // Patching the existing secret: adding another non-sensitive field succeeds...
    const patched = JSON.parse(
      textOf(
        await client.callTool({
          name: 'upsert_secret_meta',
          arguments: { project: 'alpha', name: 'Staging', fields: [{ key: 'url', value: 'https://x' }] },
        }),
      ),
    );
    expect(patched.fields).toEqual(expect.arrayContaining([{ key: 'url', sensitive: false, value: 'https://x' }]));

    // ...but touching the sensitive "password" field added directly via the repo is refused.
    createSecret(t.db, t.ring, { projectId: alpha.id, name: 'HasSecret', description: '', tags: [], fields: [{ key: 'password', value: 'p1' }] });
    const touchSensitive = await client.callTool({
      name: 'upsert_secret_meta',
      arguments: { project: 'alpha', name: 'HasSecret', fields: [{ key: 'password', value: 'p2' }] },
    });
    expect(touchSensitive.isError).toBe(true);
    expect(textOf(touchSensitive)).toContain('forbidden');

    const noScope = await connect(t.token(['secrets:meta'], ['alpha']));
    const deniedNoScope = await noScope.callTool({
      name: 'upsert_secret_meta',
      arguments: { project: 'alpha', name: 'New2', fields: [{ key: 'host', value: 'h' }] },
    });
    expect(deniedNoScope.isError).toBe(true);
    expect(textOf(deniedNoScope)).toMatch(/missing_scope|secrets:meta-write/);

    // Global scope (project omitted) works the same way.
    const global = JSON.parse(
      textOf(await client.callTool({ name: 'upsert_secret_meta', arguments: { name: 'GlobalOne', fields: [{ key: 'host', value: 'g' }] } })),
    );
    expect(global.fields).toEqual([{ key: 'host', sensitive: false, value: 'g' }]);
  });

  it('secret_request_link requires any secrets scope and builds a URL from the request origin with encoded params (spec §1.4/§1.5)', async () => {
    t = await makeTestApp();
    t.project('alpha');
    const client = await connect(t.token(['secrets:use'], ['alpha']));
    const res = JSON.parse(
      textOf(
        await client.callTool({
          name: 'secret_request_link',
          arguments: {
            project: 'alpha',
            name: 'SMTP',
            description: 'mailer',
            tags: ['prod'],
            keys: [
              { key: 'host', sensitive: false },
              { key: 'password', sensitive: true },
            ],
          },
        }),
      ),
    );
    const url = new URL(res.url);
    expect(url.pathname).toBe('/p/alpha/secrets/new');
    expect(url.searchParams.get('name')).toBe('SMTP');
    expect(url.searchParams.get('description')).toBe('mailer');
    expect(url.searchParams.get('tags')).toBe('prod');
    expect(url.searchParams.get('keys')).toBe('host!,password');

    const global = JSON.parse(
      textOf(
        await client.callTool({
          name: 'secret_request_link',
          arguments: { name: 'Root', keys: [{ key: 'username', sensitive: false }] },
        }),
      ),
    );
    expect(new URL(global.url).pathname).toBe('/global/secrets/new');

    const noScope = await connect(t.token(['projects:read'], ['alpha']));
    const denied = await noScope.callTool({ name: 'secret_request_link', arguments: { name: 'X', keys: [{ key: 'a', sensitive: true }] } });
    expect(denied.isError).toBe(true);

    const missingProject = await client.callTool({
      name: 'secret_request_link',
      arguments: { project: 'does-not-exist', name: 'X', keys: [{ key: 'a', sensitive: true }] },
    });
    expect(missingProject.isError).toBe(true);
    expect(textOf(missingProject)).toContain('not_found');
  });

  it('rejects unauthenticated MCP requests', async () => {
    t = await makeTestApp();
    const r = await t.app.inject({ method: 'POST', url: '/mcp', payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
    expect(r.statusCode).toBe(401);
    expect((await t.app.inject({ method: 'GET', url: '/mcp', headers: { authorization: `Bearer ${t.token(['admin'])}` } })).statusCode).toBe(405);
  });
});
