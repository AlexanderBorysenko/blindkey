import { afterEach, describe, expect, it } from 'vitest';
import { actorOf, jsonAs, makeShared, type Shared } from './access.fixture.js';
import { auth } from './helpers.js';
import type { Actor } from '../src/auth/principal.js';
import { accessFor } from '../src/auth/access.js';
import { AppError, NotFoundError } from '../src/errors.js';
import { createSession, createUser, deleteUser, getSession, setUserDisabled, setUserSuper } from '../src/repos/admin.js';
import { hashPassword } from '../src/crypto/passwords.js';
import { listAudit, writeAudit } from '../src/repos/audit.js';
import { createToken, getTokenById, latestAgentLabel, listTokens, revokeAgentTokensByName } from '../src/repos/tokens.js';
import { createSecret } from '../src/repos/secrets.js';
import { upsertDocument } from '../src/repos/documents.js';
import { addOwner, createWorkspace } from '../src/repos/workspaces.js';
import { createProject } from '../src/repos/projects.js';
import { upsertGrant } from '../src/repos/grants.js';
import { runPasswordReset } from '../src/ops.js';
import { approveConnect, pollConnect, startConnect } from '../src/services/connect.js';
import { createTokenFor, listAuditFor, renameTokenFor, revokeTokenFor, updateTokenProjectsFor } from '../src/services/admin.js';
import { changePassword, mustChangePassword } from '../src/services/password.js';
import { confirmEnrollment, disableTwoFactor, regenerateRecoveryCodes, startEnrollment } from '../src/services/twofactor.js';
import { startImpersonation, stopImpersonation } from '../src/services/users.js';
import { searchFor } from '../src/services/search.js';

let t: Shared;
afterEach(async () => {
  await t?.app.close();
});

const PW = 'Correct-horse-9';

/** The thrown AppError of a sync or async call. */
async function failure(fn: () => unknown): Promise<AppError> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof AppError) return e;
    throw e;
  }
  throw new Error('did not throw');
}

describe('1. agent-token supersede is per user', () => {
  it('a reconnect under the same name revokes only the approver\'s own tokens and inherits only their label', async () => {
    t = await makeShared();
    const owner = t.owner();
    const connect = async (user: Actor, label: string): Promise<{ id: number }> => {
      const start = startConnect(t.ctx, { name: 'claude@laptop', scopes: ['projects:read'], projects: ['alpha'], expires_days: 30 }, '', '', 'http://x');
      approveConnect(t.ctx, user, start.user_code, ['projects:read'], ['alpha'], '30', label);
      return pollConnect(t.ctx, start.device_code, '', '');
    };
    const ownersFirst = await connect(actorOf(owner), 'Owner Mac');
    const bobs = await connect(actorOf(t.bob), '');
    // bob's connect neither revoked the owner's token nor picked up the owner's label
    expect(getTokenById(t.db, ownersFirst.id)!.revoked_at).toBeNull();
    expect(getTokenById(t.db, bobs.id)!.label).toBeNull();
    // the owner reconnecting supersedes only the owner's earlier token and keeps the owner's label
    const ownersSecond = await connect(actorOf(owner), '');
    expect(getTokenById(t.db, ownersFirst.id)!.revoked_at).not.toBeNull();
    expect(getTokenById(t.db, ownersSecond.id)!.label).toBe('Owner Mac');
    expect(getTokenById(t.db, bobs.id)!.revoked_at).toBeNull();
  });

  it('the repo helpers are scoped to the user', async () => {
    t = await makeShared();
    const mk = (userId: number) => createToken(t.db, { userId, name: 'same', scopes: ['projects:read'], projectIds: [], expiresAt: null, kind: 'agent', label: `l${userId}` }).row;
    const a = mk(t.owner().id);
    const b = mk(t.bob.id);
    expect(latestAgentLabel(t.db, t.bob.id, 'same')).toBe(`l${t.bob.id}`);
    expect(revokeAgentTokensByName(t.db, t.bob.id, 'same')).toBe(1);
    expect(getTokenById(t.db, a.id)!.revoked_at).toBeNull();
    expect(getTokenById(t.db, b.id)!.revoked_at).not.toBeNull();
  });
});

describe('2. impersonation sessions do not survive the super\'s credential reset', () => {
  it('a password change and the shell passwd end the sessions the super opened as someone else', async () => {
    t = await makeShared();
    const owner = t.owner();
    t.db.prepare(`UPDATE admin SET password_hash = ?, must_change_password = 0 WHERE id = ?`).run(await hashPassword('Old-password-1'), owner.id);
    const real = createSession(t.db, owner.id, 60_000, '', '');

    // UI password change by the super
    const a = startImpersonation(t.ctx, actorOf(owner), t.bob.id);
    const res = await changePassword(t.ctx, actorOf(owner), { current: 'Old-password-1', next: 'New-password-12', confirm: 'New-password-12', code: '' }, real);
    expect(res.ok).toBe(true);
    expect(getSession(t.db, a)).toBeNull();
    expect(getSession(t.db, real)).not.toBeNull();

    // shell passwd (all sessions)
    const b = startImpersonation(t.ctx, actorOf(owner), t.bob.id);
    await runPasswordReset(t.db, 'Another-password-3', owner.username);
    expect(getSession(t.db, b)).toBeNull();
  });

  it('disabling the super ends them too', async () => {
    t = await makeShared();
    const owner = t.owner();
    const asBob = startImpersonation(t.ctx, actorOf(owner), t.bob.id);
    setUserDisabled(t.db, owner.id, true);
    expect(getSession(t.db, asBob)).toBeNull();
  });

  it('stopping an impersonation yields no session once the real user is no longer an enabled super', async () => {
    t = await makeShared();
    const owner = t.owner();
    const second = createUser(t.db, { username: 'zed', passwordHash: 'h', isSuper: true });
    const asBob = startImpersonation(t.ctx, actorOf(owner), t.bob.id);
    const p = { ...actorOf(t.bob).principal, impersonatorId: owner.id };
    setUserSuper(t.db, owner.id, false);
    const before = (t.db.prepare(`SELECT COUNT(*) AS n FROM sessions`).get() as { n: number }).n;
    expect(() => stopImpersonation(t.ctx, { principal: p, ip: '', userAgent: '' }, asBob)).toThrow(NotFoundError);
    expect((t.db.prepare(`SELECT COUNT(*) AS n FROM sessions`).get() as { n: number }).n).toBe(before);
    expect(second.is_super).toBe(true);
  });
});

describe('3. no credential or token management while impersonating', () => {
  const impersonated = (t0: Shared): Actor => {
    const a = actorOf(t0.bob);
    a.principal = { ...a.principal, impersonatorId: t0.owner().id };
    return a;
  };

  it('refuses token create/rename/revoke/re-scope, connect approval, 2FA changes and password change with 403 forbidden', async () => {
    t = await makeShared();
    const mine = createTokenFor(t.ctx, actorOf(t.bob), { name: 'bobs', scopes: ['docs:read'], projects: ['alpha'] });
    const start = startConnect(t.ctx, { name: 'agent', scopes: ['projects:read'], projects: ['alpha'], expires_days: 30 }, '', '', 'http://x');
    const act = impersonated(t);
    const calls: [string, () => unknown][] = [
      ['create', () => createTokenFor(t.ctx, act, { name: 'x', scopes: ['docs:read'], projects: ['alpha'] })],
      ['rename', () => renameTokenFor(t.ctx, act, mine.id, 'x')],
      ['revoke', () => revokeTokenFor(t.ctx, act, mine.id)],
      ['rescope', () => updateTokenProjectsFor(t.ctx, act, mine.id, ['alpha'])],
      ['connect', () => approveConnect(t.ctx, act, start.user_code, ['projects:read'], ['alpha'], '30')],
      ['2fa start', () => startEnrollment(t.ctx, t.bob.id, act.principal)],
      ['2fa confirm', () => confirmEnrollment(t.ctx, act, '123456')],
      ['2fa recovery', () => regenerateRecoveryCodes(t.ctx, act)],
      ['2fa disable', () => disableTwoFactor(t.ctx, act)],
      ['password', () => changePassword(t.ctx, act, { current: 'a', next: 'New-password-12', confirm: 'New-password-12', code: '' }, 'sid')],
    ];
    for (const [name, call] of calls) {
      const err = await failure(call);
      expect({ name, status: err.status, code: err.code }).toEqual({ name, status: 403, code: 'forbidden' });
    }
    expect(getTokenById(t.db, mine.id)).toMatchObject({ revoked_at: null, label: null });
    // the same actions work without the impersonation marker
    renameTokenFor(t.ctx, actorOf(t.bob), mine.id, 'fine');
    expect(getTokenById(t.db, mine.id)!.label).toBe('fine');
  });

  it('the 2FA settings routes refuse an impersonation session', async () => {
    t = await makeShared();
    const session = startImpersonation(t.ctx, actorOf(t.owner()), t.bob.id);
    const page = await t.app.inject({ method: 'GET', url: '/settings/2fa', cookies: { blindkey_session: session } });
    const csrf = /name="csrf" value="([^"]+)"/.exec(page.body)![1]!;
    for (const url of ['/settings/2fa/start', '/settings/2fa/confirm', '/settings/2fa/recovery', '/settings/2fa/disable']) {
      const res = await t.app.inject({ method: 'POST', url, cookies: { blindkey_session: session }, payload: { csrf, code: '123456', password: 'x' } });
      expect(res.statusCode, url).toBe(403);
    }
    expect((t.db.prepare(`SELECT COUNT(*) AS n FROM admin_totp`).get() as { n: number }).n).toBe(0);
  });
});

describe('4. must_change_password blocks the API token exchange', () => {
  it('no token is minted until the password has been changed', async () => {
    t = await makeShared();
    t.db.prepare(`UPDATE admin SET password_hash = ?, must_change_password = 1 WHERE id = ?`).run(await hashPassword(PW), t.bob.id);
    expect(mustChangePassword(t.ctx, t.bob.id)).toBe(true);
    expect(mustChangePassword(t.ctx, t.carol.id)).toBe(false);
    const before = listTokens(t.db).length;
    const res = await t.app.inject({ method: 'POST', url: '/api/v1/auth/token', payload: { username: 'bob', password: PW, name: 'cli' } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'password_change_required' });
    expect(res.json().message).toMatch(/change your password/);
    expect(listTokens(t.db)).toHaveLength(before);
    // a wrong password stays an ordinary 401 (the flag is not an oracle without the password)
    expect((await t.app.inject({ method: 'POST', url: '/api/v1/auth/token', payload: { username: 'bob', password: 'wrong-password-1', name: 'cli' } })).statusCode).toBe(401);
    const changed = await changePassword(t.ctx, actorOf(t.bob), { current: PW, next: 'Brand-new-pass-1', confirm: 'Brand-new-pass-1', code: '' }, 'sid');
    expect(changed.ok).toBe(true);
    expect(mustChangePassword(t.ctx, t.bob.id)).toBe(false);
    expect((await t.app.inject({ method: 'POST', url: '/api/v1/auth/token', payload: { username: 'bob', password: 'Brand-new-pass-1', name: 'cli' } })).statusCode).toBe(201);
  });
});

describe('5. audit history is not inherited by reused user and token ids', () => {
  it('a user created after a deleted one with the same id sees none of the predecessor\'s rows', async () => {
    t = await makeShared();
    const old = createUser(t.db, { username: 'old', passwordHash: 'h' });
    const oldToken = createToken(t.db, { userId: old.id, name: 'oldtok', scopes: ['admin'], projectIds: null, expiresAt: null }).row;
    const past = Date.now() - 60_000;
    writeAudit(t.db, { actor_type: 'admin', actor_id: old.id, action: 'old.user.action' }, past);
    writeAudit(t.db, { actor_type: 'token', actor_id: oldToken.id, action: 'old.token.action' }, past);
    deleteUser(t.db, old.id);
    const fresh = createUser(t.db, { username: 'fresh', passwordHash: 'h' });
    expect(fresh.id).toBe(old.id); // ids are reused
    const freshToken = createToken(t.db, { userId: fresh.id, name: 'freshtok', scopes: ['admin'], projectIds: null, expiresAt: null }).row;
    expect(freshToken.id).toBe(oldToken.id);
    writeAudit(t.db, { actor_type: 'admin', actor_id: fresh.id, action: 'new.user.action' });
    writeAudit(t.db, { actor_type: 'token', actor_id: freshToken.id, action: 'new.token.action' });
    const seen = listAuditFor(t.ctx, actorOf(fresh).principal, { limit: 50 }).map((r) => r.action);
    expect(seen).toContain('new.user.action');
    expect(seen).toContain('new.token.action');
    expect(seen).not.toContain('old.user.action');
    expect(seen).not.toContain('old.token.action');
  });

  it('a recreated token of the same user does not show its predecessor\'s rows either', async () => {
    t = await makeShared();
    const first = createToken(t.db, { userId: t.bob.id, name: 'a', scopes: ['admin'], projectIds: null, expiresAt: null }).row;
    writeAudit(t.db, { actor_type: 'token', actor_id: first.id, action: 'first.token.action' }, Date.now() - 60_000);
    t.db.prepare(`DELETE FROM api_tokens WHERE id = ?`).run(first.id);
    const second = createToken(t.db, { userId: t.bob.id, name: 'b', scopes: ['admin'], projectIds: null, expiresAt: null }).row;
    expect(second.id).toBe(first.id);
    const seen = listAuditFor(t.ctx, actorOf(t.bob).principal, { limit: 50 }).map((r) => r.action);
    expect(seen).not.toContain('first.token.action');
    expect(listAudit(t.db, { action: 'first.token.action' })).toHaveLength(1);
  });
});

describe('7. search is complete for restricted users', () => {
  it('finds the visible hits even when more than 1000 hidden ones rank first', async () => {
    t = await makeShared();
    const beta = t.project_id('beta');
    const alpha = t.project_id('alpha');
    t.db.transaction(() => {
      for (let i = 0; i < 1100; i++) {
        upsertDocument(t.db, { projectId: beta, workspaceId: t.workspaceId, slug: `hidden-${i}`, title: 'needle', category: 'notes', body_md: 'needle' });
        createSecret(t.db, t.ring, { projectId: beta, workspaceId: t.workspaceId, name: `needle-a-${i}`, description: '', tags: [], fields: [{ key: 'host', value: 'h' }] });
      }
    })();
    upsertDocument(t.db, { projectId: alpha, workspaceId: t.workspaceId, slug: 'visible', title: 'visible doc', category: 'notes', body_md: 'filler filler filler filler needle filler filler filler filler filler filler' });
    createSecret(t.db, t.ring, { projectId: alpha, workspaceId: t.workspaceId, name: 'needle-zzz', description: '', tags: [], fields: [{ key: 'host', value: 'h' }] });
    const res = searchFor(t.ctx, actorOf(t.bob).principal, 'needle');
    expect(res.documents!.map((d) => d.slug)).toEqual(['visible']);
    expect(res.secrets!.map((s) => s.name)).toEqual(['needle-zzz']);
    // erin has no access at all
    const none = searchFor(t.ctx, actorOf(t.erin).principal, 'needle');
    expect(none.documents).toEqual([]);
    expect(none.secrets).toEqual([]);
    // the owner is capped at 20 results
    expect(searchFor(t.ctx, actorOf(t.owner()).principal, 'needle').documents).toHaveLength(20);
  });

  it('respects item grants, project grants and globals', async () => {
    t = await makeShared();
    // dave: docs.read on gamma/gdoc only; carol: cli on beta/DB only
    expect(searchFor(t.ctx, actorOf(t.dave).principal, 'gamma').documents!.map((d) => d.slug)).toEqual(['gdoc']);
    expect(searchFor(t.ctx, actorOf(t.carol).principal, 'DB').secrets!.map((s) => s.name)).toEqual(['DB']);
    // bob has no access to globals, the owner does
    expect(searchFor(t.ctx, actorOf(t.bob).principal, 'ghandbook').documents).toEqual([]);
    expect(searchFor(t.ctx, actorOf(t.owner()).principal, 'ghandbook').documents!.map((d) => d.slug)).toEqual(['ghandbook']);
    // a docs-less project grant shows secrets but not documents of that project
    const gamma = t.project_id('gamma');
    upsertGrant(t.db, { userId: t.erin.id, targetType: 'project', targetId: gamma, perms: ['public.read'] });
    expect(searchFor(t.ctx, actorOf(t.erin).principal, 'gamma').documents).toEqual([]);
    expect(searchFor(t.ctx, actorOf(t.erin).principal, 'GS').secrets!.map((s) => s.name)).toEqual(['GS']);
  });
});

describe('8. project-scoped tokens only see the workspaces holding their projects', () => {
  it('lists and reads globals of those workspaces only; creating a project in an owned workspace still works', async () => {
    t = await makeShared();
    const owner = t.owner();
    const second = createWorkspace(t.db, { slug: 'second', name: 'Second' });
    addOwner(t.db, second.id, owner.id);
    createSecret(t.db, t.ring, { projectId: null, workspaceId: second.id, name: 'SECOND_GLOBAL', description: '', tags: [], fields: [{ key: 'host', value: 'h' }] });
    upsertDocument(t.db, { projectId: null, workspaceId: second.id, slug: 'second-doc', title: 'second doc', category: 'notes', body_md: 'second global needle' });
    createProject(t.db, { slug: 'other', name: 'Other', status: 'active', tags: [], summary: '' }, second.id);

    const scoped = auth(t.as(owner, ['admin'], ['alpha']));
    const wide = auth(t.as(owner));
    const get = async (url: string, headers: Record<string, string>) => t.app.inject({ method: 'GET', url, headers });
    expect(jsonAs<{ slug: string }[]>({ json: (await get('/api/v1/workspaces', scoped)).json() }).map((w) => w.slug)).toEqual(['default']);
    expect(jsonAs<{ slug: string }[]>({ json: (await get('/api/v1/workspaces', wide)).json() }).map((w) => w.slug).sort()).toEqual(['default', 'second']);
    expect((await get('/api/v1/secrets?workspace=second', scoped)).statusCode).toBe(404);
    expect((await get('/api/v1/secrets/SECOND_GLOBAL?workspace=second', scoped)).statusCode).toBe(404);
    expect((await get('/api/v1/docs?workspace=second', scoped)).statusCode).toBe(404);
    expect((await get('/api/v1/secrets?workspace=default', scoped)).statusCode).toBe(200);
    expect((await get('/api/v1/secrets/SECOND_GLOBAL?workspace=second', wide)).statusCode).toBe(200);
    // and the item checks themselves refuse them, whatever route reached the item
    const sec = { id: 1, project_id: null, workspace_id: second.id };
    expect(accessFor(t.db, { ...actorOf(owner).principal, projectIds: [t.project_id('alpha')] }).secretVisible(sec)).toBe(false);
    expect(accessFor(t.db, { ...actorOf(owner).principal, projectIds: [t.project_id('alpha')] }).docVisible(sec)).toBe(false);
    expect(accessFor(t.db, actorOf(owner).principal).secretVisible(sec)).toBe(true);
    // search does not leak them either
    const scopedPrincipal = actorOf(owner, ['admin']).principal;
    scopedPrincipal.projectIds = [t.project_id('alpha')];
    expect(searchFor(t.ctx, scopedPrincipal, 'second').documents).toEqual([]);
    expect(searchFor(t.ctx, scopedPrincipal, 'SECOND').secrets).toEqual([]);
    expect(searchFor(t.ctx, actorOf(owner).principal, 'second').documents!.map((d) => d.slug)).toEqual(['second-doc']);
    // many hidden globals sorting first must not crowd out the token's own hit
    for (let i = 0; i < 25; i++) createSecret(t.db, t.ring, { projectId: null, workspaceId: second.id, name: `aaa-dup-${i}`, description: '', tags: [], fields: [{ key: 'host', value: 'h' }] });
    createSecret(t.db, t.ring, { projectId: t.project_id('alpha'), name: 'zzz-dup', description: '', tags: [], fields: [{ key: 'host', value: 'h' }] });
    expect(searchFor(t.ctx, scopedPrincipal, 'dup').secrets!.map((x) => x.name)).toEqual(['zzz-dup']);

    // a token that may create projects and has none yet can still target a workspace the user owns
    const creator = auth(t.as(owner, ['projects:create', 'projects:read'], []));
    const made = await t.app.inject({ method: 'POST', url: '/api/v1/projects', headers: creator, payload: { slug: 'fresh', name: 'Fresh', workspace: 'second' } });
    expect(made.statusCode).toBe(201);
    expect(jsonAs<{ slug: string }[]>({ json: (await get('/api/v1/workspaces', creator)).json() }).map((w) => w.slug)).toEqual(['second']);
  });
});
