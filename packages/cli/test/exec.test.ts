import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PidbClient } from '../src/client.js';
import { buildEnv, envKeyFor, runSecretExec } from '../src/commands/exec.js';
import { CliError } from '../src/errors.js';
import { makeServer, runCliAsync, type ServerFixture } from './helpers.js';

let s: ServerFixture;
let dir: string;
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const client = (scopes: Parameters<ServerFixture['token']>[0]) => new PidbClient({ url: s.url, token: s.token(scopes) });

beforeAll(async () => {
  s = await makeServer();
  dir = mkdtempSync(join(tmpdir(), 'pidb-exec-'));
  s.project('acme');
  s.secret('acme', 'DB', [
    { key: 'host', value: 'db.internal' },
    { key: 'password', value: 'hunter2hunter2' },
    { key: 'api.key-1', value: 'dotted-value' },
  ]);
});
afterAll(async () => {
  await s.close();
});

describe('envKeyFor', () => {
  it('uppercases and sanitizes', () => {
    expect(envKeyFor('password')).toBe('PIDB_PASSWORD');
    expect(envKeyFor('api.key-1')).toBe('PIDB_API_KEY_1');
  });
});

describe('buildEnv reserved variables by mode', () => {
  it('agent mode allows url/token fields (agent mode ignores PIDB_URL/PIDB_TOKEN)', () => {
    expect(buildEnv({ url: 'https://site', token: 't' }, {}, true)).toEqual({ PIDB_URL: 'https://site', PIDB_TOKEN: 't' });
  });
  it('user mode still refuses url/token fields', () => {
    expect(() => buildEnv({ url: 'https://site' }, {})).toThrow(/reserved variable PIDB_URL/);
  });
  it.each(['plugin_data', 'agent', 'allow_user_mode', 'config_home'])('refuses %s in both modes', (key) => {
    expect(() => buildEnv({ [key]: 'x' }, {}, true)).toThrow(CliError);
    expect(() => buildEnv({ [key]: 'x' }, {})).toThrow(CliError);
  });
});

describe('buildEnv', () => {
  it('rejects two fields that map to the same env var', () => {
    expect(() => buildEnv({ 'a.b': '1', 'a-b': '2' }, {})).toThrow(CliError);
  });
  it('keeps the parent environment', () => {
    expect(buildEnv({ host: 'h' }, { PATH: '/bin' })).toEqual({ PATH: '/bin', PIDB_HOST: 'h' });
  });

  it('strips the caller\'s PIDB_TOKEN from the child environment', () => {
    const env = buildEnv({ host: 'h' }, { PATH: '/bin', PIDB_TOKEN: 'pidb_secret' });
    expect(env).toEqual({ PATH: '/bin', PIDB_HOST: 'h' });
    expect(env.PIDB_TOKEN).toBeUndefined();
  });

  it('rejects a field that would overwrite a reserved variable', () => {
    expect(() => buildEnv({ token: 'sekret-value' }, { PATH: '/bin' })).toThrow(CliError);
    try {
      buildEnv({ token: 'sekret-value' }, { PATH: '/bin' });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as CliError).message).toContain('PIDB_TOKEN');
      expect((err as CliError).message).not.toContain('sekret-value');
    }
  });
});

describe('runSecretExec', () => {
  it('injects PIDB_* into the child and returns its exit code', async () => {
    const out = join(dir, 'child.txt');
    const code = await runSecretExec(client(['secrets:reveal']), 'acme', 'DB', [
      process.execPath,
      '-e',
      `require('fs').writeFileSync(${JSON.stringify(out)}, [process.env.PIDB_HOST, process.env.PIDB_PASSWORD, process.env.PIDB_API_KEY_1].join('|'))`,
    ]);
    expect(code).toBe(0);
    expect(readFileSync(out, 'utf8')).toBe('db.internal|hunter2hunter2|dotted-value');
  });

  it('propagates a non-zero child exit code', async () => {
    const code = await runSecretExec(client(['secrets:reveal']), 'acme', 'DB', [process.execPath, '-e', 'process.exit(7)']);
    expect(code).toBe(7);
  });

  it('audits every sensitive field it revealed', async () => {
    const before = (s.db.prepare("SELECT COUNT(*) AS c FROM audit_log WHERE action = 'secret.reveal'").get() as { c: number }).c;
    await runSecretExec(client(['secrets:reveal']), 'acme', 'DB', [process.execPath, '-e', '']);
    const after = (s.db.prepare("SELECT COUNT(*) AS c FROM audit_log WHERE action = 'secret.reveal'").get() as { c: number }).c;
    expect(after).toBeGreaterThan(before);
  });
});

describe('pidb secret exec (spawned)', () => {
  it('prints no secret value on stdout or stderr', async () => {
    const token = s.token(['secrets:reveal']);
    const r = await runCliAsync(
      ['secret', 'exec', 'acme', 'DB', '--', process.execPath, '-e', 'console.log("child ran")'],
      { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', PIDB_URL: s.url, PIDB_TOKEN: token, PIDB_CONFIG_HOME: dir },
      repoRoot,
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('child ran');
    expect(r.stdout).not.toContain('hunter2hunter2');
    expect(r.stderr).not.toContain('hunter2hunter2');
  });
});
