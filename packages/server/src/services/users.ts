import { z } from 'zod';
import type { AppContext } from '../http/context.js';
import { assertScope, type Actor, type Principal } from '../auth/principal.js';
import { ConflictError, NotFoundError, PermissionError, ValidationError } from '../errors.js';
import {
  countOtherEnabledSupers,
  createSession,
  createUser,
  deleteAllSessions,
  deleteSession,
  deleteUser,
  getUserById,
  listUsers,
  setAdminPasswordHash,
  setUserDisabled,
  setUserMustChangePassword,
  setUserSuper,
  type UserRow,
} from '../repos/admin.js';
import { revokeTokensForUser } from '../repos/tokens.js';
import { deleteApprovedConnectRequestsFor } from '../repos/connect.js';
import { deleteChallengesFor, deleteTwoFactor, getTotp, resetFactorFailures, savePendingTotp, setTwoFactorByAdmin } from '../repos/twofactor.js';
import { activatePendingEnrollment, pendingEnrollment } from './twofactor.js';
import { isTwoFactorByAdmin } from '../repos/twofactor.js';
import { generateTotpSecret } from '../auth/totp.js';
import { listOwnedWorkspaces, listOwnerIds } from '../repos/workspaces.js';
import { hashPassword } from '../crypto/passwords.js';
import { SESSION_TTL_MS } from '../ui/session.js';
import { auditAs } from './common.js';
import { validateNewPassword } from './password.js';

export const IMPERSONATION_TTL_MS = 2 * 60 * 60 * 1000;

const usernameSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9._@-]+$/, 'letters, digits and . _ @ - only');

export interface PublicUser {
  id: number;
  username: string;
  is_super: boolean;
  disabled: boolean;
  must_change_password: boolean;
  created_at: number;
}

function publicUser(u: UserRow): PublicUser {
  return { id: u.id, username: u.username, is_super: u.is_super, disabled: u.disabled_at !== null, must_change_password: u.must_change_password, created_at: u.created_at };
}

/** User management is for super users only (and, for a token, one carrying the `admin` scope). */
function assertSuper(principal: Principal): void {
  assertScope(principal, 'admin');
  if (!principal.isSuper) throw new PermissionError('super user');
}

function mustUser(ctx: AppContext, id: number): UserRow {
  const u = getUserById(ctx.db, id);
  if (!u) throw new NotFoundError('user not found');
  return u;
}

function mustValidPassword(password: string): void {
  const error = validateNewPassword(password);
  if (error) throw new ValidationError([{ path: ['password'], message: error }]);
}

export function listUsersFor(ctx: AppContext, principal: Principal): PublicUser[] {
  assertSuper(principal);
  return listUsers(ctx.db).map(publicUser);
}

/**
 * Creates a user with a temporary password they must change at their first login, plus a pending
 * two-factor enrollment the super user finishes (`confirmUserSetupFor`) with the user's phone.
 * Until then the user cannot log in at all.
 */
export async function createUserFor(ctx: AppContext, actor: Actor, input: { username: string; password: string }): Promise<PublicUser> {
  assertSuper(actor.principal);
  const name = usernameSchema.safeParse(input.username);
  if (!name.success) throw new ValidationError(name.error.issues);
  mustValidPassword(input.password);
  const hash = await hashPassword(input.password);
  const user = ctx.db.transaction(() => {
    const created = createUser(ctx.db, { username: name.data, passwordHash: hash, mustChangePassword: true });
    savePendingTotp(ctx.db, ctx.ring, created.id, generateTotpSecret());
    setTwoFactorByAdmin(ctx.db, created.id, true);
    return created;
  })();
  auditAs(ctx, actor, { action: 'user.create', target_type: 'user', target_id: user.id, meta: { username: user.username } });
  return publicUser(user);
}

/** Refuses to lock everybody out of user management: the target must not be the last enabled super user. */
function assertNotLastSuper(ctx: AppContext, target: UserRow): void {
  if (target.is_super && target.disabled_at === null && countOtherEnabledSupers(ctx.db, target.id) === 0) {
    throw new ConflictError('this is the last enabled super user');
  }
}

export function setUserDisabledFor(ctx: AppContext, actor: Actor, id: number, disabled: boolean): void {
  assertSuper(actor.principal);
  const target = mustUser(ctx, id);
  if (disabled) {
    if (target.id === actor.principal.userId) throw new ConflictError('you cannot disable yourself');
    assertNotLastSuper(ctx, target);
  }
  setUserDisabled(ctx.db, id, disabled);
  if (disabled) deleteApprovedConnectRequestsFor(ctx.db, id);
  auditAs(ctx, actor, { action: disabled ? 'user.disable' : 'user.enable', target_type: 'user', target_id: id, meta: { username: target.username } });
}

export function setUserSuperFor(ctx: AppContext, actor: Actor, id: number, isSuper: boolean): void {
  assertSuper(actor.principal);
  const target = mustUser(ctx, id);
  if (!isSuper) {
    if (target.id === actor.principal.userId) throw new ConflictError('you cannot demote yourself');
    assertNotLastSuper(ctx, target);
  }
  setUserSuper(ctx.db, id, isSuper);
  auditAs(ctx, actor, { action: isSuper ? 'user.promote' : 'user.demote', target_type: 'user', target_id: id, meta: { username: target.username } });
}

/**
 * Sets a new temporary password, forces a change at next login and signs the user out everywhere.
 * `revokeTokens` (default) also revokes all of the user's API and agent tokens, which a password change alone leaves working.
 */
export async function resetUserPasswordFor(ctx: AppContext, actor: Actor, id: number, password: string, revokeTokens = true): Promise<void> {
  assertSuper(actor.principal);
  const target = mustUser(ctx, id);
  mustValidPassword(password);
  const hash = await hashPassword(password);
  const revoked = ctx.db.transaction(() => {
    setAdminPasswordHash(ctx.db, id, hash);
    setUserMustChangePassword(ctx.db, id, true);
    deleteAllSessions(ctx.db, id);
    deleteChallengesFor(ctx.db, id);
    resetFactorFailures(ctx.db, id);
    deleteApprovedConnectRequestsFor(ctx.db, id);
    return revokeTokens ? revokeTokensForUser(ctx.db, id) : 0;
  })();
  auditAs(ctx, actor, { action: 'user.password_reset', target_type: 'user', target_id: id, meta: { username: target.username, tokens_revoked: revokeTokens ? revoked : false } });
}

/**
 * Removes the user's second factor, signs them out everywhere, revokes all their API and agent
 * tokens (they were minted under 2FA) and starts a fresh pending enrollment for a super user to
 * finish (`confirmUserSetupFor`). Until then the user cannot log in. Not for yourself: that would sign you out of the very page that finishes it.
 */
export function resetUserTwoFactorFor(ctx: AppContext, actor: Actor, id: number): void {
  assertSuper(actor.principal);
  const target = mustUser(ctx, id);
  if (target.id === actor.principal.userId) throw new ConflictError('use "Re-enroll" on your own two-factor page');
  const { revoked, sessions } = ctx.db.transaction(() => {
    deleteTwoFactor(ctx.db, id);
    deleteChallengesFor(ctx.db, id);
    savePendingTotp(ctx.db, ctx.ring, id, generateTotpSecret());
    setTwoFactorByAdmin(ctx.db, id, true);
    const deleted = deleteAllSessions(ctx.db, id);
    // approvals made under the old factor must not mint a token later
    deleteApprovedConnectRequestsFor(ctx.db, id);
    return { revoked: revokeTokensForUser(ctx.db, id), sessions: deleted };
  })();
  auditAs(ctx, actor, { action: 'user.2fa_reset', target_type: 'user', target_id: id, meta: { username: target.username, tokens_revoked: revoked, sessions_deleted: sessions } });
}

export interface UserSetup {
  username: string;
  secret: string;
  uri: string;
}

/** The pending enrollment a super user is setting up for `id`; null when there is none (nothing to continue). */
export function userSetupFor(ctx: AppContext, principal: Principal, id: number): UserSetup | null {
  assertSuper(principal);
  const target = mustUser(ctx, id);
  // Only an enrollment a super user started (new account, reset): never a user's own pending self-enrollment.
  if (!isTwoFactorByAdmin(ctx.db, id)) return null;
  const pending = pendingEnrollment(ctx, id, target.username);
  return pending ? { username: target.username, ...pending } : null;
}

/**
 * Confirms the pending enrollment of `id` with a code from the user's phone. On success the user can log in,
 * and the new recovery codes are returned for the super user to hand over (they are never stored or audited in clear).
 */
export async function confirmUserSetupFor(ctx: AppContext, actor: Actor, id: number, code: string): Promise<string[] | null> {
  assertSuper(actor.principal);
  const target = mustUser(ctx, id);
  const row = getTotp(ctx.db, id);
  if (!isTwoFactorByAdmin(ctx.db, id) || !row || row.enabled_at !== null) throw new ConflictError('there is no pending two-factor setup for this user');
  const codes = await activatePendingEnrollment(ctx, id, code);
  if (!codes) {
    auditAs(ctx, actor, { action: 'user.2fa_enroll_failed', target_type: 'user', target_id: id, meta: { username: target.username } });
    return null;
  }
  auditAs(ctx, actor, { action: 'user.2fa_enrolled_by_super', target_type: 'user', target_id: id, meta: { username: target.username } });
  return codes;
}

/** Deletes a user with their sessions, tokens and grants. Not yourself, not the last enabled super, not a sole workspace owner. */
export function deleteUserFor(ctx: AppContext, actor: Actor, id: number): void {
  assertSuper(actor.principal);
  const target = mustUser(ctx, id);
  if (target.id === actor.principal.userId) throw new ConflictError('you cannot delete yourself');
  assertNotLastSuper(ctx, target);
  const sole = listOwnedWorkspaces(ctx.db, id).find((w) => listOwnerIds(ctx.db, w.id).length === 1);
  if (sole) throw new ConflictError(`"${target.username}" is the only owner of workspace "${sole.slug}"; add another owner first`);
  deleteUser(ctx.db, id);
  auditAs(ctx, actor, { action: 'user.delete', target_type: 'user', target_id: id, meta: { username: target.username } });
}

/**
 * A super user (in a browser session, not already impersonating) acts as another user until they
 * stop: a new session for the target, remembering who is behind it. Ruling: only an enabled,
 * non-super user can be impersonated, so impersonation never grants user-management rights.
 * Returns the new session id.
 */
export function startImpersonation(ctx: AppContext, actor: Actor, targetId: number, currentSessionId?: string): string {
  const p = actor.principal;
  assertSuper(p);
  if (p.kind !== 'admin' || p.impersonatorId !== null) throw new PermissionError('super user session');
  const target = mustUser(ctx, targetId);
  if (target.id === p.userId) throw new ValidationError([{ path: ['user'], message: 'you cannot impersonate yourself' }]);
  if (target.is_super) throw new PermissionError('impersonate a non-super user');
  if (target.disabled_at !== null) throw new ValidationError([{ path: ['user'], message: 'user is disabled' }]);
  const session = createSession(ctx.db, target.id, IMPERSONATION_TTL_MS, actor.ip, actor.userAgent, p.userId);
  // The cookie is overwritten with the impersonation session, so the super user's own session row would only linger unused.
  if (currentSessionId) deleteSession(ctx.db, currentSessionId);
  auditAs(ctx, actor, { action: 'impersonate.start', target_type: 'user', target_id: target.id, meta: { username: target.username } });
  return session;
}

/**
 * Ends an impersonation: drops the impersonation session and returns a fresh session of the real user.
 * Written while still acting as the target, so the row carries `meta.impersonator`.
 */
export function stopImpersonation(ctx: AppContext, actor: Actor, sessionId: string): string {
  const p = actor.principal;
  if (p.kind !== 'admin' || p.impersonatorId === null) throw new NotFoundError('not impersonating');
  const real = getUserById(ctx.db, p.impersonatorId);
  // Only a still-enabled super user may come back; a demoted or disabled one gets no fresh session.
  if (!real || real.disabled_at !== null || !real.is_super) throw new NotFoundError('not impersonating');
  auditAs(ctx, actor, { action: 'impersonate.stop', target_type: 'user', target_id: p.userId });
  deleteSession(ctx.db, sessionId);
  return createSession(ctx.db, real.id, SESSION_TTL_MS, actor.ip, actor.userAgent);
}
