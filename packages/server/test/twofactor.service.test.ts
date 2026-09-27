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
});
