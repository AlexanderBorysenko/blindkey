import { defaultSensitive, type SecretInput, type SecretPatch } from '@blindkey/shared';
import type { Db } from '../db/connection.js';
import type { KeyRing } from '../config.js';
import { decryptField, encryptField, generateDek, unwrapDek, wrapDek } from '../crypto/envelope.js';
import { ConflictError, CryptoError, NotFoundError } from '../errors.js';
import { keyVersionReport, probeCurrentVersion, type KeyVersionStatus } from './keyversions.js';
import { inList, isUniqueViolation, now, parseJsonArray } from './util.js';

export type { KeyVersionStatus };

export interface SecretFieldMeta {
  key: string;
  sensitive: boolean;
  value?: string;
}
export interface SecretMeta {
  id: number;
  project_id: number | null;
  name: string;
  description: string;
  tags: string[];
  created_at: number;
  updated_at: number;
  fields: SecretFieldMeta[];
}
export interface RevealedField {
  key: string;
  sensitive: boolean;
  value: string;
}

interface RawSecret {
  id: number;
  project_id: number | null;
  name: string;
  description: string;
  tags: string;
  dek_wrapped: Buffer;
  key_version: number;
  created_at: number;
  updated_at: number;
}
interface RawField {
  key: string;
  value_enc: Buffer;
  is_sensitive: number;
}

const COLS = 'id, project_id, name, description, tags, dek_wrapped, key_version, created_at, updated_at';

function masterKey(ring: KeyRing, version: number): Buffer {
  const k = ring.keys.get(version);
  if (!k) throw new CryptoError(`no master key for version ${version}`);
  return k;
}

function loadDek(ring: KeyRing, row: RawSecret): Buffer {
  return unwrapDek(masterKey(ring, row.key_version), row.dek_wrapped);
}

function withSecret<T>(id: number, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof CryptoError) throw new CryptoError(e.message, { secret_id: id });
    throw e;
  }
}

function rawById(db: Db, id: number): RawSecret | null {
  return (db.prepare(`SELECT ${COLS} FROM secrets WHERE id = ?`).get(id) as RawSecret | undefined) ?? null;
}

function rawFields(db: Db, secretId: number): RawField[] {
  return db.prepare(`SELECT key, value_enc, is_sensitive FROM secret_fields WHERE secret_id = ? ORDER BY sort, id`).all(secretId) as RawField[];
}

function toMeta(db: Db, ring: KeyRing, row: RawSecret): SecretMeta {
  const fields = rawFields(db, row.id);
  return withSecret(row.id, () => {
    const hasPublic = fields.some((f) => f.is_sensitive === 0);
    const dek = hasPublic ? loadDek(ring, row) : null;
    return {
      id: row.id,
      project_id: row.project_id,
      name: row.name,
      description: row.description,
      tags: parseJsonArray<string>(row.tags),
      created_at: row.created_at,
      updated_at: row.updated_at,
      fields: fields.map((f) =>
        f.is_sensitive === 0
          ? { key: f.key, sensitive: false, value: decryptField(dek!, row.id, f.key, f.value_enc) }
          : { key: f.key, sensitive: true },
      ),
    };
  });
}

export function getSecretMetaById(db: Db, ring: KeyRing, id: number): SecretMeta | null {
  const row = rawById(db, id);
  return row ? toMeta(db, ring, row) : null;
}

export function getSecretMeta(db: Db, ring: KeyRing, projectId: number | null, name: string): SecretMeta | null {
  const row = db.prepare(`SELECT ${COLS} FROM secrets WHERE project_id IS ? AND name = ?`).get(projectId, name) as RawSecret | undefined;
  return row ? toMeta(db, ring, row) : null;
}

export function listSecrets(db: Db, ring: KeyRing, projectId: number | null): SecretMeta[] {
  const rows = db.prepare(`SELECT ${COLS} FROM secrets WHERE project_id IS ? ORDER BY name COLLATE NOCASE`).all(projectId) as RawSecret[];
  return rows.map((r) => toMeta(db, ring, r));
}

export function createSecret(db: Db, ring: KeyRing, input: SecretInput & { projectId: number | null }): SecretMeta {
  const dek = generateDek();
  const wrapped = wrapDek(masterKey(ring, ring.current), dek);
  const ts = now();
  return db.transaction(() => {
    let id: number;
    try {
      const info = db
        .prepare(`INSERT INTO secrets (project_id, name, description, tags, dek_wrapped, key_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(input.projectId, input.name, input.description, JSON.stringify(input.tags), wrapped, ring.current, ts, ts);
      id = Number(info.lastInsertRowid);
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictError(`secret "${input.name}" already exists`);
      throw err;
    }
    const ins = db.prepare(`INSERT INTO secret_fields (secret_id, key, value_enc, is_sensitive, sort) VALUES (?, ?, ?, ?, ?)`);
    input.fields.forEach((f, i) => {
      const sensitive = f.sensitive ?? defaultSensitive(f.key);
      ins.run(id, f.key, encryptField(dek, id, f.key, f.value), sensitive ? 1 : 0, i);
    });
    return getSecretMetaById(db, ring, id)!;
  })();
}

export function revealField(db: Db, ring: KeyRing, secretId: number, key: string): string | null {
  const row = rawById(db, secretId);
  if (!row) throw new NotFoundError('secret not found');
  const f = db.prepare(`SELECT key, value_enc, is_sensitive FROM secret_fields WHERE secret_id = ? AND key = ?`).get(secretId, key) as RawField | undefined;
  if (!f) return null;
  return withSecret(secretId, () => decryptField(loadDek(ring, row), secretId, key, f.value_enc));
}

export function revealAllFields(db: Db, ring: KeyRing, secretId: number): RevealedField[] {
  const row = rawById(db, secretId);
  if (!row) throw new NotFoundError('secret not found');
  return withSecret(secretId, () => {
    const dek = loadDek(ring, row);
    return rawFields(db, secretId).map((f) => ({
      key: f.key,
      sensitive: f.is_sensitive === 1,
      value: decryptField(dek, secretId, f.key, f.value_enc),
    }));
  });
}

export function updateSecret(db: Db, ring: KeyRing, id: number, patch: SecretPatch): SecretMeta {
  return db.transaction(() => {
    const row = rawById(db, id);
    if (!row) throw new NotFoundError('secret not found');
    const sets: string[] = [];
    const values: unknown[] = [];
    if (patch.name !== undefined) { sets.push('name = ?'); values.push(patch.name); }
    if (patch.description !== undefined) { sets.push('description = ?'); values.push(patch.description); }
    if (patch.tags !== undefined) { sets.push('tags = ?'); values.push(JSON.stringify(patch.tags)); }
    sets.push('updated_at = ?');
    values.push(now());
    try {
      db.prepare(`UPDATE secrets SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictError(`secret "${patch.name}" already exists`);
      throw err;
    }
    if (patch.removeFields?.length) {
      const del = db.prepare(`DELETE FROM secret_fields WHERE secret_id = ? AND key = ?`);
      for (const k of patch.removeFields) del.run(id, k);
    }
    if (patch.fields?.length) {
      const dek = loadDek(ring, row);
      const existing = db.prepare(`SELECT key, is_sensitive FROM secret_fields WHERE secret_id = ?`).all(id) as { key: string; is_sensitive: number }[];
      const existingMap = new Map(existing.map((e) => [e.key, e.is_sensitive === 1]));
      let sort = (db.prepare(`SELECT COALESCE(MAX(sort), -1) AS m FROM secret_fields WHERE secret_id = ?`).get(id) as { m: number }).m;
      const upsert = db.prepare(
        `INSERT INTO secret_fields (secret_id, key, value_enc, is_sensitive, sort) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(secret_id, key) DO UPDATE SET value_enc = excluded.value_enc, is_sensitive = excluded.is_sensitive`,
      );
      for (const f of patch.fields) {
        const prior = existingMap.get(f.key);
        const sensitive = f.sensitive ?? prior ?? defaultSensitive(f.key);
        sort += 1;
        upsert.run(id, f.key, encryptField(dek, id, f.key, f.value), sensitive ? 1 : 0, sort);
      }
    }
    if (patch.order?.length) {
      const current = (db.prepare(`SELECT key FROM secret_fields WHERE secret_id = ? ORDER BY sort, id`).all(id) as { key: string }[]).map((r) => r.key);
      const listed = new Set(patch.order);
      const final = [...new Set(patch.order.filter((k) => current.includes(k))), ...current.filter((k) => !listed.has(k))];
      const setSort = db.prepare(`UPDATE secret_fields SET sort = ? WHERE secret_id = ? AND key = ?`);
      final.forEach((k, i) => setSort.run(i, id, k));
    }
    return getSecretMetaById(db, ring, id)!;
  })();
}

export function deleteSecret(db: Db, projectId: number | null, name: string): boolean {
  return db.prepare(`DELETE FROM secrets WHERE project_id IS ? AND name = ?`).run(projectId, name).changes > 0;
}

export interface SecretNameHit {
  id: number;
  project_id: number | null;
  name: string;
  tags: string[];
}

export function searchSecretNames(db: Db, q: string, projectIds: number[] | null, limit = 20): SecretNameHit[] {
  const term = q.trim();
  if (!term) return [];
  const like = `%${term.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  const scope = projectIds === null ? '1=1' : projectIds.length === 0 ? 'project_id IS NULL' : `(project_id IS NULL OR project_id IN (${inList(projectIds)}))`;
  const rows = db
    .prepare(`SELECT id, project_id, name, tags FROM secrets WHERE name LIKE ? ESCAPE '\\' AND ${scope} ORDER BY name COLLATE NOCASE LIMIT ?`)
    .all(like, ...(projectIds ?? []), limit) as { id: number; project_id: number | null; name: string; tags: string }[];
  return rows.map((r) => ({ ...r, tags: parseJsonArray<string>(r.tags) }));
}

export function rewrapAllSecrets(db: Db, ring: KeyRing): number {
  const currentRows = db.prepare(`SELECT ${COLS} FROM secrets WHERE key_version = ?`).all(ring.current) as RawSecret[];
  probeCurrentVersion(currentRows, ring, (row) => loadDek(ring, row), (row) => `secret ${row.id}`);
  const current = masterKey(ring, ring.current);
  const rows = db.prepare(`SELECT ${COLS} FROM secrets WHERE key_version != ?`).all(ring.current) as RawSecret[];
  const upd = db.prepare(`UPDATE secrets SET dek_wrapped = ?, key_version = ? WHERE id = ?`);
  return db.transaction(() => {
    for (const row of rows) {
      const dek = loadDek(ring, row);
      upd.run(wrapDek(current, dek), ring.current, row.id);
    }
    return rows.length;
  })();
}

/** One status per key_version present in `secrets`, for `blindkey-server key-versions` (spec §4). */
export function secretKeyVersionReport(db: Db, ring: KeyRing): KeyVersionStatus[] {
  const rows = db.prepare(`SELECT ${COLS} FROM secrets ORDER BY key_version`).all() as RawSecret[];
  return keyVersionReport(rows, (row) => row.key_version, ring, (row, key) => unwrapDek(key, row.dek_wrapped));
}
