import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { openDb } from '../src/db/connection.js';
import { createProject } from '../src/repos/projects.js';
import {
  createSecret, getSecretMeta, listSecrets, revealField, revealAllFields, updateSecret, deleteSecret, searchSecretNames, rewrapAllSecrets,
  secretKeyVersionReport,
} from '../src/repos/secrets.js';
import { ConflictError, CryptoError } from '../src/errors.js';
import type { KeyRing } from '../src/config.js';

function setup() {
  const db = openDb(':memory:');
  const ring: KeyRing = { current: 1, keys: new Map([[1, randomBytes(32)]]) };
  const p = createProject(db, { slug: 'alpha', name: 'A', status: 'active', tags: [], summary: '' });
  return { db, ring, p };
}
const staging = { name: 'Staging server', description: 'ssh box', tags: ['ssh'], fields: [
  { key: 'host', value: '10.0.0.1' }, { key: 'username', value: 'deploy' }, { key: 'password', value: 'pw-1' },
  { key: 'note', value: 'visible', sensitive: false },
] };

describe('secrets repo', () => {
  it('creates and returns meta with non-sensitive values only', () => {
    const { db, ring, p } = setup();
    const s = createSecret(db, ring, { projectId: p.id, ...staging });
    expect(s.fields).toEqual([
      { key: 'host', sensitive: false, value: '10.0.0.1' },
      { key: 'username', sensitive: false, value: 'deploy' },
      { key: 'password', sensitive: true },
      { key: 'note', sensitive: false, value: 'visible' },
    ]);
    const raw = db.prepare(`SELECT value_enc FROM secret_fields WHERE key = 'password'`).get() as { value_enc: Buffer };
    expect(raw.value_enc.toString('utf8')).not.toContain('pw-1');
  });
  it('reorders fields by patch.order without touching values; unlisted keys keep their relative order after it', () => {
    const { db, ring, p } = setup();
    const s = createSecret(db, ring, { projectId: p.id, ...staging });
    const u = updateSecret(db, ring, s.id, { order: ['password', 'nope', 'host'] });
    expect(u.fields.map((f) => f.key)).toEqual(['password', 'host', 'username', 'note']);
    expect(revealField(db, ring, s.id, 'password')).toBe('pw-1');
  });
  it('applies patch.order after upserting a new field', () => {
    const { db, ring, p } = setup();
    const s = createSecret(db, ring, { projectId: p.id, ...staging });
    const u = updateSecret(db, ring, s.id, { fields: [{ key: 'port', value: '22' }], order: ['host', 'port', 'username', 'password', 'note'] });
    expect(u.fields.map((f) => f.key)).toEqual(['host', 'port', 'username', 'password', 'note']);
  });
  it('enforces unique name per project and allows same name globally', () => {
    const { db, ring, p } = setup();
    createSecret(db, ring, { projectId: p.id, ...staging });
    expect(() => createSecret(db, ring, { projectId: p.id, ...staging })).toThrow(ConflictError);
    expect(createSecret(db, ring, { projectId: null, ...staging }).project_id).toBeNull();
    expect(getSecretMeta(db, ring, null, 'Staging server')).not.toBeNull();
    expect(listSecrets(db, ring, p.id)).toHaveLength(1);
  });
  it('reveals fields', () => {
    const { db, ring, p } = setup();
    const s = createSecret(db, ring, { projectId: p.id, ...staging });
    expect(revealField(db, ring, s.id, 'password')).toBe('pw-1');
    expect(revealField(db, ring, s.id, 'missing')).toBeNull();
    expect(revealAllFields(db, ring, s.id)).toEqual([
      { key: 'host', sensitive: false, value: '10.0.0.1' },
      { key: 'username', sensitive: false, value: 'deploy' },
      { key: 'password', sensitive: true, value: 'pw-1' },
      { key: 'note', sensitive: false, value: 'visible' },
    ]);
  });
  it('updates meta, upserts and removes fields, keeps sensitivity when unspecified', () => {
    const { db, ring, p } = setup();
    const s = createSecret(db, ring, { projectId: p.id, ...staging });
    const u = updateSecret(db, ring, s.id, {
      description: 'new', fields: [{ key: 'password', value: 'pw-2' }, { key: 'note', value: 'v2' }, { key: 'port', value: '22' }], removeFields: ['username'],
    });
    expect(u.description).toBe('new');
    expect(u.fields.map((f) => f.key)).toEqual(['host', 'password', 'note', 'port']);
    expect(u.fields.find((f) => f.key === 'note')).toEqual({ key: 'note', sensitive: false, value: 'v2' });
    expect(u.fields.find((f) => f.key === 'port')).toEqual({ key: 'port', sensitive: false, value: '22' });
    expect(revealField(db, ring, s.id, 'password')).toBe('pw-2');
    expect(revealField(db, ring, s.id, 'username')).toBeNull();
  });
  it('deletes and searches by name', () => {
    const { db, ring, p } = setup();
    createSecret(db, ring, { projectId: p.id, ...staging });
    createSecret(db, ring, { projectId: null, name: 'GitHub PAT', description: '', tags: [], fields: [{ key: 'token', value: 't' }] });
    expect(searchSecretNames(db, 'server', null).map((s) => s.name)).toEqual(['Staging server']);
    expect(searchSecretNames(db, 'git', [p.id]).map((s) => s.name)).toEqual(['GitHub PAT']);
    expect(searchSecretNames(db, 'server', [])).toEqual([]);
    expect(searchSecretNames(db, 'pw-1', null)).toEqual([]);
    expect(deleteSecret(db, p.id, 'Staging server')).toBe(true);
    expect(deleteSecret(db, p.id, 'Staging server')).toBe(false);
  });
  it('rewraps DEKs on key rotation and fails with a missing key', () => {
    const { db, ring, p } = setup();
    const s = createSecret(db, ring, { projectId: p.id, ...staging });
    const ring2: KeyRing = { current: 2, keys: new Map([[1, ring.keys.get(1)!], [2, randomBytes(32)]]) };
    expect(rewrapAllSecrets(db, ring2)).toBe(1);
    expect(rewrapAllSecrets(db, ring2)).toBe(0);
    expect(revealField(db, ring2, s.id, 'password')).toBe('pw-1');
    const ringOnlyNew: KeyRing = { current: 2, keys: new Map([[2, ring2.keys.get(2)!]]) };
    expect(revealField(db, ringOnlyNew, s.id, 'password')).toBe('pw-1');
    expect(() => revealField(db, ring, s.id, 'password')).toThrow(CryptoError);
  });
  it('rewrapAllSecrets probes rows already on the current version before rewrapping, and refuses a wrong current key without writing anything', () => {
    const { db, p } = setup();
    const keyA = randomBytes(32);
    const ringA: KeyRing = { current: 2, keys: new Map([[2, keyA]]) };
    const s = createSecret(db, ringA, { projectId: p.id, ...staging });
    const keyB = randomBytes(32);
    const wrongRing: KeyRing = { current: 2, keys: new Map([[2, keyB]]) };
    expect(() => rewrapAllSecrets(db, wrongRing)).toThrow(
      `key version 2 does not decrypt secret ${s.id} — BLINDKEY_MASTER_KEY is not the version 2 key`,
    );
    // Nothing was written: the row is untouched and still decrypts with the real key.
    const raw = db.prepare(`SELECT key_version FROM secrets WHERE id = ?`).get(s.id) as { key_version: number };
    expect(raw.key_version).toBe(2);
    expect(rewrapAllSecrets(db, ringA)).toBe(0);
    expect(revealField(db, ringA, s.id, 'password')).toBe('pw-1');
  });
  it('secretKeyVersionReport: empty, mixed versions, missing key, wrong key', () => {
    const { db, ring, p } = setup();
    expect(secretKeyVersionReport(db, ring)).toEqual([]);

    createSecret(db, ring, { projectId: p.id, ...staging });
    const keyB = randomBytes(32);
    const ring2: KeyRing = { current: 2, keys: new Map([[1, ring.keys.get(1)!], [2, keyB]]) };
    createSecret(db, ring2, { projectId: null, name: 'GitHub PAT', description: '', tags: [], fields: [{ key: 'token', value: 't' }] });

    expect(secretKeyVersionReport(db, ring2)).toEqual([
      { version: 1, rows: 1, status: 'ok', ok: true },
      { version: 2, rows: 1, status: 'ok', ok: true },
    ]);

    // Missing key for version 1.
    const missingV1: KeyRing = { current: 2, keys: new Map([[2, keyB]]) };
    expect(secretKeyVersionReport(db, missingV1)).toEqual([
      { version: 1, rows: 1, status: 'no key configured', ok: false },
      { version: 2, rows: 1, status: 'ok', ok: true },
    ]);

    // Wrong key for version 1.
    const wrongV1: KeyRing = { current: 2, keys: new Map([[1, randomBytes(32)], [2, keyB]]) };
    expect(secretKeyVersionReport(db, wrongV1)).toEqual([
      { version: 1, rows: 1, status: 'WRONG KEY (1 of 1 fail)', ok: false },
      { version: 2, rows: 1, status: 'ok', ok: true },
    ]);
  });
});
