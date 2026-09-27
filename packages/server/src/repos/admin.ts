import { randomBytes } from 'node:crypto';
import type { Db } from '../db/connection.js';
import { ConflictError } from '../errors.js';
import { now } from './util.js';

export interface AdminRow {
  id: number;
  username: string;
  password_hash: string;
  created_at: number;
}

export function getAdmin(db: Db): AdminRow | null {
  return (db.prepare(`SELECT id, username, password_hash, created_at FROM admin ORDER BY id LIMIT 1`).get() as AdminRow | undefined) ?? null;
}

export function getAdminByUsername(db: Db, username: string): AdminRow | null {
  return (db.prepare(`SELECT id, username, password_hash, created_at FROM admin WHERE username = ?`).get(username) as AdminRow | undefined) ?? null;
}

export function getAdminById(db: Db, id: number): AdminRow | null {
  return (db.prepare(`SELECT id, username, password_hash, created_at FROM admin WHERE id = ?`).get(id) as AdminRow | undefined) ?? null;
}

export function createAdmin(db: Db, username: string, passwordHash: string): AdminRow {
  if (getAdmin(db)) throw new ConflictError('admin already exists');
  const info = db.prepare(`INSERT INTO admin (username, password_hash, created_at) VALUES (?, ?, ?)`).run(username, passwordHash, now());
  return db.prepare(`SELECT id, username, password_hash, created_at FROM admin WHERE id = ?`).get(Number(info.lastInsertRowid)) as AdminRow;
}

export interface SessionRow {
  id: string;
  admin_id: number;
  expires_at: number;
}

export function createSession(db: Db, adminId: number, ttlMs: number, ip: string, ua: string): string {
  const id = randomBytes(32).toString('hex');
  const ts = now();
  db.prepare(`INSERT INTO sessions (id, admin_id, expires_at, created_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)`).run(id, adminId, ts + ttlMs, ts, ip, ua);
  return id;
}

export function getSession(db: Db, id: string, nowTs: number = now()): SessionRow | null {
  const r = db.prepare(`SELECT id, admin_id, expires_at FROM sessions WHERE id = ?`).get(id) as SessionRow | undefined;
  if (!r || r.expires_at <= nowTs) return null;
  return r;
}

export function deleteSession(db: Db, id: string): boolean {
  return db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id).changes > 0;
}

/** Deletes every session of the admin except `keepId`. Returns how many were deleted. */
export function deleteOtherSessions(db: Db, adminId: number, keepId: string): number {
  return db.prepare(`DELETE FROM sessions WHERE admin_id = ? AND id <> ?`).run(adminId, keepId).changes;
}

export function purgeExpiredSessions(db: Db, nowTs: number = now()): number {
  return db.prepare(`DELETE FROM sessions WHERE expires_at <= ?`).run(nowTs).changes;
}
