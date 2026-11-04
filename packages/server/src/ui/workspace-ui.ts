import type { AppContext } from '../http/context.js';
import type { Principal } from '../auth/principal.js';
import { accessFor } from '../auth/access.js';
import { getProjectBySlug } from '../repos/projects.js';
import { listOwnedWorkspaces, type WorkspaceRow } from '../repos/workspaces.js';
import { accessCandidatesFor } from '../services/workspaces.js';
import type { AccessEntry } from '../services/create-with-access.js';
import { activeWorkspace, body, list, str } from './forms.js';
import type { FastifyRequest } from 'fastify';

export { activeWorkspace };

export interface AccessField {
  members: string[];
  presets: { value: string; label: string }[];
}

const PRESETS: Record<'project' | 'secret' | 'document', { value: string; label: string }[]> = {
  project: [
    { value: 'all', label: 'All' },
    { value: 'cli', label: 'CLI only' },
    { value: 'read', label: 'Read only' },
  ],
  secret: [
    { value: 'all', label: 'All' },
    { value: 'cli', label: 'CLI only' },
    { value: 'read', label: 'Read only' },
  ],
  document: [
    { value: 'all', label: 'All' },
    { value: 'read', label: 'Read only' },
  ],
};

const PRESET_PERMS: Record<string, string[]> = {
  all: ['*'],
  cli: ['cli'],
  read: ['public.read', 'protected.read', 'docs.read'],
};

/** The "Access" field of a create form: the workspace's members. Null for non-owners (they skip it). */
export function accessFieldFor(ctx: AppContext, principal: Principal, workspaceId: number | undefined, kind: 'project' | 'secret' | 'document'): AccessField | null {
  if (workspaceId === undefined) return null;
  const members = accessCandidatesFor(ctx, principal, workspaceId);
  return members === null ? null : { members, presets: PRESETS[kind] };
}

/** Reads the create form's "Access" field: the ticked members, all with the chosen preset. */
export function accessEntries(req: FastifyRequest): AccessEntry[] {
  const b = body(req);
  const perms = PRESET_PERMS[str(b, 'access_preset', 'all')] ?? PRESET_PERMS.all!;
  return [...new Set(list(b, 'access_user'))].map((username) => ({ username, perms }));
}

/** Other workspaces the user owns, as targets for a move; empty unless they own `currentWorkspaceId` too. */
export function moveTargets(ctx: AppContext, principal: Principal, currentWorkspaceId: number): { slug: string; name: string }[] {
  const access = accessFor(ctx.db, principal);
  if (!access.owns(currentWorkspaceId)) return [];
  return listOwnedWorkspaces(ctx.db, principal.userId)
    .filter((w) => w.id !== currentWorkspaceId)
    .map((w) => ({ slug: w.slug, name: w.name }));
}

/** The workspace a project (or, with null, the globals of the active workspace) belongs to; null when it cannot be resolved. */
function scopeWorkspaceId(ctx: AppContext, principal: Principal, projectSlug: string | null): number | undefined {
  if (projectSlug !== null) return getProjectBySlug(ctx.db, projectSlug)?.workspace_id;
  return activeWorkspace(ctx, principal)?.id;
}

/** The "Access" field for a new secret or document in a project or in the active workspace's globals. */
export function scopeAccessField(ctx: AppContext, principal: Principal, projectSlug: string | null, kind: 'secret' | 'document'): AccessField | null {
  return accessFieldFor(ctx, principal, scopeWorkspaceId(ctx, principal, projectSlug), kind);
}

/** Move targets for a global item of the active workspace. */
export function globalMoveTargets(ctx: AppContext, principal: Principal): { slug: string; name: string }[] {
  const w = activeWorkspace(ctx, principal);
  return w ? moveTargets(ctx, principal, w.id) : [];
}
