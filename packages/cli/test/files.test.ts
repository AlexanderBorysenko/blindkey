import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PidbClient } from '../src/client.js';
import { parseMode, runSecretEnv, runSecretWrite } from '../src/commands/files.js';
import { CliError } from '../src/errors.js';
import { makeServer, type ServerFixture } from './helpers.js';

let s: ServerFixture;
let dir: string;
const client = (scopes: Parameters<ServerFixture['token']>[0]) => new PidbClient({ url: s.url, token: s.token(scopes) });

beforeAll(async () => {
  s = await makeServer();
  s.project('acme');
  s.secret('acme', 'DB', [
    { key: 'host', value: 'db.internal' },
    { key: 'password', value: 'hunter2hunter2' },
  ]);
  s.secret('acme', 'SSH', [{ key: 'content', value: '-----BEGIN KEY-----\nabc\n-----END KEY-----\n' }]);
});
afterAll(async () => {
  await s.close();
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pidb-files-'));
});

describe('parseMode', () => {
  it('parses octal with and without a leading zero', () => {
    expect(parseMode(undefined)).toBe(0o600);
    expect(parseMode('600')).toBe(0o600);
    expect(parseMode('0640')).toBe(0o640);
  });
  it('rejects nonsense', () => {
    expect(() => parseMode('go+rw')).toThrow(CliError);
    expect(() => parseMode('999')).toThrow(CliError);
  });
});

describe('secret write', () => {
  it('writes the raw value with mode 0600', async () => {
    const out = join(dir, 'key.pem');
    const result = await runSecretWrite(client(['secrets:reveal']), 'acme', 'SSH', 'content', { out });
    expect(readFileSync(out, 'utf8')).toBe('-----BEGIN KEY-----\nabc\n-----END KEY-----\n');
    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(result.text).toContain(out);
    expect(result.text).not.toContain('BEGIN KEY');
  });

  it('refuses to overwrite without --force and exits 2', async () => {
    const out = join(dir, 'key.pem');
    writeFileSync(out, 'existing');
    const err = await runSecretWrite(client(['secrets:reveal']), 'acme', 'SSH', 'content', { out }).catch((e: unknown) => e);
    expect((err as CliError).exitCode).toBe(2);
    expect(readFileSync(out, 'utf8')).toBe('existing');
  });

  it('overwrites with --force and still tightens the mode', async () => {
    const out = join(dir, 'key.pem');
    writeFileSync(out, 'existing', { mode: 0o644 });
    await runSecretWrite(client(['secrets:reveal']), 'acme', 'SSH', 'content', { out, force: true });
    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(readFileSync(out, 'utf8')).toContain('BEGIN KEY');
  });

  it('honours --mode', async () => {
    const out = join(dir, 'key.pem');
    await runSecretWrite(client(['secrets:reveal']), 'acme', 'SSH', 'content', { out, mode: '640' });
    expect(statSync(out).mode & 0o777).toBe(0o640);
  });
});

describe('secret env', () => {
  it('writes key=value lines with the stored keys, mode 0600', async () => {
    const out = join(dir, '.env');
    const result = await runSecretEnv(client(['secrets:reveal']), 'acme', 'DB', { out });
    expect(readFileSync(out, 'utf8')).toBe('host=db.internal\npassword=hunter2hunter2\n');
    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(result.text).not.toContain('hunter2hunter2');
    expect(JSON.stringify(result.json)).not.toContain('hunter2hunter2');
  });

  it('refuses a multi-line value and points at secret write', async () => {
    const err = await runSecretEnv(client(['secrets:reveal']), 'acme', 'SSH', { out: join(dir, '.env') }).catch((e: unknown) => e);
    expect((err as CliError).message).toMatch(/pidb secret write/);
    expect((err as CliError).message).not.toContain('BEGIN KEY');
  });

  it('refuses to overwrite without --force', async () => {
    const out = join(dir, '.env');
    writeFileSync(out, 'existing');
    const err = await runSecretEnv(client(['secrets:reveal']), 'acme', 'DB', { out }).catch((e: unknown) => e);
    expect((err as CliError).exitCode).toBe(2);
    expect(readFileSync(out, 'utf8')).toBe('existing');
  });
});
