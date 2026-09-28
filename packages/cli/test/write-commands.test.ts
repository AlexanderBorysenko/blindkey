import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PidbClient } from '../src/client.js';
import { runDocsPut } from '../src/commands/docs.js';
import { parseFieldArg, runDocsDelete, runProjectsCreate, runSecretsMeta, runSecretsRequest } from '../src/commands/write.js';
import { makeServer, type ServerFixture } from './helpers.js';

let s: ServerFixture;
const client = (scopes: Parameters<ServerFixture['token']>[0], projects: string[] | null = null) =>
  new PidbClient({ url: s.url, token: s.token(scopes, projects) });

beforeAll(async () => {
  s = await makeServer();
  s.project('acme');
});
afterAll(async () => {
  await s.close();
});

describe('pidb projects create', () => {
  it('creates a project the same token can then read', async () => {
    const c = client(['projects:read', 'projects:create'], ['acme']);
    const r = await runProjectsCreate(c, 'newco', { name: 'New Co', tags: 'wp, staging' });
    expect(r.text).toBe('created project newco (New Co)');
    const list = await c.json<{ slug: string; tags: string[] }[]>('GET', '/api/v1/projects');
    expect(list.map((p) => p.slug).sort()).toEqual(['acme', 'newco']);
    expect(list.find((p) => p.slug === 'newco')!.tags).toEqual(['wp', 'staging']);
  });
});

describe('pidb docs delete', () => {
  it('deletes a global document', async () => {
    const c = client(['docs:read', 'docs:write']);
    const dir = mkdtempSync(join(tmpdir(), 'pidb-docs-del-'));
    writeFileSync(join(dir, 'x.md'), '# X\n\nhello');
    await runDocsPut(c, 'global', 'temp-note', { file: join(dir, 'x.md'), title: 'X', category: 'notes' });
    expect((await runDocsDelete(c, 'global', 'temp-note')).text).toBe('deleted temp-note');
    await expect(c.json('GET', '/api/v1/docs/temp-note')).rejects.toMatchObject({ status: 404 });
  });
});

describe('pidb secrets meta', () => {
  it('parses key=value (value may contain =) as a non-sensitive field', () => {
    expect(parseFieldArg('a=b=c')).toEqual({ key: 'a', value: 'b=c', sensitive: false });
    expect(() => parseFieldArg('novalue')).toThrow(/key=value/);
  });

  it('creates, then patches, a secret with non-sensitive fields only', async () => {
    const c = client(['secrets:meta', 'secrets:meta-write'], ['acme']);
    expect((await runSecretsMeta(c, 'acme', 'Site', { field: ['web_root=/srv/site', 'host=h1'], description: 'd' })).text).toMatch(/created/);
    expect((await runSecretsMeta(c, 'acme', 'Site', { field: ['php_version=8.3'] })).text).toMatch(/updated/);
    const meta = await c.json<{ fields: { key: string; sensitive: boolean; value?: string }[] }>('GET', '/api/v1/projects/acme/secrets/Site');
    expect(meta.fields).toEqual([
      { key: 'web_root', sensitive: false, value: '/srv/site' },
      { key: 'host', sensitive: false, value: 'h1' },
      { key: 'php_version', sensitive: false, value: '8.3' },
    ]);
  });

  it('refuses a credential-looking key', async () => {
    const c = client(['secrets:meta', 'secrets:meta-write'], ['acme']);
    await expect(runSecretsMeta(c, 'acme', 'Bad', { field: ['db_password=x'] })).rejects.toMatchObject({ status: 403 });
  });
});

describe('pidb secrets request', () => {
  it('links to the new-secret form for an unknown name, marking only default-non-sensitive plain keys', async () => {
    const c = client(['secrets:meta'], ['acme']);
    const r = await runSecretsRequest(c, 'acme', 'Fresh one', { key: ['password'], plainKey: ['host', 'notes'] });
    const url = new URL((r.json as { url: string }).url);
    expect(url.origin + url.pathname).toBe(`${s.url}/p/acme/secrets/new`);
    expect(url.searchParams.get('name')).toBe('Fresh one');
    expect(url.searchParams.get('keys')).toBe('password,host!,notes');
  });

  it('links to the edit page of an existing secret', async () => {
    const c = client(['secrets:meta'], ['acme']);
    s.secret('acme', 'Existing', [{ key: 'host', value: 'h' }]);
    const r = await runSecretsRequest(c, 'acme', 'Existing', { key: ['password'] });
    expect((r.json as { url: string }).url).toContain('/p/acme/secrets/Existing/edit?');
  });
});
