import type { AppContext } from '../http/context.js';
import type { Principal } from '../auth/principal.js';
import { accessFor, hasPerm } from '../auth/access.js';
import { getProjectBySlug } from '../repos/projects.js';
import { getDocument } from '../repos/documents.js';
import { resolveDocScope } from '../services/documents.js';
import { findVisibleSecretFor } from '../services/secrets.js';
import { activeWorkspace } from './forms.js';

/**
 * What the logged-in user may do on a page, computed from the same `Access` rules the services enforce, so the UI
 * hides controls that would only answer 403. The services stay the authority; these flags are presentation only.
 */

export interface CreateCaps {
  canCreateSecret: boolean;
  canCreateDoc: boolean;
}

export interface ProjectCaps extends CreateCaps {
  canEdit: boolean;
  canDelete: boolean;
}

export interface SecretCaps {
  canEdit: boolean;
  canDelete: boolean;
  canReveal: boolean;
}

export interface DocCaps {
  canEdit: boolean;
  canDelete: boolean;
}

/** New secret / document in a project (needs a project grant) or in the active workspace's globals (owners only). */
export function createCaps(ctx: AppContext, principal: Principal, projectSlug: string | null): CreateCaps {
  const access = accessFor(ctx.db, principal);
  if (projectSlug === null) {
    const w = activeWorkspace(ctx, principal);
    const owner = w !== null && access.owns(w.id);
    return { canCreateSecret: owner, canCreateDoc: owner };
  }
  const project = getProjectBySlug(ctx.db, projectSlug);
  if (!project) return { canCreateSecret: false, canCreateDoc: false };
  const perms = access.projectPerms(project);
  return {
    canCreateSecret: hasPerm(perms, 'public.write') || hasPerm(perms, 'protected.write'),
    canCreateDoc: hasPerm(perms, 'docs.write'),
  };
}

export function projectCaps(ctx: AppContext, principal: Principal, projectSlug: string): ProjectCaps {
  const access = accessFor(ctx.db, principal);
  const project = getProjectBySlug(ctx.db, projectSlug);
  if (!project) return { canEdit: false, canDelete: false, canCreateSecret: false, canCreateDoc: false };
  const owner = access.owns(project.workspace_id);
  return {
    canEdit: owner || hasPerm(access.projectPerms(project), 'docs.write'),
    canDelete: owner,
    ...createCaps(ctx, principal, projectSlug),
  };
}

export function secretCaps(ctx: AppContext, principal: Principal, projectSlug: string | null, name: string): SecretCaps {
  const none = { canEdit: false, canDelete: false, canReveal: false };
  const secret = findVisibleSecretFor(ctx, principal, projectSlug, name);
  if (!secret) return none;
  const perms = accessFor(ctx.db, principal).secretPerms(secret);
  return {
    canEdit: hasPerm(perms, 'public.write') || hasPerm(perms, 'protected.write'),
    canDelete: hasPerm(perms, 'protected.write'),
    canReveal: hasPerm(perms, 'protected.read'),
  };
}

export function docCaps(ctx: AppContext, principal: Principal, projectSlug: string | null, slug: string): DocCaps {
  const scope = resolveDocScope(ctx, principal, projectSlug);
  const doc = getDocument(ctx.db, scope.project?.id ?? null, slug, scope.workspaceId);
  const write = doc !== null && hasPerm(accessFor(ctx.db, principal).docPerms(doc), 'docs.write');
  return { canEdit: write, canDelete: write };
}
