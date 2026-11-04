import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { MIGRATIONS, runMigrations } from '../src/db/migrations.js';
import { searchDocuments } from '../src/repos/documents.js';

/** A database as the release before multi-user left it: migrations 1-6 applied. */
function dbAtVersion6(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)`);
  for (const m of MIGRATIONS.filter((x) => x.id <= 6)) {
    db.exec(m.sql);
    db.prepare(`INSERT INTO schema_migrations (id, applied_at) VALUES (?, 0)`).run(m.id);
  }
  return db;
}

const count = (db: Database.Database, sql: string, ...params: unknown[]): number => (db.prepare(sql).get(...params) as { n: number }).n;

describe('migration 7 (multi-user + workspaces) on a populated database', () => {
  it('moves every row into the single default workspace, makes all users supers owning it, and keeps the database consistent', () => {
    const db = dbAtVersion6();
    db.prepare(`INSERT INTO admin (id, username, password_hash, created_at) VALUES (1, 'alex', 'h1', 10), (2, 'sam', 'h2', 20)`).run();
    db.prepare(`INSERT INTO projects (id, slug, name, created_at, updated_at) VALUES (1, 'acme', 'Acme', 0, 0)`).run();
    const secret = db.prepare(`INSERT INTO secrets (id, project_id, name, dek_wrapped, key_version, created_at, updated_at) VALUES (?, ?, ?, x'00', 1, 0, 0)`);
    secret.run(1, null, 'GLOBAL_KEY');
    secret.run(2, 1, 'PROJECT_KEY');
    const field = db.prepare(`INSERT INTO secret_fields (secret_id, key, value_enc, is_sensitive, sort) VALUES (?, ?, x'01', ?, ?)`);
    field.run(1, 'host', 0, 0);
    field.run(1, 'token', 1, 1);
    field.run(2, 'password', 1, 0);
    const doc = db.prepare(`INSERT INTO documents (id, project_id, slug, title, category, body_md, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, 0)`);
    doc.run(1, null, 'guidelines', 'Documentation guidelines', 'guidelines', 'always write down the zebra rules');
    doc.run(2, 1, 'runbook', 'Acme runbook', 'notes', 'restart the caddy proxy');
    const token = db.prepare(`INSERT INTO api_tokens (id, name, prefix, token_hash, scopes, created_at, kind) VALUES (?, ?, ?, ?, '["admin"]', 0, ?)`);
    token.run(1, 'cli', 'aaaa', 'hash-1', 'user');
    token.run(2, 'claude', 'bbbb', 'hash-2', 'agent');
    db.prepare(`INSERT INTO connect_requests (id, device_hash, user_code, name, scopes, projects, expires_days, status, created_at, expires_at) VALUES (1, 'd', 'u', 'n', '[]', '[]', 30, 'approved', 0, 1)`).run();
    db.prepare(`INSERT INTO sessions (id, admin_id, expires_at, created_at) VALUES ('s1', 1, 99, 0), ('s2', 2, 99, 0)`).run();
    db.prepare(`INSERT INTO audit_log (ts, actor_type, actor_id, action) VALUES (1, 'admin', 1, 'old.event')`).run();

    expect(runMigrations(db)).toBe(2); // 7 (this test) + 8 (2FA set up by admin)

    const home = (db.prepare(`SELECT id FROM workspaces WHERE slug = 'default'`).get() as { id: number }).id;
    expect(db.prepare(`SELECT slug, name FROM workspaces ORDER BY slug`).all()).toEqual([
      { slug: 'default', name: 'Default' },
    ]);
    // every project / secret / document carries the workspace — globals and project items alike
    for (const table of ['projects', 'secrets', 'documents']) {
      expect(count(db, `SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id IS NULL`), table).toBe(0);
      expect(count(db, `SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id <> ?`, home), table).toBe(0);
    }
    expect(count(db, `SELECT COUNT(*) AS n FROM secrets`)).toBe(2);
    expect(count(db, `SELECT COUNT(*) AS n FROM secret_fields`)).toBe(3);
    expect(count(db, `SELECT COUNT(*) AS n FROM documents`)).toBe(2);
    // both existing users are supers and own the default workspace
    expect(db.prepare(`SELECT id, is_super, disabled_at, must_change_password FROM admin ORDER BY id`).all()).toEqual([
      { id: 1, is_super: 1, disabled_at: null, must_change_password: 0 },
      { id: 2, is_super: 1, disabled_at: null, must_change_password: 0 },
    ]);
    for (const userId of [1, 2]) expect(count(db, `SELECT COUNT(*) AS n FROM workspace_owners WHERE user_id = ?`, userId)).toBe(1);
    // tokens and connect requests go to the first user; sessions and audit history survive
    expect(count(db, `SELECT COUNT(*) AS n FROM api_tokens WHERE user_id = 1`)).toBe(2);
    expect(count(db, `SELECT COUNT(*) AS n FROM connect_requests WHERE approved_by_user_id = 1`)).toBe(1);
    expect(count(db, `SELECT COUNT(*) AS n FROM sessions WHERE impersonator_id IS NULL`)).toBe(2);
    expect(count(db, `SELECT COUNT(*) AS n FROM audit_log WHERE action = 'old.event' AND workspace_id IS NULL`)).toBe(1);
    // full-text search still finds the documents, through the repo too
    expect(db.prepare(`SELECT rowid FROM documents_fts WHERE documents_fts MATCH 'zebra'`).all()).toEqual([{ rowid: 1 }]);
    expect(db.prepare(`SELECT rowid FROM documents_fts WHERE documents_fts MATCH 'caddy'`).all()).toEqual([{ rowid: 2 }]);
    expect(searchDocuments(db, 'zebra', null).map((h) => [h.slug, h.workspace_id])).toEqual([['guidelines', home]]);
    expect(searchDocuments(db, 'caddy', null).map((h) => [h.slug, h.project_id, h.workspace_id])).toEqual([['runbook', 1, home]]);
    db.prepare(`INSERT INTO documents_fts(documents_fts) VALUES ('integrity-check')`).run();
    // the new uniqueness rules are in force and the database is consistent
    expect(() => db.prepare(`INSERT INTO secrets (project_id, workspace_id, name, dek_wrapped, key_version, created_at, updated_at) VALUES (NULL, ?, 'GLOBAL_KEY', x'00', 1, 0, 0)`).run(home)).toThrow(/UNIQUE/);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
  });
});
