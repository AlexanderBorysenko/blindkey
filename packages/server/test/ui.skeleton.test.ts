import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeTestApp, auth, type TestCtx } from './helpers.js';
import { createAdmin } from '../src/repos/admin.js';
import { hashPassword } from '../src/crypto/passwords.js';

let t: TestCtx;
beforeAll(async () => {
  t = await makeTestApp();
  createAdmin(t.db, 'alex', await hashPassword('pw'));
});
afterAll(async () => {
  await t.app.close();
});

describe('ui skeleton', () => {
  it('serves the stylesheet, fonts and htmx from /assets', async () => {
    const app = await t.app.inject({ method: 'GET', url: '/assets/app.css' });
    expect(app.statusCode).toBe(200);
    expect(app.headers['content-type']).toContain('text/css');
    expect(app.body).toContain('--accent: #3355cc');
    expect(app.body).toContain('prefers-color-scheme: dark');

    const js = await t.app.inject({ method: 'GET', url: '/assets/htmx.min.js' });
    expect(js.statusCode).toBe(200);

    const sans = await t.app.inject({
      method: 'GET',
      url: '/assets/fonts/plex-sans/ibm-plex-sans-latin-400-normal.woff2',
    });
    expect(sans.statusCode).toBe(200);
    expect(sans.headers['content-type']).toContain('font/woff2');

    const mono = await t.app.inject({
      method: 'GET',
      url: '/assets/fonts/plex-mono/ibm-plex-mono-latin-400-normal.woff2',
    });
    expect(mono.statusCode).toBe(200);
    expect(mono.headers['content-type']).toContain('font/woff2');
  });

  it('renders an HTML 404 page for an unknown UI path', async () => {
    const login = await t.app.inject({ method: 'POST', url: '/login', payload: { username: 'alex', password: 'pw' } });
    const session = login.cookies.find((c) => c.name === 'pidb_session')?.value;
    const res = await t.app.inject({
      method: 'GET',
      url: '/no-such-page',
      cookies: { pidb_session: session! },
    });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('<!doctype html>');
    expect(res.body).toContain('not found');
  });

  it('still answers API paths with JSON', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/v1/nope',
      headers: auth(t.token(['projects:read'])),
    });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.json()).toEqual({ error: 'not_found' });
  });

  it('keeps /health as JSON', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/health' });
    expect(res.json()).toEqual({ ok: true });
  });
});
