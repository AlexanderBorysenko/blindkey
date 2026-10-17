import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeTestApp, type TestCtx } from './helpers.js';
import { createAdmin } from '../src/repos/admin.js';
import { hashPassword } from '../src/crypto/passwords.js';
import { createSecret } from '../src/repos/secrets.js';
import { upsertDocument, getDocument } from '../src/repos/documents.js';
import { getProjectBySlug } from '../src/repos/projects.js';

let t: TestCtx;
let session: string;
const page = (url: string) => t.app.inject({ method: 'GET', url, cookies: { blindkey_session: session } });
const csrfOf = (b: string) => /name="csrf" value="([^"]+)"/.exec(b)?.[1] ?? '';

beforeAll(async () => {
  t = await makeTestApp();
  createAdmin(t.db, 'alex', await hashPassword('pw'));
  session = (await t.app.inject({ method: 'POST', url: '/login', payload: { username: 'alex', password: 'pw' } }))
    .cookies.find((c) => c.name === 'blindkey_session')!.value;
  t.project('acme');
  const id = getProjectBySlug(t.db, 'acme')!.id;
  createSecret(t.db, t.ring, { projectId: id, name: 'DB', description: '', tags: [], fields: [{ key: 'password', value: 'hunter2hunter2' }] });
  createSecret(t.db, t.ring, { projectId: id, name: 'foo)(bar', description: '', tags: [], fields: [{ key: 'password', value: 'v1' }] });
  createSecret(t.db, t.ring, { projectId: id, name: 'foo]bar', description: '', tags: [], fields: [{ key: 'password', value: 'v2' }] });
  upsertDocument(t.db, {
    projectId: id,
    slug: 'deploy',
    title: 'Deploy notes',
    category: 'deploy',
    body_md: '# Deploy\n\nCredentials live in {{secret:DB}}.\n\n<img src=x onerror=alert(1)>\n',
  });
  upsertDocument(t.db, { projectId: null, slug: 'guidelines', title: 'Guidelines', category: 'guidelines', body_md: '# Guidelines\n' });
  upsertDocument(t.db, { projectId: id, slug: 'doomed', title: 'Doomed', category: 'notes', body_md: 'bye\n' });
  upsertDocument(t.db, {
    projectId: id,
    slug: 'edge-cases',
    title: 'Edge cases',
    category: 'notes',
    body_md: 'Ref one {{secret:foo)(bar}} and ref two {{secret:foo]bar}}.\n',
  });
  upsertDocument(t.db, {
    projectId: id,
    slug: 'hostile',
    title: 'Hostile',
    category: 'notes',
    body_md: '# Hostile\n\n<script>alert(1)</script><img src=x onerror=alert(1)><a href="javascript:alert(1)">click</a><p style="color:red">styled</p>\n',
  });
});
afterAll(async () => {
  await t.app.close();
});

describe('ui document view', () => {
  it('renders Markdown as HTML', async () => {
    const res = await page('/p/acme/docs/deploy');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<h1>Deploy</h1>');
  });

  it('turns a secret reference into a link to the secret page', async () => {
    const res = await page('/p/acme/docs/deploy');
    expect(res.body).toContain('href="/p/acme/secrets/DB"');
    expect(res.body).toContain('{{secret:DB}}');
  });

  it('sanitizes dangerous Markdown', async () => {
    const res = await page('/p/acme/docs/deploy');
    expect(res.body).not.toContain('onerror');
  });

  // Regression coverage for spec §3.3: sanitize-html strips <script>, on* handlers, style
  // attributes and javascript: links from rendered Markdown (verified 2026-09-13; no code change
  // in this task, but the CSP now depends on this holding for every document, not just this one).
  it('strips <script>, on* handlers, style attributes and javascript: links from rendered Markdown', async () => {
    const res = await page('/p/acme/docs/hostile');
    expect(res.statusCode).toBe(200);
    const main = res.body.split('<main')[1]!.split('</main>')[0]!;
    const article = main.split('<article class="doc">')[1]!.split('</article>')[0]!;
    expect(article).toContain('<h1>Hostile</h1>');
    expect(article).toContain('styled');
    expect(res.body).not.toContain('alert(1)</script>');
    expect(res.body).not.toMatch(/onerror/i);
    expect(res.body).not.toMatch(/javascript:/i);
    expect(res.body).not.toMatch(/style=/i);
    expect(res.body).toContain('<h1>Hostile</h1>');
  });

  it('never renders a secret value', async () => {
    const res = await page('/p/acme/docs/deploy');
    expect(res.body).not.toContain('hunter2hunter2');
  });

  it('shows the referenced secret field as a lock chip when sensitive', async () => {
    const res = await page('/p/acme/docs/deploy');
    expect(res.body).toContain('class="chip lock"');
  });

  it('wraps the delete form in a confirm dialog', async () => {
    const res = await page('/p/acme/docs/deploy');
    const dialogStart = res.body.indexOf('<dialog');
    const deleteFormIdx = res.body.indexOf('/docs/deploy/delete');
    expect(dialogStart).toBeGreaterThan(-1);
    expect(deleteFormIdx).toBeGreaterThan(dialogStart);
  });

  it('lists global documents and opens one', async () => {
    const list = await page('/global/docs');
    expect(list.statusCode).toBe(200);
    expect(list.body).toContain('href="/global/docs/guidelines"');
    const doc = await page('/global/docs/guidelines');
    expect(doc.statusCode).toBe(200);
    expect(doc.body).toContain('<h1>Guidelines</h1>');
  });

  it('encodes parentheses in a secret name so the link destination is not truncated', async () => {
    const res = await page('/p/acme/docs/edge-cases');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('href="/p/acme/secrets/foo%29%28bar"');
    expect(res.body).not.toContain('href="/p/acme/secrets/foo"');
    expect(res.body).toContain('{{secret:foo)(bar}}');
  });

  it('renders a secret name containing "]" as a link instead of breaking the label', async () => {
    const res = await page('/p/acme/docs/edge-cases');
    expect(res.body).toContain('href="/p/acme/secrets/foo%5Dbar"');
    expect(res.body).toContain('{{secret:foo]bar}}');
  });

  it('renders 404 HTML for an unknown document', async () => {
    const res = await page('/p/acme/docs/nope');
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('text/html');
  });

  it('deletes a document with a CSRF token and rejects one without', async () => {
    const view = await page('/p/acme/docs/doomed');
    const bad = await t.app.inject({ method: 'POST', url: '/p/acme/docs/doomed/delete', cookies: { blindkey_session: session }, payload: {} });
    expect(bad.statusCode).toBe(403);
    expect(getDocument(t.db, getProjectBySlug(t.db, 'acme')!.id, 'doomed')).not.toBeNull();

    const ok = await t.app.inject({
      method: 'POST',
      url: '/p/acme/docs/doomed/delete',
      cookies: { blindkey_session: session },
      payload: { csrf: csrfOf(view.body) },
    });
    expect(ok.statusCode).toBe(302);
    expect(ok.headers.location).toBe('/p/acme?done=deleted');
    expect(getDocument(t.db, getProjectBySlug(t.db, 'acme')!.id, 'doomed')).toBeNull();
  });
});
