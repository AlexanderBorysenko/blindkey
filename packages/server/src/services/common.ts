import type { AppContext } from '../http/context.js';
import { canAccessProject, type Actor, type Principal } from '../auth/principal.js';
import { NotFoundError } from '../errors.js';
import { getProjectBySlug, type ProjectRow } from '../repos/projects.js';
import { writeAudit, type AuditEntry } from '../repos/audit.js';

export function loadProjectFor(ctx: AppContext, principal: Principal, slug: string): ProjectRow {
  const project = getProjectBySlug(ctx.db, slug);
  if (!project || !canAccessProject(principal, project.id)) throw new NotFoundError('project not found');
  return project;
}

export type AuditInput = Omit<AuditEntry, 'actor_type' | 'actor_id' | 'ip' | 'user_agent'>;

export function auditAs(ctx: AppContext, actor: Actor, entry: AuditInput): void {
  writeAudit(ctx.db, {
    ...entry,
    actor_type: actor.principal.kind,
    actor_id: actor.principal.id,
    ip: actor.ip,
    user_agent: actor.userAgent,
  });
}
