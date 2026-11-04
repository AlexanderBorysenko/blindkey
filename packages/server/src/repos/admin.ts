import { randomBytes } from 'node:crypto';
import type { Db } from '../db/connection.js';
import { ConflictError } from '../errors.js';
import { isUniqueViolation, now } from './util.js';

export interface AdminRow {
  id: number;
  username: string;
  password_hash: string;
  created_at: number;
  is_super: boolean;
  disabled_at: number | null;
  must_change_password: boolean;
}
/** Alias: the `admin` table holds every user since multi-user support. */
export type UserRow = AdminRow;

interface RawAdmin {
  id: number;
  username: string;
  password_hash: string;
  created_at: number;
  is_super: number;
  disabled_at: number | null;
  must_change_password: number;
}

const COLS = 'id, username, password_hash, created_at, is_super, disabled_at, must_change_password';

function toRow(r: RawAdmin): AdminRow {
  return { ...r, is_super: r.is_super === 1, must_change_password: r.must_change_password === 1 };
}

function one(db: Db, where: string, ...params: unknown[]): AdminRow | null {
  const r = db.prepare(`SELECT ${COLS} FROM admin WHERE ${where} LIMIT 1`).get(...params) as RawAdmin | undefined;
  return r ? toRow(r) : null;
}

/** The oldest user (the original admin). */
export function getAdmin(db: Db): AdminRow | null {
  return one(db, '1=1 ORDER BY id');
}

/** The oldest super user — the default target of the shell recovery commands. */
export function getOldestSuper(db: Db): AdminRow | null {
  return one(db, 'is_super = 1 ORDER BY id');
}

export function getAdminByUsername(db: Db, username: string): AdminRow | null {
  return one(db, 'username = ?', username);
}

export function getAdminById(db: Db, id: number): AdminRow | null {
  return one(db, 'id = ?', id);
}

export const getUserByUsername = getAdminByUsername;
export const getUserById = getAdminById;

/**
 * Creates the first user (fresh install): a super user who owns every ownerless workspace (the seeded `default`)
 * (the migration seeds the `default` workspace before any user exists).
 */
export function createAdmin(db: Db, username: string, passwordHash: string): AdminRow {
  if (getAdmin(db)) throw new ConflictError('admin already exists');
  return db.transaction(() => {
    const user = createUser(db, { username, passwordHash, isSuper: true });
    db.prepare(
      `INSERT INTO workspace_owners (workspace_id, user_id)
       SELECT w.id, ? FROM workspaces w WHERE NOT EXISTS (SELECT 1 FROM workspace_owners o WHERE o.workspace_id = w.id)`,
    ).run(user.id);
    return user;
  })();
}

export interface NewUser {
  username: string;
  passwordHash: string;
  isSuper?: boolean;
  mustChangePassword?: boolean;
}

export function createUser(db: Db, input: NewUser): AdminRow {
  try {
    const info = db
      .prepare(`INSERT INTO admin (username, password_hash, created_at, is_super, must_change_password) VALUES (?, ?, ?, ?, ?)`)
      .run(input.username, input.passwordHash, now(), input.isSuper ? 1 : 0, input.mustChangePassword ? 1 : 0);
    return getAdminById(db, Number(info.lastInsertRowid))!;
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConflictError(`user "${input.username}" already exists`);
    throw err;
  }
}

export function listUsers(db: Db): AdminRow[] {
  return (db.prepare(`SELECT ${COLS} FROM admin ORDER BY username COLLATE NOCASE`).all() as RawAdmin[]).map(toRow);
}

/** Disabling also signs the user out everywhere; `getSession` additionally ignores disabled users. */
export function setUserDisabled(db: Db, id: number, disabled: boolean): boolean {
  return db.transaction(() => {
    const changed = db.prepare(`UPDATE admin SET disabled_at = ? WHERE id = ?`).run(disabled ? now() : null, id).changes > 0;
    if (changed && disabled) {
      // Ends the user's own sessions and the impersonation sessions they opened as someone else. Sessions in which a
      // super user is acting AS this user stay (they are inert while the user is disabled): that super user must still
      // be able to leave them through the stop route.
      db.prepare(`DELETE FROM sessions WHERE (admin_id = ? AND impersonator_id IS NULL) OR impersonator_id = ?`).run(id, id);
    }
    return changed;
  })();
}

/** Enabled super users other than `exceptId` — the guard against locking everybody out of user management. */
export function countOtherEnabledSupers(db: Db, exceptId: number): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM admin WHERE is_super = 1 AND disabled_at IS NULL AND id <> ?`).get(exceptId) as { n: number }).n;
}

export function setUserMustChangePassword(db: Db, id: number, mustChange: boolean): boolean {
  return db.prepare(`UPDATE admin SET must_change_password = ? WHERE id = ?`).run(mustChange ? 1 : 0, id).changes > 0;
}

export function setUserSuper(db: Db, id: number, isSuper: boolean): boolean {
  return db.transaction(() => {
    const changed = db.prepare(`UPDATE admin SET is_super = ? WHERE id = ?`).run(isSuper ? 1 : 0, id).changes > 0;
    // A demoted super user may no longer impersonate: end the sessions they opened as someone else.
    if (changed && !isSuper) db.prepare(`DELETE FROM sessions WHERE impersonator_id = ?`).run(id);
    return changed;
  })();
}

/** Cascades to the user's sessions, tokens, grants, 2FA and workspace ownerships. */
export function deleteUser(db: Db, id: number): boolean {
  return db.prepare(`DELETE FROM admin WHERE id = ?`).run(id).changes > 0;
}

export function setAdminPasswordHash(db: Db, id: number, hash: string): void {
  db.prepare(`UPDATE admin SET password_hash = ? WHERE id = ?`).run(hash, id);
}

export const setUserPasswordHash = setAdminPasswordHash;

export interface SessionRow {
  id: string;
  admin_id: number;
  expires_at: number;
  impersonator_id: number | null;
}

export function createSession(db: Db, adminId: number, ttlMs: number, ip: string, ua: string, impersonatorId: number | null = null): string {
  const id = randomBytes(32).toString('hex');
  const ts = now();
  db.prepare(`INSERT INTO sessions (id, admin_id, expires_at, created_at, ip, user_agent, impersonator_id) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, adminId, ts + ttlMs, ts, ip, ua, impersonatorId);
  return id;
}

export function getSession(db: Db, id: string, nowTs: number = now()): SessionRow | null {
  const r = db
    .prepare(
      `SELECT s.id, s.admin_id, s.expires_at, s.impersonator_id FROM sessions s JOIN admin a ON a.id = s.admin_id
       WHERE s.id = ? AND a.disabled_at IS NULL`,
    )
    .get(id) as SessionRow | undefined;
  if (!r || r.expires_at <= nowTs) return null;
  return r;
}

/**
 * A live session even when its user is disabled. Only for ending an impersonation: the impersonated user
 * may have been disabled meanwhile, and the super user behind the session must still be able to leave it.
 */
export function getImpersonationSession(db: Db, id: string, nowTs: number = now()): SessionRow | null {
  const r = db.prepare(`SELECT id, admin_id, expires_at, impersonator_id FROM sessions WHERE id = ? AND impersonator_id IS NOT NULL`).get(id) as SessionRow | undefined;
  if (!r || r.expires_at <= nowTs) return null;
  return r;
}

export function deleteSession(db: Db, id: string): boolean {
  return db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id).changes > 0;
}

/**
 * Deletes every session of the admin except `keepId`, plus every impersonation session this admin
 * opened as someone else (a credential change must cut those too). Returns how many were deleted.
 */
export function deleteOtherSessions(db: Db, adminId: number, keepId: string): number {
  return db.prepare(`DELETE FROM sessions WHERE (admin_id = ? OR impersonator_id = ?) AND id <> ?`).run(adminId, adminId, keepId).changes;
}

/** Deletes every session of the admin, including the caller's own, and every impersonation session they opened. Returns how many were deleted. */
export function deleteAllSessions(db: Db, adminId: number): number {
  return db.prepare(`DELETE FROM sessions WHERE admin_id = ? OR impersonator_id = ?`).run(adminId, adminId).changes;
}

export function purgeExpiredSessions(db: Db, nowTs: number = now()): number {
  return db.prepare(`DELETE FROM sessions WHERE expires_at <= ?`).run(nowTs).changes;
}
