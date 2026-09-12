import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Readable } from 'node:stream';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiError, PidbClient } from '../src/client.js';
import { runSecretGet, runSecretSet, runSecretsList } from '../src/commands/secrets.js';
import type { PublicSecret } from '../src/api-types.js';
import { CliError } from '../src/errors.js';
import { makeServer, type ServerFixture } from './helpers.js';

let s: ServerFixture;
let dir: string;
const client = (scopes: Parameters<ServerFixture['token']>[0]) => new PidbClient({ url: s.url, token: s.token(scopes) });
const stdinOf = (text: string) => Readable.from([text]) as unknown as NodeJS.ReadableStream;

beforeAll(async () => {
  s = await makeServer();
  dir = mkdtempSync(join(tmpdir(), 'pidb-secrets-'));
  s.project('acme');
  s.secret('acme', 'DB', [
    { key: 'host', value: 'db.internal' },
    { key: 'password', value: 'hunter2hunter2' },
  ]);
  s.secret(null, 'Cloudflare', [{ key: 'api_key', value: 'cf-key-value' }]);
});
afterAll(async () => {
  await s.close();
});

describe('secrets list', () => {
  it('lists names, fields and sensitivity without values', async () => {
    const result = await runSecretsList(client(['secrets:meta']), 'acme');
    expect(result.text).toContain('DB');
    expect(result.text).toContain('password*');
    expect(result.text).toContain('host');
    expect(result.text).not.toContain('hunter2hunter2');
    expect((result.json as PublicSecret[])[0]!.name).toBe('DB');
  });

  it('lists global secrets', async () => {
    const result = await runSecretsList(client(['secrets:meta']), 'global');
    expect(result.text).toContain('Cloudflare');
  });
});

describe('secret get', () => {
  it('refuses to print without --print and exits 2', async () => {
    const err = await runSecretGet(client(['secrets:reveal']), 'acme', 'DB', 'password', {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(2);
    expect((err as CliError).message).toMatch(/pidb secret exec/);
    expect((err as CliError).message).not.toContain('hunter2hunter2');
  });

  it('prints the raw value with --print', async () => {
    const result = await runSecretGet(client(['secrets:reveal']), 'acme', 'DB', 'password', { print: true });
    expect(result.text).toBe('hunter2hunter2');
    expect(result.json).toEqual({ key: 'password', value: 'hunter2hunter2' });
  });

  it('exits 3 without the reveal scope', async () => {
    const err = await runSecretGet(client(['secrets:meta']), 'acme', 'DB', 'password', { print: true }).catch((e: unknown) => e);
    expect((err as ApiError).exitCode).toBe(3);
  });
});

describe('secret set', () => {
  it('upserts a field read from stdin, stripping one trailing newline', async () => {
    const result = await runSecretSet(client(['secrets:write']), 'acme', 'DB', 'token', {}, stdinOf('abc123\n'));
    expect(result.text).toMatch(/DB/);
    expect(result.text).not.toContain('abc123');
    const value = await client(['secrets:reveal']).text('GET', '/api/v1/projects/acme/secrets/DB/fields/token');
    expect(value).toBe('abc123');
  });

  it('reads --from-file verbatim', async () => {
    const path = join(dir, 'body.txt');
    writeFileSync(path, 'line1\nline2\n');
    await runSecretSet(client(['secrets:write']), 'acme', 'DB', 'blob', { fromFile: path });
    const value = await client(['secrets:reveal']).text('GET', '/api/v1/projects/acme/secrets/DB/fields/blob');
    expect(value).toBe('line1\nline2\n');
  });

  it('honours --non-sensitive', async () => {
    await runSecretSet(client(['secrets:write']), 'acme', 'DB', 'region', { nonSensitive: true }, stdinOf('eu-west-1'));
    const secret = await client(['secrets:meta']).json<PublicSecret>('GET', '/api/v1/projects/acme/secrets/DB');
    expect(secret.fields.find((f) => f.key === 'region')!.sensitive).toBe(false);
  });

  it('exits 4 for an unknown secret, and creates it with --create', async () => {
    const err = await runSecretSet(client(['secrets:write']), 'acme', 'NEW', 'k', {}, stdinOf('v')).catch((e: unknown) => e);
    expect((err as ApiError).exitCode).toBe(4);
    const created = await runSecretSet(client(['secrets:write']), 'acme', 'NEW', 'k', { create: true }, stdinOf('v'));
    expect(created.text).toMatch(/created/);
  });

  it('rejects contradictory sensitivity flags', async () => {
    const err = await runSecretSet(
      client(['secrets:write']),
      'acme',
      'DB',
      'k',
      { sensitive: true, nonSensitive: true },
      stdinOf('v'),
    ).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/--sensitive|--non-sensitive/);
  });
});
