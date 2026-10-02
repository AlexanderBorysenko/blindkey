import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ApiError, BlindkeyClient } from '../src/client.js';
import { parseExpires, parseScopes, runTokenCreate, runTokenList, runTokenRevoke } from '../src/commands/tokens.js';
import type { PublicToken } from '../src/api-types.js';
import { CliError } from '../src/errors.js';
import { makeServer, type ServerFixture } from './helpers.js';

let s: ServerFixture;
const admin = () => new BlindkeyClient({ url: s.url, token: s.token(['admin']) });

beforeAll(async () => {
  s = await makeServer();
  s.project('acme');
});
afterAll(async () => {
  await s.close();
});

describe('parseScopes', () => {
  it('splits and validates', () => {
    expect(parseScopes('docs:read, secrets:meta')).toEqual(['docs:read', 'secrets:meta']);
  });
  it('rejects an unknown scope', () => {
    expect(() => parseScopes('docs:read,nope')).toThrow(/nope/);
  });
  it('rejects an empty list', () => {
    expect(() => parseScopes('  ')).toThrow(CliError);
  });
});

describe('parseExpires', () => {
  const now = Date.UTC(2026, 0, 1);
  it('understands d/h/m suffixes and returns epoch milliseconds', () => {
    expect(parseExpires('90d', now)).toBe(now + 90 * 86_400_000);
    expect(parseExpires('12h', now)).toBe(now + 12 * 3_600_000);
    expect(parseExpires('30m', now)).toBe(now + 30 * 60_000);
  });
  it('returns undefined when omitted', () => {
    expect(parseExpires(undefined, now)).toBeUndefined();
  });
  it('rejects other shapes', () => {
    expect(() => parseExpires('tomorrow', now)).toThrow(CliError);
  });
});

describe('token create', () => {
  it('creates a scoped token and shows the value exactly once', async () => {
    const result = await runTokenCreate(admin(), {
      name: 'claude-code',
      scopes: 'projects:read,docs:read',
      projects: 'acme',
      expires: '90d',
    });
    const json = result.json as PublicToken & { token: string };
    expect(json.scopes).toEqual(['projects:read', 'docs:read']);
    expect(json.projects).toEqual(['acme']);
    expect(json.expires_at).toBeGreaterThan(Date.now());
    expect(result.text).toContain(json.token);
    expect(result.text).toMatch(/shown once/i);
  });

  it('defaults to all projects when --projects is omitted', async () => {
    const result = await runTokenCreate(admin(), { name: 'all', scopes: 'docs:read' });
    expect((result.json as PublicToken).projects).toBeNull();
  });

  it('fails on an unknown project slug', async () => {
    const err = await runTokenCreate(admin(), { name: 'x', scopes: 'docs:read', projects: 'nope' }).catch((e: unknown) => e);
    expect((err as ApiError).status).toBe(400);
  });

  it('rejects --projects that lists no project instead of creating a zero-project token', async () => {
    await expect(runTokenCreate(admin(), { name: 'empty-projects', scopes: 'docs:read', projects: '' })).rejects.toThrow(CliError);
    await expect(runTokenCreate(admin(), { name: 'empty-projects', scopes: 'docs:read', projects: '' })).rejects.toThrow(/--projects/);
    await expect(runTokenCreate(admin(), { name: 'blank-projects', scopes: 'docs:read', projects: ' , ' })).rejects.toThrow(/--projects/);

    const list = (await runTokenList(admin())).json as PublicToken[];
    expect(list.some((t) => t.name === 'empty-projects' || t.name === 'blank-projects')).toBe(false);
  });
});

describe('token create expiry', () => {
  it('defaults to 90 days when --expires and --no-expiry are both omitted', async () => {
    const before = Date.now();
    const result = await runTokenCreate(admin(), { name: 'expiry-default', scopes: 'docs:read' });
    const json = result.json as PublicToken;
    expect(json.expires_at).not.toBeNull();
    expect(Math.abs((json.expires_at as number) - (before + 90 * 86_400_000))).toBeLessThan(60_000);
  });

  it('creates a never-expiring token with --no-expiry', async () => {
    const result = await runTokenCreate(admin(), { name: 'no-expiry', scopes: 'docs:read', expiry: false });
    expect((result.json as PublicToken).expires_at).toBeNull();
  });

  it('rejects combining --expires with --no-expiry', async () => {
    await expect(
      runTokenCreate(admin(), { name: 'both', scopes: 'docs:read', expires: '90d', expiry: false }),
    ).rejects.toThrow(/--no-expiry/);
  });
});

describe('token list and revoke', () => {
  it('lists tokens without their values and marks revoked ones', async () => {
    const created = (await runTokenCreate(admin(), { name: 'to-revoke', scopes: 'docs:read' })).json as PublicToken & { token: string };
    const list = await runTokenList(admin());
    expect(list.text).toContain('to-revoke');
    expect(list.text).not.toContain(created.token);

    const revoked = await runTokenRevoke(admin(), String(created.id));
    expect(revoked.text).toContain(String(created.id));
    const after = await runTokenList(admin());
    const row = (after.json as PublicToken[]).find((t) => t.id === created.id)!;
    expect(row.revoked_at).not.toBeNull();
  });

  it('rejects a non-numeric id before calling the server', async () => {
    await expect(runTokenRevoke(admin(), 'abc')).rejects.toThrow(/id/);
  });
});
