import type { AppContext } from '../http/context.js';
import type { Actor } from '../auth/principal.js';
import { getAdminById, setAdminPasswordHash, deleteOtherSessions } from '../repos/admin.js';
import { hashPassword, verifyPassword } from '../crypto/passwords.js';
import { isSecondFactorLocked, isTotpEnabled, verifySecondFactor } from './twofactor.js';
import { factorLockedMessage } from '../ui/routes/auth.js';
import { auditAs } from './common.js';

/** Shared by the UI form and the `passwd` shell command (spec §1.1). */
export function validateNewPassword(pw: string): string | null {
  if (pw.length < 12) return 'Password must be at least 12 characters.';
  if (pw.length > 1024) return 'Password must be at most 1024 characters.';
  return null;
}

export interface ChangePasswordInput {
  current: string;
  next: string;
  confirm: string;
  code: string;
}

export type ChangePasswordResult = { ok: true; sessionsRevoked: number } | { ok: false; status: 400 | 429; error: string };

/**
 * Re-authenticates with the current password (and, when 2FA is on, a fresh code) before
 * accepting a new one. Order (spec §1.2, reordered per fix-round-1 controller ruling):
 *   1. locked second factor → 429, before anything else is checked (no password oracle
 *      during a lock — Review Focus 2).
 *   2. form validation — `next !== confirm`, `validateNewPassword`, `next === current` — each
 *      → 400 with its message. These compare only the fields the caller submitted (no lookup,
 *      no oracle), so running them before re-auth means a typo in `confirm` never spends a TOTP
 *      step or a recovery code.
 *   3. re-auth: wrong password, or (with 2FA on) a wrong/missing code → 400, one generic message
 *      so the form never reveals which half was wrong (Review Focus 1: an empty code is a wrong
 *      code, never skipped).
 *   4. success.
 * On success, every OTHER session of the admin is revoked; `keepSessionId` (the caller's own
 * session) survives. API tokens are independent credentials and are never touched here.
 */
export async function changePassword(
  ctx: AppContext,
  actor: Actor,
  input: ChangePasswordInput,
  keepSessionId: string,
): Promise<ChangePasswordResult> {
  const adminId = actor.principal.id;
  const admin = getAdminById(ctx.db, adminId);
  if (!admin) throw new Error('admin not found');

  const totpOn = isTotpEnabled(ctx, adminId);
  if (totpOn) {
    const lockedUntil = isSecondFactorLocked(ctx, adminId);
    if (lockedUntil !== null) return { ok: false, status: 429, error: factorLockedMessage(lockedUntil) };
  }

  if (input.next !== input.confirm) return { ok: false, status: 400, error: 'New passwords do not match.' };
  const validationError = validateNewPassword(input.next);
  if (validationError) return { ok: false, status: 400, error: validationError };
  if (input.next === input.current) return { ok: false, status: 400, error: 'New password must differ from the current one.' };

  const passwordOk = await verifyPassword(admin.password_hash, input.current);
  const factorOk = totpOn ? (passwordOk && (await verifySecondFactor(ctx, adminId, input.code)) !== null) : true;
  if (!passwordOk || !factorOk) {
    auditAs(ctx, actor, { action: 'auth.password_change_failed', meta: { via: 'ui' } });
    return { ok: false, status: 400, error: 'Current password or code is incorrect.' };
  }

  const hash = await hashPassword(input.next);
  const sessionsRevoked = ctx.db.transaction(() => {
    setAdminPasswordHash(ctx.db, adminId, hash);
    const revoked = deleteOtherSessions(ctx.db, adminId, keepSessionId);
    auditAs(ctx, actor, { action: 'auth.password_changed', meta: { via: 'ui', sessions_revoked: revoked } });
    return revoked;
  })();
  return { ok: true, sessionsRevoked };
}
