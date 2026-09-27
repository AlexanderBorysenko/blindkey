import type { AuthTokenRequest, TokenInput } from '@pidb/shared';
import type { AppContext } from '../http/context.js';
import { assertScope, type Actor, type Principal } from '../auth/principal.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { createToken, listTokens, revokeToken, DAY_MS, type TokenKind, type TokenRow } from '../repos/tokens.js';
import { getProjectBySlug, listProjects } from '../repos/projects.js';
import { listAudit, writeAudit, type AuditQuery, type AuditRow } from '../repos/audit.js';
import { getAdminByUsername } from '../repos/admin.js';
import { verifyPassword } from '../crypto/passwords.js';
import { auditAs } from './common.js';
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
}

function publicToken(ctx: AppContext, t: TokenRow): PublicToken {
  const { project_ids, ...rest } = t;
  return { ...rest, projects: project_ids === null ? null : listProjects(ctx.db, project_ids).map((p) => p.slug) };
}

export function listTokensFor(ctx: AppContext, principal: Principal): PublicToken[] {
  assertScope(principal, 'admin');
  return listTokens(ctx.db).map((t) => publicToken(ctx, t));
}

export const DEFAULT_TOKEN_DAYS = 90;

export function createTokenFor(ctx: AppContext, actor: Actor, input: TokenInput): PublicToken & { token: string } {
  assertScope(actor.principal, 'admin');
  let projectIds: number[] | null = null;
  if (input.projects !== null) {
    projectIds = [];
    for (const slug of input.projects) {
      const p = getProjectBySlug(ctx.db, slug);
      if (!p) throw new ValidationError([{ path: ['projects'], message: `unknown project "${slug}"` }]);
      projectIds.push(p.id);
    }
  }
  const nowTs = Date.now();
  const expiresAt = input.expires_at === undefined ? nowTs + DEFAULT_TOKEN_DAYS * DAY_MS : input.expires_at;
  if (expiresAt !== null && expiresAt <= nowTs) {
    throw new ValidationError([{ path: ['expires_at'], message: 'must be in the future' }]);
  }
  const { token, row } = createToken(ctx.db, { name: input.name, scopes: input.scopes, projectIds, expiresAt });
  auditAs(ctx, actor, { action: 'token.create', target_type: 'token', target_id: row.id, meta: { name: row.name, scopes: row.scopes } });
  return { ...publicToken(ctx, row), token };
}

export function revokeTokenFor(ctx: AppContext, actor: Actor, id: number): void {
  assertScope(actor.principal, 'admin');
  if (!revokeToken(ctx.db, id)) throw new NotFoundError('token not found');
  auditAs(ctx, actor, { action: 'token.revoke', target_type: 'token', target_id: id });
}

export function listAuditFor(ctx: AppContext, principal: Principal, query: AuditQuery): AuditRow[] {
  assertScope(principal, 'admin');
  return listAudit(ctx.db, query);
}

export type ExchangeResult =
  | { ok: true; token: string; id: number; name: string; expires_at: number }
  | { ok: false; reason: 'invalid' | 'totp_required' | 'totp_locked' };

export async function exchangePassword(ctx: AppContext, input: AuthTokenRequest, ip: string, userAgent: string): Promise<ExchangeResult> {
  const admin = getAdminByUsername(ctx.db, input.username);
  const ok = admin ? await verifyPassword(admin.password_hash, input.password) : false;
  if (!admin || !ok) {
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
  const { token, row } = createToken(ctx.db, { name: input.name, scopes: ['admin'], projectIds: null, expiresAt: Date.now() + input.expires_days * DAY_MS });
  writeAudit(ctx.db, {
    actor_type: 'admin', actor_id: admin.id, action: 'auth.login', target_type: 'token', target_id: row.id, ip, user_agent: userAgent,
    meta: { name: row.name, ...(secondFactor ? { second_factor: secondFactor } : {}) },
  });
  return { ok: true, token, id: row.id, name: row.name, expires_at: row.expires_at as number };
}
