import type { Db } from '../db/connection.js';
import { now } from './util.js';

export interface AuditEntry {
  actor_type: 'admin' | 'token';
  actor_id: number | null;
  action: string;
  target_type?: string | null;
  target_id?: number | null;
  field_key?: string | null;
  ip?: string;
  user_agent?: string;
  meta?: Record<string, unknown> | null;
}

export interface AuditRow {
  id: number;
  ts: number;
  actor_type: 'admin' | 'token';
  actor_id: number | null;
  action: string;
  target_type: string | null;
  target_id: number | null;
  field_key: string | null;
  ip: string;
  user_agent: string;
  meta: Record<string, unknown> | null;
}

export function writeAudit(db: Db, e: AuditEntry, ts: number = now()): number {
  const info = db
    .prepare(
      `INSERT INTO audit_log (ts, actor_type, actor_id, action, target_type, target_id, field_key, ip, user_agent, meta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(ts, e.actor_type, e.actor_id, e.action, e.target_type ?? null, e.target_id ?? null, e.field_key ?? null, e.ip ?? '', e.user_agent ?? '', e.meta ? JSON.stringify(e.meta) : null);
  return Number(info.lastInsertRowid);
}

export interface AuditQuery {
  limit?: number;
  /** exclusive upper bound on audit row id (cursor) */
  before?: number;
  action?: string;
  actorType?: string;
}

type RawAuditRow = Omit<AuditRow, 'meta'> & { meta: string | null };

function mapAuditRow(r: RawAuditRow): AuditRow {
  return { ...r, meta: r.meta ? (JSON.parse(r.meta) as Record<string, unknown>) : null };
}

export function listAudit(db: Db, q: AuditQuery): AuditRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.before !== undefined) { where.push('id < ?'); params.push(q.before); }
  if (q.action) { where.push('action = ?'); params.push(q.action); }
  if (q.actorType) { where.push('actor_type = ?'); params.push(q.actorType); }
  const limit = Math.min(Math.max(q.limit ?? 100, 1), 1000);
  const sql = `SELECT id, ts, actor_type, actor_id, action, target_type, target_id, field_key, ip, user_agent, meta FROM audit_log
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ts DESC, id DESC LIMIT ?`;
  const rows = db.prepare(sql).all(...params, limit) as RawAuditRow[];
  return rows.map(mapAuditRow);
}

/** Recent audit rows for one target (e.g. a secret), newest first. Used by the secret page's "recent access" panel. */
export function listAuditForTarget(db: Db, targetType: string, targetId: number, limit = 5): AuditRow[] {
  const lim = Math.min(Math.max(limit, 1), 50);
  const rows = db
    .prepare(
      `SELECT id, ts, actor_type, actor_id, action, target_type, target_id, field_key, ip, user_agent, meta
       FROM audit_log WHERE target_type = ? AND target_id = ? ORDER BY ts DESC, id DESC LIMIT ?`,
    )
    .all(targetType, targetId, lim) as RawAuditRow[];
  return rows.map(mapAuditRow);
}
