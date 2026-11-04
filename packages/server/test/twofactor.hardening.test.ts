import { describe, it, expect } from 'vitest';
import { actorOf, makeShared } from './access.fixture.js';
import { sessionFor } from './helpers.js';
import { createSession, createUser, getUserByUsername } from '../src/repos/admin.js';
import { createToken, getTokenById } from '../src/repos/tokens.js';
import { createWorkspace, addOwner } from '../src/repos/workspaces.js';
import { getTotp, openTotpSecret, isTwoFactorByAdmin } from '../src/repos/twofactor.js';
import { listAudit } from '../src/repos/audit.js';
import { hashPassword } from '../src/crypto/passwords.js';
import { hotp, stepAt, base32Decode } from '../src/auth/totp.js';
import { approveConnect, startConnect } from '../src/services/connect.js';
import { beginReenrollment, confirmEnrollment, confirmReenrollment, startEnrollment, verifySecondFactor } from '../src/services/twofactor.js';
import { resetUserPasswordFor, resetUserTwoFactorFor, setUserDisabledFor, userSetupFor, confirmUserSetupFor } from '../src/services/users.js';
import { runTotpReset } from '../src/ops.js';
import { ConflictError } from '../src/errors.js';

const csrfOf = (b: string) => /name="csrf" value="([^"]+)"/.exec(b)?.[1] ?? '';
const codeOf = (secret: Buffer, d = 0) => hotp(secret, stepAt(Date.now()) + d);

describe('a super user can only set up what a super user started', () => {
  it("does not render or confirm a user's own pending self-enrollment", async () => {
    const t = await makeShared();
    try {
      const owner = t.owner();
      const u = createUser(t.db, { username: 'selfie', passwordHash: 'h' });
      startEnrollment(t.ctx, u.id); // the user's own, not super-initiated
      const secret = openTotpSecret(t.ring, getTotp(t.db, u.id)!);
      expect(isTwoFactorByAdmin(t.db, u.id)).toBe(false);
      expect(userSetupFor(t.ctx, actorOf(owner).principal, u.id)).toBeNull();
      await expect(confirmUserSetupFor(t.ctx, actorOf(owner), u.id, codeOf(secret))).rejects.toThrow(ConflictError);
      expect(getTotp(t.db, u.id)!.enabled_at).toBeNull();
      // over HTTP: 404 and no secret in the body
      const s = sessionFor(t.db, 'alex');
      const page = await t.app.inject({ method: 'GET', url: `/admin/users/${u.id}/setup-2fa`, cookies: { blindkey_session: s } });
      expect(page.statusCode).toBe(404);
      const csrf = csrfOf((await t.app.inject({ method: 'GET', url: '/', cookies: { blindkey_session: s } })).body);
      const post = await t.app.inject({ method: 'POST', url: `/admin/users/${u.id}/setup-2fa`, cookies: { blindkey_session: s }, payload: { csrf, code: codeOf(secret) } });
      expect(post.statusCode).toBe(409);
      expect(getTotp(t.db, u.id)!.enabled_at).toBeNull();
    } finally {
      await t.app.close();
    }
  });
});

describe('approved connect requests do not outlive the approver\'s factor, account or password', () => {
  const approved = async (t: Awaited<ReturnType<typeof makeShared>>, user: { id: number; username: string }) => {
    addOwner(t.db, t.workspaceId, user.id);
    const start = startConnect(t.ctx, { name: 'claude@laptop', scopes: ['projects:read'], projects: ['alpha'], expires_days: 30 }, '', '', 'http://x');
    approveConnect(t.ctx, actorOf(getUserByUsername(t.db, user.username)!), start.user_code, ['projects:read'], ['alpha'], '30');
    return start.device_code;
  };
  const poll = (t: Awaited<ReturnType<typeof makeShared>>, deviceCode: string) =>
    t.app.inject({ method: 'POST', url: '/api/v1/connect/poll', payload: { device_code: deviceCode } });

  it.each([
    ['2FA reset', (t: Awaited<ReturnType<typeof makeShared>>, id: number) => resetUserTwoFactorFor(t.ctx, actorOf(t.owner()), id)],
    ['disable', (t: Awaited<ReturnType<typeof makeShared>>, id: number) => setUserDisabledFor(t.ctx, actorOf(t.owner()), id, true)],
    ['password reset', (t: Awaited<ReturnType<typeof makeShared>>, id: number) => resetUserPasswordFor(t.ctx, actorOf(t.owner()), id, 'Another-pass-123')],
  ])('%s deletes the approved-but-uncollected request: polling finds nothing and no token is minted', async (_name, act) => {
    const t = await makeShared();
    try {
      const device = await approved(t, t.bob);
      const before = (t.db.prepare(`SELECT COUNT(*) AS n FROM api_tokens WHERE kind = 'agent'`).get() as { n: number }).n;
      await act(t, t.bob.id);
      expect((t.db.prepare(`SELECT COUNT(*) AS n FROM connect_requests WHERE approved_by_user_id = ?`).get(t.bob.id) as { n: number }).n).toBe(0);
      const res = await poll(t, device);
      expect(res.statusCode).toBe(400);
      expect((t.db.prepare(`SELECT COUNT(*) AS n FROM api_tokens WHERE kind = 'agent'`).get() as { n: number }).n).toBe(before);
    } finally {
      await t.app.close();
    }
  });

  it('the shell 2fa reset does the same, and revokes the user\'s tokens', async () => {
    const t = await makeShared();
    try {
      const device = await approved(t, t.bob);
      const tok = createToken(t.db, { userId: t.bob.id, name: 'cli', scopes: ['admin'], projectIds: null, expiresAt: null });
      runTotpReset(t.db, 'bob');
      expect(getTokenById(t.db, tok.row.id)!.revoked_at).not.toBeNull();
      expect((await poll(t, device)).statusCode).toBe(400);
    } finally {
      await t.app.close();
    }
  });
});

describe('the re-enroll token is single use', () => {
  it('a replay after a successful confirm fails, and so does an older token after a newer rotation', async () => {
    const t = await makeShared();
    try {
      const bob = actorOf(t.bob);
      const first = beginReenrollment(t.ctx, bob, 'bob');
      const second = beginReenrollment(t.ctx, bob, 'bob');
      const secretOf = (r: { secret: string }) => base32Decode(r.secret);
      // confirm the newer one
      const codes = await confirmReenrollment(t.ctx, bob, second.token, codeOf(secretOf(second)), 'sid');
      expect(codes).not.toBeNull();
      expect(openTotpSecret(t.ring, getTotp(t.db, t.bob.id)!).equals(secretOf(second))).toBe(true);
      // the older token must not replace the new secret
      expect(await confirmReenrollment(t.ctx, bob, first.token, codeOf(secretOf(first), 1), 'sid')).toBeNull();
      // replaying the consumed token (even with a fresh valid code of its secret) fails
      expect(await confirmReenrollment(t.ctx, bob, second.token, codeOf(secretOf(second), 1), 'sid')).toBeNull();
      expect(openTotpSecret(t.ring, getTotp(t.db, t.bob.id)!).equals(secretOf(second))).toBe(true);
    } finally {
      await t.app.close();
    }
  });
});

describe('re-enroll re-auth takes a current TOTP code only', () => {
  it('a recovery code does not start a re-enrollment (it still regenerates recovery codes)', async () => {
    const t = await makeShared();
    try {
      // a user with real recovery codes
      const u = createUser(t.db, { username: 'rec', passwordHash: await hashPassword('rec-password-123') });
      startEnrollment(t.ctx, u.id);
      const actor = actorOf(getUserByUsername(t.db, 'rec')!);
      const recovery = (await confirmEnrollment(t.ctx, actor, codeOf(openTotpSecret(t.ring, getTotp(t.db, u.id)!))))!;
      expect(recovery).toHaveLength(10);
      const s = createSession(t.db, u.id, 60_000, '', '');
      const csrf = csrfOf((await t.app.inject({ method: 'GET', url: '/settings/2fa', cookies: { blindkey_session: s } })).body);
      const res = await t.app.inject({ method: 'POST', url: '/settings/2fa/reenroll', cookies: { blindkey_session: s }, payload: { csrf, password: 'rec-password-123', code: recovery[0] } });
      expect(res.statusCode).toBe(400);
      expect(res.body).not.toContain('name="token"');
      // service level: totpOnly refuses a recovery code, and does not spend it
      expect(await verifySecondFactor(t.ctx, u.id, recovery[1]!, { totpOnly: true })).toBeNull();
      expect(await verifySecondFactor(t.ctx, u.id, recovery[1]!)).toBe('recovery');
    } finally {
      await t.app.close();
    }
  });
});

describe('tokens of a user without two-factor do not work', () => {
  it('bearer auth answers 401 for an unenrolled owner, and works once enrolled', async () => {
    const t = await makeShared();
    try {
      const u = createUser(t.db, { username: 'plainjane', passwordHash: 'h' });
      const token = createToken(t.db, { userId: u.id, name: 'cli', scopes: ['admin'], projectIds: null, expiresAt: null }).token;
      const call = () => t.app.inject({ method: 'GET', url: '/api/v1/me', headers: { authorization: `Bearer ${token}` } });
      expect((await call()).statusCode).toBe(401);
      t.enroll(u.id);
      expect((await call()).statusCode).toBe(200);
      // the fixture owner and users are enrolled, so their tokens keep working
      expect((await t.app.inject({ method: 'GET', url: '/api/v1/me', headers: { authorization: `Bearer ${t.as(t.bob)}` } })).statusCode).toBe(200);
    } finally {
      await t.app.close();
    }
  });
});

describe('the 2FA reset audit row counts the sessions it deleted', () => {
  it('meta.sessions_deleted', async () => {
    const t = await makeShared();
    try {
      createSession(t.db, t.bob.id, 60_000, '', '');
      createSession(t.db, t.bob.id, 60_000, '', '');
      resetUserTwoFactorFor(t.ctx, actorOf(t.owner()), t.bob.id);
      expect(listAudit(t.db, { action: 'user.2fa_reset' })[0]!.meta).toMatchObject({ sessions_deleted: 2 });
    } finally {
      await t.app.close();
    }
  });
});

describe('workspace avatar tints', () => {
  it('hashes the slug into 8 tints: two slugs that collided under the old char-sum get distinct tints, and both new tints exist in the CSS', async () => {
    const t = await makeShared();
    try {
      const a = createWorkspace(t.db, { slug: 'alpha', name: 'Alpha' });
      const b = createWorkspace(t.db, { slug: 'beta', name: 'Beta' });
      addOwner(t.db, a.id, t.owner().id);
      addOwner(t.db, b.id, t.owner().id);
      const s = sessionFor(t.db, 'alex');
      const html = (await t.app.inject({ method: 'GET', url: '/', cookies: { blindkey_session: s } })).body;
      const tint = (init: string) => new RegExp(`ws-avatar ws-tint-(\\d)" aria-hidden="true">${init}<`).exec(html)?.[1];
      expect(tint('AL')).toBeDefined();
      expect(tint('BE')).toBeDefined();
      expect(tint('AL')).not.toBe(tint('BE'));
      // FNV-1a: alpha -> 3, beta -> 7
      expect(tint('AL')).toBe('3');
      expect(tint('BE')).toBe('7');
      const css = (await t.app.inject({ method: 'GET', url: '/assets/app.css' })).body;
      expect(css).toContain('.ws-tint-6 {');
      expect(css).toContain('.ws-tint-7 {');
    } finally {
      await t.app.close();
    }
  });
});
