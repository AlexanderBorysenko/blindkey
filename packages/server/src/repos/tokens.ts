import type { Scope } from '@pidb/shared';
import type { Db } from '../db/connection.js';
import { generateToken, hashToken, hashesEqual, parseTokenPrefix } from '../crypto/tokens.js';
import { now, parseJsonArray } from './util.js';

export interface TokenRow {
  id: number;
  name: string;
  prefix: string;
  scopes: Scope[];
  project_ids: number[] | null;
  expires_at: number | null;
  last_used_at: number | null;
  revoked_at: number | null;
  created_at: number;
}

interface RawToken extends Omit<TokenRow, 'scopes' | 'project_ids'> {
  scopes: string;
  project_ids: string | null;
  token_hash: string;
}

const COLS = 'id, name, prefix, token_hash, scopes, project_ids, expires_at, last_used_at, revoked_at, created_at';

function toRow(r: RawToken): TokenRow {
  const { token_hash: _hash, ...rest } = r;
  return {
    ...rest,
    scopes: parseJsonArray<Scope>(r.scopes),
    project_ids: r.project_ids === null ? null : parseJsonArray<number>(r.project_ids),
  };
}

export function createToken(
  db: Db,
  input: { name: string; scopes: Scope[]; projectIds: number[] | null; expiresAt: number | null },
): { token: string; row: TokenRow } {
  const t = generateToken();
  const info = db
    .prepare(`INSERT INTO api_tokens (name, prefix, token_hash, scopes, project_ids, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(input.name, t.prefix, t.hash, JSON.stringify(input.scopes), input.projectIds === null ? null : JSON.stringify(input.projectIds), input.expiresAt, now());
  const row = db.prepare(`SELECT ${COLS} FROM api_tokens WHERE id = ?`).get(Number(info.lastInsertRowid)) as RawToken;
  return { token: t.token, row: toRow(row) };
}

export const DAY_MS = 86_400_000;

export type TokenLookup = { state: 'active'; row: TokenRow } | { state: 'expired'; row: TokenRow } | { state: 'none' };

/** A revoked token reads as unknown ('none'); an expired one is reported so clients can say "log in again". */
export function lookupTokenByValue(db: Db, token: string, nowTs: number = now()): TokenLookup {
  const prefix = parseTokenPrefix(token);
  if (!prefix) return { state: 'none' };
  const hash = hashToken(token);
  const candidates = db.prepare(`SELECT ${COLS} FROM api_tokens WHERE prefix = ?`).all(prefix) as RawToken[];
  for (const c of candidates) {
    if (!hashesEqual(c.token_hash, hash)) continue;
    if (c.revoked_at !== null) return { state: 'none' };
    if (c.expires_at !== null && c.expires_at <= nowTs) return { state: 'expired', row: toRow(c) };
    return { state: 'active', row: toRow(c) };
  }
  return { state: 'none' };
}

export function findActiveTokenByValue(db: Db, token: string, nowTs: number = now()): TokenRow | null {
  const r = lookupTokenByValue(db, token, nowTs);
  return r.state === 'active' ? r.row : null;
}

export function touchToken(db: Db, id: number, ts: number = now()): void {
  db.prepare(`UPDATE api_tokens SET last_used_at = ? WHERE id = ?`).run(ts, id);
}

export function listTokens(db: Db): TokenRow[] {
  return (db.prepare(`SELECT ${COLS} FROM api_tokens ORDER BY id`).all() as RawToken[]).map(toRow);
}

export function revokeToken(db: Db, id: number, ts: number = now()): boolean {
  return db.prepare(`UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`).run(ts, id).changes > 0;
}
