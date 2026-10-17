import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeTestApp, type TestCtx } from './helpers.js';
import { createAdmin } from '../src/repos/admin.js';
import { hashPassword } from '../src/crypto/passwords.js';
import { createToken, revokeToken } from '../src/repos/tokens.js';

let t: TestCtx;
let session: string;
const page = (url: string) => t.app.inject({ method: 'GET', url, cookies: { blindkey_session: session } });

beforeAll(async () => {
  t = await makeTestApp();
  createAdmin(t.db, 'alex', await hashPassword('pw'));
  session = (await t.app.inject({ method: 'POST', url: '/login', payload: { username: 'alex', password: 'pw' } }))
    .cookies.find((c) => c.name === 'blindkey_session')!.value;
  t.project('acme');
});
afterAll(async () => {
  await t.app.close();
});

describe('nav API tokens count', () => {
  it('counts only active tokens: not revoked, not expired', async () => {
    const { row: active } = createToken(t.db, { name: 'active', scopes: ['admin'], projectIds: null, expiresAt: null });
    const { row: revoked } = createToken(t.db, { name: 'revoked', scopes: ['admin'], projectIds: null, expiresAt: null });
    revokeToken(t.db, revoked.id);
    createToken(t.db, { name: 'expired', scopes: ['admin'], projectIds: null, expiresAt: Date.now() - 1000 });

    const res = await page('/');
    const nav = res.body.slice(res.body.indexOf('API tokens'), res.body.indexOf('API tokens') + 200);
    expect(nav).toContain('<span class="count">1</span>');
    // sanity: the active token really is the one counted
    expect(active.revoked_at).toBeNull();
  });
});

describe('no-store on every UI page', () => {
  it('sets cache-control: no-store on the secrets tab, the home page and login', async () => {
    for (const url of ['/p/acme?tab=secrets', '/', '/login']) {
      const res = await t.app.inject({ method: 'GET', url, cookies: { blindkey_session: session } });
      expect(String(res.headers['cache-control']), url).toContain('no-store');
    }
  });

  it('does not set cache-control: no-store on static assets', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/assets/app.css' });
    expect(String(res.headers['cache-control'] ?? '')).not.toContain('no-store');
  });
});
