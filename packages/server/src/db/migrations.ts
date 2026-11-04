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
  {
    id: 4,
    sql: `
ALTER TABLE api_tokens ADD COLUMN kind TEXT NOT NULL DEFAULT 'user';
`,
  },
  {
    id: 5,
    sql: `
CREATE TABLE connect_requests (
  id INTEGER PRIMARY KEY,
  device_hash TEXT NOT NULL UNIQUE,
  user_code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  scopes TEXT NOT NULL,
  projects TEXT NOT NULL,
  expires_days INTEGER NOT NULL,
  status TEXT NOT NULL,
  approved_scopes TEXT,
  approved_project_ids TEXT,
  approved_expires_days INTEGER,
  ip TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
`,
  },
  {
    id: 6,
    sql: `
ALTER TABLE api_tokens ADD COLUMN label TEXT;
ALTER TABLE connect_requests ADD COLUMN approved_label TEXT;
`,
  },
  {
    id: 7,
    sql: `
-- Multi-user + workspaces. The table keeps its old name \`admin\` (it now holds every user).
ALTER TABLE admin ADD COLUMN is_super INTEGER NOT NULL DEFAULT 0;
ALTER TABLE admin ADD COLUMN disabled_at INTEGER;
ALTER TABLE admin ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;

CREATE TABLE workspaces (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE workspace_owners (
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES admin(id) ON DELETE CASCADE,
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX workspace_owners_user ON workspace_owners(user_id);

ALTER TABLE projects ADD COLUMN workspace_id INTEGER REFERENCES workspaces(id);
ALTER TABLE secrets ADD COLUMN workspace_id INTEGER REFERENCES workspaces(id);
ALTER TABLE documents ADD COLUMN workspace_id INTEGER REFERENCES workspaces(id);
CREATE INDEX projects_workspace ON projects(workspace_id);
CREATE INDEX secrets_workspace ON secrets(workspace_id);
CREATE INDEX documents_workspace ON documents(workspace_id);

ALTER TABLE api_tokens ADD COLUMN user_id INTEGER REFERENCES admin(id) ON DELETE CASCADE;
ALTER TABLE connect_requests ADD COLUMN approved_by_user_id INTEGER REFERENCES admin(id) ON DELETE SET NULL;
ALTER TABLE sessions ADD COLUMN impersonator_id INTEGER REFERENCES admin(id) ON DELETE CASCADE;
ALTER TABLE audit_log ADD COLUMN workspace_id INTEGER;

-- Globals are unique per workspace, project items per project (replaces COALESCE(project_id, 0)).
DROP INDEX secrets_project_name;
DROP INDEX documents_project_slug;
CREATE UNIQUE INDEX secrets_global_name ON secrets(workspace_id, name) WHERE project_id IS NULL;
CREATE UNIQUE INDEX secrets_project_item_name ON secrets(project_id, name) WHERE project_id IS NOT NULL;
CREATE UNIQUE INDEX documents_global_slug ON documents(workspace_id, slug) WHERE project_id IS NULL;
CREATE UNIQUE INDEX documents_project_item_slug ON documents(project_id, slug) WHERE project_id IS NOT NULL;

CREATE TABLE grants (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES admin(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('project', 'secret', 'document')),
  target_id INTEGER NOT NULL,
  perms TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, target_type, target_id)
);
CREATE INDEX grants_target ON grants(target_type, target_id);

-- Row ids are reused (no AUTOINCREMENT): a stale grant would hand a later row with the same id to its old grantee.
CREATE TRIGGER projects_grants_ad AFTER DELETE ON projects BEGIN
  DELETE FROM grants WHERE target_type = 'project' AND target_id = old.id;
END;
CREATE TRIGGER secrets_grants_ad AFTER DELETE ON secrets BEGIN
  DELETE FROM grants WHERE target_type = 'secret' AND target_id = old.id;
END;
CREATE TRIGGER documents_grants_ad AFTER DELETE ON documents BEGIN
  DELETE FROM grants WHERE target_type = 'document' AND target_id = old.id;
END;

-- Data migration: one default workspace, every existing user is a super owning it, all data lands in it.
INSERT INTO workspaces (slug, name, created_at, updated_at) VALUES
  ('default', 'Default', CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
UPDATE admin SET is_super = 1;
INSERT INTO workspace_owners (workspace_id, user_id) SELECT w.id, a.id FROM workspaces w CROSS JOIN admin a;
UPDATE projects SET workspace_id = (SELECT id FROM workspaces WHERE slug = 'default');
UPDATE secrets SET workspace_id = (SELECT id FROM workspaces WHERE slug = 'default');
UPDATE documents SET workspace_id = (SELECT id FROM workspaces WHERE slug = 'default');
UPDATE api_tokens SET user_id = (SELECT id FROM admin ORDER BY id LIMIT 1);
UPDATE connect_requests SET approved_by_user_id = (SELECT id FROM admin ORDER BY id LIMIT 1);
`,
  },
  {
    id: 8,
    sql: `
-- A super user set up this user's two-factor (new account or 2FA reset): until it is confirmed the user cannot log in.
ALTER TABLE admin ADD COLUMN twofactor_by_admin INTEGER NOT NULL DEFAULT 0;
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
