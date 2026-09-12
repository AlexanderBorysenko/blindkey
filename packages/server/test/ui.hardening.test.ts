import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeTestApp, type TestCtx } from './helpers.js';
import { createAdmin } from '../src/repos/admin.js';
import { hashPassword } from '../src/crypto/passwords.js';
import { createSecret } from '../src/repos/secrets.js';
import { getProjectBySlug } from '../src/repos/projects.js';

let t: TestCtx;
let session: string;

beforeAll(async () => {
  t = await makeTestApp();
  createAdmin(t.db, 'alex', await hashPassword('pw'));
  session = (await t.app.inject({ method: 'POST', url: '/login', payload: { username: 'alex', password: 'pw' } }))
    .cookies.find((c) => c.name === 'pidb_session')!.value;
  t.project('acme');
  createSecret(t.db, t.ring, {
    projectId: getProjectBySlug(t.db, 'acme')!.id,
    name: 'DB',
    description: '',
    tags: [],
    fields: [{ key: 'password', value: 'hunter2hunter2' }],
  });
});
afterAll(async () => {
  await t.app.close();
});

describe('ui hardening', () => {
  it('sends a restrictive CSP and the usual protective headers on pages', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/', cookies: { pidb_session: session } });
    const csp = String(res.headers['content-security-policy'] ?? '');
    expect(csp).toContain("default-src 'self'");
    expect(csp).not.toContain('unsafe-eval');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('same-origin');
    expect(res.headers['x-frame-options']).toBe('DENY');
  });

  it('does not let a page with a secret on it be cached', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/p/acme/secrets/DB', cookies: { pidb_session: session } });
    expect(String(res.headers['cache-control'])).toContain('no-store');
  });

  it('leaves API responses without the UI headers', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/v1/projects',
      headers: { authorization: `Bearer ${t.token(['projects:read'])}` },
    });
    expect(res.headers['content-security-policy']).toBeUndefined();
  });

  it('bearer tokens cannot reach UI pages', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/tokens', headers: { authorization: `Bearer ${t.token(['admin'])}` } });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/login');
  });
});
