import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeTestApp, type TestCtx } from './helpers.js';
import { createAdmin } from '../src/repos/admin.js';
import { hashPassword } from '../src/crypto/passwords.js';
import { createSecret } from '../src/repos/secrets.js';
import { upsertDocument } from '../src/repos/documents.js';
import { getProjectBySlug } from '../src/repos/projects.js';

let t: TestCtx;
let session: string;

const page = (url: string) => t.app.inject({ method: 'GET', url, cookies: { pidb_session: session } });
const csrfOf = (body: string) => /name="csrf" value="([^"]+)"/.exec(body)?.[1] ?? '';

beforeAll(async () => {
  t = await makeTestApp();
  createAdmin(t.db, 'alex', await hashPassword('pw'));
  const res = await t.app.inject({ method: 'POST', url: '/login', payload: { username: 'alex', password: 'pw' } });
  session = res.cookies.find((c) => c.name === 'pidb_session')!.value;
  t.project('acme');
  t.project('beta');
  t.db.prepare(`UPDATE projects SET status = 'archived' WHERE slug = 'beta'`).run();
  upsertDocument(t.db, { projectId: getProjectBySlug(t.db, 'acme')!.id, slug: 'deploy', title: 'Deploy notes', category: 'deploy', body_md: '# Deploy\n' });
  createSecret(t.db, t.ring, { projectId: getProjectBySlug(t.db, 'acme')!.id, name: 'DB', description: '', tags: [], fields: [{ key: 'password', value: 'hunter2hunter2' }] });
});
afterAll(async () => {
  await t.app.close();
});

describe('ui projects list', () => {
  it('lists every project with its status', async () => {
    const res = await page('/');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('acme');
    expect(res.body).toContain('beta');
    expect(res.body).toContain('archived');
    expect(res.body).toContain('href="/p/acme"');
  });

  it('filters by status', async () => {
    const res = await page('/?status=archived');
    expect(res.body).toContain('beta');
    // The sidebar legitimately links every project regardless of the table's status filter
    // (R1); only the filtered <main> table content is asserted here.
    const main = res.body.slice(res.body.indexOf('<main'), res.body.indexOf('</main>'));
    expect(main).not.toContain('href="/p/acme"');
    expect(res.body).toContain('aria-current="page"');
    expect(res.body).not.toContain('aria-current=&quot;page&quot;');
  });

  it('escapes project text instead of rendering it as HTML', async () => {
    t.project('xss-demo');
    t.db.prepare(`UPDATE projects SET name = ? WHERE slug = 'xss-demo'`).run('<script>alert(1)</script>');
    const res = await page('/');
    expect(res.body).not.toContain('<script>alert(1)</script>');
    expect(res.body).toContain('&lt;script&gt;');
  });

  it('creates a project from the form and redirects to its page', async () => {
    const form = await page('/');
    const res = await t.app.inject({
      method: 'POST',
      url: '/projects',
      cookies: { pidb_session: session },
      payload: { csrf: csrfOf(form.body), slug: 'gamma', name: 'Gamma', status: 'active', tags: 'client, wp', summary: 'Third one' },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/p/gamma?done=created');
    const created = getProjectBySlug(t.db, 'gamma')!;
    expect(created.name).toBe('Gamma');
    expect(created.tags).toEqual(['client', 'wp']);
  });

  it('rejects a create without a CSRF token', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/projects',
      cookies: { pidb_session: session },
      payload: { slug: 'nope', name: 'Nope' },
    });
    expect(res.statusCode).toBe(403);
    expect(getProjectBySlug(t.db, 'nope')).toBeNull();
  });

  it('shows a filtered empty state naming the status', async () => {
    const res = await page('/?status=paused');
    const main = res.body.slice(res.body.indexOf('<main'), res.body.indexOf('</main>'));
    expect(main).toContain('No paused projects.');
  });

  it('re-renders the list with an error for an invalid slug', async () => {
    const form = await page('/');
    const res = await t.app.inject({
      method: 'POST',
      url: '/projects',
      cookies: { pidb_session: session },
      payload: { csrf: csrfOf(form.body), slug: 'Not A Slug', name: 'X' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('slug');
  });
});

describe('ui search', () => {
  it('shows documents, projects and secret names but never a value', async () => {
    const res = await page('/search?q=deploy');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Deploy notes');
    expect(res.body).not.toContain('hunter2hunter2');
  });

  it('links secret hits to their page and does not render values', async () => {
    const res = await page('/search?q=DB');
    expect(res.body).toContain('/p/acme/secrets/DB');
    expect(res.body).not.toContain('hunter2hunter2');
  });

  it('shows an escaped empty-state message for a query with no hits', async () => {
    const res = await page('/search?q=' + encodeURIComponent('<script>nope</script>'));
    expect(res.body).toContain('Nothing matches “&lt;script&gt;nope&lt;/script&gt;”.');
    expect(res.body).not.toContain('<script>nope</script>');
  });
});
