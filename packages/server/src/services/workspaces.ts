import { DOC_PERMS, PERMS, SECRET_PERMS, normalizePerms, slugSchema, type GrantTargetType, type Perm } from '@blindkey/shared';
import type { AppContext } from '../http/context.js';
import { assertScope, type Actor, type Principal } from '../auth/principal.js';
import { accessFor } from '../auth/access.js';
import { ConflictError, NotFoundError, ValidationError } from '../errors.js';
import { deleteGrant, listGrantsForUserInWorkspace, listGrantsForWorkspace, upsertGrant, type GrantRow } from '../repos/grants.js';
import { getProjectBySlug, getProjectById, moveProject } from '../repos/projects.js';
import { getSecretMeta, getSecretMetaById, moveGlobalSecret } from '../repos/secrets.js';
import { getDocument, moveGlobalDocument } from '../repos/documents.js';
import { getUserById, getUserByUsername } from '../repos/admin.js';
import { addOwner, createWorkspace, getWorkspaceById, listOwnerIds, removeOwner, updateWorkspace, type WorkspaceRow } from '../repos/workspaces.js';
import { publicProject, type PublicProject, type PublicWorkspace } from '../http/serialize.js';
import { auditAs } from './common.js';

/** `Team Alpha` -> `team-alpha`; the result must still pass the slug schema. */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/, '');
  const r = slugSchema.safeParse(slug);
  if (!r.success) throw new ValidationError([{ path: ['name'], message: 'cannot derive a workspace slug from this name; pass one' }]);
  return r.data;
}

function cleanName(name: string): string {
  const n = name.trim();
  if (n.length < 1 || n.length > 200) throw new ValidationError([{ path: ['name'], message: 'must be 1-200 characters' }]);
  return n;
}

/** The workspace, for a caller who owns it. Management is structural, so it needs the `admin` scope too. */
export function ownedWorkspace(ctx: AppContext, principal: Principal, slug: string): WorkspaceRow {
  assertScope(principal, 'admin');
  const access = accessFor(ctx.db, principal);
  const w = access.workspaceBySlug(slug);
  access.assertOwner(w);
  return w;
}

/** Any user may create a workspace and becomes its owner. */
export function createWorkspaceFor(ctx: AppContext, actor: Actor, input: { name: string; slug?: string }): PublicWorkspace {
  assertScope(actor.principal, 'admin');
  const name = cleanName(input.name);
  const slug = input.slug === undefined ? slugify(name) : input.slug;
  if (!slugSchema.safeParse(slug).success) throw new ValidationError([{ path: ['slug'], message: 'slug must be lowercase letters, digits and dashes' }]);
  const w = ctx.db.transaction(() => {
    const created = createWorkspace(ctx.db, { slug, name });
    addOwner(ctx.db, created.id, actor.principal.userId);
    return created;
  })();
  auditAs(ctx, actor, { action: 'workspace.create', target_type: 'workspace', target_id: w.id, workspace_id: w.id, meta: { slug: w.slug } });
  return { slug: w.slug, name: w.name, role: 'owner' };
}

/** Renames a workspace the caller owns (display name, optionally its slug). */
export function renameWorkspaceFor(ctx: AppContext, actor: Actor, slug: string, patch: { name?: string; slug?: string }): PublicWorkspace {
  const w = ownedWorkspace(ctx, actor.principal, slug);
  const changes: { name?: string; slug?: string } = {};
  if (patch.name !== undefined) changes.name = cleanName(patch.name);
  if (patch.slug !== undefined) {
    if (!slugSchema.safeParse(patch.slug).success) throw new ValidationError([{ path: ['slug'], message: 'slug must be lowercase letters, digits and dashes' }]);
    changes.slug = patch.slug;
  }
  const updated = updateWorkspace(ctx.db, w.id, changes);
  auditAs(ctx, actor, { action: 'workspace.rename', target_type: 'workspace', target_id: w.id, workspace_id: w.id, meta: { fields: Object.keys(changes), from: w.slug } });
  return { slug: updated.slug, name: updated.name, role: 'owner' };
}

/** Unknown and disabled users are the same 404, so usernames cannot be probed through this. */
function enabledUser(ctx: AppContext, username: string): { id: number; username: string } {
  const u = getUserByUsername(ctx.db, username);
  if (!u || u.disabled_at !== null) throw new NotFoundError('user not found');
  return { id: u.id, username: u.username };
}

/** Owners look up the person to add by their exact username (no listing, no partial matches). */
export function searchUsersFor(ctx: AppContext, principal: Principal, query: string): { username: string }[] {
  assertScope(principal, 'admin');
  if (!accessFor(ctx.db, principal).ownedWorkspaceIds().length) throw new NotFoundError('user not found');
  const user = enabledUser(ctx, query.trim());
  return [{ username: user.username }];
}

export function addWorkspaceOwnerFor(ctx: AppContext, actor: Actor, slug: string, username: string): void {
  const w = ownedWorkspace(ctx, actor.principal, slug);
  const user = enabledUser(ctx, username);
  if (!addOwner(ctx.db, w.id, user.id)) throw new ConflictError(`"${user.username}" already owns this workspace`);
  auditAs(ctx, actor, { action: 'workspace.owner_add', target_type: 'user', target_id: user.id, workspace_id: w.id, meta: { username: user.username } });
}

export function removeWorkspaceOwnerFor(ctx: AppContext, actor: Actor, slug: string, username: string): void {
  const w = ownedWorkspace(ctx, actor.principal, slug);
  const user = getUserByUsername(ctx.db, username);
  ctx.db.transaction(() => {
    const owners = listOwnerIds(ctx.db, w.id);
    if (!user || !owners.includes(user.id)) throw new NotFoundError('owner not found');
    if (owners.length <= 1) throw new ConflictError('a workspace needs at least one owner');
    removeOwner(ctx.db, w.id, user.id);
  })();
  auditAs(ctx, actor, { action: 'workspace.owner_remove', target_type: 'user', target_id: user!.id, workspace_id: w.id, meta: { username: user!.username } });
}

export interface GrantTarget {
  type: GrantTargetType;
  id: number;
}

/** The workspace a grant target lives in, or null when the target does not exist. */
function targetWorkspaceId(ctx: AppContext, target: GrantTarget): number | null {
  if (target.type === 'project') return getProjectById(ctx.db, target.id)?.workspace_id ?? null;
  if (target.type === 'secret') return getSecretMetaById(ctx.db, ctx.ring, target.id)?.workspace_id ?? null;
  const row = ctx.db.prepare(`SELECT workspace_id FROM documents WHERE id = ?`).get(target.id) as { workspace_id: number } | undefined;
  return row?.workspace_id ?? null;
}

/** A target that is missing or lives in another workspace is the same 404, so owners cannot probe other workspaces. */
function assertTargetInWorkspace(ctx: AppContext, w: WorkspaceRow, target: GrantTarget): void {
  if (targetWorkspaceId(ctx, target) !== w.id) throw new NotFoundError('target not found');
}

/** Gives (or replaces) a user's grant on a project, secret or document of the workspace. `perms` may use wildcards. */
export function setGrantFor(ctx: AppContext, actor: Actor, slug: string, username: string, target: GrantTarget, perms: string[]): GrantRow {
  const w = ownedWorkspace(ctx, actor.principal, slug);
  assertTargetInWorkspace(ctx, w, target);
  const user = enabledUser(ctx, username);
  const grant = upsertGrant(ctx.db, { userId: user.id, targetType: target.type, targetId: target.id, perms });
  auditAs(ctx, actor, {
    action: 'grant.set',
    target_type: target.type,
    target_id: target.id,
    workspace_id: w.id,
    meta: { user: user.username, perms: grant.perms },
  });
  return grant;
}

export function removeGrantFor(ctx: AppContext, actor: Actor, slug: string, username: string, target: GrantTarget): void {
  const w = ownedWorkspace(ctx, actor.principal, slug);
  assertTargetInWorkspace(ctx, w, target);
  const user = getUserByUsername(ctx.db, username);
  if (!user || !deleteGrant(ctx.db, user.id, target.type, target.id)) throw new NotFoundError('grant not found');
  auditAs(ctx, actor, { action: 'grant.remove', target_type: target.type, target_id: target.id, workspace_id: w.id, meta: { user: user.username } });
}

export interface WorkspaceMembers {
  owners: { id: number; username: string }[];
  /** Non-owners holding at least one grant in the workspace. */
  members: { user: { id: number; username: string }; grants: { target_type: GrantTargetType; target_id: number; perms: Perm[] }[] }[];
}

export function listMembersFor(ctx: AppContext, principal: Principal, slug: string): WorkspaceMembers {
  const w = ownedWorkspace(ctx, principal, slug);
  const ownerIds = listOwnerIds(ctx.db, w.id);
  const owners = ownerIds.flatMap((id) => {
    const u = getUserById(ctx.db, id);
    return u ? [{ id: u.id, username: u.username }] : [];
  });
  const byUser = new Map<number, WorkspaceMembers['members'][number]>();
  for (const g of listGrantsForWorkspace(ctx.db, w.id)) {
    if (ownerIds.includes(g.user_id)) continue;
    let m = byUser.get(g.user_id);
    if (!m) {
      const u = getUserById(ctx.db, g.user_id);
      if (!u) continue;
      m = { user: { id: u.id, username: u.username }, grants: [] };
      byUser.set(g.user_id, m);
    }
    m.grants.push({ target_type: g.target_type, target_id: g.target_id, perms: g.perms });
  }
  return { owners, members: [...byUser.values()].sort((a, b) => a.user.username.localeCompare(b.user.username)) };
}

function auditMove(ctx: AppContext, actor: Actor, action: string, targetType: string, targetId: number, from: WorkspaceRow, to: WorkspaceRow, name: string): void {
  // One row per side, so the owners of both workspaces see the move in their audit log.
  for (const w of [from, to]) {
    auditAs(ctx, actor, { action, target_type: targetType, target_id: targetId, workspace_id: w.id, meta: { name, from: from.slug, to: to.slug } });
  }
}

/** Moves a project (with its secrets and documents; grants are kept) to another workspace. Owner of both. */
export function moveProjectFor(ctx: AppContext, actor: Actor, projectSlug: string, targetSlug: string): PublicProject {
  assertScope(actor.principal, 'admin');
  const access = accessFor(ctx.db, actor.principal);
  const project = access.project(getProjectBySlug(ctx.db, projectSlug));
  const from = getWorkspaceById(ctx.db, project.workspace_id)!;
  access.assertOwner(from);
  const to = ownedWorkspace(ctx, actor.principal, targetSlug);
  if (from.id === to.id) throw new ValidationError([{ path: ['workspace'], message: 'the project is already in that workspace' }]);
  const moved = moveProject(ctx.db, project.id, to.id);
  auditMove(ctx, actor, 'project.move', 'project', project.id, from, to, project.slug);
  return publicProject(moved, to.slug);
}

/** Moves a global secret to another workspace; 409 when the name is taken there. Owner of both. */
export function moveGlobalSecretFor(ctx: AppContext, actor: Actor, slug: string, name: string, targetSlug: string): void {
  const from = ownedWorkspace(ctx, actor.principal, slug);
  const to = ownedWorkspace(ctx, actor.principal, targetSlug);
  const secret = getSecretMeta(ctx.db, ctx.ring, null, name, from.id);
  if (!secret) throw new NotFoundError('secret not found');
  if (from.id === to.id) throw new ValidationError([{ path: ['workspace'], message: 'the secret is already in that workspace' }]);
  moveGlobalSecret(ctx.db, ctx.ring, secret.id, to.id);
  auditMove(ctx, actor, 'secret.move', 'secret', secret.id, from, to, name);
}

export function moveGlobalDocumentFor(ctx: AppContext, actor: Actor, slug: string, docSlug: string, targetSlug: string): void {
  const from = ownedWorkspace(ctx, actor.principal, slug);
  const to = ownedWorkspace(ctx, actor.principal, targetSlug);
  const doc = getDocument(ctx.db, null, docSlug, from.id);
  if (!doc) throw new NotFoundError('document not found');
  if (from.id === to.id) throw new ValidationError([{ path: ['workspace'], message: 'the document is already in that workspace' }]);
  moveGlobalDocument(ctx.db, doc.id, to.id);
  auditMove(ctx, actor, 'doc.move', 'document', doc.id, from, to, docSlug);
}

// --- grant editor (UI) ------------------------------------------------------------------------

/**
 * Perms for a grant on `type`, from raw input that may use wildcards (`*`, `protected.*`).
 * Perms that do not apply to the target type are dropped, so `*` on a secret means "every secret perm".
 * Nothing left is a validation error.
 */
export function permsForTarget(type: GrantTargetType, raw: readonly string[]): Perm[] {
  let expanded: Perm[];
  try {
    expanded = normalizePerms(raw);
  } catch (e) {
    throw new ValidationError([{ path: ['perms'], message: e instanceof Error ? e.message : 'invalid permissions' }]);
  }
  const allowed: readonly Perm[] = type === 'project' ? PERMS : type === 'secret' ? SECRET_PERMS : DOC_PERMS;
  const perms = expanded.filter((p) => allowed.includes(p));
  if (perms.length === 0) throw new ValidationError([{ path: ['perms'], message: 'at least one permission is required' }]);
  return perms;
}

export interface ResourceTree {
  globalDocs: { id: number; slug: string; title: string }[];
  globalSecrets: { id: number; name: string }[];
  projects: {
    id: number;
    slug: string;
    name: string;
    secrets: { id: number; name: string }[];
    docs: { id: number; slug: string; title: string }[];
  }[];
}

/** Everything in a workspace a grant can point at (owner only). */
export function resourceTreeFor(ctx: AppContext, principal: Principal, slug: string): ResourceTree {
  const w = ownedWorkspace(ctx, principal, slug);
  const projects = ctx.db.prepare(`SELECT id, slug, name FROM projects WHERE workspace_id = ? ORDER BY slug`).all(w.id) as { id: number; slug: string; name: string }[];
  const secrets = ctx.db.prepare(`SELECT id, name, project_id FROM secrets WHERE workspace_id = ? ORDER BY name`).all(w.id) as { id: number; name: string; project_id: number | null }[];
  const docs = ctx.db.prepare(`SELECT id, slug, title, project_id FROM documents WHERE workspace_id = ? ORDER BY slug`).all(w.id) as { id: number; slug: string; title: string; project_id: number | null }[];
  return {
    globalDocs: docs.filter((d) => d.project_id === null).map(({ id, slug: s, title }) => ({ id, slug: s, title })),
    globalSecrets: secrets.filter((s) => s.project_id === null).map(({ id, name }) => ({ id, name })),
    projects: projects.map((p) => ({
      ...p,
      secrets: secrets.filter((s) => s.project_id === p.id).map(({ id, name }) => ({ id, name })),
      docs: docs.filter((d) => d.project_id === p.id).map(({ id, slug: s, title }) => ({ id, slug: s, title })),
    })),
  };
}

/** The user's current grants in the workspace (owner of the workspace only). */
export function userGrantsFor(ctx: AppContext, principal: Principal, slug: string, username: string): GrantRow[] {
  const w = ownedWorkspace(ctx, principal, slug);
  return listGrantsForUserInWorkspace(ctx.db, enabledUser(ctx, username).id, w.id);
}

export interface DesiredGrant {
  type: GrantTargetType;
  id: number;
  perms: readonly string[];
}

/**
 * Makes the user's grants in the workspace exactly `desired`: grants not listed are deleted, the rest are
 * upserted with normalized perms. All or nothing. Owners already have everything, so they cannot be edited.
 */
export function applyUserGrantsFor(ctx: AppContext, actor: Actor, slug: string, username: string, desired: readonly DesiredGrant[]): void {
  const w = ownedWorkspace(ctx, actor.principal, slug);
  const user = enabledUser(ctx, username);
  if (listOwnerIds(ctx.db, w.id).includes(user.id)) throw new ConflictError(`"${user.username}" owns this workspace and already has full access`);
  ctx.db.transaction(() => {
    const wanted = new Map<string, DesiredGrant & { perms: Perm[] }>();
    for (const d of desired) {
      assertTargetInWorkspace(ctx, w, d);
      wanted.set(`${d.type}:${d.id}`, { ...d, perms: permsForTarget(d.type, d.perms) });
    }
    for (const g of listGrantsForUserInWorkspace(ctx.db, user.id, w.id)) {
      if (wanted.has(`${g.target_type}:${g.target_id}`)) continue;
      deleteGrant(ctx.db, user.id, g.target_type, g.target_id);
      auditAs(ctx, actor, { action: 'grant.remove', target_type: g.target_type, target_id: g.target_id, workspace_id: w.id, meta: { user: user.username } });
    }
    for (const d of wanted.values()) setGrantFor(ctx, actor, slug, user.username, d, d.perms);
  })();
}

/**
 * Removes every grant a user holds in the workspace. Unlike editing, this also works for a disabled user
 * (whose grants would otherwise be stuck on the members page). Owners cannot be removed this way.
 */
export function removeUserGrantsFor(ctx: AppContext, actor: Actor, slug: string, username: string): void {
  const w = ownedWorkspace(ctx, actor.principal, slug);
  const user = getUserByUsername(ctx.db, username);
  if (!user) throw new NotFoundError('user not found');
  if (listOwnerIds(ctx.db, w.id).includes(user.id)) throw new ConflictError(`"${user.username}" owns this workspace and already has full access`);
  ctx.db.transaction(() => {
    for (const g of listGrantsForUserInWorkspace(ctx.db, user.id, w.id)) {
      deleteGrant(ctx.db, user.id, g.target_type, g.target_id);
      auditAs(ctx, actor, { action: 'grant.remove', target_type: g.target_type, target_id: g.target_id, workspace_id: w.id, meta: { user: user.username } });
    }
  })();
}

export interface MemberOverview {
  username: string;
  /** A disabled user keeps their grants (they can be removed) but cannot be given new ones. */
  disabled: boolean;
  grants: { label: string; summary: string }[];
}

/** Owners and members with a readable summary of each member's grants (owner only). */
export function membersOverviewFor(ctx: AppContext, principal: Principal, slug: string): { owners: string[]; members: MemberOverview[] } {
  const { owners, members } = listMembersFor(ctx, principal, slug);
  const tree = resourceTreeFor(ctx, principal, slug);
  const labels = new Map<string, string>();
  for (const s of tree.globalSecrets) labels.set(`secret:${s.id}`, `global secret ${s.name}`);
  for (const d of tree.globalDocs) labels.set(`document:${d.id}`, `global document ${d.slug}`);
  for (const p of tree.projects) {
    labels.set(`project:${p.id}`, `project ${p.slug}`);
    for (const s of p.secrets) labels.set(`secret:${s.id}`, `secret ${p.slug}/${s.name}`);
    for (const d of p.docs) labels.set(`document:${d.id}`, `document ${p.slug}/${d.slug}`);
  }
  const full = { project: PERMS.length, secret: SECRET_PERMS.length, document: DOC_PERMS.length };
  return {
    owners: owners.map((o) => o.username),
    members: members.map((m) => ({
      username: m.user.username,
      disabled: getUserById(ctx.db, m.user.id)?.disabled_at != null,
      grants: m.grants.map((g) => ({
        label: labels.get(`${g.target_type}:${g.target_id}`) ?? `${g.target_type} #${g.target_id}`,
        summary: g.perms.length === full[g.target_type] ? 'all' : g.perms.join(', '),
      })),
    })),
  };
}

/** Usernames that can be offered on a create form's "Access" field: the non-owner members. Null when the caller does not own the workspace. */
export function accessCandidatesFor(ctx: AppContext, principal: Principal, workspaceId: number): string[] | null {
  if (!accessFor(ctx.db, principal).owns(workspaceId)) return null;
  const ownerIds = new Set(listOwnerIds(ctx.db, workspaceId));
  const names = new Set<string>();
  for (const g of listGrantsForWorkspace(ctx.db, workspaceId)) {
    if (ownerIds.has(g.user_id)) continue;
    const u = getUserById(ctx.db, g.user_id);
    if (u && u.disabled_at === null) names.add(u.username);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}
