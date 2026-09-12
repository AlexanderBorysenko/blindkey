import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeTestApp, type TestCtx } from './helpers.js';
import { createAdmin } from '../src/repos/admin.js';
import { hashPassword } from '../src/crypto/passwords.js';
import { getDocument } from '../src/repos/documents.js';
import { listAudit } from '../src/repos/audit.js';
import { getProjectBySlug } from '../src/repos/projects.js';

let t: TestCtx;
let session: string;
const page = (url: string) => t.app.inject({ method: 'GET', url, cookies: { pidb_session: session } });
const post = (url: string, payload: Record<string, unknown>) =>
  t.app.inject({ method: 'POST', url, cookies: { pidb_session: session }, payload });
const csrfOf = (b: string) => /name="csrf" value="([^"]+)"/.exec(b)?.[1] ?? '';
let csrf: string;
const acme = () => getProjectBySlug(t.db, 'acme')!.id;

beforeAll(async () => {
  t = await makeTestApp();
  createAdmin(t.db, 'alex', await hashPassword('pw'));
  session = (await t.app.inject({ method: 'POST', url: '/login', payload: { username: 'alex', password: 'pw' } }))
    .cookies.find((c) => c.name === 'pidb_session')!.value;
  t.project('acme');
  csrf = csrfOf((await page('/p/acme')).body);
});
afterAll(async () => {
  await t.app.close();
});

describe('ui document editor', () => {
  it('offers an empty form for a new document', async () => {
    const res = await page('/p/acme/docs/new/edit');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('name="body_md"');
    expect(res.body).toContain('name="slug"');
    expect(res.body).toContain('value="deploy"'); // category option
  });

  it('creates a document and redirects to its page', async () => {
    const res = await post('/p/acme/docs/new', { csrf, slug: 'notes', title: 'Notes', category: 'notes', body_md: '# Notes\n' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/p/acme/docs/notes');
    expect(getDocument(t.db, acme(), 'notes')?.title).toBe('Notes');
  });

  it('updates an existing document', async () => {
    const res = await post('/p/acme/docs/notes', { csrf, slug: 'notes', title: 'Notes v2', category: 'notes', body_md: '# Notes v2\n' });
    expect(res.statusCode).toBe(302);
    expect(getDocument(t.db, acme(), 'notes')?.title).toBe('Notes v2');
  });

  it('re-renders the editor with lint findings instead of saving', async () => {
    const res = await post('/p/acme/docs/leak', { csrf, slug: 'leak', title: 'Leak', category: 'notes', body_md: 'db password = hunter2hunter2\n' });
    expect(res.statusCode).toBe(422);
    expect(res.body).toContain('line 1');
    expect(res.body).toContain('Save anyway');
    expect(getDocument(t.db, acme(), 'leak')).toBeNull();
  });

  it('saves anyway when force is set, and audits the override', async () => {
    const res = await post('/p/acme/docs/leak', { csrf, slug: 'leak', title: 'Leak', category: 'notes', body_md: 'db password = hunter2hunter2\n', force: 'on' });
    expect(res.statusCode).toBe(302);
    expect(getDocument(t.db, acme(), 'leak')).not.toBeNull();
    const row = listAudit(t.db, { limit: 20 }).find((r) => r.action === 'doc.write' && r.meta && (r.meta as { lint_forced?: boolean }).lint_forced === true);
    expect(row).toBeDefined();
    expect(row!.actor_type).toBe('admin');
  });

  it('re-renders with unresolved references instead of saving', async () => {
    const res = await post('/p/acme/docs/refs', { csrf, slug: 'refs', title: 'Refs', category: 'notes', body_md: 'see {{secret:Missing}}\n' });
    expect(res.statusCode).toBe(422);
    expect(res.body).toContain('{{secret:Missing}}');
    expect(getDocument(t.db, acme(), 'refs')).toBeNull();
  });

  it('renders a preview partial with findings for HTMX', async () => {
    const res = await post('/preview', { csrf, scope: '/p/acme', body_md: '# Title\n\npassword = hunter2hunter2\n' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('<h1>Title</h1>');
    expect(res.body).toContain('line 3');
    expect(res.body).not.toContain('<!doctype html>');
  });

  it('rejects a save and a preview without a CSRF token', async () => {
    expect((await post('/p/acme/docs/nocsrf', { slug: 'nocsrf', title: 'X', category: 'notes', body_md: 'x' })).statusCode).toBe(403);
    expect((await post('/preview', { body_md: 'x' })).statusCode).toBe(403);
  });

  it('rejects a title over 300 characters and does not create the document', async () => {
    const title = 'x'.repeat(301);
    const res = await post('/p/acme/docs/toolong', { csrf, slug: 'toolong', title, category: 'notes', body_md: '# hi\n' });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('name="body_md"');
    expect(getDocument(t.db, acme(), 'toolong')).toBeNull();
  });

  it('rejects a body over 2,000,000 characters and does not create the document', async () => {
    const body_md = 'x'.repeat(2_000_001);
    const res = await post('/p/acme/docs/toobig', { csrf, slug: 'toobig', title: 'Too big', category: 'notes', body_md });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('name="body_md"');
    expect(getDocument(t.db, acme(), 'toobig')).toBeNull();
  });

  it('rejects an unknown category and does not create the document', async () => {
    const res = await post('/p/acme/docs/badcat', { csrf, slug: 'badcat', title: 'Bad cat', category: 'not-a-category', body_md: '# hi\n' });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('name="body_md"');
    expect(getDocument(t.db, acme(), 'badcat')).toBeNull();
  });

  it('rejects an invalid slug and does not create the document', async () => {
    const res = await post('/p/acme/docs/new', { csrf, slug: 'Not A Slug', title: 'Bad slug', category: 'notes', body_md: '# hi\n' });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('name="body_md"');
    expect(getDocument(t.db, acme(), 'Not A Slug')).toBeNull();
  });

  it('rejects a posted slug that differs from an existing document URL, leaving it unchanged', async () => {
    await post('/p/acme/docs/new', { csrf, slug: 'stable', title: 'Stable', category: 'notes', body_md: '# Stable\n' });
    const res = await post('/p/acme/docs/stable', { csrf, slug: 'renamed', title: 'Renamed', category: 'notes', body_md: '# Renamed\n' });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('name="body_md"');
    expect(getDocument(t.db, acme(), 'stable')?.title).toBe('Stable');
    expect(getDocument(t.db, acme(), 'renamed')).toBeNull();
  });
});
