import { normalizePerms, validatePermsForTarget, type GrantTargetType, type Perm } from '@blindkey/shared';
import type { Db } from '../db/connection.js';
import { ValidationError } from '../errors.js';
import { now, parseJsonArray } from './util.js';

export interface GrantRow {
  id: number;
  user_id: number;
  target_type: GrantTargetType;
  target_id: number;
  perms: Perm[];
  created_at: number;
}

interface RawGrant {
  id: number;
  user_id: number;
  target_type: string;
  target_id: number;
  perms: string;
  created_at: number;
}

const COLS = 'id, user_id, target_type, target_id, perms, created_at';

function toRow(r: RawGrant): GrantRow {
  return { ...r, target_type: r.target_type as GrantTargetType, perms: parseJsonArray<Perm>(r.perms) };
}

export function getGrant(db: Db, userId: number, targetType: GrantTargetType, targetId: number): GrantRow | null {
  const r = db.prepare(`SELECT ${COLS} FROM grants WHERE user_id = ? AND target_type = ? AND target_id = ?`).get(userId, targetType, targetId) as RawGrant | undefined;
  return r ? toRow(r) : null;
}

/**
 * Creates or replaces the user's grant on a target. `perms` may contain wildcards (`*`, `protected.*`);
 * the stored value is the normalized expanded array, and it must be legal for the target type.
 */
export function upsertGrant(db: Db, input: { userId: number; targetType: GrantTargetType; targetId: number; perms: readonly string[] | string }): GrantRow {
  let perms: Perm[];
  try {
    perms = normalizePerms(input.perms);
  } catch (e) {
    throw new ValidationError([{ path: ['perms'], message: e instanceof Error ? e.message : 'invalid permissions' }]);
  }
  const bad = validatePermsForTarget(input.targetType, perms);
  if (bad) throw new ValidationError([{ path: ['perms'], message: bad }]);
  db.prepare(
    `INSERT INTO grants (user_id, target_type, target_id, perms, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, target_type, target_id) DO UPDATE SET perms = excluded.perms`,
  ).run(input.userId, input.targetType, input.targetId, JSON.stringify(perms), now());
  return getGrant(db, input.userId, input.targetType, input.targetId)!;
}

export function deleteGrant(db: Db, userId: number, targetType: GrantTargetType, targetId: number): boolean {
  return db.prepare(`DELETE FROM grants WHERE user_id = ? AND target_type = ? AND target_id = ?`).run(userId, targetType, targetId).changes > 0;
}

export function listGrantsForUser(db: Db, userId: number): GrantRow[] {
  return (db.prepare(`SELECT ${COLS} FROM grants WHERE user_id = ? ORDER BY id`).all(userId) as RawGrant[]).map(toRow);
}

export function listGrantsForTarget(db: Db, targetType: GrantTargetType, targetId: number): GrantRow[] {
  return (db.prepare(`SELECT ${COLS} FROM grants WHERE target_type = ? AND target_id = ? ORDER BY id`).all(targetType, targetId) as RawGrant[]).map(toRow);
}

/** Every grant (any user) on a project, a secret or a document that lives in the workspace. */
export function listGrantsForWorkspace(db: Db, workspaceId: number): GrantRow[] {
  return (
    db
      .prepare(
        `SELECT ${COLS} FROM grants WHERE
           (target_type = 'project' AND target_id IN (SELECT id FROM projects WHERE workspace_id = @w))
        OR (target_type = 'secret' AND target_id IN (SELECT id FROM secrets WHERE workspace_id = @w))
        OR (target_type = 'document' AND target_id IN (SELECT id FROM documents WHERE workspace_id = @w))
         ORDER BY user_id, id`,
      )
      .all({ w: workspaceId }) as RawGrant[]
  ).map(toRow);
}

/** A user's grants limited to one workspace. */
export function listGrantsForUserInWorkspace(db: Db, userId: number, workspaceId: number): GrantRow[] {
  return listGrantsForWorkspace(db, workspaceId).filter((g) => g.user_id === userId);
}
