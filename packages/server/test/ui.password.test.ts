import { describe, it, expect, beforeAll } from 'vitest';
import { makeTestApp, type TestCtx } from './helpers.js';
import { createAdmin, createSession, getAdmin } from '../src/repos/admin.js';
import { SESSION_TTL_MS } from '../src/ui/session.js';
import { startEnrollment, confirmEnrollment, MAX_FACTOR_FAILURES, FACTOR_LOCK_MS } from '../src/services/twofactor.js';
import { hashPassword } from '../src/crypto/passwords.js';
import { getTotp, openTotpSecret, recordFactorFailure, factorLockedUntil, createChallenge, getChallenge } from '../src/repos/twofactor.js';
import { hotp, stepAt } from '../src/auth/totp.js';
import { listAudit } from '../src/repos/audit.js';

function main(html: string): string {
  return html.split('<main')[1]!.split('</main>')[0]!;
}

async function refreshCsrf(t: TestCtx, session: string): Promise<string> {
  const res = await t.app.inject({ method: 'GET', url: '/', cookies: { pidb_session: session } });
  return /name="csrf" value="([^"]+)"/.exec(res.body)![1]!;
}

describe('ui password change — no 2FA', () => {
  let t: TestCtx;
  let session = '';
  let csrf = '';

  beforeAll(async () => {
    t = await makeTestApp();
    createAdmin(t.db, 'alex', await hashPassword('old-password!!'));
    const login = await t.app.inject({ method: 'POST', url: '/login', payload: { username: 'alex', password: 'old-password!!' } });
    session = login.cookies.find((c) => c.name === 'pidb_session')!.value;
    csrf = await refreshCsrf(t, session);
  });

  it('1. GET shows current/next/confirm and no code field, no-store', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/settings/password', cookies: { pidb_session: session } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toContain('no-store');
    const body = main(res.body);
    expect(body).toContain('name="current"');
    expect(body).toContain('name="next"');
    expect(body).toContain('name="confirm"');
    expect(body).not.toContain('name="code"');
  });

  it('2. wrong current password → 400, audited, hash unchanged', async () => {
    const before = getAdmin(t.db)!.password_hash;
    const res = await t.app.inject({
      method: 'POST',
      url: '/settings/password',
      cookies: { pidb_session: session },
      payload: { csrf, current: 'nope', next: 'brand-new-pass1', confirm: 'brand-new-pass1' },
    });
    expect(res.statusCode).toBe(400);
    expect(main(res.body)).toContain('Current password or code is incorrect.');
    expect(getAdmin(t.db)!.password_hash).toBe(before);
    const rows = listAudit(t.db, { action: 'auth.password_change_failed', limit: 1 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.meta).toEqual({ via: 'ui' });
  });

  it('5. mismatched confirm → 400', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/settings/password',
      cookies: { pidb_session: session },
      payload: { csrf, current: 'old-password!!', next: 'brand-new-pass1', confirm: 'different-pass1' },
    });
    expect(res.statusCode).toBe(400);
    expect(main(res.body)).toContain('New passwords do not match.');
  });

  it('5. an 11-character new password → 400', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/settings/password',
      cookies: { pidb_session: session },
      payload: { csrf, current: 'old-password!!', next: 'elevenchars', confirm: 'elevenchars' },
    });
    expect(res.statusCode).toBe(400);
    expect(main(res.body)).toContain('Password must be at least 12 characters.');
  });

  it('5. new password same as current → 400', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/settings/password',
      cookies: { pidb_session: session },
      payload: { csrf, current: 'old-password!!', next: 'old-password!!', confirm: 'old-password!!' },
    });
    expect(res.statusCode).toBe(400);
    expect(main(res.body)).toContain('New password must differ from the current one.');
  });

  it('7. a POST without csrf is rejected like other settings POSTs', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/settings/password',
      cookies: { pidb_session: session },
      payload: { current: 'old-password!!', next: 'brand-new-pass1', confirm: 'brand-new-pass1' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('6. success redirects 303, revokes other sessions, keeps the current one, and audits sessions_revoked', async () => {
    const other = createSession(t.db, 1, SESSION_TTL_MS, '', '');
    expect((await t.app.inject({ method: 'GET', url: '/tokens', cookies: { pidb_session: other } })).statusCode).toBe(200);

    const res = await t.app.inject({
      method: 'POST',
      url: '/settings/password',
      cookies: { pidb_session: session },
      payload: { csrf, current: 'old-password!!', next: 'brand-new-pass1', confirm: 'brand-new-pass1' },
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe('/settings/password?done=saved');

    const oldLogin = await t.app.inject({ method: 'POST', url: '/login', payload: { username: 'alex', password: 'old-password!!' } });
    expect(oldLogin.statusCode).toBe(401);
    const newLogin = await t.app.inject({ method: 'POST', url: '/login', payload: { username: 'alex', password: 'brand-new-pass1' } });
    expect(newLogin.statusCode).toBe(302);

    expect((await t.app.inject({ method: 'GET', url: '/tokens', cookies: { pidb_session: other } })).statusCode).toBe(302);
    expect((await t.app.inject({ method: 'GET', url: '/tokens', cookies: { pidb_session: session } })).statusCode).toBe(200);

    const rows = listAudit(t.db, { action: 'auth.password_changed', limit: 1 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.meta).toEqual({ via: 'ui', sessions_revoked: 1 });
    const metaText = JSON.stringify(listAudit(t.db, { limit: 20 }).map((r) => r.meta));
    expect(metaText).not.toContain('old-password!!');
    expect(metaText).not.toContain('brand-new-pass1');
  });

  it('F4: a pending login challenge for the admin is deleted on a successful password change', async () => {
    const admin = getAdmin(t.db)!;
    const challenge = createChallenge(t.db, admin.id, 60_000, '', '');
    expect(getChallenge(t.db, challenge)).not.toBeNull();

    const res = await t.app.inject({
      method: 'POST',
      url: '/settings/password',
      cookies: { pidb_session: session },
      payload: { csrf, current: 'brand-new-pass1', next: 'another-new-pass1', confirm: 'another-new-pass1' },
    });
    expect(res.statusCode).toBe(303);
    expect(getChallenge(t.db, challenge)).toBeNull();
  });
});

describe('ui password change — with 2FA enabled', () => {
  let t: TestCtx;
  let session = '';
  let csrf = '';
  let recoveryCodes: string[] = [];

  function codeFor(d: number): string {
    const row = getTotp(t.db, 1)!;
    return hotp(openTotpSecret(t.ring, row), stepAt(Date.now()) + d);
  }

  beforeAll(async () => {
    t = await makeTestApp();
    createAdmin(t.db, 'bob', await hashPassword('correct-password1'));
    const login = await t.app.inject({ method: 'POST', url: '/login', payload: { username: 'bob', password: 'correct-password1' } });
    session = login.cookies.find((c) => c.name === 'pidb_session')!.value;
    csrf = await refreshCsrf(t, session);
    startEnrollment(t.ctx, 1);
    const codes = await confirmEnrollment(
      t.ctx,
      { principal: { kind: 'admin', id: 1, scopes: ['admin'], projectIds: null, agent: false }, ip: '', userAgent: '' },
      hotp(openTotpSecret(t.ring, getTotp(t.db, 1)!), stepAt(Date.now())),
      session,
    );
    expect(codes).not.toBeNull();
    recoveryCodes = codes!;
  });

  it('1. GET shows a code field when 2FA is on', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/settings/password', cookies: { pidb_session: session } });
    expect(main(res.body)).toContain('name="code"');
  });

  it('3. correct password, empty code → 400 (Review Focus 1: never skipped)', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/settings/password',
      cookies: { pidb_session: session },
      payload: { csrf, current: 'correct-password1', next: 'brand-new-pass1', confirm: 'brand-new-pass1', code: '' },
    });
    expect(res.statusCode).toBe(400);
    expect(main(res.body)).toContain('Current password or code is incorrect.');
  });

  it('fix round 1: correct password, wrong non-empty code → 400 and the factor failure counter is +1', async () => {
    const before = (t.db.prepare(`SELECT failed_count FROM admin_totp WHERE admin_id = ?`).get(1) as { failed_count: number }).failed_count;
    const res = await t.app.inject({
      method: 'POST',
      url: '/settings/password',
      cookies: { pidb_session: session },
      payload: { csrf, current: 'correct-password1', next: 'brand-new-pass1', confirm: 'brand-new-pass1', code: '000000' },
    });
    expect(res.statusCode).toBe(400);
    expect(main(res.body)).toContain('Current password or code is incorrect.');
    const after = (t.db.prepare(`SELECT failed_count FROM admin_totp WHERE admin_id = ?`).get(1) as { failed_count: number }).failed_count;
    expect(after).toBe(before + 1);
  });

  it('4. a locked admin gets 429 even with the correct password (Review Focus 2: no password oracle)', async () => {
    for (let i = 0; i < MAX_FACTOR_FAILURES; i++) recordFactorFailure(t.db, 1, MAX_FACTOR_FAILURES, FACTOR_LOCK_MS);
    expect(factorLockedUntil(t.db, 1)).not.toBeNull();

    const res = await t.app.inject({
      method: 'POST',
      url: '/settings/password',
      cookies: { pidb_session: session },
      payload: { csrf, current: 'correct-password1', next: 'brand-new-pass1', confirm: 'brand-new-pass1', code: codeFor(1) },
    });
    expect(res.statusCode).toBe(429);
    expect(main(res.body)).toContain('Too many wrong codes');

    // Unlock for the next test (this directly clears the repo state, not through the service).
    t.db.prepare(`UPDATE admin_totp SET locked_until = NULL, failed_count = 0 WHERE admin_id = ?`).run(1);
  });

  it('fix round 1 (RULING): a mismatched confirm does not consume the TOTP code — the same code then succeeds', async () => {
    // A fresh, not-yet-claimed step: the empty and "000000" codes in the two tests above never
    // matched, so no step has been claimed since enrollment — this is the first genuine TOTP
    // value generated for this admin.
    const code = codeFor(1);

    const mismatched = await t.app.inject({
      method: 'POST',
      url: '/settings/password',
      cookies: { pidb_session: session },
      payload: { csrf, current: 'correct-password1', next: 'brand-new-pass1', confirm: 'different-pass1', code },
    });
    expect(mismatched.statusCode).toBe(400);
    expect(main(mismatched.body)).toContain('New passwords do not match.');

    // Reusing the exact same code proves the mismatched attempt above never reached
    // verifySecondFactor (a claimed TOTP step cannot be reused).
    const success = await t.app.inject({
      method: 'POST',
      url: '/settings/password',
      cookies: { pidb_session: session },
      payload: { csrf, current: 'correct-password1', next: 'brand-new-pass1', confirm: 'brand-new-pass1', code },
    });
    expect(success.statusCode).toBe(303);
    expect(success.headers.location).toBe('/settings/password?done=saved');
    const rows = listAudit(t.db, { action: 'auth.password_changed', limit: 1 });
    expect(rows[0]!.meta).toMatchObject({ via: 'ui' });
  });

  it('F5: a password change verified with a recovery code audits auth.recovery_used (meta {via:"password_change"})', async () => {
    const code = recoveryCodes.pop()!;
    const res = await t.app.inject({
      method: 'POST',
      url: '/settings/password',
      cookies: { pidb_session: session },
      payload: { csrf, current: 'brand-new-pass1', next: 'another-new-pass1', confirm: 'another-new-pass1', code },
    });
    expect(res.statusCode).toBe(303);
    const rows = listAudit(t.db, { action: 'auth.recovery_used', limit: 1 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.meta).toEqual({ via: 'password_change' });
  });
});
