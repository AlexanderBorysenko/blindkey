import type { AuthTokenRequest, TokenInput } from '@blindkey/shared';
import type { AppContext } from '../http/context.js';
import { assertScope, type Actor, type Principal } from '../auth/principal.js';
import { accessFor, type Access } from '../auth/access.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { createToken, getTokenById, listTokensForUser, revokeToken, setTokenLabel, setTokenProjects, DAY_MS, type TokenKind, type TokenRow } from '../repos/tokens.js';
import { listApprovedConnectRequests } from '../repos/connect.js';
import { getProjectBySlug, listProjects } from '../repos/projects.js';
import { listAudit, writeAudit, type AuditQuery, type AuditRow } from '../repos/audit.js';
import { getAdminByUsername } from '../repos/admin.js';
import { verifyPassword } from '../crypto/passwords.js';
import { assertNotImpersonating, auditAs } from './common.js';
import { mustChangePassword } from './password.js';
import { isSecondFactorLocked, isTotpEnabled, verifySecondFactor, type SecondFactor } from './twofactor.js';

export interface PublicToken {
  id: number;
  name: string;
  prefix: string;
  scopes: TokenRow['scopes'];
  projects: string[] | null;
  expires_at: number | null;
  last_used_at: number | null;
  revoked_at: number | null;
  created_at: number;
  kind: TokenKind;
  label: string | null;
}

function publicToken(ctx: AppContext, t: TokenRow): PublicToken {
  const { project_ids, ...rest } = t;
  return { ...rest, projects: project_ids === null ? null : listProjects(ctx.db, project_ids).map((p) => p.slug) };
}

/** Tokens are personal: everybody lists, creates, renames and revokes only their own. */
export function listTokensFor(ctx: AppContext, principal: Principal): PublicToken[] {
  assertScope(principal, 'admin');
  return listTokensForUser(ctx.db, principal.userId).map((t) => publicToken(ctx, t));
}

/** A token of the caller's; someone else's token is a 404, same as a missing one. */
function ownTokenId(ctx: AppContext, principal: Principal, id: number): number {
  const t = getTokenById(ctx.db, id);
  if (!t || t.user_id !== principal.userId) throw new NotFoundError('token not found');
  return t.id;
}

/**
 * Project slugs -> ids for a token. Only projects the user can see qualify, and a token minted by a
 * project-restricted token cannot reach beyond that token's own projects. Unknown and invisible
 * slugs give the same error.
 */
function tokenProjectIds(ctx: AppContext, access: Access, projects: string[] | null): number[] | null {
  const restrictedTo = access.principal.projectIds;
  if (projects === null) {
    if (restrictedTo !== null) throw new ValidationError([{ path: ['projects'], message: 'this token cannot create an all-projects token' }]);
    return null;
  }
  const ids: number[] = [];
  for (const slug of new Set(projects)) {
    const p = getProjectBySlug(ctx.db, slug);
    if (!p || !access.projectVisible(p)) throw new ValidationError([{ path: ['projects'], message: `unknown project "${slug}"` }]);
    ids.push(p.id);
  }
  return ids;
}

export const DEFAULT_TOKEN_DAYS = 90;

export function createTokenFor(ctx: AppContext, actor: Actor, input: TokenInput): PublicToken & { token: string } {
  assertScope(actor.principal, 'admin');
  assertNotImpersonating(actor.principal);
  const projectIds = tokenProjectIds(ctx, accessFor(ctx.db, actor.principal), input.projects);
  const nowTs = Date.now();
  const expiresAt = input.expires_at === undefined ? nowTs + DEFAULT_TOKEN_DAYS * DAY_MS : input.expires_at;
  if (expiresAt !== null && expiresAt <= nowTs) {
    throw new ValidationError([{ path: ['expires_at'], message: 'must be in the future' }]);
  }
  const { token, row } = createToken(ctx.db, { userId: actor.principal.userId, name: input.name, scopes: input.scopes, projectIds, expiresAt });
  auditAs(ctx, actor, { action: 'token.create', target_type: 'token', target_id: row.id, meta: { name: row.name, scopes: row.scopes } });
  return { ...publicToken(ctx, row), token };
}

/** An approved device-flow request whose token the agent has not picked up yet (it is minted on the agent's next poll). */
export interface PendingAgentToken {
  name: string;
  scopes: string[];
  projects: string[];
  expires_at: number;
}

export function listPendingAgentTokensFor(ctx: AppContext, principal: Principal): PendingAgentToken[] {
  assertScope(principal, 'admin');
  return listApprovedConnectRequests(ctx.db, principal.userId).map((r) => ({
    name: r.name,
    scopes: r.approved_scopes ?? [],
    projects: listProjects(ctx.db, r.approved_project_ids ?? []).map((p) => p.slug),
    expires_at: r.expires_at,
  }));
}

export const TOKEN_LABEL_MAX = 100;

/** Trimmed label, or null for blank; longer than TOKEN_LABEL_MAX is a validation error. */
export function parseTokenLabel(raw: string): string | null {
  const label = raw.trim().replace(/\s+/g, ' ');
  if (label.length > TOKEN_LABEL_MAX) throw new ValidationError([{ path: ['label'], message: `at most ${TOKEN_LABEL_MAX} characters` }]);
  return label || null;
}

/** Renames a token for display (its `name`, used to supersede agent sessions, never changes). Blank clears it. */
export function renameTokenFor(ctx: AppContext, actor: Actor, id: number, rawLabel: string): void {
  assertScope(actor.principal, 'admin');
  assertNotImpersonating(actor.principal);
  const label = parseTokenLabel(rawLabel);
  if (!setTokenLabel(ctx.db, ownTokenId(ctx, actor.principal, id), label)) throw new NotFoundError('token not found');
  auditAs(ctx, actor, { action: 'token.rename', target_type: 'token', target_id: id, meta: { label } });
}

/** Replaces which projects an active token can reach; `null` = all projects. */
export function updateTokenProjectsFor(ctx: AppContext, actor: Actor, id: number, projects: string[] | null): void {
  assertScope(actor.principal, 'admin');
  assertNotImpersonating(actor.principal);
  const tokenId = ownTokenId(ctx, actor.principal, id);
  const projectIds = tokenProjectIds(ctx, accessFor(ctx.db, actor.principal), projects);
  if (!setTokenProjects(ctx.db, tokenId, projectIds)) throw new NotFoundError('token not found or revoked');
  auditAs(ctx, actor, { action: 'token.update_projects', target_type: 'token', target_id: id, meta: { projects } });
}

export function revokeTokenFor(ctx: AppContext, actor: Actor, id: number): void {
  assertScope(actor.principal, 'admin');
  assertNotImpersonating(actor.principal);
  if (!revokeToken(ctx.db, ownTokenId(ctx, actor.principal, id))) throw new NotFoundError('token not found');
  auditAs(ctx, actor, { action: 'token.revoke', target_type: 'token', target_id: id });
}

export function listAuditFor(ctx: AppContext, principal: Principal, query: AuditQuery): AuditRow[] {
  assertScope(principal, 'admin');
  // Super users see everything; everyone else their own actions and the rows of workspaces they own.
  const visibleTo = principal.isSuper ? undefined : { userId: principal.userId, ownedWorkspaceIds: accessFor(ctx.db, principal).ownedWorkspaceIds() };
  return listAudit(ctx.db, { ...query, visibleTo });
}

export type ExchangeResult =
  | { ok: true; token: string; id: number; name: string; expires_at: number }
  | { ok: false; reason: 'invalid' | 'totp_required' | 'totp_locked' | 'password_change_required' };

export async function exchangePassword(ctx: AppContext, input: AuthTokenRequest, ip: string, userAgent: string): Promise<ExchangeResult> {
  const admin = getAdminByUsername(ctx.db, input.username);
  const ok = admin ? await verifyPassword(admin.password_hash, input.password) : false;
  // A disabled user fails like a wrong password.
  if (!admin || !ok || admin.disabled_at !== null) {
    writeAudit(ctx.db, { actor_type: 'admin', actor_id: admin?.id ?? null, action: 'auth.login_failed', ip, user_agent: userAgent, meta: { username: input.username } });
    return { ok: false, reason: 'invalid' };
  }
  let secondFactor: SecondFactor | undefined;
  if (isTotpEnabled(ctx, admin.id)) {
    // spec §2: written as soon as the password verifies for a 2FA admin, before the lock and
    // code checks, so the operator can see the password is known even when every code guess fails.
    writeAudit(ctx.db, { actor_type: 'admin', actor_id: admin.id, action: 'auth.password_ok', ip, user_agent: userAgent, meta: { via: 'api' } });
    if (isSecondFactorLocked(ctx, admin.id) !== null) return { ok: false, reason: 'totp_locked' };
    if (input.totp === undefined) return { ok: false, reason: 'totp_required' };
    const used = await verifySecondFactor(ctx, admin.id, input.totp);
    if (!used) {
      writeAudit(ctx.db, { actor_type: 'admin', actor_id: admin.id, action: 'auth.totp_failed', ip, user_agent: userAgent, meta: { via: 'api' } });
      return { ok: false, reason: 'invalid' };
    }
    if (used === 'recovery') writeAudit(ctx.db, { actor_type: 'admin', actor_id: admin.id, action: 'auth.recovery_used', ip, user_agent: userAgent, meta: { via: 'api' } });
    secondFactor = used;
  }
  // A temporary / reset password only opens the browser's change-password page; no API token comes of it.
  if (mustChangePassword(ctx, admin.id)) {
    writeAudit(ctx.db, { actor_type: 'admin', actor_id: admin.id, action: 'auth.login_blocked', ip, user_agent: userAgent, meta: { via: 'api', reason: 'password_change_required' } });
    return { ok: false, reason: 'password_change_required' };
  }
  const { token, row } = createToken(ctx.db, { userId: admin.id, name: input.name, scopes: ['admin'], projectIds: null, expiresAt: Date.now() + input.expires_days * DAY_MS });
  writeAudit(ctx.db, {
    actor_type: 'admin', actor_id: admin.id, action: 'auth.login', target_type: 'token', target_id: row.id, ip, user_agent: userAgent,
    meta: { name: row.name, ...(secondFactor ? { second_factor: secondFactor } : {}) },
  });
  return { ok: true, token, id: row.id, name: row.name, expires_at: row.expires_at as number };
}
