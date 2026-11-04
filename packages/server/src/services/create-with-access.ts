import type { DocumentInput, GrantTargetType, ProjectCreate, SecretInput } from '@blindkey/shared';
import type { AppContext } from '../http/context.js';
import type { Actor } from '../auth/principal.js';
import { accessFor } from '../auth/access.js';
import { NotFoundError } from '../errors.js';
import { getProjectBySlug } from '../repos/projects.js';
import { getSecretMeta } from '../repos/secrets.js';
import { getDocument } from '../repos/documents.js';
import { getUserByUsername } from '../repos/admin.js';
import { isOwner } from '../repos/workspaces.js';
import type { PublicDoc, PublicProject, PublicSecret } from '../http/serialize.js';
import { createProjectFor } from './projects.js';
import { createSecretFor } from './secrets.js';
import { writeDocumentFor } from './documents.js';
import { permsForTarget, setGrantFor } from './workspaces.js';

/** A user to give access to a new item, with raw perms (wildcards allowed; dropped where they do not apply). */
export interface AccessEntry {
  username: string;
  perms: readonly string[];
}

/**
 * Gives each listed user a grant on the new item. Workspace owners are skipped (they always have access);
 * an unknown or disabled user fails the whole call, so the caller's transaction rolls the item back too.
 */
function grantAll(ctx: AppContext, actor: Actor, workspaceSlug: string, workspaceId: number, type: GrantTargetType, targetId: number, entries: readonly AccessEntry[]): void {
  for (const e of entries) {
    const user = getUserByUsername(ctx.db, e.username);
    if (user && isOwner(ctx.db, workspaceId, user.id)) continue;
    setGrantFor(ctx, actor, workspaceSlug, e.username, { type, id: targetId }, permsForTarget(type, e.perms));
  }
}

/** Where a new secret or document lands: the project's workspace, or the active one for globals. */
function scopeFor(ctx: AppContext, actor: Actor, projectSlug: string | null): { projectId: number | null; workspaceId: number; workspaceSlug: string } {
  const access = accessFor(ctx.db, actor.principal);
  if (projectSlug !== null) {
    const p = access.project(getProjectBySlug(ctx.db, projectSlug));
    const w = ctx.db.prepare(`SELECT slug FROM workspaces WHERE id = ?`).get(p.workspace_id) as { slug: string };
    return { projectId: p.id, workspaceId: p.workspace_id, workspaceSlug: w.slug };
  }
  const w = access.resolveGlobalWorkspace(null);
  return { projectId: null, workspaceId: w.id, workspaceSlug: w.slug };
}

export function createProjectWithAccess(ctx: AppContext, actor: Actor, input: ProjectCreate, entries: readonly AccessEntry[]): PublicProject {
  return ctx.db.transaction(() => {
    const project = createProjectFor(ctx, actor, input);
    if (entries.length > 0) {
      const row = getProjectBySlug(ctx.db, project.slug);
      if (!row) throw new NotFoundError('project not found');
      grantAll(ctx, actor, project.workspace, row.workspace_id, 'project', row.id, entries);
    }
    return project;
  })();
}

export function createSecretWithAccess(ctx: AppContext, actor: Actor, projectSlug: string | null, input: SecretInput, entries: readonly AccessEntry[]): PublicSecret {
  return ctx.db.transaction(() => {
    const created = createSecretFor(ctx, actor, projectSlug, input);
    if (entries.length > 0) {
      const scope = scopeFor(ctx, actor, projectSlug);
      const row = getSecretMeta(ctx.db, ctx.ring, scope.projectId, created.name, scope.workspaceId);
      if (!row) throw new NotFoundError('secret not found');
      grantAll(ctx, actor, scope.workspaceSlug, scope.workspaceId, 'secret', row.id, entries);
    }
    return created;
  })();
}

/** Grants are only given when the document is new; an existing one keeps the access it has. */
export function writeDocumentWithAccess(ctx: AppContext, actor: Actor, projectSlug: string | null, slug: string, input: DocumentInput, entries: readonly AccessEntry[]): { doc: PublicDoc; created: boolean } {
  return ctx.db.transaction(() => {
    const result = writeDocumentFor(ctx, actor, projectSlug, slug, input);
    if (result.created && entries.length > 0) {
      const scope = scopeFor(ctx, actor, projectSlug);
      const row = getDocument(ctx.db, scope.projectId, result.doc.slug, scope.workspaceId);
      if (!row) throw new NotFoundError('document not found');
      grantAll(ctx, actor, scope.workspaceSlug, scope.workspaceId, 'document', row.id, entries);
    }
    return result;
  })();
}
