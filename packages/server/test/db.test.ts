import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db/connection.js';
import Database from 'better-sqlite3';
import { MIGRATIONS, runMigrations } from '../src/db/migrations.js';

describe('db', () => {
  it('creates all tables', () => {
    const db = openDb(':memory:');
    const names = db
      .prepare(`SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name`)
      .all()
      .map((r) => (r as { name: string }).name);
    for (const t of ['projects', 'secrets', 'secret_fields', 'documents', 'documents_fts', 'api_tokens', 'audit_log', 'admin', 'sessions', 'schema_migrations']) {
      expect(names).toContain(t);
    }
  });
  it('is idempotent', () => {
    const db = openDb(':memory:');
    expect(runMigrations(db)).toBe(0);
  });
  it('migration 3 adds the second-factor lockout columns to an existing admin_totp row', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)`);
    for (const m of MIGRATIONS.filter((x) => x.id <= 2)) {
      db.exec(m.sql);
      db.prepare(`INSERT INTO schema_migrations (id, applied_at) VALUES (?, 0)`).run(m.id);
    }
    db.prepare(`INSERT INTO admin (id, username, password_hash, created_at) VALUES (1, 'a', 'h', 0)`).run();
    db.prepare(`INSERT INTO admin_totp (admin_id, secret_enc, key_version, enabled_at, last_used_step, created_at) VALUES (1, x'00', 1, 5, 0, 0)`).run();
    expect(runMigrations(db)).toBe(1);
    expect(db.prepare(`SELECT failed_count, locked_until FROM admin_totp WHERE admin_id = 1`).get()).toEqual({ failed_count: 0, locked_until: null });
  });
  it('enforces foreign keys with cascade', () => {
    const db = openDb(':memory:');
    db.prepare(`INSERT INTO projects (id, slug, name, created_at, updated_at) VALUES (1, 'p', 'P', 0, 0)`).run();
    db.prepare(`INSERT INTO documents (project_id, slug, title, category, body_md, created_at, updated_at) VALUES (1, 'd', 'D', 'notes', 'x', 0, 0)`).run();
    db.prepare(`DELETE FROM projects WHERE id = 1`).run();
    expect(db.prepare(`SELECT COUNT(*) AS c FROM documents`).get()).toEqual({ c: 0 });
  });
  it('keeps FTS index in sync via triggers', () => {
    const db = openDb(':memory:');
    db.prepare(`INSERT INTO documents (id, project_id, slug, title, category, body_md, created_at, updated_at) VALUES (7, NULL, 'g', 'Guide', 'guidelines', 'deploy with caddy', 0, 0)`).run();
    const hit = db.prepare(`SELECT rowid FROM documents_fts WHERE documents_fts MATCH 'caddy'`).all();
    expect(hit).toEqual([{ rowid: 7 }]);
    db.prepare(`UPDATE documents SET body_md = 'deploy with nginx' WHERE id = 7`).run();
    expect(db.prepare(`SELECT rowid FROM documents_fts WHERE documents_fts MATCH 'caddy'`).all()).toEqual([]);
    expect(db.prepare(`SELECT rowid FROM documents_fts WHERE documents_fts MATCH 'nginx'`).all()).toEqual([{ rowid: 7 }]);
    db.prepare(`DELETE FROM documents WHERE id = 7`).run();
    expect(db.prepare(`SELECT rowid FROM documents_fts WHERE documents_fts MATCH 'nginx'`).all()).toEqual([]);
  });
  it('enforces unique secret name per project including global', () => {
    const db = openDb(':memory:');
    const ins = db.prepare(`INSERT INTO secrets (project_id, name, dek_wrapped, key_version, created_at, updated_at) VALUES (?, 'A', x'00', 1, 0, 0)`);
    ins.run(null);
    expect(() => ins.run(null)).toThrow(/UNIQUE/);
  });
});
