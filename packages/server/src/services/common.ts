import type { AppContext } from '../http/context.js';
import type { Actor, Principal } from '../auth/principal.js';
import { accessFor } from '../auth/access.js';
import { getProjectBySlug, type ProjectRow } from '../repos/projects.js';
import { getWorkspaceById } from '../repos/workspaces.js';
import { AppError } from '../errors.js';
import { writeAudit, type AuditEntry } from '../repos/audit.js';

/** The project when the principal may see it; invisible and missing projects are both a 404. */
export function loadProjectFor(ctx: AppContext, principal: Principal, slug: string): ProjectRow {
  return accessFor(ctx.db, principal).project(getProjectBySlug(ctx.db, slug));
}

export type AuditInput = Omit<AuditEntry, 'actor_type' | 'actor_id' | 'ip' | 'user_agent'>;

/** Writes an audit row as the actor; while impersonating, the real user is recorded in `meta.impersonator`. */
export function auditAs(ctx: AppContext, actor: Actor, entry: AuditInput): void {
  const impersonator = actor.principal.impersonatorId;
  writeAudit(ctx.db, {
    ...entry,
    ...(impersonator !== null ? { meta: { ...(entry.meta ?? {}), impersonator } } : {}),
    actor_type: actor.principal.kind,
    actor_id: actor.principal.id,
    ip: actor.ip,
    user_agent: actor.userAgent,
  });
}

/** Memoised workspace id -> slug lookup for building payloads that carry the workspace slug. */
export function workspaceSlugResolver(ctx: AppContext): (id: number) => string {
  const cache = new Map<number, string>();
  return (id) => {
    let slug = cache.get(id);
    if (slug === undefined) {
      slug = getWorkspaceById(ctx.db, id)?.slug ?? '';
      cache.set(id, slug);
    }
    return slug;
  };
}

/** Credential and token management is refused while a super user is acting as someone else. */
export function assertNotImpersonating(principal: Principal): void {
  if (principal.impersonatorId !== null) throw new AppError(403, 'forbidden', 'not allowed while impersonating another user');
}
