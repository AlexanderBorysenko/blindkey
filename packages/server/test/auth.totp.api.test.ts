import { describe, it, expect } from 'vitest';
import { makeTestApp, type TestCtx } from './helpers.js';
import { createAdmin } from '../src/repos/admin.js';
import { hashPassword } from '../src/crypto/passwords.js';
import { getTotp, openTotpSecret } from '../src/repos/twofactor.js';
import { hotp, stepAt } from '../src/auth/totp.js';
import { startEnrollment, confirmEnrollment } from '../src/services/twofactor.js';
import { listAudit } from '../src/repos/audit.js';
import type { Actor } from '../src/auth/principal.js';

async function setupEnrolled(t: TestCtx, adminId: number): Promise<{ actor: Actor }> {
  const actor: Actor = { principal: { kind: 'admin', id: adminId, scopes: ['admin'], projectIds: null }, ip: '1.1.1.1', userAgent: 't' };
  startEnrollment(t.ctx, adminId);
  const secret = openTotpSecret(t.ring, getTotp(t.db, adminId)!);
  const code = hotp(secret, stepAt(Date.now()));
  await confirmEnrollment(t.ctx, actor, code);
  return { actor };
}

function codeForStep(t: TestCtx, adminId: number, deltaSteps: number): string {
  const secret = openTotpSecret(t.ring, getTotp(t.db, adminId)!);
  return hotp(secret, stepAt(Date.now()) + deltaSteps);
}

describe('POST /api/v1/auth/token — 2FA', () => {
  it('enrollment only started, not confirmed: password alone mints a token', async () => {
    const t = await makeTestApp();
    const admin = createAdmin(t.db, 'alex', await hashPassword('correct horse'));
    startEnrollment(t.ctx, admin.id);

    const r = await t.app.inject({ method: 'POST', url: '/api/v1/auth/token', payload: { username: 'alex', password: 'correct horse' } });
    expect(r.statusCode).toBe(201);
    expect(r.json().token).toMatch(/^pidb_/);
  });

  it('enabled, no totp: 401 totp_required, no auth.login_failed or auth.totp_failed audit row', async () => {
    const t = await makeTestApp();
    const admin = createAdmin(t.db, 'alex', await hashPassword('correct horse'));
    await setupEnrolled(t, admin.id);

    const r = await t.app.inject({ method: 'POST', url: '/api/v1/auth/token', payload: { username: 'alex', password: 'correct horse' } });
    expect(r.statusCode).toBe(401);
    expect(r.json().error).toBe('totp_required');
    expect(listAudit(t.db, { action: 'auth.login_failed' })).toHaveLength(0);
    expect(listAudit(t.db, { action: 'auth.totp_failed' })).toHaveLength(0);
  });

  it('wrong totp: 401 unauthorized, plus an auth.totp_failed audit row', async () => {
    const t = await makeTestApp();
    const admin = createAdmin(t.db, 'alex', await hashPassword('correct horse'));
    await setupEnrolled(t, admin.id);

    const r = await t.app.inject({ method: 'POST', url: '/api/v1/auth/token', payload: { username: 'alex', password: 'correct horse', totp: '000000' } });
    expect(r.statusCode).toBe(401);
    expect(r.json().error).toBe('unauthorized');
    expect(listAudit(t.db, { action: 'auth.totp_failed' })).toHaveLength(1);
  });

  it('correct totp: 201, and auth.login meta has second_factor totp', async () => {
    const t = await makeTestApp();
    const admin = createAdmin(t.db, 'alex', await hashPassword('correct horse'));
    await setupEnrolled(t, admin.id);
    const code = codeForStep(t, admin.id, 1);

    const r = await t.app.inject({ method: 'POST', url: '/api/v1/auth/token', payload: { username: 'alex', password: 'correct horse', totp: code } });
    expect(r.statusCode).toBe(201);
    const login = listAudit(t.db, { action: 'auth.login' });
    expect(login).toHaveLength(1);
    expect(login[0]?.meta).toMatchObject({ second_factor: 'totp' });
  });

  it('the same code again, immediately: 401', async () => {
    const t = await makeTestApp();
    const admin = createAdmin(t.db, 'alex', await hashPassword('correct horse'));
    await setupEnrolled(t, admin.id);
    const code = codeForStep(t, admin.id, 1);

    const first = await t.app.inject({ method: 'POST', url: '/api/v1/auth/token', payload: { username: 'alex', password: 'correct horse', totp: code } });
    expect(first.statusCode).toBe(201);
    const second = await t.app.inject({ method: 'POST', url: '/api/v1/auth/token', payload: { username: 'alex', password: 'correct horse', totp: code } });
    expect(second.statusCode).toBe(401);
  });

  it('a recovery code: 201 with second_factor recovery', async () => {
    const t = await makeTestApp();
    const admin = createAdmin(t.db, 'alex', await hashPassword('correct horse'));
    const actor: Actor = { principal: { kind: 'admin', id: admin.id, scopes: ['admin'], projectIds: null }, ip: '1.1.1.1', userAgent: 't' };
    startEnrollment(t.ctx, admin.id);
    const secret = openTotpSecret(t.ring, getTotp(t.db, admin.id)!);
    const codes = (await confirmEnrollment(t.ctx, actor, hotp(secret, stepAt(Date.now()))))!;

    const r = await t.app.inject({ method: 'POST', url: '/api/v1/auth/token', payload: { username: 'alex', password: 'correct horse', totp: codes[0] } });
    expect(r.statusCode).toBe(201);
    const login = listAudit(t.db, { action: 'auth.login' });
    expect(login[0]?.meta).toMatchObject({ second_factor: 'recovery' });
    expect(listAudit(t.db, { action: 'auth.recovery_used' })).toHaveLength(1);
  });

  it('a wrong password with a correct code: 401 unauthorized, with auth.login_failed', async () => {
    const t = await makeTestApp();
    const admin = createAdmin(t.db, 'alex', await hashPassword('correct horse'));
    await setupEnrolled(t, admin.id);
    const code = codeForStep(t, admin.id, 1);

    const r = await t.app.inject({ method: 'POST', url: '/api/v1/auth/token', payload: { username: 'alex', password: 'wrong', totp: code } });
    expect(r.statusCode).toBe(401);
    expect(r.json().error).toBe('unauthorized');
    expect(listAudit(t.db, { action: 'auth.login_failed' })).toHaveLength(1);
    expect(listAudit(t.db, { action: 'auth.totp_failed' })).toHaveLength(0);
  });
});
