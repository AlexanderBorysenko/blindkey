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

async function connect(token: string): Promise<Client> {
  const address = await t.app.listen({ port: 0, host: '127.0.0.1' });
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

describe('mcp', () => {
  it('lists tools without any reveal tool', async () => {
    t = await makeTestApp();
    const client = await connect(t.token(['admin']));
    const names = (await client.listTools()).tools.map((x) => x.name).sort();
    expect(names).toEqual(['get_project', 'list_documents', 'list_projects', 'list_secrets', 'read_document', 'search', 'write_document']);
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
    const missing = await client.callTool({ name: 'get_project', arguments: { slug: 'beta' } });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain('not_found');
  });
  it('rejects unauthenticated MCP requests', async () => {
    t = await makeTestApp();
    const r = await t.app.inject({ method: 'POST', url: '/mcp', payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
    expect(r.statusCode).toBe(401);
    expect((await t.app.inject({ method: 'GET', url: '/mcp', headers: { authorization: `Bearer ${t.token(['admin'])}` } })).statusCode).toBe(405);
  });
});
