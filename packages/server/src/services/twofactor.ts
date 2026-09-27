import type { AppContext } from '../http/context.js';
import type { Actor } from '../auth/principal.js';
import { ConflictError } from '../errors.js';
import { hashPassword, verifyPassword } from '../crypto/passwords.js';
import {
  base32Encode, generateRecoveryCode, generateTotpSecret, normalizeRecoveryCode, otpauthUri, verifyTotp,
} from '../auth/totp.js';
import {
  claimTotpStep, deleteTwoFactor, enableTotp, getTotp, listUnusedRecoveryCodes, markRecoveryCodeUsed,
  openTotpSecret, replaceRecoveryCodes, savePendingTotp,
} from '../repos/twofactor.js';
import { auditAs } from './common.js';

export const CHALLENGE_TTL_MS = 300_000;
export const MAX_CHALLENGE_ATTEMPTS = 5;
export const RECOVERY_CODE_COUNT = 10;
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

export async function confirmEnrollment(ctx: AppContext, actor: Actor, code: string): Promise<string[] | null> {
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
  auditAs(ctx, actor, { action: 'auth.totp_enrolled' });
  return codes;
}

/**
 * Accepts a 6-digit TOTP code or a recovery code (case/space/dash-insensitive).
 * Records the used step / marks the recovery code used. Returns which factor matched.
 * Callers write the audit rows (they know the request's ip and user agent).
 */
export async function verifySecondFactor(ctx: AppContext, adminId: number, input: string): Promise<SecondFactor | null> {
  const row = getTotp(ctx.db, adminId);
  if (!row || row.enabled_at === null) return null;
  const trimmed = input.trim();
  if (/^\d{6}$/.test(trimmed)) {
    const step = verifyTotp(openTotpSecret(ctx.ring, row), trimmed, row.last_used_step);
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
