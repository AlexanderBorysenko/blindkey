import type Database from 'better-sqlite3';

export interface Migration {
  id: number;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    sql: `
CREATE TABLE projects (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  tags TEXT NOT NULL DEFAULT '[]',
  summary TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE secrets (
  id INTEGER PRIMARY KEY,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  dek_wrapped BLOB NOT NULL,
  key_version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX secrets_project_name ON secrets(COALESCE(project_id, 0), name);

CREATE TABLE secret_fields (
  id INTEGER PRIMARY KEY,
  secret_id INTEGER NOT NULL REFERENCES secrets(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value_enc BLOB NOT NULL,
  is_sensitive INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  UNIQUE(secret_id, key)
);

CREATE TABLE documents (
  id INTEGER PRIMARY KEY,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  body_md TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX documents_project_slug ON documents(COALESCE(project_id, 0), slug);

CREATE VIRTUAL TABLE documents_fts USING fts5(title, body_md, content='documents', content_rowid='id');
CREATE TRIGGER documents_ai AFTER INSERT ON documents BEGIN
  INSERT INTO documents_fts(rowid, title, body_md) VALUES (new.id, new.title, new.body_md);
END;
CREATE TRIGGER documents_ad AFTER DELETE ON documents BEGIN
  INSERT INTO documents_fts(documents_fts, rowid, title, body_md) VALUES ('delete', old.id, old.title, old.body_md);
END;
CREATE TRIGGER documents_au AFTER UPDATE ON documents BEGIN
  INSERT INTO documents_fts(documents_fts, rowid, title, body_md) VALUES ('delete', old.id, old.title, old.body_md);
  INSERT INTO documents_fts(rowid, title, body_md) VALUES (new.id, new.title, new.body_md);
END;

CREATE TABLE api_tokens (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL,
  project_ids TEXT,
  expires_at INTEGER,
  last_used_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX api_tokens_prefix ON api_tokens(prefix);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id INTEGER,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id INTEGER,
  field_key TEXT,
  ip TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT '',
  meta TEXT
);
CREATE INDEX audit_log_ts ON audit_log(ts);

CREATE TABLE admin (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  admin_id INTEGER NOT NULL REFERENCES admin(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  ip TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT ''
);
`,
  },
  {
    id: 2,
    sql: `
CREATE TABLE admin_totp (
  admin_id INTEGER PRIMARY KEY REFERENCES admin(id) ON DELETE CASCADE,
  secret_enc BLOB NOT NULL,
  key_version INTEGER NOT NULL,
  enabled_at INTEGER,
  last_used_step INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE recovery_codes (
  id INTEGER PRIMARY KEY,
  admin_id INTEGER NOT NULL REFERENCES admin(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX recovery_codes_admin ON recovery_codes(admin_id);
CREATE TABLE login_challenges (
  id TEXT PRIMARY KEY,
  admin_id INTEGER NOT NULL REFERENCES admin(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  ip TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT ''
);
`,
  },
  {
    id: 3,
    sql: `
ALTER TABLE admin_totp ADD COLUMN failed_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE admin_totp ADD COLUMN locked_until INTEGER;
`,
  },
];

export function runMigrations(db: Database.Database): number {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)`);
  const applied = new Set(
    (db.prepare(`SELECT id FROM schema_migrations`).all() as { id: number }[]).map((r) => r.id),
  );
  const insert = db.prepare(`INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)`);
  let count = 0;
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      insert.run(m.id, Date.now());
    })();
    count++;
  }
  return count;
}
