import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { makeTestApp, type TestCtx } from './helpers.js';
import { createAdmin } from '../src/repos/admin.js';
import { hashPassword } from '../src/crypto/passwords.js';
import { listAudit } from '../src/repos/audit.js';
import { openDb } from '../src/db/connection.js';
import { buildApp } from '../src/http/app.js';
import type { AppContext } from '../src/http/context.js';
import type { KeyRing } from '../src/config.js';

let t: TestCtx;

async function login(username = 'alex', password = 'correct horse'): Promise<string | undefined> {
  const res = await t.app.inject({ method: 'POST', url: '/login', payload: { username, password } });
  return res.cookies.find((c) => c.name === 'pidb_session')?.value;
}

beforeAll(async () => {
  t = await makeTestApp();
  createAdmin(t.db, 'alex', await hashPassword('correct horse'));
});
afterAll(async () => {
  await t.app.close();
});

describe('ui auth', () => {
  it('serves the login form without a session', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/login' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('name="username"');
    expect(res.body).toContain('name="password"');
  });

  it('redirects an anonymous visitor from a page to /login', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  it('sets an httpOnly session cookie on a good password and audits the login', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/login', payload: { username: 'alex', password: 'correct horse' } });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/');
    const cookie = res.cookies.find((c) => c.name === 'pidb_session');
    expect(cookie).toBeDefined();
    expect(cookie!.httpOnly).toBe(true);
    expect(cookie!.sameSite?.toLowerCase()).toBe('lax');
    expect(cookie!.path).toBe('/');
    expect(listAudit(t.db, { limit: 5 }).some((r) => r.action === 'auth.login' && r.actor_type === 'admin')).toBe(true);
  });

  it('re-renders the form with an error and no cookie on a bad password', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/login', payload: { username: 'alex', password: 'wrong' } });
    expect(res.statusCode).toBe(401);
    expect(res.body).toContain('Invalid username or password');
    expect(res.cookies.find((c) => c.name === 'pidb_session')).toBeUndefined();
    expect(listAudit(t.db, { limit: 5 }).some((r) => r.action === 'auth.login_failed')).toBe(true);
  });

  it('never echoes the submitted password back into the form', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/login', payload: { username: 'alex', password: 'sup3r-sekrit' } });
    expect(res.body).not.toContain('sup3r-sekrit');
  });

  it('lets a session through to a page', async () => {
    const session = await login();
    const res = await t.app.inject({ method: 'GET', url: '/', cookies: { pidb_session: session! } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Projects');
  });

  it('rejects a POST without a CSRF token', async () => {
    const session = await login();
    const res = await t.app.inject({ method: 'POST', url: '/logout', cookies: { pidb_session: session! }, payload: {} });
    expect(res.statusCode).toBe(403);
    const still = await t.app.inject({ method: 'GET', url: '/', cookies: { pidb_session: session! } });
    expect(still.statusCode).toBe(200);
  });

  it('logs out with a valid CSRF token and invalidates the session', async () => {
    const session = await login();
    const page = await t.app.inject({ method: 'GET', url: '/', cookies: { pidb_session: session! } });
    const csrf = /name="csrf" value="([^"]+)"/.exec(page.body)?.[1];
    expect(csrf).toBeTruthy();
    const res = await t.app.inject({ method: 'POST', url: '/logout', cookies: { pidb_session: session! }, payload: { csrf } });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/login');
    const after = await t.app.inject({ method: 'GET', url: '/', cookies: { pidb_session: session! } });
    expect(after.statusCode).toBe(302);
  });

  it('ignores an unknown or expired session cookie', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/', cookies: { pidb_session: 'deadbeef'.repeat(8) } });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  it('leaves the bearer API untouched', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/projects', headers: { authorization: `Bearer ${t.token(['projects:read'])}` } });
    expect(res.statusCode).toBe(200);
  });

  it('does not accept the UI session cookie as auth for the JSON API', async () => {
    const session = await login();
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/projects', cookies: { pidb_session: session! } });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: 'unauthorized' });
  });

  it('does not accept the UI session cookie as auth for MCP', async () => {
    const session = await login();
    const res = await t.app.inject({
      method: 'POST',
      url: '/mcp',
      cookies: { pidb_session: session! },
      payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: 'unauthorized' });
  });

  it('does not mark the session cookie Secure when the request is not trusted as HTTPS', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/login', payload: { username: 'alex', password: 'correct horse' } });
    const cookie = res.cookies.find((c) => c.name === 'pidb_session');
    expect(cookie).toBeDefined();
    expect(cookie!.secure).toBeFalsy();
  });

  it('marks the session cookie Secure when behind a trusted proxy terminating TLS', async () => {
    const db = openDb(':memory:');
    const ring: KeyRing = { current: 1, keys: new Map([[1, randomBytes(32)]]) };
    const ctx: AppContext = { db, ring, logLevel: 'silent', trustProxy: true };
    const app = await buildApp(ctx);
    createAdmin(db, 'alex', await hashPassword('correct horse'));
    const res = await app.inject({
      method: 'POST',
      url: '/login',
      headers: { 'x-forwarded-proto': 'https' },
      payload: { username: 'alex', password: 'correct horse' },
    });
    const cookie = res.cookies.find((c) => c.name === 'pidb_session');
    expect(cookie).toBeDefined();
    expect(cookie!.secure).toBe(true);
    await app.close();
  });
});
