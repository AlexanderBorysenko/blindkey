import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeTestApp, sessionFor, type TestCtx } from './helpers.js';
import { createAdmin } from '../src/repos/admin.js';
import { hashPassword } from '../src/crypto/passwords.js';
import { createSecret, getSecretMeta } from '../src/repos/secrets.js';
import { getProjectBySlug } from '../src/repos/projects.js';
import { addOwner, createWorkspace } from '../src/repos/workspaces.js';

let t: TestCtx;
let session: string;
const page = (url: string) => t.app.inject({ method: 'GET', url, cookies: { blindkey_session: session } });
const acmeId = () => getProjectBySlug(t.db, 'acme')!.id;
const rowsSection = (body: string) => body.slice(body.indexOf('id="rows"'), body.indexOf('row-actions'));

beforeAll(async () => {
  t = await makeTestApp();
  t.enroll(createAdmin(t.db, 'alex', await hashPassword('pw')).id);
  session = sessionFor(t.db, 'alex');
  t.project('acme');
});
afterAll(async () => {
  await t.app.close();
});

describe('prefilled secret form (spec §1.4)', () => {
  it('prefills name, description and tags from the query', async () => {
    const res = await page('/p/acme/secrets/new?name=SMTP&description=mailer&tags=prod%2Cmail');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('value="SMTP"');
    expect(res.body).toContain('value="mailer"');
    expect(res.body).toContain('value="prod,mail"');
  });

  it('renders one row per key, empty value, sensitive by default and non-sensitive for a "!" suffix', async () => {
    const res = await page('/p/acme/secrets/new?keys=' + encodeURIComponent('host!,password'));
    expect(res.statusCode).toBe(200);
    const rows = rowsSection(res.body);
    expect(rows).toContain('value="host"');
    expect(rows).toContain('value="password"');
    const sensitives = [...rows.matchAll(/name="sensitive" value="(\d)"/g)].map((m) => m[1]);
    expect(sensitives).toEqual(['0', '1']);
    // Empty value boxes: no stored/prefilled value text between the <textarea> tags.
    const values = [...rows.matchAll(/<textarea name="value"[^>]*>([\s\S]*?)<\/textarea>/g)].map((m) => m[1]);
    expect(values).toEqual(['', '']);
  });

  it('ignores a "!" suffix on a default-sensitive key: the row stays sensitive (spec §1.4, F4)', async () => {
    const res = await page('/p/acme/secrets/new?keys=' + encodeURIComponent('password!,api_key!,host!'));
    expect(res.statusCode).toBe(200);
    const rows = rowsSection(res.body);
    expect(rows).toContain('value="password"');
    expect(rows).toContain('value="api_key"');
    expect([...rows.matchAll(/name="sensitive" value="(\d)"/g)].map((m) => m[1])).toEqual(['1', '1', '0']);
  });

  it('works for the global new-secret form too', async () => {
    const res = await page('/global/secrets/new?name=Root&keys=username!');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('value="Root"');
    const rows = rowsSection(res.body);
    expect(rows).toContain('value="username"');
    expect([...rows.matchAll(/name="sensitive" value="(\d)"/g)].map((m) => m[1])).toEqual(['0']);
  });

  it('ignores any value* query params — a value box is never prefilled from the query', async () => {
    const res = await page('/p/acme/secrets/new?keys=password&value=hax0r&value0=hax0r2&values=hax0r3');
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('hax0r');
  });

  it('drops an invalid key (fails the field-key pattern) but keeps the valid ones', async () => {
    const res = await page('/p/acme/secrets/new?keys=' + encodeURIComponent('bad key,password'));
    expect(res.statusCode).toBe(200);
    const rows = rowsSection(res.body);
    expect(rows).not.toContain('bad key');
    expect(rows).toContain('value="password"');
    const cardStarts = [...rows.matchAll(/<div class="field-card/g)];
    expect(cardStarts.length).toBe(1);
  });

  it('falls back to a single empty sensitive row when keys is absent or entirely invalid', async () => {
    const absent = await page('/p/acme/secrets/new');
    const invalid = await page('/p/acme/secrets/new?keys=' + encodeURIComponent('bad key,also bad'));
    for (const res of [absent, invalid]) {
      const rows = rowsSection(res.body);
      const cardStarts = [...rows.matchAll(/<div class="field-card/g)];
      expect(cardStarts.length).toBe(1);
      expect(rows).toMatch(/name="sensitive" value="1"/);
    }
  });

  it('creates nothing on GET, no matter what is in the query', async () => {
    const res = await page('/p/acme/secrets/new?name=ShouldNotExist&description=d&tags=t&keys=host,password');
    expect(res.statusCode).toBe(200);
    expect(getSecretMeta(t.db, t.ring, acmeId(), 'ShouldNotExist')).toBeNull();
  });

  it('de-duplicates a repeated key in the same list', async () => {
    const res = await page('/p/acme/secrets/new?keys=' + encodeURIComponent('host,host,password,password!'));
    expect(res.statusCode).toBe(200);
    const rows = rowsSection(res.body);
    const cardStarts = [...rows.matchAll(/<div class="field-card/g)];
    expect(cardStarts.length).toBe(2);
    const keys = [...rows.matchAll(/name="key" value="([^"]*)"/g)].map((m) => m[1]);
    expect(keys).toEqual(['host', 'password']);
  });
});

describe('edit-form prefill via keys (spec §1.4 — how secret_request_link points at an existing secret)', () => {
  it('appends an empty row only for a key not already on the secret; an existing key is left untouched', async () => {
    createSecret(t.db, t.ring, { projectId: acmeId(), name: 'EditMe', description: '', tags: [], fields: [{ key: 'host', value: 'h1' }] });
    const res = await page('/p/acme/secrets/EditMe/edit?keys=' + encodeURIComponent('host!,password'));
    expect(res.statusCode).toBe(200);
    const rows = rowsSection(res.body);
    const cardStarts = [...rows.matchAll(/<div class="field-card/g)];
    expect(cardStarts.length).toBe(2);
    const keys = [...rows.matchAll(/name="key" value="([^"]*)"/g)].map((m) => m[1]);
    expect(keys).toEqual(['host', 'password']);
    // host's stored (non-sensitive) value survives untouched; password's new row starts empty.
    const values = [...rows.matchAll(/<textarea name="value"[^>]*>([\s\S]*?)<\/textarea>/g)].map((m) => m[1]);
    expect(values).toEqual(['h1', '']);
    const sensitives = [...rows.matchAll(/name="sensitive" value="(\d)"/g)].map((m) => m[1]);
    expect(sensitives).toEqual(['0', '1']);
  });

  it('adds nothing when keys is absent — no behavior change for the plain edit form', async () => {
    const res = await page('/p/acme/secrets/EditMe/edit');
    expect(res.statusCode).toBe(200);
    const rows = rowsSection(res.body);
    const cardStarts = [...rows.matchAll(/<div class="field-card/g)];
    expect(cardStarts.length).toBe(1);
  });
});

describe('workspace carried by a global secret link', () => {
  beforeAll(() => {
    addOwner(t.db, createWorkspace(t.db, { slug: 'second', name: 'Second' }).id, t.owner().id);
  });
  const hiddenWs = (body: string) => /name="workspace" value="([^"]*)"/.exec(body)?.[1];
  const anyWsCookie = (res: Awaited<ReturnType<typeof page>>) => res.cookies.find((c) => c.name === 'blindkey_ws');
  const post = (payload: Record<string, unknown>, cookies: Record<string, string> = {}) =>
    t.app.inject({ method: 'POST', url: '/global/secrets', cookies: { blindkey_session: session, ...cookies }, payload });
  const csrfOf = (body: string) => /name="csrf" value="([^"]+)"/.exec(body)?.[1] ?? '';

  it('?workspace=<slug> applies to that request only: the form carries it, no cookie is written', async () => {
    const res = await page('/global/secrets/new?name=Root&workspace=second');
    expect(res.statusCode).toBe(200);
    expect(hiddenWs(res.body)).toBe('second');
    expect(anyWsCookie(res)).toBeUndefined();
    // the next page without the parameter is back on the default workspace
    const plain = await page('/global/secrets/new?name=Root');
    expect(hiddenWs(plain.body)).toBe('default');
  });

  it('a workspace the user cannot see is ignored (no cookie; the form carries the workspace actually rendered)', async () => {
    createWorkspace(t.db, { slug: 'not-mine', name: 'Not mine' });
    for (const ws of ['not-mine', 'nope']) {
      const res = await page(`/global/secrets/new?name=Root&workspace=${ws}`);
      expect(res.statusCode).toBe(200);
      expect(anyWsCookie(res)).toBeUndefined();
      expect(hiddenWs(res.body)).toBe('default');
    }
  });

  it('creating the secret from that link lands it in the linked workspace without any cookie', async () => {
    const form = await page('/global/secrets/new?name=Linked&workspace=second');
    const res = await post({ csrf: csrfOf(form.body), workspace: hiddenWs(form.body), name: 'Linked', description: '', tags: '', key: ['host'], value: ['h.example'], sensitive: ['0'] });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('workspace=second');
    const row = t.db.prepare(`SELECT w.slug AS slug FROM secrets s JOIN workspaces w ON w.id = s.workspace_id WHERE s.name = 'Linked'`).get() as { slug: string };
    expect(row.slug).toBe('second');
    // the redirect target resolves the same workspace
    const shown = await page(String(res.headers.location));
    expect(shown.statusCode).toBe(200);
  });

  it('a posted workspace the user cannot see is refused (404) instead of falling back to the cookie', async () => {
    const form = await page('/global/secrets/new?name=Fallback');
    const csrf = csrfOf(form.body);
    const res = await post({ csrf, workspace: 'not-mine', name: 'Fallback', description: '', tags: '', key: ['host'], value: ['h'], sensitive: ['0'] });
    expect(res.statusCode).toBe(404);
    expect(t.db.prepare(`SELECT COUNT(*) AS n FROM secrets WHERE name = 'Fallback'`).get()).toEqual({ n: 0 });
  });

  it('a global page carries the workspace it was rendered for, so a later cookie change cannot redirect the post', async () => {
    // no cookie at all: the page resolves the first visible workspace and says so in the form and in its links
    const form = await page('/global/secrets/new?name=Pinned');
    expect(hiddenWs(form.body)).toBe('default');
    const list = await page('/global/secrets');
    expect(list.body).toContain('href="/global/secrets/new?workspace=default"');
    // the user switches workspace in another tab before submitting
    const res = await post(
      { csrf: csrfOf(form.body), workspace: hiddenWs(form.body), name: 'Pinned', description: '', tags: '', key: ['host'], value: ['h'], sensitive: ['0'] },
      { blindkey_ws: 'second' },
    );
    expect(res.statusCode).toBe(302);
    const row = t.db.prepare(`SELECT w.slug AS slug FROM secrets s JOIN workspaces w ON w.id = s.workspace_id WHERE s.name = 'Pinned'`).get() as { slug: string };
    expect(row.slug).toBe('default');
  });
});

describe('POST /workspace/switch', () => {
  const sw = (payload: Record<string, unknown>, withSession = true) =>
    t.app.inject({ method: 'POST', url: '/workspace/switch', ...(withSession ? { cookies: { blindkey_session: session } } : {}), payload });
  const csrf = async () => /name="csrf" value="([^"]+)"/.exec((await page('/global/secrets')).body)?.[1] ?? '';

  it('sets the cookie for a visible workspace and redirects to a safe same-origin path', async () => {
    const res = await sw({ csrf: await csrf(), workspace: 'second', next: '/global/docs' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/global/docs');
    expect(res.cookies.find((c) => c.name === 'blindkey_ws')?.value).toBe('second');
    // and the cookie then selects the workspace for global pages
    const form = await t.app.inject({ method: 'GET', url: '/global/secrets/new', cookies: { blindkey_session: session, blindkey_ws: 'second' } });
    expect(/name="workspace" value="([^"]*)"/.exec(form.body)?.[1]).toBe('second');
  });

  it.each(['//evil.example', 'https://evil.example/x', '/\\evil.example', 'relative', ''])('never redirects off-site (next=%j)', async (next) => {
    const res = await sw({ csrf: await csrf(), workspace: 'second', next });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/');
  });

  it('needs a CSRF token, a session and a visible workspace', async () => {
    expect((await sw({ workspace: 'second', next: '/' })).statusCode).toBe(403);
    expect((await sw({ csrf: 'wrong', workspace: 'second', next: '/' })).statusCode).toBe(403);
    expect((await sw({ csrf: 'x', workspace: 'second' }, false)).statusCode).toBe(302);
    const hidden = await sw({ csrf: await csrf(), workspace: 'not-mine', next: '/' });
    expect(hidden.statusCode).toBe(404);
    expect(hidden.cookies.find((c) => c.name === 'blindkey_ws')).toBeUndefined();
    expect((await sw({ csrf: await csrf(), workspace: 'nope', next: '/' })).statusCode).toBe(404);
  });
});
