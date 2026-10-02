import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeTestApp, type TestCtx } from './helpers.js';
import { createAdmin } from '../src/repos/admin.js';
import { hashPassword } from '../src/crypto/passwords.js';
import { listTokens, DAY_MS } from '../src/repos/tokens.js';

let t: TestCtx;
let session: string;
let csrf: string;
const near = (value: number, expected: number) => expect(Math.abs(value - expected)).toBeLessThan(60_000);
const page = (url: string) => t.app.inject({ method: 'GET', url, cookies: { blindkey_session: session } });
const post = (url: string, payload: Record<string, unknown>) =>
  t.app.inject({ method: 'POST', url, cookies: { blindkey_session: session }, payload });
const csrfOf = (b: string) => /name="csrf" value="([^"]+)"/.exec(b)?.[1] ?? '';

beforeAll(async () => {
  t = await makeTestApp();
  createAdmin(t.db, 'alex', await hashPassword('pw'));
  session = (await t.app.inject({ method: 'POST', url: '/login', payload: { username: 'alex', password: 'pw' } }))
    .cookies.find((c) => c.name === 'blindkey_session')!.value;
  t.project('acme');
  csrf = csrfOf((await page('/tokens')).body);
});
afterAll(async () => {
  await t.app.close();
});

describe('ui tokens', () => {
  it('lists every scope as a checkbox and shows the token list', async () => {
    const res = await page('/tokens');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('secrets:reveal');
    expect(res.body).toContain('class="token-list"');
  });

  it('creates a token, shows the value once, and never shows it again', async () => {
    const res = await post('/tokens', { csrf, name: 'agent', scopes: ['projects:read', 'docs:read'], projects: 'acme', days: '90' });
    expect(res.statusCode).toBe(200);
    const value = /bk_[A-Za-z0-9_-]+/.exec(res.body)?.[0];
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
  });

  it('empty days defaults to about 90 days', async () => {
    await post('/tokens', { csrf, name: 'empty-days', scopes: 'admin' });
    const row = listTokens(t.db).find((r) => r.name === 'empty-days')!;
    near(row.expires_at!, Date.now() + 90 * DAY_MS);
  });

  it('the never expires checkbox mints a token that never expires', async () => {
    await post('/tokens', { csrf, name: 'never-expires', scopes: 'admin', never: 'on', days: '' });
    const row = listTokens(t.db).find((r) => r.name === 'never-expires')!;
    expect(row.expires_at).toBeNull();
  });

  it('flags non-expiring active tokens in the table', async () => {
    await post('/tokens', { csrf, name: 'flagged-never', scopes: 'admin', never: 'on', days: '' });
    const res = await page('/tokens');
    const main = res.body.slice(res.body.indexOf('<main'), res.body.indexOf('</main>'));
    expect(main).toContain('never expires');
    expect(main).toContain('class="pill status-paused"');
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
    expect(res.headers.location).toBe('/tokens?done=revoked');
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

  it('renders active tokens with the active pill and revoked tokens with the archived pill', async () => {
    await post('/tokens', { csrf, name: 'style-active', scopes: 'docs:read' });
    await post('/tokens', { csrf, name: 'style-revoked', scopes: 'docs:read' });
    const revokedId = listTokens(t.db).find((r) => r.name === 'style-revoked')!.id;
    await post(`/tokens/${revokedId}/revoke`, { csrf });
    const res = await page('/tokens');
    const [activePart, revokedPart = ''] = res.body.split('class="revoked-tokens"');
    expect(activePart).toContain('style-active');
    expect(activePart).toContain(`/tokens/${listTokens(t.db).find((r) => r.name === 'style-active')!.id}/revoke`);
    expect(activePart).not.toContain('style-revoked');
    expect(revokedPart).toContain('style-revoked');
    expect(revokedPart).toContain('Revoked tokens (');
  });

  it('renames a token (label), shows it instead of the name, and clears it when blank', async () => {
    await post('/tokens', { csrf, name: 'machine-name', scopes: 'docs:read' });
    const id = listTokens(t.db).find((r) => r.name === 'machine-name')!.id;
    const r = await post(`/tokens/${id}/label`, { csrf, label: '  Easy   Renovation · home <b>PC</b> ' });
    expect(r.statusCode).toBe(302);
    expect(listTokens(t.db).find((x) => x.id === id)!.label).toBe('Easy Renovation · home <b>PC</b>');
    const body = (await page('/tokens')).body;
    expect(body).toContain('<strong>Easy Renovation · home &lt;b&gt;PC&lt;/b&gt;</strong>');
    expect(body).not.toContain('<b>PC</b>');
    await post(`/tokens/${id}/label`, { csrf, label: '   ' });
    expect(listTokens(t.db).find((x) => x.id === id)!.label).toBeNull();
    expect((await post(`/tokens/${id}/label`, { csrf, label: 'x'.repeat(101) })).statusCode).toBe(400);
    expect((await post(`/tokens/${id}/label`, { label: 'no csrf' })).statusCode).toBe(403);
  });

  it('rejects create and revoke without a CSRF token', async () => {
    expect((await post('/tokens', { name: 'nope', scopes: 'admin' })).statusCode).toBe(403);
    expect(listTokens(t.db).some((r) => r.name === 'nope')).toBe(false);
    const id = listTokens(t.db)[0]!.id;
    expect((await post(`/tokens/${id}/revoke`, {})).statusCode).toBe(403);
  });
});
