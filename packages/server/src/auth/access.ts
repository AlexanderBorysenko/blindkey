import { DOC_PERMS, PERMS, SECRET_PERMS, type Perm } from '@blindkey/shared';
import type { Db } from '../db/connection.js';
import { AppError, NotFoundError, PermissionError, ValidationError } from '../errors.js';
import { listGrantsForUser } from '../repos/grants.js';
import type { ItemVisibility } from '../repos/util.js';
import { getProjectById, listProjects, type ProjectRow } from '../repos/projects.js';
import { getWorkspaceBySlug, listOwnedWorkspaces, listVisibleWorkspaces, type WorkspaceRow } from '../repos/workspaces.js';
import { canAccessProject, type Principal } from './principal.js';

/**
 * The single place the sharing rules live (spec: "Permissions"). The user's own rights come from
 * workspace ownership and grants; token scopes are checked separately by the services (assertScope)
 * and a token's `project_ids` is applied here as an extra restriction. Anything the user cannot
 * see is a NotFoundError — identical to a missing row — and only a visible-but-unpermitted action
 * is a PermissionError (403).
 */

export interface ProjectRef {
  id: number;
  workspace_id: number;
}
export interface ItemRef {
  id: number;
  project_id: number | null;
  workspace_id: number;
}

export function hasPerm(perms: readonly Perm[], perm: Perm): boolean {
  return perms.includes(perm);
}

function only(perms: Iterable<Perm>, allowed: readonly Perm[]): Perm[] {
  const set = new Set(perms);
  return allowed.filter((p) => set.has(p));
}

export class Access {
  private readonly owned: Set<number>;
  private readonly grants = new Map<string, readonly Perm[]>();
  /** Projects in which the user holds a grant on a single secret or document. */
  private readonly itemProjects: Set<number>;
  /** A project-scoped token only sees the workspaces that contain its projects; null = no restriction. */
  private readonly tokenWorkspaces: Set<number> | null;

  constructor(
    private readonly db: Db,
    readonly principal: Principal,
  ) {
    const uid = principal.userId;
    this.owned = new Set(listOwnedWorkspaces(db, uid).map((w) => w.id));
    for (const g of listGrantsForUser(db, uid)) this.grants.set(`${g.target_type}:${g.target_id}`, g.perms);
    const rows = db
      .prepare(
        `SELECT s.project_id AS project_id FROM grants g JOIN secrets s ON g.target_type = 'secret' AND s.id = g.target_id
           WHERE g.user_id = ? AND s.project_id IS NOT NULL
         UNION
         SELECT d.project_id FROM grants g JOIN documents d ON g.target_type = 'document' AND d.id = g.target_id
           WHERE g.user_id = ? AND d.project_id IS NOT NULL`,
      )
      .all(uid, uid) as { project_id: number }[];
    this.itemProjects = new Set(rows.map((r) => r.project_id));
    this.tokenWorkspaces =
      principal.projectIds === null
        ? null
        : new Set(principal.projectIds.flatMap((id) => {
            const p = getProjectById(db, id);
            return p ? [p.workspace_id] : [];
          }));
  }

  // --- workspaces -------------------------------------------------------------------------

  owns(workspaceId: number): boolean {
    return this.owned.has(workspaceId);
  }

  ownedWorkspaceIds(): number[] {
    return [...this.owned];
  }

  /** What the user themselves can see, ignoring any project restriction of the token. */
  private userVisibleWorkspaces(): WorkspaceRow[] {
    return listVisibleWorkspaces(this.db, this.principal.userId);
  }

  visibleWorkspaces(): WorkspaceRow[] {
    const all = this.userVisibleWorkspaces();
    return this.tokenWorkspaces === null ? all : all.filter((w) => this.tokenWorkspaces!.has(w.id));
  }

  role(workspaceId: number): 'owner' | 'member' {
    return this.owns(workspaceId) ? 'owner' : 'member';
  }

  /** A visible workspace by slug; an invisible one is indistinguishable from a missing one. */
  workspaceBySlug(slug: string): WorkspaceRow {
    const w = getWorkspaceBySlug(this.db, slug);
    if (!w || !this.visibleWorkspaces().some((v) => v.id === w.id)) throw new NotFoundError('workspace not found');
    return w;
  }

  assertOwner(workspace: { id: number }): void {
    if (!this.owns(workspace.id)) throw new PermissionError('workspace owner');
  }

  /**
   * Which workspace a global (project-less) secret/document call addresses. Explicit slug wins;
   * otherwise the only visible workspace, or the one holding all of a project-scoped token's projects.
   */
  resolveGlobalWorkspace(slug: string | null | undefined): WorkspaceRow {
    if (slug) return this.workspaceBySlug(slug);
    const visible = this.visibleWorkspaces();
    if (visible.length === 1) return visible[0]!;
    if (this.principal.kind === 'admin') {
      // A browser session always has an active workspace: the selected one, else the first visible.
      const active = visible.find((w) => w.slug === this.principal.workspaceHint) ?? visible[0];
      if (active) return active;
    }
    const ids = this.principal.projectIds;
    if (ids !== null && ids.length > 0) {
      const spaces = new Set(ids.map((id) => getProjectById(this.db, id)?.workspace_id));
      if (spaces.size === 1) {
        const match = visible.find((w) => spaces.has(w.id));
        if (match) return match;
      }
    }
    throw new ValidationError([{ path: ['workspace'], message: 'workspace required' }]);
  }

  /**
   * The workspace a new project goes into. A selection (the named slug, or a browser session's selected
   * workspace) must be one the user owns: 403 otherwise, never a silent fallback to another owned workspace.
   * Without any selection: the only workspace the user owns.
   */
  resolveProjectWorkspace(slug: string | undefined): WorkspaceRow {
    if (slug) {
      // Creating a project is not bounded by the token's current projects (it may start with none).
      const w = getWorkspaceBySlug(this.db, slug);
      if (!w || !this.userVisibleWorkspaces().some((v) => v.id === w.id)) throw new NotFoundError('workspace not found');
      if (!this.owns(w.id)) throw new AppError(403, 'forbidden', "you don't own this workspace");
      return w;
    }
    if (this.principal.kind === 'admin' && this.principal.workspaceHint) {
      const selected = getWorkspaceBySlug(this.db, this.principal.workspaceHint);
      if (selected) {
        if (!this.owns(selected.id)) throw new AppError(403, 'forbidden', "you don't own this workspace");
        return selected;
      }
    }
    const owned = listOwnedWorkspaces(this.db, this.principal.userId);
    if (owned.length === 1) return owned[0]!;
    if (owned.length === 0) throw new AppError(403, 'forbidden', "you don't own any workspace yet — create one first");
    throw new ValidationError([{ path: ['workspace'], message: 'workspace required' }]);
  }

  // --- effective permissions --------------------------------------------------------------

  private grant(type: 'project' | 'secret' | 'document', id: number): readonly Perm[] {
    return this.grants.get(`${type}:${id}`) ?? [];
  }

  /** Perms from the project grant alone (what applies to the project itself). Owners: everything. */
  projectPerms(p: ProjectRef): Perm[] {
    return this.owns(p.workspace_id) ? [...PERMS] : [...this.grant('project', p.id)];
  }

  /** union(project grant, item grant) restricted to the secret perms. Globals have no project grant. */
  secretPerms(s: ItemRef): Perm[] {
    if (this.owns(s.workspace_id)) return [...SECRET_PERMS];
    const project = s.project_id === null ? [] : this.grant('project', s.project_id);
    return only([...project, ...this.grant('secret', s.id)], SECRET_PERMS);
  }

  docPerms(d: ItemRef): Perm[] {
    if (this.owns(d.workspace_id)) return [...DOC_PERMS];
    const project = d.project_id === null ? [] : this.grant('project', d.project_id);
    return only([...project, ...this.grant('document', d.id)], DOC_PERMS);
  }

  // --- visibility -------------------------------------------------------------------------

  projectVisible(p: ProjectRef): boolean {
    if (!canAccessProject(this.principal, p.id)) return false;
    return this.owns(p.workspace_id) || this.grant('project', p.id).length > 0 || this.itemProjects.has(p.id);
  }

  /** A global item of a workspace a project-scoped token cannot see stays hidden. */
  private globalReachable(item: ItemRef): boolean {
    return item.project_id !== null || this.tokenWorkspaces === null || this.tokenWorkspaces.has(item.workspace_id);
  }

  secretVisible(s: ItemRef): boolean {
    if (!this.globalReachable(s)) return false;
    if (s.project_id !== null && !canAccessProject(this.principal, s.project_id)) return false;
    return this.secretPerms(s).length > 0;
  }

  docVisible(d: ItemRef): boolean {
    if (!this.globalReachable(d)) return false;
    if (d.project_id !== null && !canAccessProject(this.principal, d.project_id)) return false;
    return this.docPerms(d).length > 0;
  }

  /**
   * The ids behind `secretVisible` / "has `docs.read`" as an SQL filter (see `ItemVisibility`), so searches
   * can be limited in the query itself. Global items outside a project-scoped token's workspaces are cut here too.
   */
  itemVisibility(kind: 'secret' | 'document'): ItemVisibility {
    const allowed: readonly Perm[] = kind === 'secret' ? SECRET_PERMS : ['docs.read'];
    const projectIds: number[] = [];
    const itemIds: number[] = [];
    for (const [key, perms] of this.grants) {
      if (!perms.some((p) => allowed.includes(p))) continue;
      const [type, id] = key.split(':') as [string, string];
      if (type === 'project') projectIds.push(Number(id));
      else if (type === kind) itemIds.push(Number(id));
    }
    return {
      workspaceIds: [...this.owned],
      projectIds,
      itemIds,
      globalWorkspaceIds: this.tokenWorkspaces === null ? null : [...this.tokenWorkspaces],
    };
  }

  visibleProjects(): ProjectRow[] {
    return listProjects(this.db, this.principal.projectIds).filter((p) => this.projectVisible(p));
  }

  visibleProjectInWorkspace(workspaceId: number): ProjectRow[] {
    return this.visibleProjects().filter((p) => p.workspace_id === workspaceId);
  }

  // --- asserting --------------------------------------------------------------------------

  /** The project when visible (404 otherwise); with `perm`, also 403 when the project grant lacks it. */
  project(p: ProjectRow | null, perm?: Perm): ProjectRow {
    if (!p || !this.projectVisible(p)) throw new NotFoundError('project not found');
    if (perm && !hasPerm(this.projectPerms(p), perm)) throw new PermissionError(perm);
    return p;
  }

  /** Effective secret perms when visible (404 otherwise); with `perm`, also 403 when missing. */
  secret(s: ItemRef, perm?: Perm): Perm[] {
    if (!this.secretVisible(s)) throw new NotFoundError('secret not found');
    const perms = this.secretPerms(s);
    if (perm && !hasPerm(perms, perm)) throw new PermissionError(perm);
    return perms;
  }

  doc(d: ItemRef, perm?: Perm): Perm[] {
    if (!this.docVisible(d)) throw new NotFoundError('document not found');
    const perms = this.docPerms(d);
    if (perm && !hasPerm(perms, perm)) throw new PermissionError(perm);
    return perms;
  }
}

export function accessFor(db: Db, principal: Principal): Access {
  return new Access(db, principal);
}
