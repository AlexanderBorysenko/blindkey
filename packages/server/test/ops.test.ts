import { describe, it, expect } from 'vitest';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { openDb } from '../src/db/connection.js';
import { runInit, runRotateKey, runBackup } from '../src/ops.js';
import { getAdmin } from '../src/repos/admin.js';
import { getDocument } from '../src/repos/documents.js';
import { createSecret, revealField } from '../src/repos/secrets.js';
import { verifyPassword } from '../src/crypto/passwords.js';
import type { KeyRing } from '../src/config.js';

describe('ops', () => {
  it('init creates admin and seeds guidelines once', async () => {
    const db = openDb(':memory:');
    const first = await runInit(db, { username: 'alex', password: 'pw' });
    expect(first).toEqual({ adminCreated: true, guidelinesSeeded: true });
    expect(await verifyPassword(getAdmin(db)!.password_hash, 'pw')).toBe(true);
    expect(getDocument(db, null, 'guidelines')?.category).toBe('guidelines');
    const second = await runInit(db, { username: 'other', password: 'x' });
    expect(second).toEqual({ adminCreated: false, guidelinesSeeded: false });
    expect(getAdmin(db)!.username).toBe('alex');
  });
  it('rotate-key rewraps secrets', () => {
    const db = openDb(':memory:');
    const ring1: KeyRing = { current: 1, keys: new Map([[1, randomBytes(32)]]) };
    const s = createSecret(db, ring1, { projectId: null, name: 'A', description: '', tags: [], fields: [{ key: 'k', value: 'v' }] });
    const ring2: KeyRing = { current: 2, keys: new Map([[1, ring1.keys.get(1)!], [2, randomBytes(32)]]) };
    expect(runRotateKey(db, ring2)).toBe(1);
    expect(revealField(db, { current: 2, keys: new Map([[2, ring2.keys.get(2)!]]) }, s.id, 'k')).toBe('v');
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
});
