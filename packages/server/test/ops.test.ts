import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { openDb } from '../src/db/connection.js';
import { runInit, runRotateKey, runKeyVersions, runBackup, runTotpReset, runPasswordReset } from '../src/ops.js';
import { getAdmin, createAdmin, createSession } from '../src/repos/admin.js';
import { getDocument } from '../src/repos/documents.js';
import { createSecret, revealField } from '../src/repos/secrets.js';
import { savePendingTotp, getTotp, createChallenge, getChallenge, factorLockedUntil } from '../src/repos/twofactor.js';
import { listAudit } from '../src/repos/audit.js';
import { verifyPassword } from '../src/crypto/passwords.js';
import type { KeyRing } from '../src/config.js';

describe('ops', () => {
  it('init creates admin and seeds guidelines once', async () => {
    const db = openDb(':memory:');
    const first = await runInit(db, { username: 'alex', password: 'first-password!' });
    expect(first).toEqual({ adminCreated: true, guidelinesSeeded: true });
    expect(await verifyPassword(getAdmin(db)!.password_hash, 'first-password!')).toBe(true);
    expect(getDocument(db, null, 'guidelines')?.category).toBe('guidelines');
    // The admin already exists, so this is a no-op — a short password here must not throw
    // (F1: the validator only runs when an admin is actually being created).
    const second = await runInit(db, { username: 'other', password: 'x' });
    expect(second).toEqual({ adminCreated: false, guidelinesSeeded: false });
    expect(getAdmin(db)!.username).toBe('alex');
  });
  it('init throws the validator message for a too-short password and creates no admin (F1)', async () => {
    const db = openDb(':memory:');
    await expect(runInit(db, { username: 'alex', password: 'elevenchars' })).rejects.toThrow(
      'Password must be at least 12 characters.',
    );
    expect(getAdmin(db)).toBeNull();
  });
  it('rotate-key rewraps secrets', () => {
    const db = openDb(':memory:');
    const ring1: KeyRing = { current: 1, keys: new Map([[1, randomBytes(32)]]) };
    const s = createSecret(db, ring1, { projectId: null, name: 'A', description: '', tags: [], fields: [{ key: 'k', value: 'v' }] });
    const ring2: KeyRing = { current: 2, keys: new Map([[1, ring1.keys.get(1)!], [2, randomBytes(32)]]) };
    expect(runRotateKey(db, ring2)).toEqual({ secrets: 1, totp: 0 });
    expect(revealField(db, { current: 2, keys: new Map([[2, ring2.keys.get(2)!]]) }, s.id, 'k')).toBe('v');
  });
  it('rotate-key is all-or-nothing: a failed 2FA rewrap leaves the secrets table on the old key version', () => {
    const db = openDb(':memory:');
    const ring1: KeyRing = { current: 1, keys: new Map([[1, randomBytes(32)]]) };
    const s = createSecret(db, ring1, { projectId: null, name: 'A', description: '', tags: [], fields: [{ key: 'k', value: 'v' }] });
    const admin = createAdmin(db, 'alex', 'hash');
    savePendingTotp(db, ring1, admin.id, randomBytes(20));
    // Corrupt the 2FA row so its rewrap throws (no key for version 99 in any ring below).
    db.prepare(`UPDATE admin_totp SET key_version = 99 WHERE admin_id = ?`).run(admin.id);

    const ring2: KeyRing = { current: 2, keys: new Map([[1, ring1.keys.get(1)!], [2, randomBytes(32)]]) };
    expect(() => runRotateKey(db, ring2)).toThrow(/no master key for version 99/);

    const raw = db.prepare(`SELECT key_version FROM secrets WHERE id = ?`).get(s.id) as { key_version: number };
    expect(raw.key_version).toBe(1);
  });
  it('rotate-key probes rows already on the current version and fails on a wrong current key, instead of reporting "rewrapped 0" (Review Focus 4)', () => {
    const db = openDb(':memory:');
    const keyA = randomBytes(32);
    const ringA: KeyRing = { current: 2, keys: new Map([[2, keyA]]) };
    const s = createSecret(db, ringA, { projectId: null, name: 'A', description: '', tags: [], fields: [{ key: 'k', value: 'v' }] });

    const keyB = randomBytes(32);
    const wrongRing: KeyRing = { current: 2, keys: new Map([[2, keyB]]) };
    expect(() => runRotateKey(db, wrongRing)).toThrow(
      `key version 2 does not decrypt secret ${s.id} — PIDB_MASTER_KEY is not the version 2 key`,
    );

    const raw = db.prepare(`SELECT key_version FROM secrets WHERE id = ?`).get(s.id) as { key_version: number };
    expect(raw.key_version).toBe(2);
    expect(revealField(db, ringA, s.id, 'k')).toBe('v');
  });
  it('key-versions reports "no encrypted rows" on an empty db, is ok', () => {
    const db = openDb(':memory:');
    const ring: KeyRing = { current: 1, keys: new Map([[1, randomBytes(32)]]) };
    expect(runKeyVersions(db, ring)).toEqual({ lines: ['no encrypted rows'], ok: true });
  });
  it('key-versions reports one line per (kind, version), ok when both decrypt', () => {
    const db = openDb(':memory:');
    const k1 = randomBytes(32);
    const k2 = randomBytes(32);
    const ring1: KeyRing = { current: 1, keys: new Map([[1, k1]]) };
    createSecret(db, ring1, { projectId: null, name: 'A', description: '', tags: [], fields: [{ key: 'k', value: 'v' }] });
    const admin = createAdmin(db, 'alex', 'hash');
    savePendingTotp(db, ring1, admin.id, randomBytes(20));

    const ring2: KeyRing = { current: 2, keys: new Map([[1, k1], [2, k2]]) };
    expect(runKeyVersions(db, ring2)).toEqual({
      lines: ['secrets v1: 1 rows, ok', '2fa v1: 1 rows, ok'],
      ok: true,
    });
  });
  it('key-versions reports "no key configured" for a missing previous key, and is not ok', () => {
    const db = openDb(':memory:');
    const k1 = randomBytes(32);
    const ring1: KeyRing = { current: 1, keys: new Map([[1, k1]]) };
    createSecret(db, ring1, { projectId: null, name: 'A', description: '', tags: [], fields: [{ key: 'k', value: 'v' }] });
    const ring2: KeyRing = { current: 2, keys: new Map([[2, randomBytes(32)]]) };
    expect(runKeyVersions(db, ring2)).toEqual({
      lines: ['secrets v1: 1 rows, no key configured'],
      ok: false,
    });
  });
  it('key-versions reports "WRONG KEY (k of n fail)" and is not ok', () => {
    const db = openDb(':memory:');
    const k1 = randomBytes(32);
    const ring1: KeyRing = { current: 1, keys: new Map([[1, k1]]) };
    createSecret(db, ring1, { projectId: null, name: 'A', description: '', tags: [], fields: [{ key: 'k', value: 'v' }] });
    const wrongRing: KeyRing = { current: 1, keys: new Map([[1, randomBytes(32)]]) };
    expect(runKeyVersions(db, wrongRing)).toEqual({
      lines: ['secrets v1: 1 rows, WRONG KEY (1 of 1 fail)'],
      ok: false,
    });
  });
  it('2fa reset deletes the admin_totp row and audits auth.totp_reset via shell', async () => {
    const db = openDb(':memory:');
    await runInit(db, { username: 'alex', password: 'first-password!' });
    const ring: KeyRing = { current: 1, keys: new Map([[1, randomBytes(32)]]) };
    const admin = getAdmin(db)!;
    savePendingTotp(db, ring, admin.id, randomBytes(20));
    expect(runTotpReset(db)).toBe('alex');
    expect(getTotp(db, admin.id)).toBeNull();
    const rows = listAudit(db, { action: 'auth.totp_reset' });
    expect(rows.length).toBe(1);
    expect(rows[0]!.meta).toEqual({ via: 'shell' });
  });
  it('2fa reset throws when there is no admin', () => {
    const db = openDb(':memory:');
    expect(() => runTotpReset(db)).toThrow(/no admin user/);
  });
  it('passwd changes the hash, signs out every session, clears a 2FA lock, drops pending challenges, and audits password_reset', async () => {
    const db = openDb(':memory:');
    await runInit(db, { username: 'alex', password: 'old-password!!' });
    const admin = getAdmin(db)!;
    createSession(db, admin.id, 60_000, '', '');
    createSession(db, admin.id, 60_000, '', '');
    const challenge = createChallenge(db, admin.id, 60_000, '', '');
    const ring: KeyRing = { current: 1, keys: new Map([[1, randomBytes(32)]]) };
    savePendingTotp(db, ring, admin.id, randomBytes(20));
    db.prepare(`UPDATE admin_totp SET locked_until = ? WHERE admin_id = ?`).run(Date.now() + 60_000, admin.id);

    const result = await runPasswordReset(db, 'brand-new-pass1');
    expect(result).toEqual({ username: 'alex', sessions: 2 });
    expect(await verifyPassword(getAdmin(db)!.password_hash, 'brand-new-pass1')).toBe(true);
    expect(await verifyPassword(getAdmin(db)!.password_hash, 'old-password!!')).toBe(false);
    expect((db.prepare(`SELECT COUNT(*) AS c FROM sessions`).get() as { c: number }).c).toBe(0);
    expect(factorLockedUntil(db, admin.id)).toBeNull();
    expect(getChallenge(db, challenge)).toBeNull();
    const rows = listAudit(db, { action: 'auth.password_reset' });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.meta).toEqual({ via: 'shell' });
  });
  it('passwd throws when there is no admin', async () => {
    const db = openDb(':memory:');
    await expect(runPasswordReset(db, 'brand-new-pass1')).rejects.toThrow(/no admin user/);
  });
  it('passwd throws the validator message for a too-short password', async () => {
    const db = openDb(':memory:');
    await runInit(db, { username: 'alex', password: 'old-password!!' });
    await expect(runPasswordReset(db, 'short')).rejects.toThrow('Password must be at least 12 characters.');
  });
  it('backup writes a consistent copy and prunes old ones', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pidb-backup-'));
    const db = openDb(join(dir, 'pidb.sqlite'));
    db.prepare(`INSERT INTO projects (slug, name, created_at, updated_at) VALUES ('p', 'P', 0, 0)`).run();
    const out = join(dir, 'backups');
    for (let i = 0; i < 3; i++) {
      runBackup(db, out, 2, new Date(Date.UTC(2001, 0, i + 1)));
    }
    const files = readdirSync(out).sort();
    expect(files).toEqual(['pidb-2001-01-02T00-00-00.sqlite', 'pidb-2001-01-03T00-00-00.sqlite']);
    const copy = new Database(join(out, files[1]!), { readonly: true });
    expect(copy.prepare(`SELECT COUNT(*) AS c FROM projects`).get()).toEqual({ c: 1 });
    copy.close();
    db.close();
  });
  it('backup passes integrity_check, and leaves no .tmp file behind', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pidb-backup-'));
    const db = openDb(join(dir, 'pidb.sqlite'));
    const out = join(dir, 'backups');
    const file = runBackup(db, out, 14, new Date(Date.UTC(2001, 0, 1)));
    const copy = new Database(file, { readonly: true, fileMustExist: true });
    expect(copy.pragma('integrity_check', { simple: true })).toBe('ok');
    copy.close();
    expect(readdirSync(out).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    db.close();
  });
  it('backup removes a stale .tmp from a crashed run, prunes to `keep`, and keeps the newest ones (Review Focus 5)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pidb-backup-'));
    const db = openDb(join(dir, 'pidb.sqlite'));
    const out = join(dir, 'backups');
    mkdirSync(out, { recursive: true });
    const keep = 2;
    // Pre-seed `keep` real backups with older stamps, so pruning has something to do, plus a
    // stale .tmp from a crashed run that must never count toward `keep` or survive.
    for (let i = 0; i < keep; i++) {
      writeFileSync(join(out, `pidb-2000-01-0${i + 1}T00-00-00.sqlite`), 'old backup');
    }
    const stale = join(out, 'pidb-2020-01-01T00-00-00.sqlite.tmp');
    writeFileSync(stale, 'garbage from a crashed run');

    const file = runBackup(db, out, keep, new Date(Date.UTC(2001, 0, 1)));

    expect(existsSync(stale)).toBe(false);
    const files = readdirSync(out).filter((f) => f.endsWith('.sqlite')).sort();
    // Exactly `keep` remain: the oldest pre-seeded backup (2000-01-01) is pruned; its
    // successor (2000-01-02) and the just-written one (2001-01-01) are the newest `keep` and survive.
    expect(files).toEqual(['pidb-2000-01-02T00-00-00.sqlite', 'pidb-2001-01-01T00-00-00.sqlite']);
    expect(files).toHaveLength(keep);
    expect(file).toBe(join(out, 'pidb-2001-01-01T00-00-00.sqlite'));
    db.close();
  });
  it('backup deletes the temp file and throws when the integrity check fails, leaving no final file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pidb-backup-'));
    const db = openDb(join(dir, 'pidb.sqlite'));
    const out = join(dir, 'backups');
    const failingVerify = () => {
      throw new Error('backup integrity check failed: corrupt');
    };
    expect(() => runBackup(db, out, 14, new Date(Date.UTC(2001, 0, 1)), failingVerify)).toThrow(/integrity check failed/);
    expect(readdirSync(out)).toEqual([]);
    db.close();
  });
});

describe('pidb-server cli', () => {
  it('exits 1 with a clear message when the master key is missing', () => {
    const root = fileURLToPath(new URL('../../..', import.meta.url));
    const r = spawnSync(
      join(root, 'node_modules/.bin/tsx'),
      [join(root, 'packages/server/src/cli.ts'), 'rotate-key'],
      { env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' }, encoding: 'utf8' },
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('PIDB_MASTER_KEY');
  });
  it('key-versions (spawned): exits 0 when the current key decrypts everything, 1 when it does not', () => {
    const root = fileURLToPath(new URL('../../..', import.meta.url));
    const dir = mkdtempSync(join(tmpdir(), 'pidb-key-versions-'));
    const dbPath = join(dir, 'pidb.sqlite');
    const keyBuf = randomBytes(32);

    const db = openDb(dbPath);
    const ring: KeyRing = { current: 1, keys: new Map([[1, keyBuf]]) };
    createSecret(db, ring, { projectId: null, name: 'A', description: '', tags: [], fields: [{ key: 'k', value: 'v' }] });
    db.close();

    const tsx = join(root, 'node_modules/.bin/tsx');
    const cli = join(root, 'packages/server/src/cli.ts');
    const baseEnv = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', PIDB_DB_PATH: dbPath, PIDB_DATA_DIR: dir };

    const ok = spawnSync(tsx, [cli, 'key-versions'], { env: { ...baseEnv, PIDB_MASTER_KEY: keyBuf.toString('base64') }, encoding: 'utf8' });
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain('secrets v1: 1 rows, ok');

    const bad = spawnSync(tsx, [cli, 'key-versions'], { env: { ...baseEnv, PIDB_MASTER_KEY: randomBytes(32).toString('base64') }, encoding: 'utf8' });
    expect(bad.status).toBe(1);
    expect(bad.stdout).toContain('WRONG KEY');
  });
  it('key-versions (spawned): exits 1 with "no database" and creates no file when the db is missing (F2)', () => {
    const root = fileURLToPath(new URL('../../..', import.meta.url));
    const dir = mkdtempSync(join(tmpdir(), 'pidb-no-db-'));
    const dbPath = join(dir, 'pidb.sqlite');
    const tsx = join(root, 'node_modules/.bin/tsx');
    const cli = join(root, 'packages/server/src/cli.ts');
    const env = {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      PIDB_DATA_DIR: dir,
      PIDB_DB_PATH: dbPath,
      PIDB_MASTER_KEY: randomBytes(32).toString('base64'),
    };

    const r = spawnSync(tsx, [cli, 'key-versions'], { env, encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`error: no database at ${dbPath} — run init first (or check PIDB_DATA_DIR / the restore)`);
    expect(existsSync(dbPath)).toBe(false);
  });
});
