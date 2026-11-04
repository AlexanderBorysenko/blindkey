import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { makeTestApp, type TestCtx } from './helpers.js';
import { createAdmin, createSession, createUser, getUserByUsername, getSession, setUserDisabled, setUserSuper } from '../src/repos/admin.js';
import { createToken, listTokensForUser } from '../src/repos/tokens.js';
import { createSecret } from '../src/repos/secrets.js';
import { getProjectBySlug } from '../src/repos/projects.js';
import { addOwner } from '../src/repos/workspaces.js';
import { hashPassword } from '../src/crypto/passwords.js';
import { listAudit } from '../src/repos/audit.js';

let t: TestCtx;
let superSession: string;
let superCsrf: string;

const main = (html: string): string => html.split('<main')[1]!.split('</main>')[0]!;
const csrfOf = (b: string) => /name="csrf" value="([^"]+)"/.exec(b)?.[1] ?? '';
const cookieOf = (res: { cookies: { name: string; value: string }[] }) => res.cookies.find((c) => c.name === 'blindkey_session')?.value ?? '';
const get = (session: string, url: string) => t.app.inject({ method: 'GET', url, cookies: { blindkey_session: session } });
const post = (session: string, url: string, payload: Record<string, unknown>) =>
  t.app.inject({ method: 'POST', url, cookies: { blindkey_session: session }, payload });
const login = async (username: string, password: string) =>
  cookieOf(await t.app.inject({ method: 'POST', url: '/login', payload: { username, password } }));
// The login form is rate limited (10/min); tests that are not about logging in open sessions directly.
const sessionFor = (username: string) => createSession(t.db, getUserByUsername(t.db, username)!.id, 3_600_000, '127.0.0.1', 'test');
const idOf = (username: string) => getUserByUsername(t.db, username)!.id;
const asSuper = (url: string, extra: Record<string, unknown> = {}) => post(superSession, url, { csrf: superCsrf, ...extra });

beforeAll(async () => {
  t = await makeTestApp();
  createAdmin(t.db, 'alex', await hashPassword('super-password-1'));
  superSession = await login('alex', 'super-password-1');
  superCsrf = csrfOf((await get(superSession, '/')).body);
});
afterAll(async () => {
  await t.app.close();
});
// Starting an impersonation ends the super user's own session row, so every test gets a fresh one.
beforeEach(async () => {
  superSession = sessionFor('alex');
  superCsrf = csrfOf((await get(superSession, '/')).body);
});

describe('users page access', () => {
  it('super sees the list and the Users link; sidebar footer names the user', async () => {
    const res = await get(superSession, '/admin/users');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('href="/admin/users"');
    expect(res.body).toContain('<span class="tag">alex</span>');
    expect(res.body).toContain('<span class="tag">super</span>');
    expect(main(res.body)).toContain('<strong>alex</strong>');
  });

  it('a non-super gets 404 on every users route and sees no Users link', async () => {
    createUser(t.db, { username: 'plain', passwordHash: await hashPassword('plain-password-1') });
    const s = sessionFor('plain');
    const home = await get(s, '/');
    expect(home.body).not.toContain('/admin/users');
    expect(home.body).toContain('<span class="tag">plain</span>');
    expect(home.body).not.toContain('<span class="tag">super</span>');
    expect((await get(s, '/admin/users')).statusCode).toBe(404);
    const c = csrfOf(home.body);
    expect((await post(s, '/admin/users', { csrf: c, username: 'x', password: 'long-enough-pass' })).statusCode).toBe(404);
    expect((await post(s, `/admin/users/${idOf('alex')}/disable`, { csrf: c })).statusCode).toBe(404);
    expect((await post(s, `/admin/users/${idOf('alex')}/impersonate`, { csrf: c })).statusCode).toBe(404);
    expect(getUserByUsername(t.db, 'x')).toBeNull();
  });
});

describe('create user and forced password change', () => {
  it('creates a user with a typed temp password; they must change it before browsing', async () => {
    const res = await asSuper('/admin/users', { username: 'dana', password: 'temp-password-123' });
    expect(res.statusCode).toBe(200);
    expect(main(res.body)).toContain('User created');
    expect(main(res.body)).not.toContain('temp-password-123');
    const row = getUserByUsername(t.db, 'dana')!;
    expect(row.must_change_password).toBe(true);

    const s = await login('dana', 'temp-password-123');
    expect(s).not.toBe('');
    const redirect = await get(s, '/');
    expect(redirect.statusCode).toBe(302);
    expect(redirect.headers.location).toBe('/settings/password');
    expect((await get(s, '/tokens')).headers.location).toBe('/settings/password');
    const form = await get(s, '/settings/password');
    expect(form.statusCode).toBe(200);
    expect(main(form.body)).toContain('temporary password');
    const c = csrfOf(form.body);
    // non-GET to anything else is refused
    expect((await post(s, '/tokens', { csrf: c, name: 'n', scopes: ['docs:read'] })).statusCode).toBe(403);
    // assets stay reachable
    expect((await get(s, '/assets/app.css')).statusCode).toBe(200);

    const changed = await post(s, '/settings/password', { csrf: c, current: 'temp-password-123', next: 'my-own-password-9', confirm: 'my-own-password-9' });
    expect(changed.statusCode).toBe(303);
    expect(getUserByUsername(t.db, 'dana')!.must_change_password).toBe(false);
    expect((await get(s, '/')).statusCode).toBe(200);
  });

  it('logout stays reachable while forced', async () => {
    await asSuper('/admin/users', { username: 'ed', password: 'temp-password-456' });
    const s = sessionFor('ed');
    const c = csrfOf((await get(s, '/settings/password')).body);
    expect((await post(s, '/logout', { csrf: c })).statusCode).toBe(302);
  });

  it('generated password is shown once, works, and is not in the audit log', async () => {
    const res = await asSuper('/admin/users', { username: 'gina', generate: 'on' });
    expect(res.statusCode).toBe(200);
    const shown = /id="new-user-password">([^<]+)</.exec(res.body)?.[1];
    expect(shown).toBeTruthy();
    expect(shown!.length).toBeGreaterThanOrEqual(24);
    expect(res.headers['cache-control']).toContain('no-store');
    expect(await login('gina', shown!)).not.toBe('');
    const again = await get(superSession, '/admin/users');
    expect(again.body).not.toContain(shown!);
    expect(JSON.stringify(listAudit(t.db, { limit: 1000 }))).not.toContain(shown!);
  });

  it('reset password with generate shows it once, forces change, kills sessions', async () => {
    const s = sessionFor('dana');
    expect(getSession(t.db, s)).not.toBeNull();
    const res = await asSuper(`/admin/users/${idOf('dana')}/reset-password`, { generate: 'on' });
    const shown = /id="new-user-password">([^<]+)</.exec(res.body)?.[1];
    expect(shown).toBeTruthy();
    expect(getSession(t.db, s)).toBeNull();
    expect(getUserByUsername(t.db, 'dana')!.must_change_password).toBe(true);
    expect(JSON.stringify(listAudit(t.db, { limit: 1000 }))).not.toContain(shown!);
    const s2 = await login('dana', shown!);
    expect((await get(s2, '/')).headers.location).toBe('/settings/password');
  });

  it('a short typed password and a duplicate username render as messages', async () => {
    const short = await asSuper('/admin/users', { username: 'shorty', password: 'abc' });
    expect(short.statusCode).toBe(400);
    expect(main(short.body)).toContain('role="alert"');
    expect(main(short.body)).toContain('at least 12 characters');
    const dup = await asSuper('/admin/users', { username: 'dana', password: 'temp-password-789' });
    expect(dup.statusCode).toBe(409);
    expect(main(dup.body)).toContain('role="alert"');
  });
});

describe('user actions', () => {
  it('disable kills their session and blocks login; enable restores it', async () => {
    await asSuper('/admin/users', { username: 'fred', password: 'temp-password-fred' });
    const s = sessionFor('fred');
    expect(getSession(t.db, s)).not.toBeNull();
    const res = await asSuper(`/admin/users/${idOf('fred')}/disable`);
    expect(res.statusCode).toBe(303);
    expect(getSession(t.db, s)).toBeNull();
    expect((await get(s, '/')).statusCode).toBe(302);
    expect(await login('fred', 'temp-password-fred')).toBe('');
    expect(main((await get(superSession, '/admin/users')).body)).toContain('disabled');
    await asSuper(`/admin/users/${idOf('fred')}/enable`);
    expect(await login('fred', 'temp-password-fred')).not.toBe('');
  });

  it('promote, demote and reset 2FA redirect and are audited', async () => {
    const id = idOf('fred');
    expect((await asSuper(`/admin/users/${id}/promote`)).statusCode).toBe(303);
    expect(getUserByUsername(t.db, 'fred')!.is_super).toBe(true);
    expect((await asSuper(`/admin/users/${id}/demote`)).statusCode).toBe(303);
    expect(getUserByUsername(t.db, 'fred')!.is_super).toBe(false);
    expect((await asSuper(`/admin/users/${id}/reset-2fa`)).statusCode).toBe(303);
    const actions = listAudit(t.db, { limit: 1000 }).map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['user.promote', 'user.demote', 'user.2fa_reset']));
  });

  it('delete needs a second confirming post', async () => {
    await asSuper('/admin/users', { username: 'gone', password: 'temp-password-gone' });
    const id = idOf('gone');
    const first = await asSuper(`/admin/users/${id}/delete`);
    expect(first.statusCode).toBe(200);
    expect(main(first.body)).toContain('Delete gone?');
    expect(getUserByUsername(t.db, 'gone')).not.toBeNull();
    const second = await asSuper(`/admin/users/${id}/delete`, { confirmed: '1' });
    expect(second.statusCode).toBe(303);
    expect(getUserByUsername(t.db, 'gone')).toBeNull();
  });

  it('guard errors render as messages, not 500s', async () => {
    const me = idOf('alex');
    for (const [path, extra, text] of [
      [`/admin/users/${me}/disable`, {}, 'cannot disable yourself'],
      [`/admin/users/${me}/demote`, {}, 'cannot demote yourself'],
      [`/admin/users/${me}/delete`, { confirmed: '1' }, 'cannot delete yourself'],
      [`/admin/users/${me}/impersonate`, {}, 'cannot impersonate yourself'],
      ['/admin/users/99999/disable', {}, 'user not found'],
    ] as const) {
      const res = await asSuper(path, extra);
      expect(res.statusCode, path).toBeGreaterThanOrEqual(400);
      expect(res.statusCode, path).toBeLessThan(500);
      const m = main(res.body);
      expect(m, path).toContain('role="alert"');
      expect(m, path).toContain(text);
    }
  });
});

describe('csrf on every new post', () => {
  it('rejects a missing or wrong token with 403 and changes nothing', async () => {
    const id = idOf('fred');
    const urls = [
      '/admin/users',
      `/admin/users/${id}/disable`,
      `/admin/users/${id}/enable`,
      `/admin/users/${id}/promote`,
      `/admin/users/${id}/demote`,
      `/admin/users/${id}/reset-2fa`,
      `/admin/users/${id}/reset-password`,
      `/admin/users/${id}/delete`,
      `/admin/users/${id}/impersonate`,
      '/impersonate/stop',
    ];
    for (const url of urls) {
      const none = await post(superSession, url, { username: 'nocsrf', password: 'long-enough-pass', confirmed: '1' });
      expect(none.statusCode, url).toBe(403);
      const bad = await post(superSession, url, { csrf: 'nope', username: 'nocsrf', password: 'long-enough-pass', confirmed: '1' });
      expect(bad.statusCode, url).toBe(403);
    }
    expect(getUserByUsername(t.db, 'nocsrf')).toBeNull();
    expect(getUserByUsername(t.db, 'fred')).not.toBeNull();
  });
});

describe('impersonation', () => {
  it('banner, audited actions with impersonator, stop returns to the super user', async () => {
    createUser(t.db, { username: 'bob', passwordHash: await hashPassword('bob-password-123') });
    const res = await asSuper(`/admin/users/${idOf('bob')}/impersonate`);
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe('/');
    const asBob = cookieOf(res);
    expect(asBob).not.toBe('');
    expect(asBob).not.toBe(superSession);
    // the super user's own session row is gone (the cookie is overwritten with the impersonation one)
    expect(getSession(t.db, superSession)).toBeNull();

    const home = await get(asBob, '/');
    expect(home.statusCode).toBe(200);
    expect(main(home.body)).toContain('Acting as <strong>bob</strong>');
    expect(main(home.body)).toContain('action="/impersonate/stop"');
    expect(main((await get(asBob, '/tokens')).body)).toContain('Acting as');
    // not super while impersonating
    expect(home.body).not.toContain('/admin/users');
    expect((await get(asBob, '/admin/users')).statusCode).toBe(404);

    // a normal page of another session does not show the banner
    expect(main((await get(sessionFor('alex'), '/tokens')).body)).not.toContain('Acting as');

    const bobCsrf = csrfOf(home.body);
    addOwner(t.db, t.workspaceId, idOf('bob'));
    const made = await post(asBob, '/projects', { csrf: bobCsrf, slug: 'bobs-proj', name: 'Bobs' });
    expect(made.statusCode).toBe(302);
    const create = listAudit(t.db, { action: 'project.create' })[0]!;
    expect(create.actor_id).toBe(idOf('bob'));
    expect(create.meta).toMatchObject({ impersonator: idOf('alex') });
    const start = listAudit(t.db, { action: 'impersonate.start' })[0]!;
    expect(start.actor_id).toBe(idOf('alex'));
    expect(start.meta ?? {}).not.toHaveProperty('impersonator');
    expect(main((await get(asBob, '/audit')).body)).toContain('<td>as bob by alex</td>');

    const stop = await post(asBob, '/impersonate/stop', { csrf: bobCsrf });
    expect(stop.statusCode).toBe(303);
    expect(stop.headers.location).toBe('/admin/users');
    const back = cookieOf(stop);
    expect(getSession(t.db, asBob)).toBeNull();
    expect((await get(back, '/admin/users')).statusCode).toBe(200);
    const stopped = listAudit(t.db, { action: 'impersonate.stop' })[0]!;
    expect(stopped.meta).toMatchObject({ impersonator: idOf('alex') });
  });

  it('impersonating a user with a temporary password is not blocked by the flag', async () => {
    await asSuper('/admin/users', { username: 'newbie', password: 'temp-password-newbie' });
    const res = await asSuper(`/admin/users/${idOf('newbie')}/impersonate`);
    const s = cookieOf(res);
    const home = await get(s, '/');
    expect(home.statusCode).toBe(200);
    expect(main(home.body)).toContain('Acting as');
    await post(s, '/impersonate/stop', { csrf: csrfOf(home.body) });
  });

  it('refuses to impersonate a super or disabled user with a message', async () => {
    createUser(t.db, { username: 'boss', passwordHash: await hashPassword('boss-password-12'), isSuper: true });
    const sup = await asSuper(`/admin/users/${idOf('boss')}/impersonate`);
    expect(sup.statusCode).toBe(403);
    expect(main(sup.body)).toContain('role="alert"');
    await asSuper(`/admin/users/${idOf('newbie')}/disable`);
    const dis = await asSuper(`/admin/users/${idOf('newbie')}/impersonate`);
    expect(dis.statusCode).toBe(400);
    expect(main(dis.body)).toContain('disabled');
  });

  it('a demoted super user loses their impersonation session immediately', async () => {
    const carol = createUser(t.db, { username: 'carol', passwordHash: await hashPassword('carol-password-1'), isSuper: true });
    createUser(t.db, { username: 'vic', passwordHash: await hashPassword('vic-password-123') });
    const cs = sessionFor('carol');
    const cc = csrfOf((await get(cs, '/')).body);
    const imp = cookieOf(await post(cs, `/admin/users/${idOf('vic')}/impersonate`, { csrf: cc }));
    expect((await get(imp, '/')).statusCode).toBe(200);
    expect((await asSuper(`/admin/users/${carol.id}/demote`)).statusCode).toBe(303);
    expect(getSession(t.db, imp)).toBeNull();
    expect((await get(imp, '/')).statusCode).toBe(302);
  });
});

describe('impersonation edge cases', () => {
  it('stopping still works when the impersonated user was disabled meanwhile', async () => {
    createUser(t.db, { username: 'dina', passwordHash: await hashPassword('dina-password-12') });
    const asDina = cookieOf(await asSuper(`/admin/users/${idOf('dina')}/impersonate`));
    const dinaCsrf = csrfOf((await get(asDina, '/')).body);
    // disabled by another super user while the impersonation is running
    setUserDisabled(t.db, idOf('dina'), true);
    expect((await get(asDina, '/')).statusCode).toBe(302); // every other request is locked out
    const stop = await post(asDina, '/impersonate/stop', { csrf: dinaCsrf });
    expect(stop.statusCode).toBe(303);
    expect(stop.headers.location).toBe('/admin/users');
    expect(getSession(t.db, asDina)).toBeNull();
    expect((await get(cookieOf(stop), '/admin/users')).statusCode).toBe(200);
  });

  it('a disabled user session without an impersonator can never reach the stop route', async () => {
    createUser(t.db, { username: 'eve', passwordHash: await hashPassword('eve-password-123') });
    const eve = sessionFor('eve');
    const eveCsrf = csrfOf((await get(eve, '/')).body);
    setUserDisabled(t.db, idOf('eve'), true);
    expect((await post(eve, '/impersonate/stop', { csrf: eveCsrf })).statusCode).toBe(302);
  });
});

describe('reset password and tokens', () => {
  const activeTokens = (userId: number) => listTokensForUser(t.db, userId).filter((x) => x.revoked_at === null).length;

  it('revokes all API and agent tokens when the box is ticked, and says so in the audit row', async () => {
    const u = createUser(t.db, { username: 'tessa', passwordHash: await hashPassword('tessa-password-1') });
    createToken(t.db, { userId: u.id, name: 'cli', scopes: ['admin'], projectIds: null, expiresAt: null });
    createToken(t.db, { userId: u.id, name: 'claude', scopes: ['projects:read'], projectIds: null, expiresAt: null, kind: 'agent' });
    expect(activeTokens(u.id)).toBe(2);
    const res = await asSuper(`/admin/users/${u.id}/reset-password`, { password: 'new-temp-password-1', revoke_tokens: 'on' });
    expect(res.statusCode).toBe(200); // the page shows the reset result
    expect(activeTokens(u.id)).toBe(0);
    const row = listAudit(t.db, { action: 'user.password_reset' })[0]!;
    expect(row.meta).toMatchObject({ username: 'tessa', tokens_revoked: 2 });
  });

  it('keeps the tokens when the box is left unticked', async () => {
    const u = createUser(t.db, { username: 'tom', passwordHash: await hashPassword('tom-password-123') });
    createToken(t.db, { userId: u.id, name: 'cli', scopes: ['admin'], projectIds: null, expiresAt: null });
    expect((await asSuper(`/admin/users/${u.id}/reset-password`, { password: 'new-temp-password-2' })).statusCode).toBe(200);
    expect(activeTokens(u.id)).toBe(1);
    expect(listAudit(t.db, { action: 'user.password_reset' })[0]!.meta).toMatchObject({ tokens_revoked: false });
  });

  it('the form offers the checkbox, ticked by default', async () => {
    createUser(t.db, { username: 'tina', passwordHash: await hashPassword('tina-password-12') });
    expect(main((await get(superSession, '/admin/users')).body)).toMatch(/<input type="checkbox" name="revoke_tokens" checked \/> Also revoke all API and agent tokens/);
  });
});

describe('audit and secret pages name users', () => {
  it('audit shows usernames, not "you"/"admin"', async () => {
    const res = await get(superSession, '/audit');
    const m = main(res.body);
    expect(m).toContain('<td>alex</td>');
    expect(m).not.toContain('<td>admin #');
  });

  it('secret recent access shows the username', async () => {
    t.project('acme');
    createSecret(t.db, t.ring, {
      projectId: getProjectBySlug(t.db, 'acme')!.id,
      workspaceId: t.workspaceId,
      name: 'DB',
      description: '',
      tags: [],
      fields: [{ key: 'password', value: 'hunter2hunter2' }],
    });
    const reveal = await post(superSession, '/p/acme/secrets/DB/reveal', { csrf: superCsrf, key: 'password' });
    expect(reveal.statusCode).toBe(200);
    const m = main((await get(superSession, '/p/acme/secrets/DB')).body);
    expect(m).toContain('Recent access');
    expect(m).toContain('<span>alex</span>');
    expect(m).not.toContain('<span>you</span>');
  });
});
