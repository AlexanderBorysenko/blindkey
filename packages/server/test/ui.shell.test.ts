import type { FastifyRequest } from 'fastify';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeTestApp, type TestCtx } from './helpers.js';
import { createAdmin } from '../src/repos/admin.js';
import { hashPassword } from '../src/crypto/passwords.js';
import { createSecret } from '../src/repos/secrets.js';
import { getProjectBySlug } from '../src/repos/projects.js';
import { pageContext } from '../src/ui/forms.js';

let t: TestCtx;
let session: string;

const page = (url: string, cookies: Record<string, string> = { blindkey_session: session }) => t.app.inject({ method: 'GET', url, cookies });

function sidebar(body: string): string {
  return body.slice(body.indexOf('<aside class="sidebar">'), body.indexOf('</aside>'));
}

beforeAll(async () => {
  t = await makeTestApp();
  createAdmin(t.db, 'alex', await hashPassword('pw'));
  const res = await t.app.inject({ method: 'POST', url: '/login', payload: { username: 'alex', password: 'pw' } });
  session = res.cookies.find((c) => c.name === 'blindkey_session')!.value;
  t.project('acme');
  const acme = getProjectBySlug(t.db, 'acme')!;
  createSecret(t.db, t.ring, { projectId: acme.id, name: 'DB', description: '', tags: [], fields: [{ key: 'password', value: 'hunter2hunter2' }] });
  createSecret(t.db, t.ring, { projectId: acme.id, name: 'API', description: '', tags: [], fields: [{ key: 'key', value: 'k'.repeat(12) }] });
});
afterAll(async () => {
  await t.app.close();
});

describe('app shell', () => {
  it('renders the sidebar with a project link and its secret count', async () => {
    const res = await page('/');
    expect(res.body).toContain('class="sidebar"');
    expect(sidebar(res.body)).toContain('href="/p/acme"');
    expect(sidebar(res.body)).toContain('data-count="2"');
  });

  it('marks the active project with aria-current only on its own page', async () => {
    const home = await page('/');
    const proj = await page('/p/acme');
    expect(sidebar(home.body)).not.toContain('aria-current="page"');
    expect(sidebar(proj.body)).toContain('aria-current="page"');
  });

  it('shows the flash toast for a whitelisted done value and not for an unsafe one', async () => {
    const saved = await page('/?done=saved');
    expect(saved.body).toContain('class="toast"');
    expect(saved.body).toContain('Saved');

    const unsafe = await page('/?done=%3Cscript%3E');
    expect(unsafe.body).not.toContain('class="toast"');
    expect(unsafe.body).not.toContain('<script>');
  });

  it('renders no sidebar for an anonymous login page', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/login' });
    expect(res.body).not.toContain('class="sidebar"');
  });

  it('renders the 404 page without a sidebar and without throwing', async () => {
    const res = await page('/does-not-exist');
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain('class="sidebar"');
  });

  it('does not 500 on a valid-hex-but-invalid-UTF-8 slug segment', async () => {
    // %E0%A4 is a well-formed percent escape but not valid UTF-8, so a raw decodeURIComponent
    // throws URIError. In this Fastify version the request never even reaches our handler for
    // this exact URL (Fastify's own FST_ERR_BAD_URL guard rejects it with 400 first), but the
    // assertion and the direct unit test below both guard the real invariant regardless of
    // that framework behaviour.
    const res = await page('/p/%E0%A4/secrets/new');
    expect(res.statusCode).not.toBe(500);
  });

  it('pageContext does not throw when the path has an undecodable slug segment', () => {
    // Exercises forms.ts's activeSlugFor directly, bypassing Fastify's own URL guard, so this
    // is the test that actually goes red if the try/catch in activeSlugFor is removed.
    const fakeReq = { url: '/p/%E0%A4/secrets/new', query: {}, cookies: {} } as unknown as FastifyRequest;
    expect(() => pageContext(t.ctx, fakeReq, 'New secret')).not.toThrow();
    expect(pageContext(t.ctx, fakeReq, 'New secret').activeSlug).toBeNull();
  });
});
