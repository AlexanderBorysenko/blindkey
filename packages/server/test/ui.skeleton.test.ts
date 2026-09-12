import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeTestApp, auth, type TestCtx } from './helpers.js';

let t: TestCtx;
beforeAll(async () => {
  t = await makeTestApp();
});
afterAll(async () => {
  await t.app.close();
});

describe('ui skeleton', () => {
  it('serves the Pico stylesheet and htmx from /assets', async () => {
    const css = await t.app.inject({ method: 'GET', url: '/assets/pico.min.css' });
    expect(css.statusCode).toBe(200);
    expect(css.headers['content-type']).toContain('text/css');
    const js = await t.app.inject({ method: 'GET', url: '/assets/htmx.min.js' });
    expect(js.statusCode).toBe(200);
    const app = await t.app.inject({ method: 'GET', url: '/assets/app.css' });
    expect(app.statusCode).toBe(200);
  });

  it('renders an HTML 404 page for an unknown UI path', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: '/no-such-page',
      headers: auth(t.token(['projects:read'])),
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
