import { afterEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { actorOf, jsonAs, makeShared, type Shared } from './access.fixture.js';
import { auth, sessionFor } from './helpers.js';
import type { Principal } from '../src/auth/principal.js';
import { createSession, createUser, getSession, getUserById, getUserByUsername, setUserDisabled, setUserSuper } from '../src/repos/admin.js';
import { verifyPassword } from '../src/crypto/passwords.js';
import { hashPassword } from '../src/crypto/passwords.js';
import { listAudit } from '../src/repos/audit.js';
import { getTotp, isTwoFactorByAdmin, openTotpSecret } from '../src/repos/twofactor.js';
import { getGrant } from '../src/repos/grants.js';
import { listTokens } from '../src/repos/tokens.js';
import { registerSessionResolver } from '../src/ui/session.js';
import { AppError, ConflictError, NotFoundError, PermissionError, ValidationError } from '../src/errors.js';
import {
  createUserFor, deleteUserFor, listUsersFor, resetUserPasswordFor, resetUserTwoFactorFor, setUserDisabledFor, setUserSuperFor,
  startImpersonation, stopImpersonation,
} from '../src/services/users.js';
import { createTokenFor, exchangePassword, listAuditFor, listTokensFor, renameTokenFor, revokeTokenFor, updateTokenProjectsFor } from '../src/services/admin.js';
import { createWorkspaceFor, setGrantFor } from '../src/services/workspaces.js';
import { getProjectBySlug } from '../src/repos/projects.js';
import { createSecretFor } from '../src/services/secrets.js';
import { getSecretMeta } from '../src/repos/secrets.js';

let t: Shared;
afterEach(async () => {
  await t?.app.close();
});

const PW = 'Correct-horse-9';

describe('user management (super only)', () => {
  it('creates a user with a temporary password and a forced change; only super users may', async () => {
    t = await makeShared();
    const owner = t.owner();
    const u = await createUserFor(t.ctx, actorOf(owner), { username: 'frank', password: PW });
    expect(u).toMatchObject({ username: 'frank', is_super: false, disabled: false, must_change_password: true });
    const row = getUserByUsername(t.db, 'frank')!;
    expect(await verifyPassword(row.password_hash, PW)).toBe(true);
    expect(row.password_hash).not.toContain(PW);
    expect(listAudit(t.db, { action: 'user.create' })[0]).toMatchObject({ actor_id: owner.id, target_type: 'user', target_id: row.id });
    await expect(createUserFor(t.ctx, actorOf(owner), { username: 'frank', password: PW })).rejects.toThrow(ConflictError);
    await expect(createUserFor(t.ctx, actorOf(owner), { username: 'x y', password: PW })).rejects.toThrow(ValidationError);
    await expect(createUserFor(t.ctx, actorOf(owner), { username: 'weak', password: 'short' })).rejects.toThrow(ValidationError);
    expect(listUsersFor(t.ctx, actorOf(owner).principal).map((x) => x.username)).toEqual(['alex', 'bob', 'carol', 'dave', 'erin', 'frank']);
    // everybody else: no
    await expect(createUserFor(t.ctx, actorOf(t.bob), { username: 'g', password: PW })).rejects.toThrow(PermissionError);
    expect(() => listUsersFor(t.ctx, actorOf(t.bob).principal)).toThrow(PermissionError);
    expect(() => setUserDisabledFor(t.ctx, actorOf(t.bob), owner.id, true)).toThrow(PermissionError);
    expect(() => deleteUserFor(t.ctx, actorOf(t.bob), t.erin.id)).toThrow(PermissionError);
    // a token of a super user needs the admin scope for user management
    expect(() => listUsersFor(t.ctx, actorOf(owner, ['projects:read']).principal)).toThrow(AppError);
    expect(getUserById(t.db, t.erin.id)).not.toBeNull();
  });

  it('disabling signs the user out everywhere at once and blocks every way in; enabling restores it', async () => {
    t = await makeShared();
    const owner = t.owner();
    const hash = await hashPassword(PW);
    t.db.prepare(`UPDATE admin SET password_hash = ? WHERE id = ?`).run(hash, t.bob.id);
    const session = createSession(t.db, t.bob.id, 60_000, '', '');
    const token = t.as(t.bob);
    const factor = t.enroll(t.bob.id);
    const web = () => t.app.inject({ method: 'GET', url: '/', cookies: { blindkey_session: session } });
    expect((await web()).statusCode).toBe(200);
    setUserDisabledFor(t.ctx, actorOf(owner), t.bob.id, true);
    expect(getSession(t.db, session)).toBeNull();
    expect((await web()).statusCode).toBe(302);
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/projects', headers: auth(token) })).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'POST', url: '/login', payload: { username: 'bob', password: PW } })).statusCode).toBe(401);
    const api = await exchangePassword(t.ctx, { username: 'bob', password: PW, name: 'cli', expires_days: 1, totp: factor.code(-1) }, '1.1.1.1', 'ua');
    expect(api).toEqual({ ok: false, reason: 'invalid' });
    setUserDisabledFor(t.ctx, actorOf(owner), t.bob.id, false);
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/projects', headers: auth(token) })).statusCode).toBe(200);
    expect((await exchangePassword(t.ctx, { username: 'bob', password: PW, name: 'cli', expires_days: 1, totp: factor.code() }, '1.1.1.1', 'ua')).ok).toBe(true);
    expect(listAudit(t.db, { action: 'user.disable' })).toHaveLength(1);
    expect(listAudit(t.db, { action: 'user.enable' })).toHaveLength(1);
  });

  it('never disables, demotes or deletes yourself or the last enabled super user', async () => {
    t = await makeShared();
    const owner = t.owner();
    expect(() => setUserDisabledFor(t.ctx, actorOf(owner), owner.id, true)).toThrow(ConflictError);
    expect(() => setUserSuperFor(t.ctx, actorOf(owner), owner.id, false)).toThrow(ConflictError);
    expect(() => deleteUserFor(t.ctx, actorOf(owner), owner.id)).toThrow(ConflictError);
    // a second super can be managed freely and may manage the first...
    setUserSuperFor(t.ctx, actorOf(owner), t.bob.id, true);
    const bob = getUserById(t.db, t.bob.id)!;
    expect(bob.is_super).toBe(true);
    setUserDisabledFor(t.ctx, actorOf(bob), owner.id, true);
    // ...but with only one enabled super left, no actor (even a forged super principal) can remove it
    const forged = actorOf(t.carol);
    forged.principal.isSuper = true;
    expect(() => setUserDisabledFor(t.ctx, forged, bob.id, true)).toThrow(ConflictError);
    expect(() => setUserSuperFor(t.ctx, forged, bob.id, false)).toThrow(ConflictError);
    expect(() => deleteUserFor(t.ctx, forged, bob.id)).toThrow(ConflictError);
    expect(getUserById(t.db, bob.id)).toMatchObject({ is_super: true, disabled_at: null });
    // demoting the other one while two are enabled is fine
    setUserDisabled(t.db, owner.id, false);
    setUserSuperFor(t.ctx, actorOf(bob), owner.id, false);
    expect(getUserById(t.db, owner.id)!.is_super).toBe(false);
  });

  it('resets a password to a temporary one: forces a change, ends their sessions, old password dead', async () => {
    t = await makeShared();
    const owner = t.owner();
    t.db.prepare(`UPDATE admin SET password_hash = ?, must_change_password = 0 WHERE id = ?`).run(await hashPassword('Old-password-1'), t.bob.id);
    const session = createSession(t.db, t.bob.id, 60_000, '', '');
    const factor = t.enroll(t.bob.id);
    await resetUserPasswordFor(t.ctx, actorOf(owner), t.bob.id, PW);
    expect(getSession(t.db, session)).toBeNull();
    expect(getUserById(t.db, t.bob.id)!.must_change_password).toBe(true);
    expect((await exchangePassword(t.ctx, { username: 'bob', password: 'Old-password-1', name: 'x', expires_days: 1 }, '', '')).ok).toBe(false);
    // the temporary password opens no API token until it has been changed
    expect(await exchangePassword(t.ctx, { username: 'bob', password: PW, name: 'x', expires_days: 1, totp: factor.code() }, '', '')).toEqual({ ok: false, reason: 'password_change_required' });
    await expect(resetUserPasswordFor(t.ctx, actorOf(owner), t.bob.id, 'short')).rejects.toThrow(ValidationError);
    await expect(resetUserPasswordFor(t.ctx, actorOf(owner), 99999, PW)).rejects.toThrow(NotFoundError);
    await expect(resetUserPasswordFor(t.ctx, actorOf(t.bob), t.erin.id, PW)).rejects.toThrow(PermissionError);
    const audit = JSON.stringify(listAudit(t.db, { action: 'user.password_reset' }));
    expect(audit).not.toContain(PW);
  });

  it('resets two-factor authentication: sessions and tokens die, a fresh pending enrollment starts, login is refused until a super confirms it', async () => {
    t = await makeShared();
    const owner = t.owner();
    const oldSecret = openTotpSecret(t.ring, getTotp(t.db, t.bob.id)!);
    const session = createSession(t.db, t.bob.id, 60_000, '', '');
    const token = t.as(t.bob);
    expect(listTokens(t.db).filter((x) => x.user_id === t.bob.id && x.revoked_at === null).length).toBeGreaterThan(0);

    resetUserTwoFactorFor(t.ctx, actorOf(owner), t.bob.id);

    expect(getSession(t.db, session)).toBeNull();
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/projects', headers: auth(token) })).statusCode).toBe(401);
    expect(listTokens(t.db).filter((x) => x.user_id === t.bob.id && x.revoked_at === null)).toEqual([]);
    const pending = getTotp(t.db, t.bob.id)!;
    expect(pending.enabled_at).toBeNull();
    expect(openTotpSecret(t.ring, pending).equals(oldSecret)).toBe(false);
    expect(isTwoFactorByAdmin(t.db, t.bob.id)).toBe(true);
    const audit = listAudit(t.db, { action: 'user.2fa_reset' });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_id: owner.id, target_id: t.bob.id });
    expect(() => resetUserTwoFactorFor(t.ctx, actorOf(t.erin), t.bob.id)).toThrow(PermissionError);
    // not for yourself: it would sign you out of the page that finishes it
    expect(() => resetUserTwoFactorFor(t.ctx, actorOf(owner), owner.id)).toThrow(ConflictError);
  });

  it('deletes a user with their tokens, sessions and grants; never the sole owner of a workspace', async () => {
    t = await makeShared();
    const owner = t.owner();
    const alpha = getProjectBySlug(t.db, 'alpha')!;
    const token = t.as(t.bob);
    const session = createSession(t.db, t.bob.id, 60_000, '', '');
    deleteUserFor(t.ctx, actorOf(owner), t.bob.id);
    expect(getUserById(t.db, t.bob.id)).toBeNull();
    expect(getGrant(t.db, t.bob.id, 'project', alpha.id)).toBeNull();
    expect(getSession(t.db, session)).toBeNull();
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/projects', headers: auth(token) })).statusCode).toBe(401);
    expect(listTokens(t.db).filter((x) => x.name === 't-bob')).toEqual([]);
    // erin founds a workspace alone; she cannot be deleted until somebody else owns it too
    createWorkspaceFor(t.ctx, actorOf(t.erin), { name: 'Erins' });
    expect(() => deleteUserFor(t.ctx, actorOf(owner), t.erin.id)).toThrow(/only owner of workspace "erins"/);
    expect(getUserById(t.db, t.erin.id)).not.toBeNull();
    expect(listAudit(t.db, { action: 'user.delete' })).toHaveLength(1);
  });
});

describe('impersonation', () => {
  /** What the session resolver makes of a session cookie. */
  async function principalFor(session: string): Promise<Principal> {
    const app = Fastify();
    await app.register(cookie);
    registerSessionResolver(app, t.ctx);
    app.get('/p', async (req) => req.principal);
    const res = await app.inject({ method: 'GET', url: '/p', cookies: { blindkey_session: session } });
    await app.close();
    return res.json() as Principal;
  }

  it('starts a session as the target, audits the writes with meta.impersonator, and stops back to the real user', async () => {
    t = await makeShared();
    const owner = t.owner();
    const real = createSession(t.db, owner.id, 60_000, '', '');
    const asBob = startImpersonation(t.ctx, actorOf(owner), t.bob.id);
    const row = t.db.prepare(`SELECT admin_id, impersonator_id FROM sessions WHERE id = ?`).get(asBob);
    expect(row).toEqual({ admin_id: t.bob.id, impersonator_id: owner.id });
    expect(listAudit(t.db, { action: 'impersonate.start' })[0]).toMatchObject({ actor_id: owner.id, target_id: t.bob.id });

    const principal = await principalFor(asBob);
    expect(principal).toMatchObject({ kind: 'admin', userId: t.bob.id, isSuper: false, impersonatorId: owner.id });
    // everything done now is bob's, but marked with the real person
    createSecretFor(t.ctx, { principal, ip: '1.1.1.1', userAgent: 'ua' }, 'alpha', { name: 'made while impersonated', description: '', tags: [], fields: [{ key: 'host', value: 'h' }] });
    const made = listAudit(t.db, { action: 'secret.create' })[0]!;
    expect(made).toMatchObject({ actor_type: 'admin', actor_id: t.bob.id });
    expect(made.meta).toMatchObject({ impersonator: owner.id });
    // the super user's own audit rows carry no impersonator
    expect(listAudit(t.db, { action: 'impersonate.start' })[0]!.meta).not.toHaveProperty('impersonator');
    // an impersonated session has no super rights and cannot chain
    expect(() => listUsersFor(t.ctx, principal)).toThrow(PermissionError);
    expect(() => startImpersonation(t.ctx, { principal, ip: '', userAgent: '' }, t.erin.id)).toThrow(PermissionError);

    const back = stopImpersonation(t.ctx, { principal, ip: '1.1.1.1', userAgent: 'ua' }, asBob);
    expect(getSession(t.db, asBob)).toBeNull();
    expect(getSession(t.db, back)).toMatchObject({ admin_id: owner.id, impersonator_id: null });
    expect(getSession(t.db, real)).not.toBeNull();
    const stopped = listAudit(t.db, { action: 'impersonate.stop' })[0]!;
    expect(stopped.meta).toMatchObject({ impersonator: owner.id });
    // stopping when not impersonating is a 404
    expect(() => stopImpersonation(t.ctx, actorOf(owner), real)).toThrow(NotFoundError);
  });

  it('is for super users in a browser session only, and only onto enabled non-super users', async () => {
    t = await makeShared();
    const owner = t.owner();
    expect(() => startImpersonation(t.ctx, actorOf(t.bob), t.erin.id)).toThrow(PermissionError);
    expect(() => startImpersonation(t.ctx, actorOf(owner), owner.id)).toThrow(ValidationError);
    expect(() => startImpersonation(t.ctx, actorOf(owner), 99999)).toThrow(NotFoundError);
    setUserSuper(t.db, t.carol.id, true);
    expect(() => startImpersonation(t.ctx, actorOf(owner), t.carol.id)).toThrow(PermissionError);
    setUserDisabled(t.db, t.erin.id, true);
    expect(() => startImpersonation(t.ctx, actorOf(owner), t.erin.id)).toThrow(ValidationError);
    const tokenActor = actorOf(owner);
    tokenActor.principal.kind = 'token';
    expect(() => startImpersonation(t.ctx, tokenActor, t.bob.id)).toThrow(PermissionError);
    // the impersonation dies with the impersonator's account
    const asBob = startImpersonation(t.ctx, actorOf(owner), t.bob.id);
    setUserSuper(t.db, t.carol.id, true);
    setUserDisabledFor(t.ctx, actorOf(getUserById(t.db, t.carol.id)!), owner.id, true);
    expect(getSession(t.db, asBob)).toBeNull();
  });

  it('demoting a super user ends the impersonations they started at once', async () => {
    t = await makeShared();
    const owner = t.owner();
    setUserSuper(t.db, t.carol.id, true);
    const asBob = startImpersonation(t.ctx, actorOf(getUserById(t.db, t.carol.id)!), t.bob.id);
    expect(getSession(t.db, asBob)).not.toBeNull();
    setUserSuperFor(t.ctx, actorOf(owner), t.carol.id, false);
    expect(getSession(t.db, asBob)).toBeNull();
  });
});

describe('tokens are personal', () => {
  it('lists, renames, re-scopes and revokes only the caller\'s own tokens', async () => {
    t = await makeShared();
    const owner = t.owner();
    t.as(owner);
    const mine = createTokenFor(t.ctx, actorOf(t.bob), { name: 'bobs', scopes: ['docs:read'], projects: ['alpha'] });
    expect(listTokens(t.db).find((x) => x.id === mine.id)!.user_id).toBe(t.bob.id);
    expect(listTokensFor(t.ctx, actorOf(t.bob).principal).map((x) => x.id)).toEqual([mine.id]);
    expect(listTokensFor(t.ctx, actorOf(owner).principal).map((x) => x.name)).not.toContain('bobs');
    const ownersToken = listTokensFor(t.ctx, actorOf(owner).principal)[0]!;
    expect(() => revokeTokenFor(t.ctx, actorOf(t.bob), ownersToken.id)).toThrow(NotFoundError);
    expect(() => renameTokenFor(t.ctx, actorOf(t.bob), ownersToken.id, 'x')).toThrow(NotFoundError);
    expect(() => updateTokenProjectsFor(t.ctx, actorOf(t.bob), ownersToken.id, ['alpha'])).toThrow(NotFoundError);
    expect(listTokens(t.db).find((x) => x.id === ownersToken.id)!.revoked_at).toBeNull();
    revokeTokenFor(t.ctx, actorOf(t.bob), mine.id);
    expect(listTokens(t.db).find((x) => x.id === mine.id)!.revoked_at).not.toBeNull();
    // a super user's token management is still their own
    expect(() => revokeTokenFor(t.ctx, actorOf(owner), mine.id)).toThrow(NotFoundError);
  });

  it('a token can only be scoped to projects its user can see; a restricted token cannot widen itself', async () => {
    t = await makeShared();
    const issuesOf = (fn: () => unknown): string => {
      try {
        fn();
      } catch (e) {
        return JSON.stringify((e as AppError).details.issues);
      }
      throw new Error('did not throw');
    };
    const unknown = (slug: string) => () => createTokenFor(t.ctx, actorOf(t.bob), { name: 'x', scopes: ['docs:read'], projects: [slug] });
    expect(issuesOf(unknown('beta'))).toContain('unknown project \\"beta\\"');
    expect(issuesOf(unknown('nope'))).toContain('unknown project \\"nope\\"');
    expect(createTokenFor(t.ctx, actorOf(t.bob), { name: 'ok', scopes: ['docs:read'], projects: ['alpha'] }).projects).toEqual(['alpha']);
    const own = createTokenFor(t.ctx, actorOf(t.bob), { name: 'own', scopes: ['docs:read'], projects: ['alpha'] });
    expect(() => updateTokenProjectsFor(t.ctx, actorOf(t.bob), own.id, ['beta'])).toThrow(ValidationError);
    // all-projects tokens are for people, not for restricted tokens
    const restricted = actorOf(t.bob);
    restricted.principal.kind = 'token';
    restricted.principal.projectIds = [t.project_id('alpha')];
    expect(() => createTokenFor(t.ctx, restricted, { name: 'wide', scopes: ['docs:read'], projects: null })).toThrow(ValidationError);
    expect(createTokenFor(t.ctx, restricted, { name: 'narrow', scopes: ['docs:read'], projects: ['alpha'] }).projects).toEqual(['alpha']);
    // the visible/invisible answer is the same, so project names do not leak
    expect(issuesOf(() => createTokenFor(t.ctx, actorOf(t.erin), { name: 'x', scopes: ['docs:read'], projects: ['alpha'] }))).toContain('unknown project \\"alpha\\"');
  });
});

describe('audit visibility', () => {
  it('super sees everything; others only their own rows plus the workspaces they own', async () => {
    t = await makeShared();
    const owner = t.owner();
    // erin founds a workspace with a project and gives dave a secret grant in it; dave reveals it
    createWorkspaceFor(t.ctx, actorOf(t.erin), { name: 'Erins' });
    const made = await t.call(t.erin, 'POST', '/api/v1/projects', { workspace: 'erins', slug: 'ep', name: 'EP' });
    expect(made.status).toBe(201);
    expect((await t.call(t.erin, 'POST', '/api/v1/projects/ep/secrets', { name: 'ES', fields: [{ key: 'password', value: 'p' }] })).status).toBe(201);
    const es = getSecretMeta(t.db, t.ring, getProjectBySlug(t.db, 'ep')!.id, 'ES')!;
    setGrantFor(t.ctx, actorOf(t.erin), 'erins', 'dave', { type: 'secret', id: es.id }, ['protected.read', 'public.read']);
    expect((await t.call(t.dave, 'GET', '/api/v1/projects/ep/secrets/ES/fields/password')).status).toBe(200);
    // bob reveals something in default
    expect((await t.call(t.bob, 'GET', '/api/v1/projects/alpha/secrets/ADB/fields/password')).status).toBe(200);

    const reveals = (u: Parameters<typeof actorOf>[0]) => listAuditFor(t.ctx, actorOf(u).principal, { action: 'secret.reveal' });
    expect(reveals(owner)).toHaveLength(2); // super: all
    expect(reveals(t.erin).map((r) => r.target_id)).toEqual([es.id]); // owns the workspace dave revealed in
    expect(reveals(t.dave).map((r) => r.target_id)).toEqual([es.id]); // made it
    expect(reveals(t.bob)).toHaveLength(1); // only his own
    expect(reveals(t.bob)[0]!.target_id).not.toBe(es.id);
    expect(reveals(t.carol)).toEqual([]);
    expect(() => listAuditFor(t.ctx, actorOf(t.bob, ['projects:read']).principal, {})).toThrow(AppError);
  });
});

describe('connect approval binds the token to the approver', () => {
  // Fixture users have two-factor on, so a browser session is opened directly instead of through the login form.
  const login = async (username: string): Promise<string> => sessionFor(t.db, username);

  it('limits the project choices to what the approver sees and mints the token for them', async () => {
    t = await makeShared();
    const hash = await hashPassword('pw');
    t.db.prepare(`UPDATE admin SET password_hash = ? WHERE id IN (?, ?)`).run(hash, t.bob.id, t.owner().id);
    const start = await t.app.inject({ method: 'POST', url: '/api/v1/connect/start', payload: { name: 'claude@laptop', scopes: ['projects:read', 'secrets:use'], projects: ['alpha', 'beta'] } });
    const { device_code: deviceCode, user_code: userCode } = start.json();
    const session = await login('bob');
    const page = await t.app.inject({ method: 'GET', url: `/connect?code=${userCode}`, cookies: { blindkey_session: session } });
    const csrf = /name="csrf" value="([^"]+)"/.exec(page.body)![1]!;
    expect(page.body).toContain('value="alpha"');
    expect(page.body).not.toContain('value="beta"');
    // bob ticks a project he cannot see anyway (tampered form): it is dropped, alpha stays
    const approved = await t.app.inject({
      method: 'POST', url: '/connect/approve', cookies: { blindkey_session: session },
      payload: { csrf, code: userCode, scopes: ['projects:read', 'secrets:use'], projects: ['alpha', 'beta'], expires_days: '30' },
    });
    expect(approved.statusCode).toBe(302);
    const polled = await t.app.inject({ method: 'POST', url: '/api/v1/connect/poll', payload: { device_code: deviceCode } });
    expect(polled.statusCode).toBe(200);
    expect(polled.json().projects).toEqual(['alpha']);
    const issued = listTokens(t.db).find((x) => x.kind === 'agent')!;
    expect(issued.user_id).toBe(t.bob.id);
    const audit = listAudit(t.db, { action: 'connect.approved' })[0]!;
    expect(audit).toMatchObject({ actor_type: 'admin', actor_id: t.bob.id });
    // the agent acts as bob: alpha only, secrets by use only
    const agent = auth(polled.json().token);
    expect(jsonAs<{ slug: string }[]>({ json: (await t.app.inject({ method: 'GET', url: '/api/v1/projects', headers: agent })).json() }).map((p) => p.slug)).toEqual(['alpha']);
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/projects/alpha/secrets/ADB/fields/password', headers: agent })).statusCode).toBe(403);
    expect((await t.app.inject({ method: 'POST', url: '/api/v1/projects/alpha/secrets/ADB/use', headers: agent, payload: { purpose: 'exec' } })).statusCode).toBe(200);
    // pending (approved but unclaimed) tokens are listed to the approver only
    const second = await t.app.inject({ method: 'POST', url: '/api/v1/connect/start', payload: { name: 'claude@desktop', scopes: ['projects:read'], projects: ['alpha'] } });
    const code2 = second.json().user_code as string;
    const page2 = await t.app.inject({ method: 'GET', url: `/connect?code=${code2}`, cookies: { blindkey_session: session } });
    const csrf2 = /name="csrf" value="([^"]+)"/.exec(page2.body)![1]!;
    await t.app.inject({ method: 'POST', url: '/connect/approve', cookies: { blindkey_session: session }, payload: { csrf: csrf2, code: code2, scopes: ['projects:read'], projects: ['alpha'], expires_days: '30' } });
    const tokensPage = (u: string) => login(u).then((s) => t.app.inject({ method: 'GET', url: '/tokens', cookies: { blindkey_session: s } }));
    expect((await tokensPage('bob')).body).toContain('claude@desktop');
    expect((await tokensPage('alex')).body).not.toContain('claude@desktop');
  });
});
