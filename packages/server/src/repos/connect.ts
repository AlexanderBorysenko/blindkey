import type { Scope } from '@blindkey/shared';
import type { Db } from '../db/connection.js';
import { now, parseJsonArray } from './util.js';

export type ConnectStatus = 'pending' | 'approved' | 'denied';

export interface ConnectRequestRow {
  id: number;
  device_hash: string;
  user_code: string;
  name: string;
  scopes: Scope[];
  projects: string[];
  expires_days: number;
  status: ConnectStatus;
  approved_scopes: Scope[] | null;
  approved_project_ids: number[] | null;
  approved_expires_days: number | null;
  approved_label: string | null;
  ip: string;
  user_agent: string;
  created_at: number;
  expires_at: number;
}

interface RawRow {
  id: number;
  device_hash: string;
  user_code: string;
  name: string;
  scopes: string;
  projects: string;
  expires_days: number;
  status: string;
  approved_scopes: string | null;
  approved_project_ids: string | null;
  approved_expires_days: number | null;
  approved_label: string | null;
  ip: string;
  user_agent: string;
  created_at: number;
  expires_at: number;
}

const COLS =
  'id, device_hash, user_code, name, scopes, projects, expires_days, status, approved_scopes, approved_project_ids, approved_expires_days, approved_label, ip, user_agent, created_at, expires_at';

function toRow(r: RawRow): ConnectRequestRow {
  return {
    ...r,
    status: r.status as ConnectStatus,
    scopes: parseJsonArray<Scope>(r.scopes),
    projects: parseJsonArray<string>(r.projects),
    approved_scopes: r.approved_scopes === null ? null : parseJsonArray<Scope>(r.approved_scopes),
    approved_project_ids: r.approved_project_ids === null ? null : parseJsonArray<number>(r.approved_project_ids),
  };
}

export interface CreateConnectRequestInput {
  deviceHash: string;
  userCode: string;
  name: string;
  scopes: Scope[];
  projects: string[];
  expiresDays: number;
  ip: string;
  userAgent: string;
  ttlMs: number;
}

export function createConnectRequest(db: Db, input: CreateConnectRequestInput): ConnectRequestRow {
  const ts = now();
  const info = db
    .prepare(
      `INSERT INTO connect_requests (device_hash, user_code, name, scopes, projects, expires_days, status, ip, user_agent, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
    )
    .run(
      input.deviceHash,
      input.userCode,
      input.name,
      JSON.stringify(input.scopes),
      JSON.stringify(input.projects),
      input.expiresDays,
      input.ip,
      input.userAgent,
      ts,
      ts + input.ttlMs,
    );
  return getConnectRequestById(db, Number(info.lastInsertRowid))!;
}

export function getConnectRequestById(db: Db, id: number): ConnectRequestRow | null {
  const r = db.prepare(`SELECT ${COLS} FROM connect_requests WHERE id = ?`).get(id) as RawRow | undefined;
  return r ? toRow(r) : null;
}

export function getConnectRequestByDeviceHash(db: Db, deviceHash: string): ConnectRequestRow | null {
  const r = db.prepare(`SELECT ${COLS} FROM connect_requests WHERE device_hash = ?`).get(deviceHash) as RawRow | undefined;
  return r ? toRow(r) : null;
}

export function getConnectRequestByUserCode(db: Db, userCode: string): ConnectRequestRow | null {
  const r = db.prepare(`SELECT ${COLS} FROM connect_requests WHERE user_code = ?`).get(userCode) as RawRow | undefined;
  return r ? toRow(r) : null;
}

export interface ApproveConnectRequestInput {
  scopes: Scope[];
  projectIds: number[];
  expiresDays: number;
  label?: string | null;
}

/** Only transitions a still-`pending` row; returns false if it was already decided or is gone. */
export function approveConnectRequest(db: Db, id: number, approved: ApproveConnectRequestInput): boolean {
  return (
    db
      .prepare(
        `UPDATE connect_requests SET status = 'approved', approved_scopes = ?, approved_project_ids = ?, approved_expires_days = ?, approved_label = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(JSON.stringify(approved.scopes), JSON.stringify(approved.projectIds), approved.expiresDays, approved.label ?? null, id).changes > 0
  );
}

/** Only transitions a still-`pending` row; returns false if it was already decided or is gone. */
export function denyConnectRequest(db: Db, id: number): boolean {
  return db.prepare(`UPDATE connect_requests SET status = 'denied' WHERE id = ? AND status = 'pending'`).run(id).changes > 0;
}

export function deleteConnectRequest(db: Db, id: number): boolean {
  return db.prepare(`DELETE FROM connect_requests WHERE id = ?`).run(id).changes > 0;
}

/**
 * Atomically claims an approved request for token issuance (Review Focus 3): the `DELETE ...
 * WHERE status = 'approved'` and the read of its approved values happen as one statement via
 * `RETURNING`, so a second concurrent/replayed claim on the same row sees zero rows affected
 * (returns null) instead of racing a separate SELECT-then-DELETE against the first claim.
 */
export function claimApprovedConnectRequest(db: Db, id: number): ConnectRequestRow | null {
  const r = db.prepare(`DELETE FROM connect_requests WHERE id = ? AND status = 'approved' RETURNING ${COLS}`).get(id) as RawRow | undefined;
  return r ? toRow(r) : null;
}

export function purgeExpiredConnectRequests(db: Db, nowTs: number = now()): number {
  return db.prepare(`DELETE FROM connect_requests WHERE expires_at <= ?`).run(nowTs).changes;
}

/** Approved device-flow requests the agent has not claimed yet (still within their TTL), oldest first. */
export function listApprovedConnectRequests(db: Db, nowTs: number = now()): ConnectRequestRow[] {
  return (
    db.prepare(`SELECT ${COLS} FROM connect_requests WHERE status = 'approved' AND expires_at > ? ORDER BY id`).all(nowTs) as RawRow[]
  ).map(toRow);
}
