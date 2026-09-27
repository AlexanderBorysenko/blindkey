import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { openDb } from '../src/db/connection.js';
import type { KeyRing } from '../src/config.js';
import type { AppContext } from '../src/http/context.js';
import type { Actor } from '../src/auth/principal.js';
import { createAdmin } from '../src/repos/admin.js';
import { getTotp, openTotpSecret } from '../src/repos/twofactor.js';
import { hotp, stepAt } from '../src/auth/totp.js';
import { ConflictError } from '../src/errors.js';
import { listAudit } from '../src/repos/audit.js';
import {
  isTotpEnabled,
  startEnrollment,
  pendingEnrollment,
  confirmEnrollment,
  verifySecondFactor,
  regenerateRecoveryCodes,
  disableTwoFactor,
  countUnusedRecoveryCodes,
  isSecondFactorLocked,
  MAX_FACTOR_FAILURES,
  FACTOR_LOCK_MS,
} from '../src/services/twofactor.js';

function setup() {
  const db = openDb(':memory:');
  const ring: KeyRing = { current: 1, keys: new Map([[1, randomBytes(32)]]) };
  const ctx: AppContext = { db, ring, logLevel: 'silent' };
  const admin = createAdmin(db, 'alex', 'hash');
  const actor: Actor = { principal: { kind: 'admin', id: admin.id, scopes: ['admin'], projectIds: null }, ip: '1.1.1.1', userAgent: 't' };
  return { db, ring, ctx, admin, actor };
}

function codeForStep(ctx: AppContext, adminId: number, deltaSteps: number): string {
  const secret = openTotpSecret(ctx.ring, getTotp(ctx.db, adminId)!);
  return hotp(secret, stepAt(Date.now()) + deltaSteps);
}

describe('twofactor service', () => {
  it('isTotpEnabled: false before enrollment, false after startEnrollment only, true after confirmEnrollment', async () => {
    const { ctx, admin, actor } = setup();
    expect(isTotpEnabled(ctx, admin.id)).toBe(false);
    startEnrollment(ctx, admin.id);
    expect(isTotpEnabled(ctx, admin.id)).toBe(false);
    const code = codeForStep(ctx, admin.id, 0);
    const codes = await confirmEnrollment(ctx, actor, code);
    expect(codes).not.toBeNull();
    expect(isTotpEnabled(ctx, admin.id)).toBe(true);
  });

  it('confirmEnrollment: wrong code -> null, still disabled; correct code -> 10 recovery codes and audit auth.totp_enrolled', async () => {
    const { ctx, admin, actor } = setup();
    startEnrollment(ctx, admin.id);
    const wrong = await confirmEnrollment(ctx, actor, '000000');
    expect(wrong).toBeNull();
    expect(isTotpEnabled(ctx, admin.id)).toBe(false);

    const code = codeForStep(ctx, admin.id, 0);
    const codes = await confirmEnrollment(ctx, actor, code);
    expect(codes).not.toBeNull();
    expect(codes).toHaveLength(10);
    for (const c of codes!) expect(c).toMatch(/^[a-hjkmnp-z2-9]{5}-[a-hjkmnp-z2-9]{5}$/);
    expect(listAudit(ctx.db, { action: 'auth.totp_enrolled' })).toHaveLength(1);
  });

  it('startEnrollment throws ConflictError when 2FA is already enabled', async () => {
    const { ctx, admin, actor } = setup();
    startEnrollment(ctx, admin.id);
    const code = codeForStep(ctx, admin.id, 0);
    await confirmEnrollment(ctx, actor, code);
    expect(() => startEnrollment(ctx, admin.id)).toThrow(ConflictError);
  });

  it('pendingEnrollment returns the secret and uri while pending, null once enabled or absent', async () => {
    const { ctx, admin, actor } = setup();
    expect(pendingEnrollment(ctx, admin.id, 'alex')).toBeNull();
    startEnrollment(ctx, admin.id);
    const pending = pendingEnrollment(ctx, admin.id, 'alex');
    expect(pending).not.toBeNull();
    expect(pending!.uri).toContain('otpauth://totp/');
    const code = codeForStep(ctx, admin.id, 0);
    await confirmEnrollment(ctx, actor, code);
    expect(pendingEnrollment(ctx, admin.id, 'alex')).toBeNull();
  });

  it('verifySecondFactor: totp for step +1, replay rejected, recovery code case/dash-insensitive then single-use', async () => {
    const { ctx, admin, actor } = setup();
    startEnrollment(ctx, admin.id);
    const codes = (await confirmEnrollment(ctx, actor, codeForStep(ctx, admin.id, 0)))!;

    const nextCode = codeForStep(ctx, admin.id, 1);
    expect(await verifySecondFactor(ctx, admin.id, nextCode)).toBe('totp');
    expect(await verifySecondFactor(ctx, admin.id, nextCode)).toBeNull();

    const recovery = codes[0]!;
    const shouted = recovery.toUpperCase().replace('-', '');
    expect(await verifySecondFactor(ctx, admin.id, shouted)).toBe('recovery');
    expect(await verifySecondFactor(ctx, admin.id, shouted)).toBeNull();

    // the service writes no audit rows itself
    expect(listAudit(ctx.db, { action: 'auth.totp_failed' })).toHaveLength(0);
    expect(listAudit(ctx.db, { action: 'auth.recovery_used' })).toHaveLength(0);
  });

  it('regenerateRecoveryCodes: 10 new codes, old ones no longer verify, audit auth.recovery_regenerated', async () => {
    const { ctx, admin, actor } = setup();
    startEnrollment(ctx, admin.id);
    const oldCodes = (await confirmEnrollment(ctx, actor, codeForStep(ctx, admin.id, 0)))!;

    const newCodes = await regenerateRecoveryCodes(ctx, actor);
    expect(newCodes).toHaveLength(10);
    expect(await verifySecondFactor(ctx, admin.id, oldCodes[0]!)).toBeNull();
    expect(await verifySecondFactor(ctx, admin.id, newCodes[0]!)).toBe('recovery');
    expect(listAudit(ctx.db, { action: 'auth.recovery_regenerated' })).toHaveLength(1);
  });

  it('disableTwoFactor: isTotpEnabled false, getTotp null, audit auth.totp_disabled', async () => {
    const { ctx, admin, actor } = setup();
    startEnrollment(ctx, admin.id);
    await confirmEnrollment(ctx, actor, codeForStep(ctx, admin.id, 0));
    expect(countUnusedRecoveryCodes(ctx, admin.id)).toBe(10);

    disableTwoFactor(ctx, actor);
    expect(isTotpEnabled(ctx, admin.id)).toBe(false);
    expect(getTotp(ctx.db, admin.id)).toBeNull();
    expect(listAudit(ctx.db, { action: 'auth.totp_disabled' })).toHaveLength(1);
  });

  // F1: persistent per-admin second-factor lockout.
  function lockState(ctx: AppContext, adminId: number): { failed_count: number; locked_until: number | null } {
    return ctx.db.prepare(`SELECT failed_count, locked_until FROM admin_totp WHERE admin_id = ?`).get(adminId) as { failed_count: number; locked_until: number | null };
  }

  async function enrolled() {
    const s = setup();
    startEnrollment(s.ctx, s.admin.id);
    const codes = (await confirmEnrollment(s.ctx, s.actor, codeForStep(s.ctx, s.admin.id, 0)))!;
    return { ...s, codes };
  }

  it('lockout: constants are 10 failures / 15 minutes', () => {
    expect(MAX_FACTOR_FAILURES).toBe(10);
    expect(FACTOR_LOCK_MS).toBe(15 * 60_000);
  });

  it('lockout: 10 wrong codes lock the admin; the correct code is then rejected; auth.totp_locked is audited', async () => {
    const { ctx, admin } = await enrolled();
    for (let i = 0; i < 9; i++) expect(await verifySecondFactor(ctx, admin.id, '000000')).toBeNull();
    expect(lockState(ctx, admin.id).failed_count).toBe(9);
    expect(isSecondFactorLocked(ctx, admin.id)).toBeNull();
    const before = Date.now();
    expect(await verifySecondFactor(ctx, admin.id, '000000')).toBeNull();
    const until = isSecondFactorLocked(ctx, admin.id);
    expect(until).not.toBeNull();
    expect(until!).toBeGreaterThanOrEqual(before + FACTOR_LOCK_MS);
    expect(lockState(ctx, admin.id)).toEqual({ failed_count: 0, locked_until: until });

    const locked = listAudit(ctx.db, { action: 'auth.totp_locked' });
    expect(locked).toHaveLength(1);
    expect(locked[0]!.actor_type).toBe('admin');
    expect(locked[0]!.actor_id).toBe(admin.id);
    expect(locked[0]!.meta).toEqual({ until });

    // 11th attempt with the correct code: still rejected, and not consumed or counted.
    const good = codeForStep(ctx, admin.id, 1);
    expect(await verifySecondFactor(ctx, admin.id, good)).toBeNull();
    expect(lockState(ctx, admin.id)).toEqual({ failed_count: 0, locked_until: until });
    expect(listAudit(ctx.db, { action: 'auth.totp_locked' })).toHaveLength(1);
  });

  it('lockout: a recovery code is also rejected while locked', async () => {
    const { ctx, admin, codes } = await enrolled();
    for (let i = 0; i < MAX_FACTOR_FAILURES; i++) await verifySecondFactor(ctx, admin.id, '000000');
    expect(await verifySecondFactor(ctx, admin.id, codes[0]!)).toBeNull();
    expect(countUnusedRecoveryCodes(ctx, admin.id)).toBe(10);
  });

  it('lockout: once locked_until has passed, the correct code works again and failed_count is 0', async () => {
    const { ctx, admin } = await enrolled();
    for (let i = 0; i < MAX_FACTOR_FAILURES; i++) await verifySecondFactor(ctx, admin.id, '000000');
    expect(isSecondFactorLocked(ctx, admin.id)).not.toBeNull();
    ctx.db.prepare(`UPDATE admin_totp SET locked_until = ? WHERE admin_id = ?`).run(Date.now() - 1, admin.id);
    expect(isSecondFactorLocked(ctx, admin.id)).toBeNull();
    await verifySecondFactor(ctx, admin.id, '000000');
    expect(lockState(ctx, admin.id).failed_count).toBe(1);
    expect(await verifySecondFactor(ctx, admin.id, codeForStep(ctx, admin.id, 1))).toBe('totp');
    expect(lockState(ctx, admin.id).failed_count).toBe(0);
  });

  it('lockout: a success resets the failure count', async () => {
    const { ctx, admin } = await enrolled();
    for (let i = 0; i < MAX_FACTOR_FAILURES - 1; i++) await verifySecondFactor(ctx, admin.id, '000000');
    expect(await verifySecondFactor(ctx, admin.id, codeForStep(ctx, admin.id, 1))).toBe('totp');
    expect(lockState(ctx, admin.id).failed_count).toBe(0);
    for (let i = 0; i < MAX_FACTOR_FAILURES - 1; i++) await verifySecondFactor(ctx, admin.id, '000000');
    expect(isSecondFactorLocked(ctx, admin.id)).toBeNull();
  });

  it('lockout: malformed input counts as a failure', async () => {
    const { ctx, admin } = await enrolled();
    await verifySecondFactor(ctx, admin.id, 'not a code');
    expect(lockState(ctx, admin.id).failed_count).toBe(1);
  });

  it('lockout: confirmEnrollment failures are not counted', async () => {
    const { ctx, admin, actor } = setup();
    startEnrollment(ctx, admin.id);
    for (let i = 0; i < MAX_FACTOR_FAILURES + 2; i++) expect(await confirmEnrollment(ctx, actor, '000000')).toBeNull();
    expect(lockState(ctx, admin.id).failed_count).toBe(0);
    expect(await confirmEnrollment(ctx, actor, codeForStep(ctx, admin.id, 0))).not.toBeNull();
    expect(isSecondFactorLocked(ctx, admin.id)).toBeNull();
  });

  it('lockout: disableTwoFactor clears the lock (the row is deleted)', async () => {
    const { ctx, admin, actor } = await enrolled();
    for (let i = 0; i < MAX_FACTOR_FAILURES; i++) await verifySecondFactor(ctx, admin.id, '000000');
    expect(isSecondFactorLocked(ctx, admin.id)).not.toBeNull();
    disableTwoFactor(ctx, actor);
    expect(isSecondFactorLocked(ctx, admin.id)).toBeNull();
  });
});
