import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeTestApp, sessionFor, type TestCtx } from './helpers.js';
import { createAdmin, createSession, createUser, getUserByUsername } from '../src/repos/admin.js';
import { getTotp, openTotpSecret } from '../src/repos/twofactor.js';
import { base32Decode, hotp, stepAt } from '../src/auth/totp.js';
import { hashPassword } from '../src/crypto/passwords.js';
import { listAudit } from '../src/repos/audit.js';
import { createTokenFor } from '../src/services/admin.js';
import { approveConnect, startConnect } from '../src/services/connect.js';
import { verifySecondFactor } from '../src/services/twofactor.js';
import { addOwner } from '../src/repos/workspaces.js';
import { AppError } from '../src/errors.js';
import type { Actor } from '../src/auth/principal.js';

const main = (html: string): string => html.split('<main')[1]!.split('</main>')[0]!;
const csrfOf = (html: string) => /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? '';
const actorOf = (t: TestCtx, username: string): Actor => {
  const u = getUserByUsername(t.db, username)!;
  return { principal: { kind: 'admin', id: u.id, userId: u.id, isSuper: u.is_super, impersonatorId: null, scopes: ['admin'], projectIds: null, agent: false }, ip: '', userAgent: '' };
};
const failure = (fn: () => unknown): AppError => {
  try {
    fn();
  } catch (e) {
    if (e instanceof AppError) return e;
    throw e;
  }
  throw new Error('did not throw');
};

describe('mandatory two-factor: the onboarding gate', () => {
  let t: TestCtx;
  beforeAll(async () => {
    t = await makeTestApp();
    // what `init` leaves behind: the first super user, no second factor
    createAdmin(t.db, 'alex', await hashPassword('first-password-1'));
  });
  afterAll(async () => {
    await t.app.close();
  });

  const get = (s: string, url: string) => t.app.inject({ method: 'GET', url, cookies: { blindkey_session: s } });
  const post = (s: string, url: string, payload: Record<string, unknown>) => t.app.inject({ method: 'POST', url, cookies: { blindkey_session: s }, payload });

  it('the first super logs in with the password alone, then every page but enrollment, logout and assets is closed', async () => {
    const login = await t.app.inject({ method: 'POST', url: '/login', payload: { username: 'alex', password: 'first-password-1' } });
    expect(login.statusCode).toBe(302);
    const s = login.cookies.find((c) => c.name === 'blindkey_session')!.value;
    for (const url of ['/', '/tokens', '/audit', '/admin/users', '/settings/password', '/p/anything']) {
      const res = await get(s, url);
      expect(res.statusCode, url).toBe(302);
      expect(res.headers.location, url).toBe('/settings/2fa');
    }
    expect((await t.app.inject({ method: 'HEAD', url: '/tokens', cookies: { blindkey_session: s } })).statusCode).toBe(302);
    const page = await get(s, '/settings/2fa');
    expect(page.statusCode).toBe(200);
    const csrf = csrfOf(page.body);
    expect(main(page.body)).toContain('Two-factor authentication is required. Scan the QR code with an authenticator app to finish setting up your account.');
    expect((await get(s, '/assets/app.css')).statusCode).toBe(200);
    for (const url of ['/tokens', '/projects', '/settings/password', '/settings/2fa/recovery', '/connect/approve', '/admin/users']) {
      const res = await post(s, url, { csrf, name: 'x' });
      expect(res.statusCode, url).toBe(403);
      expect(res.body, url).toContain('totp_setup_required');
    }
    // the same gate holds when the CSRF token is missing: a closed door, not an oracle
    expect((await post(s, '/tokens', {})).statusCode).toBe(403);
  });

  it('enrollment pages work; confirming shows the recovery codes with a Continue link to /, then everything opens', async () => {
    const s = sessionFor(t.db, 'alex');
    const csrf = csrfOf((await get(s, '/settings/2fa')).body);
    const started = await post(s, '/settings/2fa/start', { csrf });
    expect(started.statusCode).toBe(200);
    expect(main(started.body)).toContain('Two-factor authentication is required.');
    const id = getUserByUsername(t.db, 'alex')!.id;
    const wrong = await post(s, '/settings/2fa/confirm', { csrf, code: '000000' });
    expect(wrong.statusCode).toBe(400);
    expect((await get(s, '/')).statusCode).toBe(302);
    const code = hotp(openTotpSecret(t.ring, getTotp(t.db, id)!), stepAt(Date.now()));
    const done = await post(s, '/settings/2fa/confirm', { csrf, code });
    expect(done.statusCode).toBe(200);
    expect(done.headers['cache-control']).toContain('no-store');
    expect(main(done.body)).toMatch(/<a [^>]*href="\/"[^>]*>Continue<\/a>/);
    expect(main(done.body).match(/[a-hjkmnp-z2-9]{5}-[a-hjkmnp-z2-9]{5}/g)).toHaveLength(10);
    expect((await get(s, '/')).statusCode).toBe(200);
    expect((await get(s, '/tokens')).statusCode).toBe(200);
    // no notice any more
    expect(main((await get(s, '/settings/2fa')).body)).not.toContain('Two-factor authentication is required');
  });
});

describe('mandatory two-factor: password first, then 2FA', () => {
  it('a new user on a temporary password is sent to the password page, then straight to 2FA enrollment, and is gated until done', async () => {
    const t = await makeTestApp();
    try {
      createAdmin(t.db, 'root', await hashPassword('root-password-1'));
      t.enroll('root');
      createUser(t.db, { username: 'newbie', passwordHash: await hashPassword('temp-password-1'), mustChangePassword: true });
      const login = await t.app.inject({ method: 'POST', url: '/login', payload: { username: 'newbie', password: 'temp-password-1' } });
      const s = login.cookies.find((c) => c.name === 'blindkey_session')!.value;
      const get = (url: string) => t.app.inject({ method: 'GET', url, cookies: { blindkey_session: s } });

      // the password gate wins first
      expect((await get('/')).headers.location).toBe('/settings/password');
      expect((await get('/settings/2fa')).headers.location).toBe('/settings/password');
      const form = await get('/settings/password');
      const csrf = csrfOf(form.body);
      const changed = await t.app.inject({
        method: 'POST', url: '/settings/password', cookies: { blindkey_session: s },
        payload: { csrf, current: 'temp-password-1', next: 'my-own-password-9', confirm: 'my-own-password-9' },
      });
      expect(changed.statusCode).toBe(303);
      expect(changed.headers.location).toBe('/settings/2fa');

      // now the 2FA gate: GETs redirect, POSTs are refused
      expect((await get('/')).headers.location).toBe('/settings/2fa');
      expect((await get('/tokens')).headers.location).toBe('/settings/2fa');
      expect((await get('/settings/password')).headers.location).toBe('/settings/2fa');
      expect((await t.app.inject({ method: 'POST', url: '/tokens', cookies: { blindkey_session: s }, payload: { csrf, name: 'x', scopes: ['docs:read'] } })).statusCode).toBe(403);
      const page = await get('/settings/2fa');
      expect(page.statusCode).toBe(200);
      const uid = getUserByUsername(t.db, 'newbie')!.id;
      await t.app.inject({ method: 'POST', url: '/settings/2fa/start', cookies: { blindkey_session: s }, payload: { csrf: csrfOf(page.body) } });
      const code = hotp(openTotpSecret(t.ring, getTotp(t.db, uid)!), stepAt(Date.now()));
      const done = await t.app.inject({ method: 'POST', url: '/settings/2fa/confirm', cookies: { blindkey_session: s }, payload: { csrf: csrfOf(page.body), code } });
      expect(done.statusCode).toBe(200);
      expect((await get('/')).statusCode).toBe(200);
    } finally {
      await t.app.close();
    }
  });

  it('impersonating a user who has not enrolled is not gated (an impersonated session cannot change 2FA at all)', async () => {
    const t = await makeTestApp();
    try {
      createAdmin(t.db, 'root', await hashPassword('root-password-1'));
      t.enroll('root');
      createUser(t.db, { username: 'plain', passwordHash: await hashPassword('plain-password-1') });
      const root = sessionFor(t.db, 'root');
      const csrf = csrfOf((await t.app.inject({ method: 'GET', url: '/', cookies: { blindkey_session: root } })).body);
      const res = await t.app.inject({ method: 'POST', url: `/admin/users/${getUserByUsername(t.db, 'plain')!.id}/impersonate`, cookies: { blindkey_session: root }, payload: { csrf } });
      expect(res.statusCode).toBe(303);
      const imp = res.cookies.find((c) => c.name === 'blindkey_session')!.value;
      const home = await t.app.inject({ method: 'GET', url: '/', cookies: { blindkey_session: imp } });
      expect(home.statusCode).toBe(200);
      expect(main(home.body)).toContain('Acting as');
      // ...but it can not enroll either
      const start = await t.app.inject({ method: 'POST', url: '/settings/2fa/start', cookies: { blindkey_session: imp }, payload: { csrf: csrfOf(home.body) } });
      expect(start.statusCode).toBe(403);
    } finally {
      await t.app.close();
    }
  });
});

describe('mandatory two-factor: server-side enforcement beyond the UI gate', () => {
  it('token create, connect approval and the API password exchange refuse with 403 totp_setup_required until the user is enrolled', async () => {
    const t = await makeTestApp();
    try {
      createAdmin(t.db, 'root', await hashPassword('root-password-1'));
      t.enroll('root');
      t.project('alpha');
      const u = createUser(t.db, { username: 'zoe', passwordHash: await hashPassword('zoe-password-123') });
      addOwner(t.db, t.workspaceId, u.id);
      const actor = actorOf(t, 'zoe');
      const start = () => startConnect(t.ctx, { name: 'claude@laptop', scopes: ['projects:read'], projects: ['alpha'], expires_days: 30 }, '', '', 'http://x');
      const exchange = (totp?: string) =>
        t.app.inject({ method: 'POST', url: '/api/v1/auth/token', payload: { username: 'zoe', password: 'zoe-password-123', name: 'cli', ...(totp ? { totp } : {}) } });

      // service level (not only routes)
      const create = failure(() => createTokenFor(t.ctx, actor, { name: 'x', scopes: ['docs:read'], projects: null }));
      expect({ status: create.status, code: create.code, message: create.message }).toEqual({ status: 403, code: 'totp_setup_required', message: 'two-factor authentication must be set up first' });
      const pending = start();
      const approve = failure(() => approveConnect(t.ctx, actor, pending.user_code, ['projects:read'], ['alpha'], '30'));
      expect({ status: approve.status, code: approve.code }).toEqual({ status: 403, code: 'totp_setup_required' });
      // HTTP exchange
      const ex = await exchange();
      expect(ex.statusCode).toBe(403);
      expect(ex.json()).toMatchObject({ error: 'totp_setup_required', message: 'two-factor authentication must be set up first' });
      expect(ex.json().token).toBeUndefined();
      expect((t.db.prepare(`SELECT COUNT(*) AS n FROM api_tokens WHERE user_id = ?`).get(u.id) as { n: number }).n).toBe(0);

      // enrolled: all three work
      const factor = t.enroll(u.id);
      expect(createTokenFor(t.ctx, actor, { name: 'x', scopes: ['docs:read'], projects: null }).token).toMatch(/^bk_/);
      approveConnect(t.ctx, actor, pending.user_code, ['projects:read'], ['alpha'], '30');
      const ok = await exchange(factor.code());
      expect(ok.statusCode).toBe(201);
    } finally {
      await t.app.close();
    }
  });

  it('an approved connect request cannot be collected after the approver lost their 2FA (reset)', async () => {
    const t = await makeTestApp();
    try {
      createAdmin(t.db, 'root', await hashPassword('root-password-1'));
      t.enroll('root');
      t.project('alpha');
      const u = createUser(t.db, { username: 'yan', passwordHash: await hashPassword('yan-password-123') });
      addOwner(t.db, t.workspaceId, u.id);
      t.enroll(u.id);
      const start = startConnect(t.ctx, { name: 'claude@laptop', scopes: ['projects:read'], projects: ['alpha'], expires_days: 30 }, '', '', 'http://x');
      approveConnect(t.ctx, actorOf(t, 'yan'), start.user_code, ['projects:read'], ['alpha'], '30');
      t.db.prepare(`DELETE FROM admin_totp WHERE admin_id = ?`).run(u.id); // what a reset does to the factor
      const poll = await t.app.inject({ method: 'POST', url: '/api/v1/connect/poll', payload: { device_code: start.device_code } });
      expect(poll.statusCode).toBe(403);
      expect(poll.json().error).toBe('totp_setup_required');
      expect((t.db.prepare(`SELECT COUNT(*) AS n FROM api_tokens WHERE user_id = ?`).get(u.id) as { n: number }).n).toBe(0);
    } finally {
      await t.app.close();
    }
  });
});

describe('re-enroll: rotate the authenticator secret', () => {
  it('needs password + current code; the old secret keeps working until the new one is confirmed, then it stops; new recovery codes; other sessions out; nothing secret is audited', async () => {
    const t = await makeTestApp();
    try {
      createAdmin(t.db, 'carl', await hashPassword('carl-password-1'));
      const uid = getUserByUsername(t.db, 'carl')!.id;
      const oldFactor = t.enroll(uid);
      const s = sessionFor(t.db, 'carl');
      const other = createSession(t.db, uid, 3_600_000, '', '');
      const get = (url: string) => t.app.inject({ method: 'GET', url, cookies: { blindkey_session: s } });
      const post = (url: string, payload: Record<string, unknown>) => t.app.inject({ method: 'POST', url, cookies: { blindkey_session: s }, payload });
      const page = await get('/settings/2fa');
      expect(main(page.body)).toContain('Rotate your authenticator secret (e.g. after an admin set it up for you).');
      const csrf = csrfOf(page.body);

      // CSRF on both new POSTs
      expect((await post('/settings/2fa/reenroll', { password: 'carl-password-1', code: oldFactor.code(-1) })).statusCode).toBe(403);
      expect((await post('/settings/2fa/reenroll/confirm', { code: '123456', token: 'x' })).statusCode).toBe(403);
      // wrong password / wrong code
      expect((await post('/settings/2fa/reenroll', { csrf, password: 'nope', code: oldFactor.code(-1) })).statusCode).toBe(400);
      expect((await post('/settings/2fa/reenroll', { csrf, password: 'carl-password-1', code: '000000' })).statusCode).toBe(400);

      const begin = await post('/settings/2fa/reenroll', { csrf, password: 'carl-password-1', code: oldFactor.code(-1) });
      expect(begin.statusCode).toBe(200);
      const m = main(begin.body);
      expect(m).toContain('data:image/svg+xml;base64,');
      const token = /name="token" value="([^"]+)"/.exec(m)![1]!;
      const newSecret = base32Decode(/id="totp-secret"[^>]*>([^<]+)</.exec(m)![1]!.replace(/\s+/g, ''));
      expect(newSecret.equals(oldFactor.secret)).toBe(false);
      // nothing replaced yet
      expect(openTotpSecret(t.ring, getTotp(t.db, uid)!).equals(oldFactor.secret)).toBe(true);

      // a wrong code (or the OLD authenticator's code) does not confirm; the page offers the same QR again
      const bad = await post('/settings/2fa/reenroll/confirm', { csrf, token, code: oldFactor.code() });
      expect(bad.statusCode).toBe(400);
      expect(main(bad.body)).toContain('Invalid code.');
      expect(openTotpSecret(t.ring, getTotp(t.db, uid)!).equals(oldFactor.secret)).toBe(true);
      // a forged token is rejected
      expect((await post('/settings/2fa/reenroll/confirm', { csrf, token: 'v.1.zzz', code: hotp(newSecret, stepAt(Date.now())) })).statusCode).toBe(400);

      const done = await post('/settings/2fa/reenroll/confirm', { csrf, token, code: hotp(newSecret, stepAt(Date.now())) });
      expect(done.statusCode).toBe(200);
      expect(done.headers['cache-control']).toContain('no-store');
      const codes = main(done.body).match(/[a-hjkmnp-z2-9]{5}-[a-hjkmnp-z2-9]{5}/g) ?? [];
      expect(codes).toHaveLength(10);
      expect(openTotpSecret(t.ring, getTotp(t.db, uid)!).equals(newSecret)).toBe(true);
      // the old secret no longer verifies, the new one does (next step: the confirmation claimed this one)
      expect(await verifySecondFactor(t.ctx, uid, oldFactor.code(1))).toBeNull();
      expect(await verifySecondFactor(t.ctx, uid, hotp(newSecret, stepAt(Date.now()) + 1))).toBe('totp');
      // other sessions signed out, this one stays
      expect((await t.app.inject({ method: 'GET', url: '/settings/2fa', cookies: { blindkey_session: other } })).statusCode).toBe(302);
      expect((await get('/settings/2fa')).statusCode).toBe(200);
      // audited, with no secret material or codes
      const audit = listAudit(t.db, { action: 'auth.totp_reenrolled' });
      expect(audit).toHaveLength(1);
      const everything = JSON.stringify(listAudit(t.db, { limit: 1000 }));
      for (const c of codes) expect(everything).not.toContain(c);
      expect(everything).not.toContain(token);
      expect(everything).not.toContain(newSecret.toString('hex'));
    } finally {
      await t.app.close();
    }
  });
});
