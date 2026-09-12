import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeTestApp, type TestCtx } from './helpers.js';
import { createAdmin } from '../src/repos/admin.js';
import { hashPassword } from '../src/crypto/passwords.js';
import { listTokens } from '../src/repos/tokens.js';

let t: TestCtx;
let session: string;
let csrf: string;
const page = (url: string) => t.app.inject({ method: 'GET', url, cookies: { pidb_session: session } });
const post = (url: string, payload: Record<string, unknown>) =>
  t.app.inject({ method: 'POST', url, cookies: { pidb_session: session }, payload });
const csrfOf = (b: string) => /name="csrf" value="([^"]+)"/.exec(b)?.[1] ?? '';

beforeAll(async () => {
  t = await makeTestApp();
  createAdmin(t.db, 'alex', await hashPassword('pw'));
  session = (await t.app.inject({ method: 'POST', url: '/login', payload: { username: 'alex', password: 'pw' } }))
    .cookies.find((c) => c.name === 'pidb_session')!.value;
  t.project('acme');
  csrf = csrfOf((await page('/tokens')).body);
});
afterAll(async () => {
  await t.app.close();
});

describe('ui tokens', () => {
  it('lists every scope as a checkbox and shows the table', async () => {
    const res = await page('/tokens');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('secrets:reveal');
    expect(res.body).toContain('<th>Prefix</th>');
  });

  it('creates a token, shows the value once, and never shows it again', async () => {
    const res = await post('/tokens', { csrf, name: 'agent', scopes: ['projects:read', 'docs:read'], projects: 'acme', days: '90' });
    expect(res.statusCode).toBe(200);
    const value = /pidb_[A-Za-z0-9_-]+/.exec(res.body)?.[0];
    expect(value).toBeTruthy();
    expect(res.body).toContain('shown once');

    const again = await page('/tokens');
    expect(again.body).not.toContain(value!);
    const row = listTokens(t.db).find((r) => r.name === 'agent')!;
    expect(row.scopes).toEqual(['projects:read', 'docs:read']);
    expect(row.expires_at).toBeGreaterThan(Date.now());
  });

  it('creates an unrestricted token when no project is named', async () => {
    await post('/tokens', { csrf, name: 'all-projects', scopes: 'admin' });
    const row = listTokens(t.db).find((r) => r.name === 'all-projects')!;
    expect(row.project_ids).toBeNull();
    expect(row.expires_at).toBeNull();
  });

  it('re-renders with an error when no scope is checked', async () => {
    const res = await post('/tokens', { csrf, name: 'no-scopes' });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('scope');
    expect(listTokens(t.db).some((r) => r.name === 'no-scopes')).toBe(false);
  });

  it('revokes a token', async () => {
    await post('/tokens', { csrf, name: 'to-revoke', scopes: 'docs:read' });
    const id = listTokens(t.db).find((r) => r.name === 'to-revoke')!.id;
    const res = await post(`/tokens/${id}/revoke`, { csrf });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/tokens');
    expect(listTokens(t.db).find((r) => r.id === id)!.revoked_at).not.toBeNull();
  });

  it('rejects a negative expiry instead of minting an already-expired token', async () => {
    const res = await post('/tokens', { csrf, name: 'bad-days-negative', scopes: 'admin', days: '-5' });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('Expiry');
    expect(listTokens(t.db).some((r) => r.name === 'bad-days-negative')).toBe(false);
  });

  it('rejects a zero expiry instead of minting a dead-on-arrival token', async () => {
    const res = await post('/tokens', { csrf, name: 'bad-days-zero', scopes: 'admin', days: '0' });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('Expiry');
    expect(listTokens(t.db).some((r) => r.name === 'bad-days-zero')).toBe(false);
  });

  it('rejects a non-numeric expiry', async () => {
    const res = await post('/tokens', { csrf, name: 'bad-days-nan', scopes: 'admin', days: 'abc' });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('Expiry');
    expect(listTokens(t.db).some((r) => r.name === 'bad-days-nan')).toBe(false);
  });

  it('rejects create and revoke without a CSRF token', async () => {
    expect((await post('/tokens', { name: 'nope', scopes: 'admin' })).statusCode).toBe(403);
    expect(listTokens(t.db).some((r) => r.name === 'nope')).toBe(false);
    const id = listTokens(t.db)[0]!.id;
    expect((await post(`/tokens/${id}/revoke`, {})).statusCode).toBe(403);
  });
});
