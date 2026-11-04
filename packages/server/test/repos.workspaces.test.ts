import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { openDb, type Db } from '../src/db/connection.js';
import { MIGRATIONS, runMigrations } from '../src/db/migrations.js';
import type { KeyRing } from '../src/config.js';
import { ConflictError, NotFoundError, ValidationError } from '../src/errors.js';
import {
  createAdmin, createUser, createSession, deleteUser, getAdminById, getSession, getUserByUsername, listUsers,
  setUserDisabled, setUserMustChangePassword, setUserSuper, setUserPasswordHash, getAdminByUsername,
} from '../src/repos/admin.js';
import { createProject, deleteProject, getProjectById, moveProject } from '../src/repos/projects.js';
import { createSecret, deleteSecret, getSecretMeta, getSecretMetaById, listSecrets, moveGlobalSecret } from '../src/repos/secrets.js';
import { deleteDocument, getDocument, listDocuments, moveGlobalDocument, upsertDocument } from '../src/repos/documents.js';
import {
  addOwner, createWorkspace, deleteWorkspace, getWorkspaceBySlug, isOwner, listOwnedWorkspaces, listOwnerIds,
  listVisibleWorkspaces, listWorkspaces, removeOwner, updateWorkspace,
} from '../src/repos/workspaces.js';
import { deleteGrant, getGrant, listGrantsForTarget, listGrantsForUser, listGrantsForWorkspace, upsertGrant } from '../src/repos/grants.js';

const ring: KeyRing = { current: 1, keys: new Map([[1, randomBytes(32)]]) };
const pinput = (slug: string) => ({ slug, name: slug.toUpperCase(), status: 'active' as const, tags: [], summary: '' });
const sinput = (name: string) => ({ name, description: '', tags: [], fields: [{ key: 'token', value: 'v' }] });

/** Id of a workspace by slug; any slug other than the seeded `default` is created on first use. */
function ws(db: Db, slug: string): number {
  return (getWorkspaceBySlug(db, slug) ?? createWorkspace(db, { slug, name: slug[0]!.toUpperCase() + slug.slice(1) })).id;
}

describe('migration 7', () => {
  it('fresh DB gets only the default workspace and no owners', () => {
    const db = openDb(':memory:');
    expect(listWorkspaces(db).map((w) => [w.slug, w.name])).toEqual([['default', 'Default']]);
    expect(listOwnerIds(db, ws(db, 'default'))).toEqual([]);
  });

  it('init-style first admin becomes super and owns the ownerless default workspace', () => {
    const db = openDb(':memory:');
    const a = createAdmin(db, 'root', 'hash');
    expect(a.is_super).toBe(true);
    expect(listOwnedWorkspaces(db, a.id).map((w) => w.slug)).toEqual(['default']);
    expect(() => createAdmin(db, 'second', 'hash')).toThrow(ConflictError);
  });

  it('moves a populated pre-7 database into default', () => {
    const raw = new Database(':memory:');
    raw.pragma('foreign_keys = ON');
    raw.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)`);
    for (const m of MIGRATIONS.filter((x) => x.id <= 6)) {
      raw.exec(m.sql);
      raw.prepare(`INSERT INTO schema_migrations (id, applied_at) VALUES (?, 0)`).run(m.id);
    }
    raw.prepare(`INSERT INTO admin (username, password_hash, created_at) VALUES ('owner', 'h', 1), ('later', 'h', 2)`).run();
    raw.prepare(`INSERT INTO projects (id, slug, name, created_at, updated_at) VALUES (1, 'p1', 'P1', 1, 1), (2, 'p2', 'P2', 1, 1)`).run();
    raw.prepare(`INSERT INTO secrets (project_id, name, dek_wrapped, key_version, created_at, updated_at) VALUES (1, 's', x'00', 1, 1, 1), (NULL, 'g', x'00', 1, 1, 1)`).run();
    raw.prepare(`INSERT INTO documents (project_id, slug, title, category, created_at, updated_at) VALUES (2, 'd', 'D', 'context', 1, 1), (NULL, 'gd', 'GD', 'guidelines', 1, 1)`).run();
    raw.prepare(`INSERT INTO api_tokens (name, prefix, token_hash, scopes, created_at) VALUES ('t', 'pre', 'hash', '[]', 1)`).run();
    raw.prepare(
      `INSERT INTO connect_requests (device_hash, user_code, name, scopes, projects, expires_days, status, created_at, expires_at)
       VALUES ('dh', 'uc', 'n', '[]', '[]', 1, 'pending', 1, 2)`,
    ).run();
    raw.prepare(`INSERT INTO sessions (id, admin_id, expires_at, created_at) VALUES ('sess', 1, 9999999999999, 1)`).run();

    expect(runMigrations(raw)).toBe(MIGRATIONS.filter((x) => x.id > 6).length);

    const home = (raw.prepare(`SELECT id FROM workspaces WHERE slug = 'default'`).get() as { id: number }).id;
    const count = (sql: string) => (raw.prepare(sql).get() as { n: number }).n;
    expect(count(`SELECT COUNT(*) AS n FROM projects WHERE workspace_id = ${home}`)).toBe(2);
    expect(count(`SELECT COUNT(*) AS n FROM secrets WHERE workspace_id = ${home}`)).toBe(2);
    expect(count(`SELECT COUNT(*) AS n FROM documents WHERE workspace_id = ${home}`)).toBe(2);
    expect(count(`SELECT COUNT(*) AS n FROM projects WHERE workspace_id IS NULL`)).toBe(0);
    expect(count(`SELECT COUNT(*) AS n FROM admin WHERE is_super = 1`)).toBe(2);
    expect(count(`SELECT COUNT(*) AS n FROM workspaces`)).toBe(1);
    // 2 users x the one workspace
    expect(count(`SELECT COUNT(*) AS n FROM workspace_owners`)).toBe(2);
    expect(count(`SELECT COUNT(*) AS n FROM workspace_owners WHERE user_id = 1`)).toBe(1);
    expect(count(`SELECT COUNT(*) AS n FROM api_tokens WHERE user_id = 1`)).toBe(1);
    expect(count(`SELECT COUNT(*) AS n FROM connect_requests WHERE approved_by_user_id = 1`)).toBe(1);
    // existing session still resolves
    expect(getSession(raw, 'sess')?.admin_id).toBe(1);
  });
});

describe('workspace-scoped uniqueness', () => {
  it('allows the same global secret name in two workspaces, rejects twice in one', () => {
    const db = openDb(':memory:');
    const a = ws(db, 'default');
    const b = ws(db, 'second');
    createSecret(db, ring, { ...sinput('SHARED'), projectId: null, workspaceId: a });
    createSecret(db, ring, { ...sinput('SHARED'), projectId: null, workspaceId: b });
    expect(() => createSecret(db, ring, { ...sinput('SHARED'), projectId: null, workspaceId: a })).toThrow(ConflictError);
    expect(getSecretMeta(db, ring, null, 'SHARED', a)!.workspace_id).toBe(a);
    expect(getSecretMeta(db, ring, null, 'SHARED', b)!.workspace_id).toBe(b);
    expect(listSecrets(db, ring, null, b)).toHaveLength(1);
    expect(deleteSecret(db, null, 'SHARED', b)).toBe(true);
    expect(getSecretMeta(db, ring, null, 'SHARED', b)).toBeNull();
    expect(getSecretMeta(db, ring, null, 'SHARED', a)).not.toBeNull();
  });

  it('same for global documents', () => {
    const db = openDb(':memory:');
    const a = ws(db, 'default');
    const b = ws(db, 'second');
    const base = { projectId: null, slug: 'notes', title: 'N', category: 'context' as const, body_md: 'x' };
    expect(upsertDocument(db, { ...base, workspaceId: a }).created).toBe(true);
    expect(upsertDocument(db, { ...base, workspaceId: b }).created).toBe(true);
    expect(upsertDocument(db, { ...base, workspaceId: a, body_md: 'y' }).created).toBe(false);
    expect(getDocument(db, null, 'notes', a)!.body_md).toBe('y');
    expect(getDocument(db, null, 'notes', b)!.body_md).toBe('x');
    expect(listDocuments(db, null, a)).toHaveLength(1);
    expect(deleteDocument(db, null, 'notes', a)).toBe(true);
    expect(getDocument(db, null, 'notes', b)).not.toBeNull();
  });

  it('project items are unique per project and inherit its workspace', () => {
    const db = openDb(':memory:');
    const second = ws(db, 'second');
    const p1 = createProject(db, pinput('p1'), second);
    const p2 = createProject(db, pinput('p2'), second);
    const s1 = createSecret(db, ring, { ...sinput('K'), projectId: p1.id });
    createSecret(db, ring, { ...sinput('K'), projectId: p2.id });
    expect(s1.workspace_id).toBe(second);
    expect(() => createSecret(db, ring, { ...sinput('K'), projectId: p1.id })).toThrow(ConflictError);
    const d = upsertDocument(db, { projectId: p1.id, slug: 'a', title: 'A', category: 'context', body_md: '' });
    expect(d.doc.workspace_id).toBe(second);
    expect(() => createSecret(db, ring, { ...sinput('K'), projectId: 9999 })).toThrow(NotFoundError);
  });

  it('createProject refuses to guess a workspace', () => {
    const db = openDb(':memory:');
    expect(() => createProject(db, pinput('p'), undefined as unknown as number)).toThrow(/workspaceId is required/);
    expect(createProject(db, pinput('p'), ws(db, 'default')).workspace_id).toBe(ws(db, 'default'));
  });
});

describe('moveProject / move globals', () => {
  it('moves the project with its secrets and documents', () => {
    const db = openDb(':memory:');
    const p = createProject(db, pinput('p'), ws(db, 'default'));
    const s = createSecret(db, ring, { ...sinput('K'), projectId: p.id });
    upsertDocument(db, { projectId: p.id, slug: 'a', title: 'A', category: 'context', body_md: '' });
    const other = createProject(db, pinput('other'), ws(db, 'default'));
    const sOther = createSecret(db, ring, { ...sinput('K'), projectId: other.id });
    const second = ws(db, 'second');
    const moved = moveProject(db, p.id, second);
    expect(moved.workspace_id).toBe(second);
    expect(getSecretMetaById(db, ring, s.id)!.workspace_id).toBe(second);
    expect(getDocument(db, p.id, 'a')!.workspace_id).toBe(second);
    expect(getSecretMetaById(db, ring, sOther.id)!.workspace_id).toBe(ws(db, 'default'));
    expect(getProjectById(db, other.id)!.workspace_id).toBe(ws(db, 'default'));
    expect(() => moveProject(db, 999, second)).toThrow(NotFoundError);
    expect(() => moveProject(db, p.id, 999)).toThrow(NotFoundError);
  });

  it('keeps grants when a project moves', () => {
    const db = openDb(':memory:');
    const u = createUser(db, { username: 'u', passwordHash: 'h' });
    const p = createProject(db, pinput('p'), ws(db, 'default'));
    upsertGrant(db, { userId: u.id, targetType: 'project', targetId: p.id, perms: '*' });
    moveProject(db, p.id, ws(db, 'second'));
    expect(getGrant(db, u.id, 'project', p.id)).not.toBeNull();
  });

  it('moves a global secret or doc, 409 on a name conflict', () => {
    const db = openDb(':memory:');
    const a = ws(db, 'default');
    const b = ws(db, 'second');
    const s = createSecret(db, ring, { ...sinput('G'), projectId: null, workspaceId: a });
    expect(moveGlobalSecret(db, ring, s.id, b).workspace_id).toBe(b);
    const s2 = createSecret(db, ring, { ...sinput('G'), projectId: null, workspaceId: a });
    expect(() => moveGlobalSecret(db, ring, s2.id, b)).toThrow(ConflictError);
    expect(getSecretMetaById(db, ring, s2.id)!.workspace_id).toBe(a);

    const base = { projectId: null, title: 'T', category: 'context' as const, body_md: '' };
    const d = upsertDocument(db, { ...base, slug: 'g', workspaceId: a }).doc;
    expect(moveGlobalDocument(db, d.id, b).workspace_id).toBe(b);
    const d2 = upsertDocument(db, { ...base, slug: 'g', workspaceId: a }).doc;
    expect(() => moveGlobalDocument(db, d2.id, b)).toThrow(ConflictError);

    const p = createProject(db, pinput('p'), a);
    const ps = createSecret(db, ring, { ...sinput('X'), projectId: p.id });
    expect(() => moveGlobalSecret(db, ring, ps.id, b)).toThrow(ConflictError);
    expect(() => moveGlobalSecret(db, ring, 9999, b)).toThrow(NotFoundError);
  });
});

describe('grants', () => {
  it('normalizes, validates and upserts', () => {
    const db = openDb(':memory:');
    const u = createUser(db, { username: 'u', passwordHash: 'h' });
    const p = createProject(db, pinput('p'), ws(db, 'default'));
    const s = createSecret(db, ring, { ...sinput('K'), projectId: p.id });
    const g = upsertGrant(db, { userId: u.id, targetType: 'secret', targetId: s.id, perms: ['protected.*', 'cli', 'cli'] });
    expect(g.perms).toEqual(['protected.read', 'protected.write', 'cli']);
    const g2 = upsertGrant(db, { userId: u.id, targetType: 'secret', targetId: s.id, perms: ['public.read'] });
    expect(g2.id).toBe(g.id);
    expect(g2.perms).toEqual(['public.read']);
    expect(upsertGrant(db, { userId: u.id, targetType: 'project', targetId: p.id, perms: '*' }).perms).toHaveLength(7);
    expect(() => upsertGrant(db, { userId: u.id, targetType: 'secret', targetId: s.id, perms: '*' })).toThrow(ValidationError);
    expect(() => upsertGrant(db, { userId: u.id, targetType: 'document', targetId: 1, perms: ['cli'] })).toThrow(ValidationError);
    expect(() => upsertGrant(db, { userId: u.id, targetType: 'project', targetId: p.id, perms: ['bogus'] })).toThrow(ValidationError);
    expect(() => upsertGrant(db, { userId: u.id, targetType: 'project', targetId: p.id, perms: [] })).toThrow(ValidationError);
  });

  it('lists per user, target and workspace; deletes', () => {
    const db = openDb(':memory:');
    const u1 = createUser(db, { username: 'u1', passwordHash: 'h' });
    const u2 = createUser(db, { username: 'u2', passwordHash: 'h' });
    const p = createProject(db, pinput('p'), ws(db, 'default'));
    const q = createProject(db, pinput('q'), ws(db, 'second'));
    upsertGrant(db, { userId: u1.id, targetType: 'project', targetId: p.id, perms: '*' });
    upsertGrant(db, { userId: u2.id, targetType: 'project', targetId: p.id, perms: ['docs.read'] });
    upsertGrant(db, { userId: u1.id, targetType: 'project', targetId: q.id, perms: '*' });
    expect(listGrantsForUser(db, u1.id)).toHaveLength(2);
    expect(listGrantsForTarget(db, 'project', p.id).map((g) => g.user_id)).toEqual([u1.id, u2.id]);
    expect(listGrantsForWorkspace(db, ws(db, 'default'))).toHaveLength(2);
    expect(listGrantsForWorkspace(db, ws(db, 'second'))).toHaveLength(1);
    expect(deleteGrant(db, u1.id, 'project', p.id)).toBe(true);
    expect(deleteGrant(db, u1.id, 'project', p.id)).toBe(false);
  });

  it('is removed with the user', () => {
    const db = openDb(':memory:');
    const u = createUser(db, { username: 'u', passwordHash: 'h' });
    const p = createProject(db, pinput('p'), ws(db, 'default'));
    upsertGrant(db, { userId: u.id, targetType: 'project', targetId: p.id, perms: '*' });
    deleteUser(db, u.id);
    expect(listGrantsForTarget(db, 'project', p.id)).toEqual([]);
  });

  describe('cleanup triggers (ids are reused)', () => {
    it('direct delete of a secret, document and project removes grants', () => {
      const db = openDb(':memory:');
      const u = createUser(db, { username: 'u', passwordHash: 'h' });
      const home = ws(db, 'default');
      const s = createSecret(db, ring, { ...sinput('G'), projectId: null, workspaceId: home });
      const d = upsertDocument(db, { projectId: null, workspaceId: home, slug: 'g', title: 'G', category: 'context', body_md: '' }).doc;
      const p = createProject(db, pinput('p'), home);
      upsertGrant(db, { userId: u.id, targetType: 'secret', targetId: s.id, perms: ['cli'] });
      upsertGrant(db, { userId: u.id, targetType: 'document', targetId: d.id, perms: ['docs.read'] });
      upsertGrant(db, { userId: u.id, targetType: 'project', targetId: p.id, perms: '*' });
      deleteSecret(db, null, 'G', home);
      deleteDocument(db, null, 'g', home);
      deleteProject(db, p.id);
      expect(listGrantsForUser(db, u.id)).toEqual([]);
    });

    it('project delete cascades to its secrets/docs and their grants', () => {
      const db = openDb(':memory:');
      const u = createUser(db, { username: 'u', passwordHash: 'h' });
      const p = createProject(db, pinput('p'), ws(db, 'default'));
      const s = createSecret(db, ring, { ...sinput('K'), projectId: p.id });
      const d = upsertDocument(db, { projectId: p.id, slug: 'a', title: 'A', category: 'context', body_md: '' }).doc;
      upsertGrant(db, { userId: u.id, targetType: 'secret', targetId: s.id, perms: ['protected.read'] });
      upsertGrant(db, { userId: u.id, targetType: 'document', targetId: d.id, perms: ['docs.write'] });
      upsertGrant(db, { userId: u.id, targetType: 'project', targetId: p.id, perms: ['public.read'] });
      expect(deleteProject(db, p.id)).toBe(true);
      expect(listGrantsForUser(db, u.id)).toEqual([]);
    });

    it('a row that reuses a deleted id does not inherit the old grant', () => {
      const db = openDb(':memory:');
      const u = createUser(db, { username: 'u', passwordHash: 'h' });
      const home = ws(db, 'default');
      const p = createProject(db, pinput('p'), home);
      const s = createSecret(db, ring, { ...sinput('K'), projectId: p.id });
      upsertGrant(db, { userId: u.id, targetType: 'secret', targetId: s.id, perms: ['protected.read'] });
      upsertGrant(db, { userId: u.id, targetType: 'project', targetId: p.id, perms: '*' });
      deleteProject(db, p.id);
      const p2 = createProject(db, pinput('p2'), home);
      const s2 = createSecret(db, ring, { ...sinput('K2'), projectId: p2.id });
      // without AUTOINCREMENT SQLite reuses the freed rowids
      expect(p2.id).toBe(p.id);
      expect(s2.id).toBe(s.id);
      expect(getGrant(db, u.id, 'project', p2.id)).toBeNull();
      expect(getGrant(db, u.id, 'secret', s2.id)).toBeNull();
    });
  });
});

describe('workspaces repo', () => {
  it('CRUD with slug conflicts', () => {
    const db = openDb(':memory:');
    const w = createWorkspace(db, { slug: 'new', name: 'New' });
    expect(() => createWorkspace(db, { slug: 'new', name: 'Dup' })).toThrow(ConflictError);
    expect(updateWorkspace(db, w.id, { name: 'Renamed' }).name).toBe('Renamed');
    expect(() => updateWorkspace(db, w.id, { slug: 'default' })).toThrow(ConflictError);
    expect(() => updateWorkspace(db, 999, { name: 'x' })).toThrow(NotFoundError);
    expect(deleteWorkspace(db, w.id)).toBe(true);
    expect(deleteWorkspace(db, w.id)).toBe(false);
  });

  it('refuses to delete a non-empty workspace', () => {
    const db = openDb(':memory:');
    const w = createWorkspace(db, { slug: 'new', name: 'New' });
    createProject(db, pinput('p'), w.id);
    expect(() => deleteWorkspace(db, w.id)).toThrow(ConflictError);
  });

  it('owners add/remove/list and isOwner', () => {
    const db = openDb(':memory:');
    const u = createUser(db, { username: 'u', passwordHash: 'h' });
    const w = createWorkspace(db, { slug: 'new', name: 'New' });
    expect(isOwner(db, w.id, u.id)).toBe(false);
    expect(addOwner(db, w.id, u.id)).toBe(true);
    expect(addOwner(db, w.id, u.id)).toBe(false);
    expect(isOwner(db, w.id, u.id)).toBe(true);
    expect(listOwnerIds(db, w.id)).toEqual([u.id]);
    expect(removeOwner(db, w.id, u.id)).toBe(true);
    expect(isOwner(db, w.id, u.id)).toBe(false);
  });

  it('visible = owned or holding any grant', () => {
    const db = openDb(':memory:');
    const u = createUser(db, { username: 'u', passwordHash: 'h' });
    expect(listVisibleWorkspaces(db, u.id)).toEqual([]);
    addOwner(db, ws(db, 'default'), u.id);
    const second = ws(db, 'second');
    const mine = ws(db, 'third');
    const p = createProject(db, pinput('p'), second);
    const g = createSecret(db, ring, { ...sinput('G'), projectId: null, workspaceId: mine });
    upsertGrant(db, { userId: u.id, targetType: 'project', targetId: p.id, perms: '*' });
    expect(listVisibleWorkspaces(db, u.id).map((w) => w.slug)).toEqual(['default', 'second']);
    upsertGrant(db, { userId: u.id, targetType: 'secret', targetId: g.id, perms: ['cli'] });
    expect(listVisibleWorkspaces(db, u.id).map((w) => w.slug).sort()).toEqual(['default', 'second', 'third']);
    deleteGrant(db, u.id, 'project', p.id);
    expect(listVisibleWorkspaces(db, u.id).map((w) => w.slug).sort()).toEqual(['default', 'third']);
  });
});

describe('users repo', () => {
  it('create, lookup, list, flags, delete', () => {
    const db = openDb(':memory:');
    const u = createUser(db, { username: 'Bob', passwordHash: 'h1', mustChangePassword: true });
    expect(u.is_super).toBe(false);
    expect(u.must_change_password).toBe(true);
    expect(u.disabled_at).toBeNull();
    expect(() => createUser(db, { username: 'Bob', passwordHash: 'x' })).toThrow(ConflictError);
    createUser(db, { username: 'alice', passwordHash: 'h', isSuper: true });
    expect(listUsers(db).map((x) => x.username)).toEqual(['alice', 'Bob']);
    expect(getUserByUsername(db, 'Bob')!.id).toBe(u.id);
    expect(getAdminByUsername(db, 'nobody')).toBeNull();
    expect(setUserMustChangePassword(db, u.id, false)).toBe(true);
    expect(setUserSuper(db, u.id, true)).toBe(true);
    setUserPasswordHash(db, u.id, 'h2');
    const after = getAdminById(db, u.id)!;
    expect(after.must_change_password).toBe(false);
    expect(after.is_super).toBe(true);
    expect(after.password_hash).toBe('h2');
    expect(deleteUser(db, u.id)).toBe(true);
    expect(deleteUser(db, u.id)).toBe(false);
  });

  it('a disabled user session stops resolving, enabling does not revive deleted sessions, delete removes them', () => {
    const db = openDb(':memory:');
    const u = createUser(db, { username: 'u', passwordHash: 'h' });
    const sid = createSession(db, u.id, 60_000, '', '');
    expect(getSession(db, sid)?.admin_id).toBe(u.id);
    expect(getSession(db, sid)?.impersonator_id).toBeNull();
    expect(setUserDisabled(db, u.id, true)).toBe(true);
    expect(getAdminById(db, u.id)!.disabled_at).not.toBeNull();
    expect(getSession(db, sid)).toBeNull();
    setUserDisabled(db, u.id, false);
    expect(getSession(db, sid)).toBeNull();
    const sid2 = createSession(db, u.id, 60_000, '', '');
    expect(getSession(db, sid2)).not.toBeNull();
    // a session created for a disabled user is ignored too
    db.prepare(`UPDATE admin SET disabled_at = 1 WHERE id = ?`).run(u.id);
    expect(getSession(db, sid2)).toBeNull();
    db.prepare(`UPDATE admin SET disabled_at = NULL WHERE id = ?`).run(u.id);
    deleteUser(db, u.id);
    expect(getSession(db, sid2)).toBeNull();
  });

  it('records the impersonator on a session', () => {
    const db = openDb(':memory:');
    const root = createUser(db, { username: 'root', passwordHash: 'h', isSuper: true });
    const u = createUser(db, { username: 'u', passwordHash: 'h' });
    const sid = createSession(db, u.id, 60_000, '', '', root.id);
    expect(getSession(db, sid)?.impersonator_id).toBe(root.id);
  });
});
