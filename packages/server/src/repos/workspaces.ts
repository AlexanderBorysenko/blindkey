import type { Db } from '../db/connection.js';
import { ConflictError, NotFoundError } from '../errors.js';
import { isUniqueViolation, now } from './util.js';

export interface WorkspaceRow {
  id: number;
  slug: string;
  name: string;
  created_at: number;
  updated_at: number;
}

const COLS = 'id, slug, name, created_at, updated_at';

export function getWorkspaceById(db: Db, id: number): WorkspaceRow | null {
  return (db.prepare(`SELECT ${COLS} FROM workspaces WHERE id = ?`).get(id) as WorkspaceRow | undefined) ?? null;
}

export function getWorkspaceBySlug(db: Db, slug: string): WorkspaceRow | null {
  return (db.prepare(`SELECT ${COLS} FROM workspaces WHERE slug = ?`).get(slug) as WorkspaceRow | undefined) ?? null;
}

/** The first workspace by id; used where nobody names one (seeding the guidelines on `init`). */
export function getDefaultWorkspace(db: Db): WorkspaceRow | null {
  return (db.prepare(`SELECT ${COLS} FROM workspaces ORDER BY id LIMIT 1`).get() as WorkspaceRow | undefined) ?? null;
}

export function listWorkspaces(db: Db): WorkspaceRow[] {
  return db.prepare(`SELECT ${COLS} FROM workspaces ORDER BY name COLLATE NOCASE`).all() as WorkspaceRow[];
}

export function createWorkspace(db: Db, input: { slug: string; name: string }): WorkspaceRow {
  const ts = now();
  try {
    const info = db.prepare(`INSERT INTO workspaces (slug, name, created_at, updated_at) VALUES (?, ?, ?, ?)`).run(input.slug, input.name, ts, ts);
    return getWorkspaceById(db, Number(info.lastInsertRowid))!;
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConflictError(`workspace slug "${input.slug}" already exists`);
    throw err;
  }
}

export function updateWorkspace(db: Db, id: number, patch: { slug?: string; name?: string }): WorkspaceRow {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (patch.slug !== undefined) { sets.push('slug = ?'); values.push(patch.slug); }
  if (patch.name !== undefined) { sets.push('name = ?'); values.push(patch.name); }
  sets.push('updated_at = ?');
  values.push(now());
  try {
    const info = db.prepare(`UPDATE workspaces SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
    if (info.changes === 0) throw new NotFoundError('workspace not found');
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConflictError(`workspace slug "${patch.slug}" already exists`);
    throw err;
  }
  return getWorkspaceById(db, id)!;
}

/** Refuses to delete a workspace that still holds projects, secrets or documents. */
export function deleteWorkspace(db: Db, id: number): boolean {
  return db.transaction(() => {
    if (!getWorkspaceById(db, id)) return false;
    const used = db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM projects WHERE workspace_id = ?) + (SELECT COUNT(*) FROM secrets WHERE workspace_id = ?)
              + (SELECT COUNT(*) FROM documents WHERE workspace_id = ?) AS n`,
      )
      .get(id, id, id) as { n: number };
    if (used.n > 0) throw new ConflictError('workspace is not empty');
    return db.prepare(`DELETE FROM workspaces WHERE id = ?`).run(id).changes > 0;
  })();
}

export function addOwner(db: Db, workspaceId: number, userId: number): boolean {
  return db.prepare(`INSERT OR IGNORE INTO workspace_owners (workspace_id, user_id) VALUES (?, ?)`).run(workspaceId, userId).changes > 0;
}

export function removeOwner(db: Db, workspaceId: number, userId: number): boolean {
  return db.prepare(`DELETE FROM workspace_owners WHERE workspace_id = ? AND user_id = ?`).run(workspaceId, userId).changes > 0;
}

export function listOwnerIds(db: Db, workspaceId: number): number[] {
  return (db.prepare(`SELECT user_id FROM workspace_owners WHERE workspace_id = ? ORDER BY user_id`).all(workspaceId) as { user_id: number }[]).map((r) => r.user_id);
}

export function isOwner(db: Db, workspaceId: number, userId: number): boolean {
  return db.prepare(`SELECT 1 FROM workspace_owners WHERE workspace_id = ? AND user_id = ?`).get(workspaceId, userId) !== undefined;
}

export function listOwnedWorkspaces(db: Db, userId: number): WorkspaceRow[] {
  return db
    .prepare(`SELECT w.id, w.slug, w.name, w.created_at, w.updated_at FROM workspaces w JOIN workspace_owners o ON o.workspace_id = w.id WHERE o.user_id = ? ORDER BY w.name COLLATE NOCASE`)
    .all(userId) as WorkspaceRow[];
}

/**
 * Workspaces a user can see: ones they own, or ones holding anything they have a grant on
 * (a granted project, secret or document).
 */
export function listVisibleWorkspaces(db: Db, userId: number): WorkspaceRow[] {
  return db
    .prepare(
      `SELECT ${COLS} FROM workspaces w WHERE
         EXISTS (SELECT 1 FROM workspace_owners o WHERE o.workspace_id = w.id AND o.user_id = @u)
         OR EXISTS (SELECT 1 FROM grants g JOIN projects p ON g.target_type = 'project' AND p.id = g.target_id
                    WHERE g.user_id = @u AND p.workspace_id = w.id)
         OR EXISTS (SELECT 1 FROM grants g JOIN secrets s ON g.target_type = 'secret' AND s.id = g.target_id
                    WHERE g.user_id = @u AND s.workspace_id = w.id)
         OR EXISTS (SELECT 1 FROM grants g JOIN documents d ON g.target_type = 'document' AND d.id = g.target_id
                    WHERE g.user_id = @u AND d.workspace_id = w.id)
       ORDER BY w.name COLLATE NOCASE`,
    )
    .all({ u: userId }) as WorkspaceRow[];
}

export function isWorkspaceVisible(db: Db, workspaceId: number, userId: number): boolean {
  return listVisibleWorkspaces(db, userId).some((w) => w.id === workspaceId);
}
