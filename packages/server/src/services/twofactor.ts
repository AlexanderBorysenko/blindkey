import type { AppContext } from '../http/context.js';
import type { Actor } from '../auth/principal.js';
import { ConflictError } from '../errors.js';
import { hashPassword, verifyPassword } from '../crypto/passwords.js';
import {
  base32Encode, generateRecoveryCode, generateTotpSecret, normalizeRecoveryCode, otpauthUri, verifyTotp,
} from '../auth/totp.js';
import {
  type TotpRow, claimTotpStep, deleteTwoFactor, enableTotp, factorLockedUntil, getTotp, listUnusedRecoveryCodes, markRecoveryCodeUsed,
  openTotpSecret, recordFactorFailure, replaceRecoveryCodes, resetFactorFailures, savePendingTotp,
} from '../repos/twofactor.js';
import { writeAudit } from '../repos/audit.js';
import { deleteOtherSessions } from '../repos/admin.js';
import { auditAs } from './common.js';

export const CHALLENGE_TTL_MS = 300_000;
export const MAX_CHALLENGE_ATTEMPTS = 5;
export const RECOVERY_CODE_COUNT = 10;
/** Persistent per-admin cap on wrong second-factor codes (spec §2.4). */
export const MAX_FACTOR_FAILURES = 10;
export const FACTOR_LOCK_MS = 15 * 60_000;
export type SecondFactor = 'totp' | 'recovery';

export function isTotpEnabled(ctx: AppContext, adminId: number): boolean {
  return getTotp(ctx.db, adminId)?.enabled_at != null;
}

export function startEnrollment(ctx: AppContext, adminId: number): void {
  if (isTotpEnabled(ctx, adminId)) throw new ConflictError('two-factor authentication is already on');
  savePendingTotp(ctx.db, ctx.ring, adminId, generateTotpSecret());
}

export function pendingEnrollment(ctx: AppContext, adminId: number, username: string): { secret: string; uri: string } | null {
  const row = getTotp(ctx.db, adminId);
  if (!row || row.enabled_at !== null) return null;
  const secret = openTotpSecret(ctx.ring, row);
  return { secret: base32Encode(secret), uri: otpauthUri(username, secret) };
}

async function newRecoveryCodes(ctx: AppContext, adminId: number): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => generateRecoveryCode());
  replaceRecoveryCodes(ctx.db, adminId, await Promise.all(codes.map((c) => hashPassword(c))));
  return codes;
}

/**
 * Enables a pending enrollment when `code` matches. With `keepSessionId` (the UI session that
 * enrolled), every other session of the admin is signed out (spec §2.3).
 */
export async function confirmEnrollment(ctx: AppContext, actor: Actor, code: string, keepSessionId?: string): Promise<string[] | null> {
  const adminId = actor.principal.id;
  const row = getTotp(ctx.db, adminId);
  if (!row || row.enabled_at !== null) return null;
  const step = verifyTotp(openTotpSecret(ctx.ring, row), code.trim(), row.last_used_step);
  if (step === null) {
    auditAs(ctx, actor, { action: 'auth.totp_failed', meta: { during: 'enrollment' } });
    return null;
  }
  enableTotp(ctx.db, adminId, step);
  const codes = await newRecoveryCodes(ctx, adminId);
  const revoked = keepSessionId === undefined ? undefined : deleteOtherSessions(ctx.db, adminId, keepSessionId);
  auditAs(ctx, actor, { action: 'auth.totp_enrolled', ...(revoked === undefined ? {} : { meta: { revoked_sessions: revoked } }) });
  return codes;
}

/** Epoch ms until which the admin's second factor is locked after too many wrong codes, or null. */
export function isSecondFactorLocked(ctx: AppContext, adminId: number): number | null {
  return factorLockedUntil(ctx.db, adminId, Date.now());
}

async function matchSecondFactor(ctx: AppContext, row: TotpRow, input: string): Promise<SecondFactor | null> {
  const adminId = row.admin_id;
  const trimmed = input.trim();
  const digits = trimmed;
  if (/^\d{6}$/.test(digits)) {
    const step = verifyTotp(openTotpSecret(ctx.ring, row), digits, row.last_used_step);
    return step !== null && claimTotpStep(ctx.db, adminId, step) ? 'totp' : null;
  }
  const normalized = normalizeRecoveryCode(trimmed);
  if (!normalized) return null;
  for (const rc of listUnusedRecoveryCodes(ctx.db, adminId)) {
    if (await verifyPassword(rc.code_hash, normalized)) {
      return markRecoveryCodeUsed(ctx.db, rc.id) ? 'recovery' : null;
    }
  }
  return null;
}

/**
 * Accepts a 6-digit TOTP code or a recovery code (case/space/dash-insensitive).
 * Records the used step / marks the recovery code used. Returns which factor matched.
 * While the admin is locked out it returns null without checking the input. Every failure is
 * counted; the MAX_FACTOR_FAILURES-th locks the factor for FACTOR_LOCK_MS (audited as
 * auth.totp_locked). Callers write the per-request audit rows (they know the ip and user agent).
 */
export async function verifySecondFactor(ctx: AppContext, adminId: number, input: string): Promise<SecondFactor | null> {
  const row = getTotp(ctx.db, adminId);
  if (!row || row.enabled_at === null) return null;
  if (isSecondFactorLocked(ctx, adminId) !== null) return null;
  const used = await matchSecondFactor(ctx, row, input);
  if (used) {
    resetFactorFailures(ctx.db, adminId);
    return used;
  }
  const { locked, until } = recordFactorFailure(ctx.db, adminId, MAX_FACTOR_FAILURES, FACTOR_LOCK_MS, Date.now());
  if (locked) writeAudit(ctx.db, { actor_type: 'admin', actor_id: adminId, action: 'auth.totp_locked', meta: { until } });
  return null;
}

export async function regenerateRecoveryCodes(ctx: AppContext, actor: Actor): Promise<string[]> {
  const codes = await newRecoveryCodes(ctx, actor.principal.id);
  auditAs(ctx, actor, { action: 'auth.recovery_regenerated' });
  return codes;
}

export function disableTwoFactor(ctx: AppContext, actor: Actor): void {
  deleteTwoFactor(ctx.db, actor.principal.id);
  auditAs(ctx, actor, { action: 'auth.totp_disabled' });
}

export function countUnusedRecoveryCodes(ctx: AppContext, adminId: number): number {
  return listUnusedRecoveryCodes(ctx.db, adminId).length;
}
