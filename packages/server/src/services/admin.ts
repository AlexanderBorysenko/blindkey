import type { AuthTokenRequest, TokenInput } from '@pidb/shared';
import type { AppContext } from '../http/context.js';
import { assertScope, type Actor, type Principal } from '../auth/principal.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { createToken, listTokens, revokeToken, type TokenRow } from '../repos/tokens.js';
import { getProjectBySlug, listProjects } from '../repos/projects.js';
import { listAudit, writeAudit, type AuditQuery, type AuditRow } from '../repos/audit.js';
import { getAdminByUsername } from '../repos/admin.js';
import { verifyPassword } from '../crypto/passwords.js';
import { auditAs } from './common.js';

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
}

function publicToken(ctx: AppContext, t: TokenRow): PublicToken {
  const { project_ids, ...rest } = t;
  return { ...rest, projects: project_ids === null ? null : listProjects(ctx.db, project_ids).map((p) => p.slug) };
}

export function listTokensFor(ctx: AppContext, principal: Principal): PublicToken[] {
  assertScope(principal, 'admin');
  return listTokens(ctx.db).map((t) => publicToken(ctx, t));
}

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
  const { token, row } = createToken(ctx.db, { name: input.name, scopes: input.scopes, projectIds, expiresAt: input.expires_at });
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

export async function exchangePassword(
  ctx: AppContext,
  input: AuthTokenRequest,
  ip: string,
  userAgent: string,
): Promise<{ token: string; id: number; name: string } | null> {
  const admin = getAdminByUsername(ctx.db, input.username);
  const ok = admin ? await verifyPassword(admin.password_hash, input.password) : false;
  if (!admin || !ok) {
    writeAudit(ctx.db, { actor_type: 'admin', actor_id: admin?.id ?? null, action: 'auth.login_failed', ip, user_agent: userAgent, meta: { username: input.username } });
    return null;
  }
  const { token, row } = createToken(ctx.db, { name: input.name, scopes: ['admin'], projectIds: null, expiresAt: null });
  writeAudit(ctx.db, { actor_type: 'admin', actor_id: admin.id, action: 'auth.login', target_type: 'token', target_id: row.id, ip, user_agent: userAgent, meta: { name: row.name } });
  return { token, id: row.id, name: row.name };
}
