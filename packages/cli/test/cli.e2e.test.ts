import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeServer, runCliAsync, type ServerFixture } from './helpers.js';

let s: ServerFixture;
let dir: string;
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

async function runCli(args: string[], env: Record<string, string> = {}) {
  return runCliAsync(
    args,
    {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      PIDB_CONFIG_HOME: dir,
      PIDB_URL: s.url,
      PIDB_TOKEN: s.token(['secrets:reveal', 'secrets:meta', 'projects:read']),
      ...env,
    },
    repoRoot,
  );
}

beforeAll(async () => {
  s = await makeServer();
  dir = mkdtempSync(join(tmpdir(), 'pidb-e2e-'));
  s.project('acme');
  s.secret('acme', 'DB', [
    { key: 'host', value: 'db.internal' },
    { key: 'password', value: 'hunter2hunter2' },
  ]);
});
afterAll(async () => {
  await s.close();
});

describe('pidb exit codes', () => {
  it('exits 2 for `secret get` without --print and prints no value', async () => {
    const r = await runCli(['secret', 'get', 'acme', 'DB', 'password']);
    expect(r.status).toBe(2);
    expect(r.stdout).not.toContain('hunter2hunter2');
    expect(r.stderr).not.toContain('hunter2hunter2');
    expect(r.stderr).toMatch(/--print/);
  });

  it('exits 0 and prints the value with --print', async () => {
    const r = await runCli(['secret', 'get', 'acme', 'DB', 'password', '--print']);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('hunter2hunter2');
  });

  it('exits 3 with a bad token', async () => {
    const r = await runCli(['projects', 'list'], { PIDB_TOKEN: 'pidb_not_a_token' });
    expect(r.status).toBe(3);
  });

  it('exits 3 when nothing is configured', async () => {
    const r = await runCliAsync(['projects', 'list'], {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      PIDB_CONFIG_HOME: mkdtempSync(join(tmpdir(), 'pidb-empty-')),
    }, repoRoot);
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/pidb login/);
  });

  it('exits 4 for an unknown project', async () => {
    const r = await runCli(['projects', 'get', 'nope']);
    expect(r.status).toBe(4);
  });

  it('writes a 0600 file and exits 2 when asked to overwrite it', async () => {
    const out = join(dir, 'pw.txt');
    const first = await runCli(['secret', 'write', 'acme', 'DB', 'password', '--out', out]);
    expect(first.status).toBe(0);
    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(readFileSync(out, 'utf8')).toBe('hunter2hunter2');
    expect(first.stdout).not.toContain('hunter2hunter2');

    const second = await runCli(['secret', 'write', 'acme', 'DB', 'password', '--out', out]);
    expect(second.status).toBe(2);
  });
});
