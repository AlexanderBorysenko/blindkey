import type { ProjectCreate, ProjectPatch } from '@blindkey/shared';
import type { AppContext } from '../http/context.js';
import { assertScope, hasScope, type Actor, type Principal } from '../auth/principal.js';
import { accessFor, hasPerm } from '../auth/access.js';
import { ForbiddenError, PermissionError } from '../errors.js';
import { createProject, deleteProject, getProjectBySlug, updateProject, type ProjectRow } from '../repos/projects.js';
import { listDocuments } from '../repos/documents.js';
import { listSecrets } from '../repos/secrets.js';
import { addProjectToToken } from '../repos/tokens.js';
import { publicDocSummary, publicProject, publicSecret, type PublicDocSummary, type PublicProject, type PublicSecret, type PublicWorkspace } from '../http/serialize.js';
import { auditAs, loadProjectFor, workspaceSlugResolver } from './common.js';

export interface ProjectDetail extends PublicProject {
  documents: PublicDocSummary[];
  secrets: PublicSecret[];
}

export function listProjectsFor(ctx: AppContext, principal: Principal): PublicProject[] {
  assertScope(principal, 'projects:read');
  const slugOf = workspaceSlugResolver(ctx);
  return accessFor(ctx.db, principal)
    .visibleProjects()
    .map((p) => publicProject(p, slugOf(p.workspace_id)));
}

/** Workspaces the principal can see, with their role. Needs `projects:read` like the project list. */
export function listWorkspacesFor(ctx: AppContext, principal: Principal): PublicWorkspace[] {
  assertScope(principal, 'projects:read');
  const access = accessFor(ctx.db, principal);
  return access.visibleWorkspaces().map((w) => ({ slug: w.slug, name: w.name, role: access.role(w.id) }));
}

export function getProjectDetailFor(ctx: AppContext, principal: Principal, slug: string): ProjectDetail {
  assertScope(principal, 'projects:read');
  const project = loadProjectFor(ctx, principal, slug);
  const access = accessFor(ctx.db, principal);
  const showValues = hasScope(principal, 'secrets:meta') || hasScope(principal, 'secrets:reveal');
  return {
    ...publicProject(project, workspaceSlugResolver(ctx)(project.workspace_id)),
    documents: hasScope(principal, 'docs:read') ? listDocuments(ctx.db, project.id).filter((d) => access.docVisible(d)).map(publicDocSummary) : [],
    secrets: hasScope(principal, 'secrets:meta')
      ? listSecrets(ctx.db, ctx.ring, project.id)
          .filter((s) => access.secretVisible(s))
          .map((s) => publicSecret(s, showValues && hasPerm(access.secretPerms(s), 'public.read')))
      : [],
  };
}

/**
 * `admin`, or `projects:create` for a token; the user must also own the target workspace (named by
 * `input.workspace`, else the only workspace they own). A project-scoped token that creates a
 * project gets it added to its own `project_ids` in the same transaction, so the creator can use it right away.
 */
export function createProjectFor(ctx: AppContext, actor: Actor, input: ProjectCreate): PublicProject {
  const p = actor.principal;
  if (!hasScope(p, 'admin') && !hasScope(p, 'projects:create')) throw new ForbiddenError('projects:create');
  const access = accessFor(ctx.db, p);
  const workspace = access.resolveProjectWorkspace(input.workspace);
  access.assertOwner(workspace);
  const { workspace: _workspace, ...projectInput } = input;
  const grantToToken = p.kind === 'token' && p.projectIds !== null;
  const project = ctx.db.transaction(() => {
    const created = createProject(ctx.db, projectInput, workspace.id);
    if (grantToToken) addProjectToToken(ctx.db, p.id, created.id);
    return created;
  })();
  // The principal is rebuilt from the database on every request, so later requests (including later
  // MCP tool calls) see the new project anyway; this only keeps the rest of *this* request consistent.
  if (grantToToken && !p.projectIds!.includes(project.id)) p.projectIds!.push(project.id);
  auditAs(ctx, actor, {
    action: 'project.create',
    target_type: 'project',
    target_id: project.id,
    workspace_id: workspace.id,
    meta: { slug: project.slug, ...(grantToToken ? { granted_to_token: p.id } : {}) },
  });
  return publicProject(project, workspace.slug);
}

/**
 * `projects:write` (spec §1.1) covers summary/tags/status/name for a project the caller can reach,
 * as a workspace owner or with a project grant that includes `docs.write`; changing the slug
 * stays `admin`-only and owner-only, same as create/delete.
 */
export function updateProjectFor(ctx: AppContext, actor: Actor, slug: string, patch: ProjectPatch): PublicProject {
  if (patch.slug !== undefined) {
    assertScope(actor.principal, 'admin');
  } else if (!hasScope(actor.principal, 'admin') && !hasScope(actor.principal, 'projects:write')) {
    throw new ForbiddenError('projects:write');
  }
  const access = accessFor(ctx.db, actor.principal);
  const project = access.project(getProjectBySlug(ctx.db, slug));
  if (patch.slug !== undefined) {
    if (!access.owns(project.workspace_id)) throw new PermissionError('workspace owner');
  } else if (!access.owns(project.workspace_id) && !hasPerm(access.projectPerms(project), 'docs.write')) {
    throw new PermissionError('docs.write');
  }
  const updated = updateProject(ctx.db, project.id, patch);
  // Only the keys actually provided — MCP's update_project passes every optional param, undefined or not.
  const providedFields = Object.keys(patch).filter((k) => patch[k as keyof ProjectPatch] !== undefined);
  auditAs(ctx, actor, { action: 'project.update', target_type: 'project', target_id: project.id, workspace_id: project.workspace_id, meta: { fields: providedFields } });
  return publicProject(updated, workspaceSlugResolver(ctx)(updated.workspace_id));
}

export function deleteProjectFor(ctx: AppContext, actor: Actor, slug: string): void {
  assertScope(actor.principal, 'admin');
  const project: ProjectRow = loadProjectFor(ctx, actor.principal, slug);
  if (!accessFor(ctx.db, actor.principal).owns(project.workspace_id)) throw new PermissionError('workspace owner');
  deleteProject(ctx.db, project.id);
  auditAs(ctx, actor, { action: 'project.delete', target_type: 'project', target_id: project.id, workspace_id: project.workspace_id, meta: { slug } });
}
