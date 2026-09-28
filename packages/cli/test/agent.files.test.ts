import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PidbClient } from '../src/client.js';
import { runSecretEnv, runSecretWrite } from '../src/commands/files.js';
import { loadWritten } from '../src/agent/state.js';
import { CliError } from '../src/errors.js';
import { makeServer, type ServerFixture } from './helpers.js';

let s: ServerFixture;
let dir: string;
let dataDir: string;
const client = (scopes: Parameters<ServerFixture['token']>[0]) => new PidbClient({ url: s.url, token: s.token(scopes) });

beforeAll(async () => {
  s = await makeServer();
  s.project('acme');
  s.secret('acme', 'DB', [
    { key: 'host', value: 'db.internal' },
    { key: 'password', value: 'hunter2hunter2' },
  ]);
});
afterAll(async () => {
  await s.close();
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pidb-agent-files-'));
  dataDir = mkdtempSync(join(tmpdir(), 'pidb-agent-files-data-'));
});

describe('secret write (agent mode)', () => {
  it('fetches via the /use endpoint (purpose write, single field) and records the path in written.json', async () => {
    const out = join(dir, 'password.txt');
    const before = (s.db.prepare("SELECT COUNT(*) AS c FROM audit_log WHERE action = 'secret.used'").get() as { c: number }).c;
    const result = await runSecretWrite(client(['secrets:use']), 'acme', 'DB', 'password', { out, agent: true, dataDir });
    expect(readFileSync(out, 'utf8')).toBe('hunter2hunter2');
    expect(result.text).not.toContain('hunter2hunter2');
    const after = (s.db.prepare("SELECT COUNT(*) AS c FROM audit_log WHERE action = 'secret.used'").get() as { c: number }).c;
    expect(after).toBeGreaterThan(before);
    expect(loadWritten(dataDir).paths).toEqual([out]);
  });

  it('a secrets:use-only token cannot read via secret write in normal (non-agent) mode', async () => {
    const out = join(dir, 'password.txt');
    await expect(runSecretWrite(client(['secrets:use']), 'acme', 'DB', 'password', { out })).rejects.toMatchObject({ status: 403 });
  });

  it('refuses to write inside the plugin data dir', async () => {
    const out = join(dataDir, 'password.txt');
    const err = await runSecretWrite(client(['secrets:use']), 'acme', 'DB', 'password', { out, agent: true, dataDir }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(2);
    expect(loadWritten(dataDir).paths).toEqual([]);
  });

  it('refuses a nested path inside the plugin data dir', async () => {
    const out = join(dataDir, 'sub', 'dir', 'password.txt');
    await expect(
      runSecretWrite(client(['secrets:use']), 'acme', 'DB', 'password', { out, agent: true, dataDir }),
    ).rejects.toBeInstanceOf(CliError);
  });

  it('does not record the path twice on a second write to the same file', async () => {
    const out = join(dir, 'password.txt');
    await runSecretWrite(client(['secrets:use']), 'acme', 'DB', 'password', { out, agent: true, dataDir, force: true });
    await runSecretWrite(client(['secrets:use']), 'acme', 'DB', 'password', { out, agent: true, dataDir, force: true });
    expect(loadWritten(dataDir).paths).toEqual([out]);
  });
});

describe('secret env (agent mode)', () => {
  it('fetches via the /use endpoint (purpose env, all fields) and records the path', async () => {
    const out = join(dir, '.env');
    const result = await runSecretEnv(client(['secrets:use']), 'acme', 'DB', { out, agent: true, dataDir });
    expect(readFileSync(out, 'utf8')).toBe('host=db.internal\npassword=hunter2hunter2\n');
    expect(JSON.stringify(result.json)).not.toContain('hunter2hunter2');
    expect(loadWritten(dataDir).paths).toEqual([out]);
  });

  it('refuses to write inside the plugin data dir', async () => {
    const out = join(dataDir, '.env');
    await expect(runSecretEnv(client(['secrets:use']), 'acme', 'DB', { out, agent: true, dataDir })).rejects.toMatchObject({
      exitCode: 2,
    });
  });
});
