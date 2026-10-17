import type { ProjectInput, ProjectPatch } from '@blindkey/shared';
import type { AppContext } from '../http/context.js';
import { assertScope, hasScope, type Actor, type Principal } from '../auth/principal.js';
import { ForbiddenError } from '../errors.js';
import { createProject, deleteProject, listProjects, updateProject } from '../repos/projects.js';
import { listDocuments } from '../repos/documents.js';
import { listSecrets } from '../repos/secrets.js';
import { addProjectToToken } from '../repos/tokens.js';
import { publicDocSummary, publicProject, publicSecret, type PublicDocSummary, type PublicProject, type PublicSecret } from '../http/serialize.js';
import { auditAs, loadProjectFor } from './common.js';

export interface ProjectDetail extends PublicProject {
  documents: PublicDocSummary[];
  secrets: PublicSecret[];
}

export function listProjectsFor(ctx: AppContext, principal: Principal): PublicProject[] {
  assertScope(principal, 'projects:read');
  return listProjects(ctx.db, principal.projectIds).map(publicProject);
}

export function getProjectDetailFor(ctx: AppContext, principal: Principal, slug: string): ProjectDetail {
  assertScope(principal, 'projects:read');
  const project = loadProjectFor(ctx, principal, slug);
  return {
    ...publicProject(project),
    documents: hasScope(principal, 'docs:read') ? listDocuments(ctx.db, project.id).map(publicDocSummary) : [],
    secrets: hasScope(principal, 'secrets:meta') ? listSecrets(ctx.db, ctx.ring, project.id).map(publicSecret) : [],
  };
}

/**
 * `admin`, or `projects:create` for a token. A project-scoped token that creates a project gets it
 * added to its own `project_ids` in the same transaction, so the creator can use it right away.
 */
export function createProjectFor(ctx: AppContext, actor: Actor, input: ProjectInput): PublicProject {
  const p = actor.principal;
  if (!hasScope(p, 'admin') && !hasScope(p, 'projects:create')) throw new ForbiddenError('projects:create');
  const grantToToken = p.kind === 'token' && p.projectIds !== null;
  const project = ctx.db.transaction(() => {
    const created = createProject(ctx.db, input);
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
    meta: { slug: project.slug, ...(grantToToken ? { granted_to_token: p.id } : {}) },
  });
  return publicProject(project);
}

/**
 * `projects:write` (spec §1.1) covers summary/tags/status/name for a project the token can
 * access; changing the slug stays `admin`-only, same as create/delete.
 */
export function updateProjectFor(ctx: AppContext, actor: Actor, slug: string, patch: ProjectPatch): PublicProject {
  if (patch.slug !== undefined) {
    assertScope(actor.principal, 'admin');
  } else if (!hasScope(actor.principal, 'admin') && !hasScope(actor.principal, 'projects:write')) {
    throw new ForbiddenError('projects:write');
  }
  const project = loadProjectFor(ctx, actor.principal, slug);
  const updated = updateProject(ctx.db, project.id, patch);
  // Only the keys actually provided — MCP's update_project passes every optional param, undefined or not.
  const providedFields = Object.keys(patch).filter((k) => patch[k as keyof ProjectPatch] !== undefined);
  auditAs(ctx, actor, { action: 'project.update', target_type: 'project', target_id: project.id, meta: { fields: providedFields } });
  return publicProject(updated);
}

export function deleteProjectFor(ctx: AppContext, actor: Actor, slug: string): void {
  assertScope(actor.principal, 'admin');
  const project = loadProjectFor(ctx, actor.principal, slug);
  deleteProject(ctx.db, project.id);
  auditAs(ctx, actor, { action: 'project.delete', target_type: 'project', target_id: project.id, meta: { slug } });
}
