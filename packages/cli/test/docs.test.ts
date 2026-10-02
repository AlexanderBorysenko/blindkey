import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BlindkeyClient } from '../src/client.js';
import { ApiError } from '../src/client.js';
import { resolveDocTarget, runDocsGet, runDocsList, runDocsPut } from '../src/commands/docs.js';
import type { PublicDoc } from '../src/api-types.js';
import { makeServer, type ServerFixture } from './helpers.js';

let s: ServerFixture;
let dir: string;
const client = (scopes: Parameters<ServerFixture['token']>[0]) => new BlindkeyClient({ url: s.url, token: s.token(scopes) });

beforeAll(async () => {
  s = await makeServer();
  dir = mkdtempSync(join(tmpdir(), 'blindkey-docs-'));
  s.project('acme');
  s.doc('acme', 'deploy', '# Deploy\n\nssh to the box.\n');
  s.doc(null, 'guidelines', '# Guidelines\n');
  s.secret('acme', 'DB', [{ key: 'host', value: 'db.internal' }]);
});
afterAll(async () => {
  await s.close();
});

describe('resolveDocTarget', () => {
  it('treats a single positional as a global document', () => {
    expect(resolveDocTarget('guidelines')).toEqual({ target: 'global', doc: 'guidelines' });
    expect(resolveDocTarget('acme', 'deploy')).toEqual({ target: 'acme', doc: 'deploy' });
    expect(resolveDocTarget('global', 'guidelines')).toEqual({ target: 'global', doc: 'guidelines' });
  });
});

describe('docs list', () => {
  it('lists project documents', async () => {
    const result = await runDocsList(client(['docs:read']), 'acme');
    expect(result.text).toContain('deploy');
    expect(result.text).not.toContain('guidelines');
  });

  it('lists global documents', async () => {
    const result = await runDocsList(client(['docs:read']), 'global');
    expect(result.text).toContain('guidelines');
  });
});

describe('docs get', () => {
  it('prints the raw markdown body', async () => {
    const result = await runDocsGet(client(['docs:read']), 'acme', 'deploy', {});
    expect(result.text).toBe('# Deploy\n\nssh to the box.\n');
    expect((result.json as PublicDoc).slug).toBe('deploy');
  });

  it('appends resolved refs with --refs', async () => {
    await runDocsPut(client(['docs:write']), 'acme', 'refs-doc', {
      file: write(join(dir, 'refs.md'), 'db lives at {{secret:DB}}\n'),
      title: 'Refs',
      category: 'notes',
    });
    const result = await runDocsGet(client(['docs:read', 'secrets:meta']), 'acme', 'refs-doc', { refs: true });
    expect(result.text).toContain('{{secret:DB}}');
    expect(result.text).toMatch(/host/);
    expect(result.text).toMatch(/blindkey secret exec/);
    expect(result.text).not.toContain('db.internal');
    expect(JSON.stringify(result.json)).not.toContain('db.internal');
  });

  it('exits 4 for an unknown document', async () => {
    const err = await runDocsGet(client(['docs:read']), 'acme', 'nope', {}).catch((e: unknown) => e);
    expect((err as ApiError).exitCode).toBe(4);
  });
});

describe('docs put', () => {
  it('creates and then updates a document from a file', async () => {
    const file = write(join(dir, 'notes.md'), '# Notes\n');
    const created = await runDocsPut(client(['docs:write']), 'acme', 'notes', { file, title: 'Notes', category: 'notes' });
    expect(created.text).toMatch(/created/);
    const updated = await runDocsPut(client(['docs:write']), 'acme', 'notes', { file, title: 'Notes 2', category: 'notes' });
    expect(updated.text).toMatch(/updated/);
  });

  it('distinguishes created from updated by HTTP status, never by timestamps', async () => {
    const file = write(join(dir, 'stub.md'), '# Stub\n');
    const sameTimestamps: PublicDoc = {
      slug: 'stub',
      title: 'Stub',
      category: 'notes',
      body_md: '# Stub\n',
      created_at: 1000,
      updated_at: 1000,
    };
    const differentTimestamps: PublicDoc = {
      slug: 'stub',
      title: 'Stub',
      category: 'notes',
      body_md: '# Stub\n',
      created_at: 1000,
      updated_at: 2000,
    };

    // status: 200 with equal timestamps must still report "updated" — a
    // timestamp-based implementation (created_at === updated_at) would
    // wrongly call this "created".
    const stub200 = { jsonStatus: async () => ({ status: 200, data: sameTimestamps }) } as unknown as BlindkeyClient;
    const resultUpdated = await runDocsPut(stub200, 'acme', 'stub', { file, title: 'Stub', category: 'notes' });
    expect(resultUpdated.text).toMatch(/updated/);

    // status: 201 with different timestamps must still report "created" —
    // pinning that the status code drives the wording, not the timestamps.
    const stub201 = { jsonStatus: async () => ({ status: 201, data: differentTimestamps }) } as unknown as BlindkeyClient;
    const resultCreated = await runDocsPut(stub201, 'acme', 'stub', { file, title: 'Stub', category: 'notes' });
    expect(resultCreated.text).toMatch(/created/);
  });

  it('surfaces lint findings and accepts --force', async () => {
    const file = write(join(dir, 'leak.md'), 'db password = hunter2hunter2\n');
    const err = await runDocsPut(client(['docs:write']), 'acme', 'leak', { file, title: 'Leak', category: 'notes' }).catch((e: unknown) => e);
    expect((err as ApiError).status).toBe(422);
    expect((err as ApiError).message).toMatch(/--force/);
    await expect(
      runDocsPut(client(['docs:write']), 'acme', 'leak', { file, title: 'Leak', category: 'notes', force: true }),
    ).resolves.toBeTruthy();
  });

  it('reports a missing file as a generic error', async () => {
    const err = await runDocsPut(client(['docs:write']), 'acme', 'x', {
      file: join(dir, 'missing.md'),
      title: 'X',
      category: 'notes',
    }).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/cannot read/);
    expect((err as { exitCode?: number }).exitCode).toBe(1);
  });

  it('rejects an unknown category before calling the server', async () => {
    const err = await runDocsPut(client(['docs:write']), 'acme', 'x', {
      file: write(join(dir, 'ok.md'), 'hi\n'),
      title: 'X',
      category: 'nonsense',
    }).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/category/);
  });
});

function write(path: string, content: string): string {
  writeFileSync(path, content);
  return path;
}
