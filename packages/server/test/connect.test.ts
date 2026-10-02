import { describe, it, expect } from 'vitest';
import { makeTestApp } from './helpers.js';
import { createAdmin } from '../src/repos/admin.js';
import { hashPassword } from '../src/crypto/passwords.js';
import { listAudit } from '../src/repos/audit.js';
import { getConnectRequestByUserCode } from '../src/repos/connect.js';
import { createToken } from '../src/repos/tokens.js';

async function login(t: Awaited<ReturnType<typeof makeTestApp>>, username = 'alex', password = 'pw') {
  const res = await t.app.inject({ method: 'POST', url: '/login', payload: { username, password } });
  return res.cookies.find((c) => c.name === 'blindkey_session')!.value;
}

async function csrfFor(t: Awaited<ReturnType<typeof makeTestApp>>, session: string): Promise<string> {
  const res = await t.app.inject({ method: 'GET', url: '/', cookies: { blindkey_session: session } });
  return /name="csrf" value="([^"]+)"/.exec(res.body)![1]!;
}

async function start(t: Awaited<ReturnType<typeof makeTestApp>>, body: Record<string, unknown>) {
  return t.app.inject({ method: 'POST', url: '/api/v1/connect/start', payload: body });
}

async function poll(t: Awaited<ReturnType<typeof makeTestApp>>, deviceCode: string) {
  return t.app.inject({ method: 'POST', url: '/api/v1/connect/poll', payload: { device_code: deviceCode } });
}

async function approve(
  t: Awaited<ReturnType<typeof makeTestApp>>,
  session: string,
  csrf: string,
  code: string,
  scopes: string[],
  projects: string[],
  expiresDays: string | number = '90',
) {
  return t.app.inject({
    method: 'POST',
    url: '/connect/approve',
    cookies: { blindkey_session: session },
    payload: { csrf, code, scopes, projects, expires_days: String(expiresDays) },
  });
}

async function deny(t: Awaited<ReturnType<typeof makeTestApp>>, session: string, csrf: string, code: string) {
  return t.app.inject({ method: 'POST', url: '/connect/deny', cookies: { blindkey_session: session }, payload: { csrf, code } });
}

describe('device flow: start (spec §1.3)', () => {
  it('starts a request with a well-formed device_code, user_code and verification_url', async () => {
    const t = await makeTestApp();
    const res = await start(t, { name: 'claude-prod@laptop', scopes: ['projects:read'], projects: ['alpha'] });
    expect(res.statusCode).toBe(201);
    const b = res.json();
    expect(b.device_code).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(b.user_code).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    expect(b.verification_url).toMatch(/^http:\/\/[^/]+\/connect\?code=/);
    expect(b.verification_url.endsWith(`code=${b.user_code}`)).toBe(true);
    expect(b.expires_in).toBe(600);
    expect(b.interval).toBe(3);
  });

  it('verification_url keeps the request host including its port (Fastify req.hostname would drop it)', async () => {
    const t = await makeTestApp();
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/connect/start',
      headers: { host: 'localhost:8080' },
      payload: { name: 'x', scopes: ['projects:read'] },
    });
    expect(res.statusCode).toBe(201);
    const b = res.json();
    expect(b.verification_url).toBe(`http://localhost:8080/connect?code=${b.user_code}`);
  });

  it('accepts an unknown project slug — kept, not an error', async () => {
    const t = await makeTestApp();
    const res = await start(t, { name: 'x', scopes: ['projects:read'], projects: ['does-not-exist'] });
    expect(res.statusCode).toBe(201);
  });

  it('rejects a scope outside AGENT_SCOPES (admin, secrets:reveal, secrets:write) with 400', async () => {
    const t = await makeTestApp();
    for (const scope of ['admin', 'secrets:reveal', 'secrets:write']) {
      const res = await start(t, { name: 'x', scopes: [scope] });
      expect(res.statusCode, scope).toBe(400);
    }
  });

  it('rejects an empty scopes array', async () => {
    const t = await makeTestApp();
    const res = await start(t, { name: 'x', scopes: [] });
    expect(res.statusCode).toBe(400);
  });

  it('writes a connect.started audit row with no device_code inside', async () => {
    const t = await makeTestApp();
    const res = await start(t, { name: 'claude-prod@laptop', scopes: ['projects:read'] });
    const { device_code: deviceCode, user_code: userCode } = res.json();
    const rows = listAudit(t.db, { action: 'connect.started' });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.meta).toMatchObject({ name: 'claude-prod@laptop', user_code: userCode });
    expect(JSON.stringify(rows[0]!.meta)).not.toContain(deviceCode);
  });

  it('is rate limited to 10/min', async () => {
    const t = await makeTestApp();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await start(t, { name: 'x', scopes: ['projects:read'] })).statusCode);
    expect(statuses.slice(0, 10)).not.toContain(429);
    expect(statuses[10]).toBe(429);
  });
});

describe('device flow: poll states (spec §1.3)', () => {
  it('an unknown device_code → 400 invalid_request', async () => {
    const t = await makeTestApp();
    const res = await poll(t, 'not-a-real-code');
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_request');
  });

  it('a pending request → 428 authorization_pending', async () => {
    const t = await makeTestApp();
    const { device_code: deviceCode } = (await start(t, { name: 'x', scopes: ['projects:read'] })).json();
    const res = await poll(t, deviceCode);
    expect(res.statusCode).toBe(428);
    expect(res.json().error).toBe('authorization_pending');
  });

  it('an expired request → 410 expired, and the row is gone (next poll is 400)', async () => {
    const t = await makeTestApp();
    const { device_code: deviceCode, user_code: userCode } = (await start(t, { name: 'x', scopes: ['projects:read'] })).json();
    t.db.prepare(`UPDATE connect_requests SET expires_at = ? WHERE user_code = ?`).run(Date.now() - 1000, userCode);
    const res = await poll(t, deviceCode);
    expect(res.statusCode).toBe(410);
    expect(res.json().error).toBe('expired');
    const again = await poll(t, deviceCode);
    expect(again.statusCode).toBe(400);
  });

  it('a denied request → 403 access_denied, and the row is deleted (next poll is 400)', async () => {
    const t = await makeTestApp();
    createAdmin(t.db, 'alex', await hashPassword('pw'));
    const session = await login(t);
    const csrf = await csrfFor(t, session);
    const { device_code: deviceCode, user_code: userCode } = (await start(t, { name: 'x', scopes: ['projects:read'] })).json();

    const denyRes = await deny(t, session, csrf, userCode);
    expect(denyRes.statusCode).toBe(302);

    const res = await poll(t, deviceCode);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('access_denied');
    expect(getConnectRequestByUserCode(t.db, userCode)).toBeNull();

    const again = await poll(t, deviceCode);
    expect(again.statusCode).toBe(400);
    expect(again.json().error).toBe('invalid_request');

    expect(listAudit(t.db, { action: 'connect.denied' })).toHaveLength(1);
  });

  it('is rate limited to 60/min', async () => {
    const t = await makeTestApp();
    const statuses: number[] = [];
    for (let i = 0; i < 61; i++) statuses.push((await poll(t, 'nope')).statusCode);
    expect(statuses.slice(0, 60)).not.toContain(429);
    expect(statuses[60]).toBe(429);
  });
});

describe('device flow: approve then poll issues a token (spec §1.3)', () => {
  async function setupApprovedPoll(t: Awaited<ReturnType<typeof makeTestApp>>) {
    createAdmin(t.db, 'alex', await hashPassword('pw'));
    const session = await login(t);
    const csrf = await csrfFor(t, session);
    t.project('alpha');
    t.project('beta');
    const { device_code: deviceCode, user_code: userCode } = (
      await start(t, { name: 'claude-prod@laptop', scopes: ['projects:read', 'docs:read'], projects: ['alpha'] })
    ).json();
    return { session, csrf, deviceCode, userCode };
  }

  it('approve requires CSRF', async () => {
    const t = await makeTestApp();
    const { session, userCode } = await setupApprovedPoll(t);
    const res = await t.app.inject({
      method: 'POST',
      url: '/connect/approve',
      cookies: { blindkey_session: session },
      payload: { code: userCode, scopes: ['projects:read'], projects: ['alpha'] },
    });
    expect(res.statusCode).toBe(403);
  });

  it('approve requires at least one scope', async () => {
    const t = await makeTestApp();
    const { session, csrf, userCode } = await setupApprovedPoll(t);
    const res = await approve(t, session, csrf, userCode, [], ['alpha']);
    expect(res.statusCode).toBe(400);
    expect(getConnectRequestByUserCode(t.db, userCode)!.status).toBe('pending');
  });

  it('approve requires at least one project', async () => {
    const t = await makeTestApp();
    const { session, csrf, userCode } = await setupApprovedPoll(t);
    const res = await approve(t, session, csrf, userCode, ['projects:read'], []);
    expect(res.statusCode).toBe(400);
    expect(getConnectRequestByUserCode(t.db, userCode)!.status).toBe('pending');
  });

  it('a tampered form cannot add a non-agent scope (admin/secrets:reveal/secrets:write)', async () => {
    const t = await makeTestApp();
    const { session, csrf, userCode, deviceCode } = await setupApprovedPoll(t);
    const res = await approve(t, session, csrf, userCode, ['projects:read', 'admin'], ['alpha']);
    expect(res.statusCode).toBe(400);
    expect(getConnectRequestByUserCode(t.db, userCode)!.status).toBe('pending');
    // Confirm no token was ever issued from the tampered attempt.
    const poll1 = await poll(t, deviceCode);
    expect(poll1.statusCode).toBe(428); // still only pending — the tampered approve never took effect
  });

  it('a tampered form cannot add secrets:reveal', async () => {
    const t = await makeTestApp();
    const { session, csrf, userCode } = await setupApprovedPoll(t);
    const res = await approve(t, session, csrf, userCode, ['projects:read', 'secrets:reveal'], ['alpha']);
    expect(res.statusCode).toBe(400);
    expect(getConnectRequestByUserCode(t.db, userCode)!.status).toBe('pending');
  });

  it('a tampered form cannot add secrets:write', async () => {
    const t = await makeTestApp();
    const { session, csrf, userCode } = await setupApprovedPoll(t);
    const res = await approve(t, session, csrf, userCode, ['projects:read', 'secrets:write'], ['alpha']);
    expect(res.statusCode).toBe(400);
    expect(getConnectRequestByUserCode(t.db, userCode)!.status).toBe('pending');
  });

  it('approving an already-expired pending request errors and issues no token', async () => {
    const t = await makeTestApp();
    const { session, csrf, userCode, deviceCode } = await setupApprovedPoll(t);
    t.db.prepare(`UPDATE connect_requests SET expires_at = ? WHERE user_code = ?`).run(Date.now() - 1000, userCode);
    const res = await approve(t, session, csrf, userCode, ['projects:read'], ['alpha']);
    expect(res.statusCode).toBe(404);
    const pollRes = await poll(t, deviceCode);
    expect(pollRes.statusCode).toBe(410); // the row was never approved (still pending) and is expired
    const tokens = t.db.prepare(`SELECT COUNT(*) as n FROM api_tokens WHERE kind = 'agent'`).get() as { n: number };
    expect(tokens.n).toBe(0);
  });

  it('the approver can edit the expiry: an approved expiry different from the requested one is reflected in the issued token', async () => {
    const t = await makeTestApp();
    const { session, csrf, userCode, deviceCode } = await setupApprovedPoll(t);
    const before = Date.now();
    const approveRes = await approve(t, session, csrf, userCode, ['projects:read'], ['alpha'], 5);
    expect(approveRes.statusCode).toBe(302);
    const pollRes = await poll(t, deviceCode);
    expect(pollRes.statusCode).toBe(200);
    const expiresAt = pollRes.json().expires_at as number;
    const fiveDaysMs = 5 * 24 * 60 * 60 * 1000;
    // Well short of the requested 90-day default, and consistent with a ~5 day grant.
    expect(expiresAt).toBeLessThan(before + fiveDaysMs + 60_000);
    expect(expiresAt).toBeGreaterThan(before + fiveDaysMs - 60_000);
  });

  it('an out-of-range edited expiry is rejected with 400 and the request stays pending', async () => {
    const t = await makeTestApp();
    const { session, csrf, userCode } = await setupApprovedPoll(t);
    for (const bad of [0, -1, 366, 100_000]) {
      const res = await approve(t, session, csrf, userCode, ['projects:read'], ['alpha'], bad);
      expect(res.statusCode, String(bad)).toBe(400);
      expect(getConnectRequestByUserCode(t.db, userCode)!.status, String(bad)).toBe('pending');
    }
  });

  it('approve then poll issues an agent-kind token with the approved scopes/projects/expiry, and deletes the request', async () => {
    const t = await makeTestApp();
    const { session, csrf, userCode, deviceCode } = await setupApprovedPoll(t);

    const approveRes = await approve(t, session, csrf, userCode, ['projects:read', 'docs:read'], ['alpha', 'beta']);
    expect(approveRes.statusCode).toBe(302);

    const pollRes = await poll(t, deviceCode);
    expect(pollRes.statusCode).toBe(200);
    const b = pollRes.json();
    expect(b.token).toMatch(/^bk_/);
    expect(b.name).toBe('claude-prod@laptop');
    expect(b.scopes.sort()).toEqual(['docs:read', 'projects:read']);
    expect(b.projects.sort()).toEqual(['alpha', 'beta']);
    expect(typeof b.expires_at).toBe('number');
    expect(b.expires_at).toBeGreaterThan(Date.now());

    expect(getConnectRequestByUserCode(t.db, userCode)).toBeNull();

    const row = t.db.prepare(`SELECT kind FROM api_tokens WHERE id = ?`).get(b.id) as { kind: string };
    expect(row.kind).toBe('agent');
  });

  it('revokes an older agent token with the same name, but leaves a user-kind token with that name alone', async () => {
    const t = await makeTestApp();
    const { session, csrf, userCode, deviceCode } = await setupApprovedPoll(t);
    const { row: oldAgent } = createToken(t.db, {
      name: 'claude-prod@laptop',
      scopes: ['projects:read'],
      projectIds: null,
      expiresAt: null,
      kind: 'agent',
    });
    const { row: userToken } = createToken(t.db, {
      name: 'claude-prod@laptop',
      scopes: ['projects:read'],
      projectIds: null,
      expiresAt: null,
      kind: 'user',
    });

    await approve(t, session, csrf, userCode, ['projects:read'], ['alpha']);
    await poll(t, deviceCode);

    const oldAfter = t.db.prepare(`SELECT revoked_at FROM api_tokens WHERE id = ?`).get(oldAgent.id) as { revoked_at: number | null };
    expect(oldAfter.revoked_at).not.toBeNull();
    const userAfter = t.db.prepare(`SELECT revoked_at FROM api_tokens WHERE id = ?`).get(userToken.id) as { revoked_at: number | null };
    expect(userAfter.revoked_at).toBeNull();
  });

  it('poll after approval is race-safe: a replayed second poll gets 400 invalid_request, exactly one token issued (Review Focus 3)', async () => {
    const t = await makeTestApp();
    const { session, csrf, userCode, deviceCode } = await setupApprovedPoll(t);
    await approve(t, session, csrf, userCode, ['projects:read'], ['alpha']);

    const [first, second] = await Promise.all([poll(t, deviceCode), poll(t, deviceCode)]);
    const statuses = [first.statusCode, second.statusCode].sort();
    expect(statuses).toEqual([200, 400]);
    const failed = first.statusCode === 400 ? first : second;
    expect(failed.json().error).toBe('invalid_request');

    const tokens = t.db.prepare(`SELECT COUNT(*) as n FROM api_tokens WHERE kind = 'agent'`).get() as { n: number };
    expect(tokens.n).toBe(1);
    expect(listAudit(t.db, { action: 'connect.token_issued' })).toHaveLength(1);
  });

  it('de-duplicates a repeated scope or project value in the submitted form', async () => {
    const t = await makeTestApp();
    const { session, csrf, userCode, deviceCode } = await setupApprovedPoll(t);
    const res = await approve(t, session, csrf, userCode, ['projects:read', 'projects:read'], ['alpha', 'alpha']);
    expect(res.statusCode).toBe(302);
    const pollRes = await poll(t, deviceCode);
    expect(pollRes.statusCode).toBe(200);
    const b = pollRes.json();
    expect(b.scopes).toEqual(['projects:read']);
    expect(b.projects).toEqual(['alpha']);
  });

  it('writes a connect.approved audit row and a connect.token_issued audit row with no device_code or token inside', async () => {
    const t = await makeTestApp();
    const { session, csrf, userCode, deviceCode } = await setupApprovedPoll(t);
    await approve(t, session, csrf, userCode, ['projects:read'], ['alpha']);
    const pollRes = await poll(t, deviceCode);
    const token = pollRes.json().token;

    const approved = listAudit(t.db, { action: 'connect.approved' });
    expect(approved).toHaveLength(1);
    expect(approved[0]!.meta).toMatchObject({ name: 'claude-prod@laptop' });

    const issued = listAudit(t.db, { action: 'connect.token_issued' });
    expect(issued).toHaveLength(1);
    expect(JSON.stringify(issued[0]!.meta)).not.toContain(token);
    expect(JSON.stringify(issued[0]!.meta)).not.toContain(deviceCode);
    expect(JSON.stringify(approved[0]!.meta)).not.toContain(deviceCode);
  });
});
