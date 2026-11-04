import { createHash } from 'node:crypto';
import type { AppContext } from '../http/context.js';
import type { Actor, Principal } from '../auth/principal.js';
import { AppError, ConflictError } from '../errors.js';
import { hashPassword, verifyPassword } from '../crypto/passwords.js';
import {
  base32Encode, generateRecoveryCode, generateTotpSecret, normalizeRecoveryCode, otpauthUri, verifyTotp,
} from '../auth/totp.js';
import {
  type TotpRow, claimTotpStep, enableTotp, isTwoFactorByAdmin, replaceTotpSecret, setTwoFactorByAdmin, factorLockedUntil, getTotp, listUnusedRecoveryCodes, markRecoveryCodeUsed,
  openTotpSecret, recordFactorFailure, replaceRecoveryCodes, resetFactorFailures, savePendingTotp,
} from '../repos/twofactor.js';
import { open, seal } from '../crypto/envelope.js';
import { writeAudit } from '../repos/audit.js';
import { deleteOtherSessions } from '../repos/admin.js';
import { assertNotImpersonating, auditAs } from './common.js';

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

export const TOTP_SETUP_REQUIRED = 'totp_setup_required';

/** Two-factor is mandatory: tokens (admin, agent) are only ever minted for a user who has finished enrollment. */
export function assertTwoFactorEnabled(ctx: AppContext, userId: number): void {
  if (!isTotpEnabled(ctx, userId)) {
    throw new AppError(403, TOTP_SETUP_REQUIRED, 'two-factor authentication must be set up first');
  }
}

/** `principal`, when the call comes from a request, is refused while impersonating. */
export function startEnrollment(ctx: AppContext, adminId: number, principal?: Principal): void {
  if (principal) assertNotImpersonating(principal);
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
 * Enables a user's pending enrollment when `code` matches and returns the fresh recovery codes
 * (null when there is no pending enrollment or the code is wrong). No audit rows: callers write theirs.
 */
export async function activatePendingEnrollment(ctx: AppContext, adminId: number, code: string): Promise<string[] | null> {
  const row = getTotp(ctx.db, adminId);
  if (!row || row.enabled_at !== null) return null;
  const step = verifyTotp(openTotpSecret(ctx.ring, row), code.trim(), row.last_used_step);
  if (step === null) return null;
  enableTotp(ctx.db, adminId, step);
  setTwoFactorByAdmin(ctx.db, adminId, false);
  return newRecoveryCodes(ctx, adminId);
}

/**
 * Enables a pending enrollment when `code` matches. With `keepSessionId` (the UI session that
 * enrolled), every other session of the admin is signed out (spec §2.3).
 */
export async function confirmEnrollment(ctx: AppContext, actor: Actor, code: string, keepSessionId?: string): Promise<string[] | null> {
  assertNotImpersonating(actor.principal);
  const adminId = actor.principal.id;
  const codes = await activatePendingEnrollment(ctx, adminId, code);
  if (!codes) {
    const row = getTotp(ctx.db, adminId);
    if (row && row.enabled_at === null) auditAs(ctx, actor, { action: 'auth.totp_failed', meta: { during: 'enrollment' } });
    return null;
  }
  const revoked = keepSessionId === undefined ? undefined : deleteOtherSessions(ctx.db, adminId, keepSessionId);
  auditAs(ctx, actor, { action: 'auth.totp_enrolled', ...(revoked === undefined ? {} : { meta: { revoked_sessions: revoked } }) });
  return codes;
}

/** True while a super user is setting up this user's two-factor: such a user cannot log in until it is confirmed. */
export function isLoginBlockedBySetup(ctx: AppContext, adminId: number): boolean {
  return !isTotpEnabled(ctx, adminId) && isTwoFactorByAdmin(ctx.db, adminId);
}

export const REENROLL_TTL_MS = 10 * 60_000;
/**
 * The token is bound to the secret it was issued against (a hash of the stored ciphertext, which changes with every
 * secret replacement): once a re-enrollment is confirmed, that token and every older one stop opening.
 */
const reenrollAad = (adminId: number, expiresAt: number, current: Buffer) =>
  `totp-reenroll:${adminId}:${expiresAt}:${createHash('sha256').update(current).digest('hex')}`;

/**
 * Starts a re-enrollment of an enabled factor. Nothing is stored: the new secret travels in the
 * page as an opaque token (sealed under the master key, bound to the admin and an expiry), so the
 * old secret keeps working until `confirmReenrollment` sees a code from the new one.
 */
export function beginReenrollment(ctx: AppContext, actor: Actor, username: string): { token: string; secret: string; uri: string } {
  assertNotImpersonating(actor.principal);
  const adminId = actor.principal.id;
  if (!isTotpEnabled(ctx, adminId)) throw new ConflictError('two-factor authentication is not on yet');
  const current = getTotp(ctx.db, adminId);
  if (!current) throw new ConflictError('two-factor authentication is not on yet');
  const secret = generateTotpSecret();
  const expiresAt = Date.now() + REENROLL_TTL_MS;
  const version = ctx.ring.current;
  const key = ctx.ring.keys.get(version);
  if (!key) throw new Error(`no master key for version ${version}`);
  const sealed = seal(key, secret, reenrollAad(adminId, expiresAt, current.secret_enc));
  return { token: `${version}.${expiresAt}.${sealed.toString('base64url')}`, secret: base32Encode(secret), uri: otpauthUri(username, secret) };
}

function openReenrollToken(ctx: AppContext, adminId: number, token: string): Buffer | null {
  const [v, e, blob] = token.split('.');
  const version = Number(v);
  const expiresAt = Number(e);
  const current = getTotp(ctx.db, adminId);
  const key = ctx.ring.keys.get(version);
  if (!current || !key || !blob || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) return null;
  try {
    return open(key, Buffer.from(blob, 'base64url'), reenrollAad(adminId, expiresAt, current.secret_enc));
  } catch {
    return null;
  }
}

/** The pending replacement secret of a re-enrollment token (for redisplay after a wrong code), or null when invalid or expired. */
export function reenrollmentSecret(ctx: AppContext, adminId: number, token: string, username: string): { secret: string; uri: string } | null {
  const secret = openReenrollToken(ctx, adminId, token);
  return secret ? { secret: base32Encode(secret), uri: otpauthUri(username, secret) } : null;
}

/**
 * Replaces the secret with the one in `token` when `code` is a valid code of it: new recovery codes,
 * every other session signed out. Returns the new recovery codes, or null for a bad token or code.
 */
export async function confirmReenrollment(ctx: AppContext, actor: Actor, token: string, code: string, keepSessionId: string): Promise<string[] | null> {
  assertNotImpersonating(actor.principal);
  const adminId = actor.principal.id;
  if (!isTotpEnabled(ctx, adminId)) return null;
  const secret = openReenrollToken(ctx, adminId, token);
  const step = secret ? verifyTotp(secret, code.trim(), 0) : null;
  if (!secret || step === null) {
    auditAs(ctx, actor, { action: 'auth.totp_failed', meta: { during: 're-enrollment' } });
    return null;
  }
  replaceTotpSecret(ctx.db, ctx.ring, adminId, secret, step);
  const codes = await newRecoveryCodes(ctx, adminId);
  const revoked = deleteOtherSessions(ctx.db, adminId, keepSessionId);
  auditAs(ctx, actor, { action: 'auth.totp_reenrolled', meta: { revoked_sessions: revoked } });
  return codes;
}

/** Epoch ms until which the admin's second factor is locked after too many wrong codes, or null. */
export function isSecondFactorLocked(ctx: AppContext, adminId: number): number | null {
  return factorLockedUntil(ctx.db, adminId, Date.now());
}

async function matchSecondFactor(ctx: AppContext, row: TotpRow, input: string, totpOnly: boolean): Promise<SecondFactor | null> {
  const adminId = row.admin_id;
  const trimmed = input.trim();
  const digits = trimmed.replace(/\s+/g, '');
  if (/^\d{6}$/.test(digits)) {
    const step = verifyTotp(openTotpSecret(ctx.ring, row), digits, row.last_used_step);
    return step !== null && claimTotpStep(ctx.db, adminId, step) ? 'totp' : null;
  }
  if (totpOnly) return null;
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
 * Accepts a 6-digit TOTP code (whitespace ignored, e.g. `123 456`) or a recovery code (case/space/dash-insensitive).
 * Records the used step / marks the recovery code used. Returns which factor matched.
 * While the admin is locked out it returns null without checking the input. Every failure is
 * counted; the MAX_FACTOR_FAILURES-th locks the factor for FACTOR_LOCK_MS (audited as
 * auth.totp_locked). Callers write the per-request audit rows (they know the ip and user agent).
 */
export async function verifySecondFactor(ctx: AppContext, adminId: number, input: string, opts: { totpOnly?: boolean } = {}): Promise<SecondFactor | null> {
  const row = getTotp(ctx.db, adminId);
  if (!row || row.enabled_at === null) return null;
  if (isSecondFactorLocked(ctx, adminId) !== null) return null;
  const used = await matchSecondFactor(ctx, row, input, opts.totpOnly === true);
  if (used) {
    resetFactorFailures(ctx.db, adminId);
    return used;
  }
  const { locked, until } = recordFactorFailure(ctx.db, adminId, MAX_FACTOR_FAILURES, FACTOR_LOCK_MS, Date.now());
  if (locked) writeAudit(ctx.db, { actor_type: 'admin', actor_id: adminId, action: 'auth.totp_locked', meta: { until } });
  return null;
}

export async function regenerateRecoveryCodes(ctx: AppContext, actor: Actor): Promise<string[]> {
  assertNotImpersonating(actor.principal);
  const codes = await newRecoveryCodes(ctx, actor.principal.id);
  auditAs(ctx, actor, { action: 'auth.recovery_regenerated' });
  return codes;
}

export function countUnusedRecoveryCodes(ctx: AppContext, adminId: number): number {
  return listUnusedRecoveryCodes(ctx.db, adminId).length;
}
