import type { Scope } from '@pidb/shared';
import type { Db } from '../db/connection.js';
import { generateToken, hashToken, hashesEqual, parseTokenPrefix } from '../crypto/tokens.js';
import { now, parseJsonArray } from './util.js';

export type TokenKind = 'user' | 'agent';

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
  kind: TokenKind;
  /** Admin-chosen display name (e.g. "Easy Renovation · home PC"); `name` stays the machine identity. */
  label: string | null;
}

interface RawToken extends Omit<TokenRow, 'scopes' | 'project_ids' | 'kind'> {
  scopes: string;
  project_ids: string | null;
  token_hash: string;
  kind: string;
}

const COLS = 'id, name, prefix, token_hash, scopes, project_ids, expires_at, last_used_at, revoked_at, created_at, kind, label';

function toRow(r: RawToken): TokenRow {
  const { token_hash: _hash, ...rest } = r;
  return {
    ...rest,
    scopes: parseJsonArray<Scope>(r.scopes),
    project_ids: r.project_ids === null ? null : parseJsonArray<number>(r.project_ids),
    kind: r.kind as TokenKind,
  };
}

export function createToken(
  db: Db,
  input: { name: string; scopes: Scope[]; projectIds: number[] | null; expiresAt: number | null; kind?: TokenKind; label?: string | null },
): { token: string; row: TokenRow } {
  const t = generateToken();
  const info = db
    .prepare(`INSERT INTO api_tokens (name, prefix, token_hash, scopes, project_ids, expires_at, created_at, kind, label) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      input.name,
      t.prefix,
      t.hash,
      JSON.stringify(input.scopes),
      input.projectIds === null ? null : JSON.stringify(input.projectIds),
      input.expiresAt,
      now(),
      input.kind ?? 'user',
      input.label ?? null,
    );
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

/**
 * Revokes every still-active `kind='agent'` token with this exact name (spec §1.3): a device-flow
 * approval for a name that already has a live agent token supersedes it, rather than piling up
 * agent tokens under the same name every time `pidb connect` is re-run.
 */
export function revokeAgentTokensByName(db: Db, name: string, ts: number = now()): number {
  return db
    .prepare(`UPDATE api_tokens SET revoked_at = ? WHERE name = ? AND kind = 'agent' AND revoked_at IS NULL`)
    .run(ts, name).changes;
}

/** Adds one project to a project-scoped token (no-op for an all-projects token or one that already has it). */
export function addProjectToToken(db: Db, id: number, projectId: number): void {
  const r = db.prepare(`SELECT project_ids FROM api_tokens WHERE id = ?`).get(id) as { project_ids: string | null } | undefined;
  if (!r || r.project_ids === null) return;
  const ids = parseJsonArray<number>(r.project_ids);
  if (ids.includes(projectId)) return;
  db.prepare(`UPDATE api_tokens SET project_ids = ? WHERE id = ?`).run(JSON.stringify([...ids, projectId]), id);
}

/** Replaces a token's project list; `null` = all projects. Returns false when the token does not exist or is revoked. */
export function setTokenProjects(db: Db, id: number, projectIds: number[] | null): boolean {
  return (
    db
      .prepare(`UPDATE api_tokens SET project_ids = ? WHERE id = ? AND revoked_at IS NULL`)
      .run(projectIds === null ? null : JSON.stringify(projectIds), id).changes > 0
  );
}

/** Sets (or clears, with null) a token's display label. Returns false when the token does not exist. */
export function setTokenLabel(db: Db, id: number, label: string | null): boolean {
  return db.prepare(`UPDATE api_tokens SET label = ? WHERE id = ?`).run(label, id).changes > 0;
}

/** The label of the newest agent token with this name — carried over when a reconnect supersedes it. */
export function latestAgentLabel(db: Db, name: string): string | null {
  const r = db
    .prepare(`SELECT label FROM api_tokens WHERE name = ? AND kind = 'agent' AND label IS NOT NULL ORDER BY id DESC LIMIT 1`)
    .get(name) as { label: string } | undefined;
  return r?.label ?? null;
}
