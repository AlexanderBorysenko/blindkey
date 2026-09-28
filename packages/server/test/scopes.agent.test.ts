import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { makeTestApp, auth } from './helpers.js';
import { createToken } from '../src/repos/tokens.js';
import { registerAuth } from '../src/http/auth.js';
import type { Principal } from '../src/auth/principal.js';

describe('agent token kind (spec §1.1)', () => {
  it('migration 4 adds api_tokens.kind defaulting to user', async () => {
    const t = await makeTestApp();
    const row = t.db.prepare(`SELECT kind FROM api_tokens LIMIT 0`).columns();
    expect(row.some((c) => c.name === 'kind')).toBe(true);
    const { row: created } = createToken(t.db, { name: 'plain', scopes: ['docs:read'], projectIds: null, expiresAt: null });
    expect(created.kind).toBe('user');
    const raw = t.db.prepare(`SELECT kind FROM api_tokens WHERE id = ?`).get(created.id) as { kind: string };
    expect(raw.kind).toBe('user');
  });

  it('createToken accepts an explicit agent kind', async () => {
    const t = await makeTestApp();
    const { row } = createToken(t.db, { name: 'agent-token', scopes: ['projects:read'], projectIds: null, expiresAt: null, kind: 'agent' });
    expect(row.kind).toBe('agent');
  });

  it('a bearer request from an agent-kind token sets principal.agent = true; a user-kind token sets it false', async () => {
    const t = await makeTestApp();
    const { token: agentToken } = createToken(t.db, { name: 'agent', scopes: ['projects:read'], projectIds: null, expiresAt: null, kind: 'agent' });
    const { token: userToken } = createToken(t.db, { name: 'user', scopes: ['projects:read'], projectIds: null, expiresAt: null, kind: 'user' });

    const app = Fastify();
    registerAuth(app, t.ctx);
    app.get('/whoami', async (req) => req.principal as Principal);

    const agentRes = await app.inject({ method: 'GET', url: '/whoami', headers: auth(agentToken) });
    expect(agentRes.json().agent).toBe(true);
    const userRes = await app.inject({ method: 'GET', url: '/whoami', headers: auth(userToken) });
    expect(userRes.json().agent).toBe(false);
    await app.close();
  });

  it('the UI session resolver always sets principal.agent = false for an admin session', async () => {
    const t = await makeTestApp();
    const { createAdmin } = await import('../src/repos/admin.js');
    const { hashPassword } = await import('../src/crypto/passwords.js');
    createAdmin(t.db, 'alex', await hashPassword('pw'));
    const { registerSessionResolver } = await import('../src/ui/session.js');

    const app = Fastify();
    await app.register(cookie);
    registerSessionResolver(app, t.ctx);
    app.get('/tokens', async (req) => (req as unknown as { principal: Principal }).principal ?? null);
    const loginRes = await t.app.inject({ method: 'POST', url: '/login', payload: { username: 'alex', password: 'pw' } });
    const session = loginRes.cookies.find((c) => c.name === 'pidb_session')!.value;
    const res = await app.inject({ method: 'GET', url: '/tokens', cookies: { pidb_session: session } });
    expect(res.json().kind).toBe('admin');
    expect(res.json().agent).toBe(false);
    await app.close();
  });

  it('tokens UI shows an agent pill for a kind=agent token, and none for a kind=user token', async () => {
    const t = await makeTestApp();
    const { createAdmin } = await import('../src/repos/admin.js');
    const { hashPassword } = await import('../src/crypto/passwords.js');
    createAdmin(t.db, 'alex', await hashPassword('pw'));
    const session = (await t.app.inject({ method: 'POST', url: '/login', payload: { username: 'alex', password: 'pw' } }))
      .cookies.find((c) => c.name === 'pidb_session')!.value;
    createToken(t.db, { name: 'the-agent-token', scopes: ['projects:read'], projectIds: null, expiresAt: null, kind: 'agent' });
    createToken(t.db, { name: 'the-user-token', scopes: ['projects:read'], projectIds: null, expiresAt: null, kind: 'user' });
    const res = await t.app.inject({ method: 'GET', url: '/tokens', cookies: { pidb_session: session } });
    expect(res.statusCode).toBe(200);
    const body = res.body;
    // Each token is a card; its title line ends at the first </div> after the name.
    const agentRowStart = body.indexOf('the-agent-token');
    const agentRowEnd = body.indexOf('</div>', agentRowStart);
    expect(body.slice(agentRowStart, agentRowEnd)).toContain('class="pill kind-agent"');
    const userRowStart = body.indexOf('the-user-token');
    const userRowEnd = body.indexOf('</div>', userRowStart);
    expect(body.slice(userRowStart, userRowEnd)).not.toContain('kind-agent');
  });

  it('tokens create form offers the new scopes for user tokens too', async () => {
    const t = await makeTestApp();
    const { createAdmin } = await import('../src/repos/admin.js');
    const { hashPassword } = await import('../src/crypto/passwords.js');
    createAdmin(t.db, 'alex', await hashPassword('pw'));
    const session = (await t.app.inject({ method: 'POST', url: '/login', payload: { username: 'alex', password: 'pw' } }))
      .cookies.find((c) => c.name === 'pidb_session')!.value;
    const res = await t.app.inject({ method: 'GET', url: '/tokens', cookies: { pidb_session: session } });
    for (const scope of ['projects:write', 'secrets:meta-write', 'secrets:use']) {
      expect(res.body).toContain(`value="${scope}"`);
    }
  });
});
