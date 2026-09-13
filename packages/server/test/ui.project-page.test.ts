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
const csrfOf = (b: string) => /name="csrf" value="([^"]+)"/.exec(b)?.[1] ?? '';
const post = (url: string, payload: Record<string, unknown>) =>
  t.app.inject({ method: 'POST', url, cookies: { pidb_session: session }, payload });

beforeAll(async () => {
  t = await makeTestApp();
  createAdmin(t.db, 'alex', await hashPassword('pw'));
  session = (await t.app.inject({ method: 'POST', url: '/login', payload: { username: 'alex', password: 'pw' } }))
    .cookies.find((c) => c.name === 'pidb_session')!.value;
  t.project('acme');
  const id = getProjectBySlug(t.db, 'acme')!.id;
  upsertDocument(t.db, { projectId: id, slug: 'deploy', title: 'Deploy notes', category: 'deploy', body_md: '# Deploy\n' });
  upsertDocument(t.db, { projectId: id, slug: 'runbook', title: 'Runbook', category: 'notes', body_md: '# Runbook\n' });
  createSecret(t.db, t.ring, {
    projectId: id,
    name: 'DB',
    description: 'main database',
    tags: ['prod'],
    fields: [{ key: 'host', value: 'db.internal' }, { key: 'password', value: 'hunter2hunter2' }],
  });
});
afterAll(async () => {
  await t.app.close();
});

describe('ui project page', () => {
  it('shows the header and the documents tab by default', async () => {
    const res = await page('/p/acme');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('acme');
    expect(res.body).toContain('Deploy notes');
    expect(res.body).toContain('href="/p/acme/docs/deploy"');
  });

  it('shows secret metadata on the secrets tab without any sensitive value', async () => {
    const res = await page('/p/acme?tab=secrets');
    expect(res.body).toContain('DB');
    expect(res.body).toContain('main database');
    expect(res.body).toContain('db.internal');          // non-sensitive value is safe to show
    expect(res.body).not.toContain('hunter2hunter2');   // sensitive value is not
    expect(res.body).toContain('href="/p/acme/secrets/DB"');
    expect(res.body).toContain('class="chip lock"');
    expect(res.body).not.toContain('sensitive — value hidden');
  });

  it('shows counts on the tabs', async () => {
    const res = await page('/p/acme');
    const tabs = res.body.slice(res.body.indexOf('<nav class="tabs"'), res.body.indexOf('</nav>'));
    // acme has 2 documents and 1 secret; the tabs must show each tab's own count,
    // not e.g. the sidebar's per-project secret badge (which would also read data-count="1").
    expect(tabs).toMatch(/Documents\s*<span class="count" data-count="2">2<\/span>/);
    expect(tabs).toMatch(/Secrets\s*<span class="count" data-count="1">1<\/span>/);
  });

  it('puts the delete form inside its confirm dialog', async () => {
    const res = await page('/p/acme');
    expect(res.body).toMatch(/<dialog[^>]*id="delete-project"[\s\S]*action="\/p\/acme\/delete"/);
  });

  it('shows an empty-state message on the secrets tab of a project with no secrets', async () => {
    t.project('bare');
    const res = await page('/p/bare?tab=secrets');
    const main = res.body.slice(res.body.indexOf('<main'), res.body.indexOf('</main>'));
    expect(main).toContain('No secrets yet.');
  });

  it('updates the project meta', async () => {
    const form = await page('/p/acme');
    const res = await post('/p/acme', { csrf: csrfOf(form.body), name: 'Acme Renamed', status: 'paused', tags: 'client, wp', summary: 'Updated' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/p/acme?done=saved');
    const row = getProjectBySlug(t.db, 'acme')!;
    expect(row.name).toBe('Acme Renamed');
    expect(row.status).toBe('paused');
    expect(row.tags).toEqual(['client', 'wp']);
  });

  it('rejects an update without a CSRF token', async () => {
    const res = await post('/p/acme', { name: 'Hacked' });
    expect(res.statusCode).toBe(403);
    expect(getProjectBySlug(t.db, 'acme')!.name).toBe('Acme Renamed');
  });

  it('renders 404 HTML for an unknown project', async () => {
    const res = await page('/p/nope');
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('text/html');
  });

  it('deletes a project and redirects to the list', async () => {
    t.project('doomed');
    const form = await page('/p/doomed');
    const res = await post('/p/doomed/delete', { csrf: csrfOf(form.body) });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/?done=deleted');
    expect(getProjectBySlug(t.db, 'doomed')).toBeNull();
  });
});
