import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeTestApp, sessionFor, type TestCtx } from './helpers.js';
import { createAdmin, createSession, createUser, getUserByUsername } from '../src/repos/admin.js';
import { updateSecretFor } from '../src/services/secrets.js';
import type { Actor } from '../src/auth/principal.js';
import { upsertGrant } from '../src/repos/grants.js';
import { listAuditForTarget } from '../src/repos/audit.js';
import { runInNewContext } from 'node:vm';
import { hashPassword } from '../src/crypto/passwords.js';
import { createSecret, getSecretMeta, revealField } from '../src/repos/secrets.js';
import { getProjectBySlug } from '../src/repos/projects.js';
import { renderPage } from '../src/ui/render.js';

describe('secret-edit view: hint keys are embedded safely', () => {
  it('escapes "<" in a hint key as the six characters \\u003c, never a literal </script>', () => {
    const html = renderPage('secret-edit', {
      title: 'New secret',
      csrf: 'tok',
      prefix: '/global',
      scopeLabel: 'global',
      isNew: true,
      action: '/global/secrets',
      hintKeys: ['a</script>b'],
      error: null,
      form: { name: '', description: '', tags: '', rows: [{ key: '', value: '', sensitive: true }] },
    });
    expect(html).toContain('data-hint-keys="[&quot;a&lt;/script&gt;b&quot;]"');
    expect(html).not.toContain('a</script>b');
  });
});

let t: TestCtx;
let session: string;
let csrf: string;
const page = (url: string) => t.app.inject({ method: 'GET', url, cookies: { blindkey_session: session } });
const post = (url: string, payload: Record<string, unknown>) =>
  t.app.inject({ method: 'POST', url, cookies: { blindkey_session: session }, payload });
const csrfOf = (b: string) => /name="csrf" value="([^"]+)"/.exec(b)?.[1] ?? '';
const acme = () => getProjectBySlug(t.db, 'acme')!.id;

beforeAll(async () => {
  t = await makeTestApp();
  t.enroll(createAdmin(t.db, 'alex', await hashPassword('pw')).id);
  session = sessionFor(t.db, 'alex');
  t.project('acme');
  createSecret(t.db, t.ring, {
    projectId: getProjectBySlug(t.db, 'acme')!.id,
    name: 'DB',
    description: '',
    tags: [],
    fields: [{ key: 'host', value: 'db.internal' }, { key: 'password', value: 'hunter2hunter2' }],
  });
  csrf = csrfOf((await page('/p/acme')).body);
});
afterAll(async () => {
  await t.app.close();
});

describe('ui secret create', () => {
  it('offers a form with the common non-sensitive keys as hints', async () => {
    const res = await page('/p/acme/secrets/new');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('name="name"');
    expect(res.body).toContain('name="key"');
    expect(res.body).toContain('host');
  });

  it('creates a secret with mixed sensitivity', async () => {
    const res = await post('/p/acme/secrets', {
      csrf,
      name: 'SMTP',
      description: 'mailer',
      tags: 'prod',
      key: ['host', 'password'],
      value: ['smtp.example.com', 's3cret-mail'],
      sensitive: ['0', '1'],
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/p/acme/secrets/SMTP?done=created');
    const meta = getSecretMeta(t.db, t.ring, acme(), 'SMTP')!;
    expect(meta.fields.map((f) => [f.key, f.sensitive])).toEqual([['host', false], ['password', true]]);
    expect(revealField(t.db, t.ring, meta.id, 'password')).toBe('s3cret-mail');
  });

  it('stores sensitivity positionally, aligned with key/value order (not by key string)', async () => {
    const res = await post('/p/acme/secrets', {
      csrf,
      name: 'Positional',
      key: ['host', 'password'],
      value: ['h', 'p'],
      sensitive: ['0', '1'],
    });
    expect(res.statusCode).toBe(302);
    const meta = getSecretMeta(t.db, t.ring, acme(), 'Positional')!;
    expect(meta.fields.map((f) => [f.key, f.sensitive])).toEqual([['host', false], ['password', true]]);
  });

  it('falls back to defaultSensitive per row when sensitive is omitted entirely', async () => {
    const res = await post('/p/acme/secrets', {
      csrf,
      name: 'NoJs',
      key: ['host', 'password'],
      value: ['h', 'p'],
    });
    expect(res.statusCode).toBe(302);
    const meta = getSecretMeta(t.db, t.ring, acme(), 'NoJs')!;
    expect(meta.fields.map((f) => [f.key, f.sensitive])).toEqual([['host', false], ['password', true]]);
  });

  it('falls back to defaultSensitive, never to false, when sensitive carries a stale key-string token (old encoding)', async () => {
    const res = await post('/p/acme/secrets', {
      csrf,
      name: 'OldEncoding',
      key: ['password', 'host'],
      value: ['p', 'h'],
      sensitive: 'password',
    });
    expect(res.statusCode).toBe(302);
    const meta = getSecretMeta(t.db, t.ring, acme(), 'OldEncoding')!;
    expect(meta.fields.map((f) => [f.key, f.sensitive])).toEqual([['password', true], ['host', false]]);
  });

  it('drops rows with an empty key', async () => {
    await post('/p/acme/secrets', { csrf, name: 'Sparse', key: ['token', ''], value: ['v', 'ignored'] });
    const meta = getSecretMeta(t.db, t.ring, acme(), 'Sparse')!;
    expect(meta.fields.map((f) => f.key)).toEqual(['token']);
  });

  it('re-renders with an error when the name is missing', async () => {
    const res = await post('/p/acme/secrets', { csrf, name: '', key: ['k'], value: ['v'] });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('name');
  });

  it('rejects a create without a CSRF token', async () => {
    const res = await post('/p/acme/secrets', { name: 'NoCsrf', key: ['k'], value: ['v'] });
    expect(res.statusCode).toBe(403);
    expect(getSecretMeta(t.db, t.ring, acme(), 'NoCsrf')).toBeNull();
  });

  it('a name collision re-renders the form with a clear error and never echoes the typed-in (possibly sensitive) values', async () => {
    const res = await post('/p/acme/secrets', {
      csrf,
      name: 'DB',
      description: 'nope',
      tags: 'x',
      key: ['password'],
      value: ['typed-in-secret-value'],
      sensitive: ['1'],
    });
    expect(res.statusCode).toBe(409);
    expect(res.body).toContain('A secret with this name already exists');
    expect(res.body).not.toContain('typed-in-secret-value');
    const main = /<main[^>]*>([\s\S]*?)<\/main>/.exec(res.body)![1];
    expect(main).toContain('value="password"');
    const values = [...main.matchAll(/<textarea name="value"[^>]*>([\s\S]*?)<\/textarea>/g)].map((m) => m[1]);
    expect(values).toEqual(['']);
    // The existing secret's own stored value is untouched by the failed attempt.
    const meta = getSecretMeta(t.db, t.ring, acme(), 'DB')!;
    expect(revealField(t.db, t.ring, meta.id, 'password')).toBe('hunter2hunter2');
  });
});

describe('ui secret edit', () => {
  it('shows the keys but never a stored sensitive value', async () => {
    const res = await page('/p/acme/secrets/DB/edit');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('value="host"');
    expect(res.body).toContain('value="password"');
    expect(res.body).not.toContain('hunter2hunter2');
  });

  it('renders the sensitive hidden input positionally, one per field-card, in field order', async () => {
    const res = await page('/p/acme/secrets/DB/edit');
    expect(res.statusCode).toBe(200);
    const sensitiveValues = [...res.body.matchAll(/name="sensitive" value="(\d)"/g)].map((m) => m[1]);
    // DB has host (not sensitive) then password (sensitive), in that order.
    expect(sensitiveValues).toEqual(['0', '1']);
    const rowsSection = res.body.slice(res.body.indexOf('id="rows"'), res.body.indexOf('row-actions'));
    const cardStarts = [...rowsSection.matchAll(/<div class="field-card/g)].map((m) => m.index!);
    expect(cardStarts.length).toBe(2);
    const cards = cardStarts.map((start, i) => rowsSection.slice(start, cardStarts[i + 1] ?? rowsSection.length));
    for (const card of cards) {
      const matches = [...card.matchAll(/name="sensitive"/g)];
      expect(matches.length).toBe(1);
    }
    expect(res.body).toContain('aria-pressed="true"');
  });

  it('accepts a POST built from the rendered edit form, keeping the field order and password sensitivity', async () => {
    const form = await page('/p/acme/secrets/DB/edit');
    // Parse the rendered form itself (scoped to <main>) rather than hand-writing the payload:
    // the three lists below are what a browser would actually submit for this form as rendered.
    const main = /<main[^>]*>([\s\S]*?)<\/main>/.exec(form.body)![1];
    const keys = [...main.matchAll(/name="key" value="([^"]*)"/g)].map((m) => m[1]);
    const values = [...main.matchAll(/<textarea name="value"[^>]*>([\s\S]*?)<\/textarea>/g)].map((m) => m[1]);
    const sensitives = [...main.matchAll(/name="sensitive" value="(\d)"/g)].map((m) => m[1]);
    expect(keys).toEqual(['host', 'password']);
    // host is not sensitive, so its stored value is shown; password's box starts empty.
    expect(values).toEqual(['db.internal', '']);
    expect(sensitives).toEqual(['0', '1']);

    // Change host's value; leave password's box empty, exactly as parsed from the form.
    values[0] = 'db3.internal';

    const res = await post('/p/acme/secrets/DB', {
      csrf,
      name: 'DB',
      description: 'updated',
      tags: 'prod',
      key: keys,
      value: values,
      sensitive: sensitives,
    });
    expect(res.statusCode).toBe(302);
    const meta = getSecretMeta(t.db, t.ring, acme(), 'DB')!;
    expect(meta.fields.map((f) => [f.key, f.sensitive])).toEqual([['host', false], ['password', true]]);
    expect(revealField(t.db, t.ring, meta.id, 'host')).toBe('db3.internal');
    expect(revealField(t.db, t.ring, meta.id, 'password')).toBe('hunter2hunter2');
  });

  it('keeps a stored value when the box is left empty and updates one that is filled', async () => {
    const res = await post('/p/acme/secrets/DB', {
      csrf,
      name: 'DB',
      description: 'updated',
      tags: 'prod',
      key: ['host', 'password'],
      value: ['db2.internal', ''],
      sensitive: ['0', '1'],
    });
    expect(res.statusCode).toBe(302);
    const meta = getSecretMeta(t.db, t.ring, acme(), 'DB')!;
    expect(meta.description).toBe('updated');
    expect(revealField(t.db, t.ring, meta.id, 'host')).toBe('db2.internal');
    expect(revealField(t.db, t.ring, meta.id, 'password')).toBe('hunter2hunter2');
  });

  it('accepts a renamed field submitted with an empty value box (the value moves with the key)', async () => {
    createSecret(t.db, t.ring, {
      projectId: acme(),
      name: 'EditProbe',
      description: '',
      tags: [],
      fields: [{ key: 'host', value: 'h1' }, { key: 'password', value: 'p1', sensitive: true }],
    });
    const res = await post('/p/acme/secrets/EditProbe', {
      csrf,
      name: 'EditProbe',
      key: ['host', 'passwd'],
      value: ['h1', ''],
      sensitive: ['0', '1'],
      orig_key: ['host', 'password'],
    });
    expect(res.statusCode).toBe(302);
    const meta = getSecretMeta(t.db, t.ring, acme(), 'EditProbe')!;
    expect(meta.fields.map((f) => f.key)).toEqual(['host', 'passwd']);
    expect(revealField(t.db, t.ring, meta.id, 'passwd')).toBe('p1');
    // put it back for the tests below
    await post('/p/acme/secrets/EditProbe', { csrf, name: 'EditProbe', key: ['host', 'password'], value: ['h1', ''], sensitive: ['0', '1'], orig_key: ['host', 'passwd'] });
    expect(getSecretMeta(t.db, t.ring, acme(), 'EditProbe')!.fields.map((f) => f.key)).toEqual(['host', 'password']);
  });

  it('accepts flipping a field to Sensitive with an empty value box, keeping its value', async () => {
    const res = await post('/p/acme/secrets/EditProbe', {
      csrf,
      name: 'EditProbe',
      key: ['host', 'password'],
      value: ['', 'p1'],
      sensitive: ['1', '1'],
    });
    expect(res.statusCode).toBe(302);
    const meta = getSecretMeta(t.db, t.ring, acme(), 'EditProbe')!;
    expect(meta.fields.map((f) => [f.key, f.sensitive])).toEqual([['host', true], ['password', true]]);
    expect(revealField(t.db, t.ring, meta.id, 'host')).toBe('h1');
    // restore for the next test
    await post('/p/acme/secrets/EditProbe', { csrf, name: 'EditProbe', key: ['host', 'password'], value: ['', ''], sensitive: ['0', '1'] });
  });

  it('flips sensitivity when a value is supplied', async () => {
    const res = await post('/p/acme/secrets/EditProbe', {
      csrf,
      name: 'EditProbe',
      key: ['host', 'password'],
      value: ['h2', 'p1'],
      sensitive: ['1', '1'],
    });
    expect(res.statusCode).toBe(302);
    const meta = getSecretMeta(t.db, t.ring, acme(), 'EditProbe')!;
    expect(meta.fields.map((f) => [f.key, f.sensitive])).toEqual([['host', true], ['password', true]]);
    expect(revealField(t.db, t.ring, meta.id, 'host')).toBe('h2');
  });

  it('renders values as textareas with move buttons', async () => {
    const res = await page('/p/acme/secrets/EditProbe/edit');
    expect(res.body).toMatch(/<textarea name="value"/);
    expect(res.body).not.toMatch(/<input name="value"/);
    expect(res.body).toContain('data-action="move-up"');
    expect(res.body).toContain('data-action="move-down"');
  });

  it('persists the submitted row order even for rows whose value box is empty', async () => {
    const res = await post('/p/acme/secrets/EditProbe', {
      csrf,
      name: 'EditProbe',
      key: ['password', 'host'],
      value: ['', ''],
      sensitive: ['1', '1'],
    });
    expect(res.statusCode).toBe(302);
    const meta = getSecretMeta(t.db, t.ring, acme(), 'EditProbe')!;
    expect(meta.fields.map((f) => f.key)).toEqual(['password', 'host']);
    expect(revealField(t.db, t.ring, meta.id, 'host')).toBe('h2');
  });

  it('stores multi-line values with LF line endings (browsers submit textareas as CRLF)', async () => {
    const res = await post('/p/acme/secrets', {
      csrf,
      name: 'SshKey',
      key: ['private_ssh_key'],
      value: ['-----BEGIN KEY-----\r\nAAAA\r\nBBBB\r\n-----END KEY-----\r\n'],
      sensitive: ['1'],
    });
    expect(res.statusCode).toBe(302);
    const meta = getSecretMeta(t.db, t.ring, acme(), 'SshKey')!;
    expect(revealField(t.db, t.ring, meta.id, 'private_ssh_key')).toBe('-----BEGIN KEY-----\nAAAA\nBBBB\n-----END KEY-----\n');
  });

  it('removes a field that was dropped from the form', async () => {
    await post('/p/acme/secrets/DB', { csrf, name: 'DB', key: ['host'], value: [''] });
    const meta = getSecretMeta(t.db, t.ring, acme(), 'DB')!;
    expect(meta.fields.map((f) => f.key)).toEqual(['host']);
  });

  it('renames a secret from the edit form, keeping its stored values', async () => {
    createSecret(t.db, t.ring, { projectId: acme(), name: 'OldName', description: '', tags: [], fields: [{ key: 'token', value: 's3cret' }] });
    const form = await page('/p/acme/secrets/OldName/edit');
    expect(form.body).not.toContain('readonly');
    const res = await post('/p/acme/secrets/OldName', { csrf, name: 'NewName', key: ['token'], value: [''], sensitive: ['1'] });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/p/acme/secrets/NewName?done=saved');
    expect(getSecretMeta(t.db, t.ring, acme(), 'OldName')).toBeNull();
    const meta = getSecretMeta(t.db, t.ring, acme(), 'NewName')!;
    expect(revealField(t.db, t.ring, meta.id, 'token')).toBe('s3cret');
  });

  it('re-renders with an error when renaming onto an existing name', async () => {
    createSecret(t.db, t.ring, { projectId: acme(), name: 'Taken', description: '', tags: [], fields: [{ key: 'k', value: 'v' }] });
    createSecret(t.db, t.ring, { projectId: acme(), name: 'Mover', description: '', tags: [], fields: [{ key: 'k', value: 'v' }] });
    const res = await post('/p/acme/secrets/Mover', { csrf, name: 'Taken', key: ['k'], value: [''], sensitive: ['1'] });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('role="alert"');
    expect(res.body).toContain('already exists');
    expect(getSecretMeta(t.db, t.ring, acme(), 'Mover')).not.toBeNull();
  });

  it('keeps the Cancel link and breadcrumb pointed at the original secret after a rename conflict, not the refused name', async () => {
    createSecret(t.db, t.ring, { projectId: acme(), name: 'TakenName', description: '', tags: [], fields: [{ key: 'k', value: 'v' }] });
    createSecret(t.db, t.ring, { projectId: acme(), name: 'MoverTwo', description: '', tags: [], fields: [{ key: 'k', value: 'v' }] });
    const res = await post('/p/acme/secrets/MoverTwo', { csrf, name: 'TakenName', key: ['k'], value: [''], sensitive: ['1'] });
    expect(res.statusCode).toBe(400);
    const main = /<main[\s\S]*<\/main>/.exec(res.body)?.[0] ?? '';
    expect(main).toContain('href="/p/acme/secrets/MoverTwo">Cancel</a>');
    expect(main).toContain('<span class="current">MoverTwo</span>');
    expect(main).not.toContain('href="/p/acme/secrets/TakenName">Cancel</a>');
    expect(main).not.toContain('<span class="current">TakenName</span>');
  });

  it('deletes a secret and redirects to the project', async () => {
    createSecret(t.db, t.ring, { projectId: acme(), name: 'Doomed', description: '', tags: [], fields: [{ key: 'k', value: 'v' }] });
    const view = await page('/p/acme/secrets/Doomed');
    const res = await post('/p/acme/secrets/Doomed/delete', { csrf: csrfOf(view.body) });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/p/acme?tab=secrets&done=deleted');
    expect(getSecretMeta(t.db, t.ring, acme(), 'Doomed')).toBeNull();
  });
});

const mainOf = (html: string): string => /<main[\s\S]*?<\/main>/.exec(html)?.[0] ?? '';

describe('ui secret edit: an empty "unchanged" box never errors', () => {
  let n = 0;
  const mk = (fields: { key: string; value: string; sensitive?: boolean }[]) => {
    const name = `Unch${++n}`;
    const meta = createSecret(t.db, t.ring, { projectId: acme(), name, description: '', tags: [], fields });
    return { name, id: meta.id };
  };
  const edit = (name: string, rows: { key: string; orig: string; value?: string; sensitive: boolean }[], extra: Record<string, unknown> = {}, who = { session, csrf }) =>
    t.app.inject({
      method: 'POST',
      url: `/p/acme/secrets/${name}`,
      cookies: { blindkey_session: who.session },
      payload: {
        csrf: who.csrf,
        name,
        key: rows.map((r) => r.key),
        orig_key: rows.map((r) => r.orig),
        value: rows.map((r) => r.value ?? ''),
        sensitive: rows.map((r) => (r.sensitive ? '1' : '0')),
        ...extra,
      },
    });
  const state = (name: string) => {
    const m = getSecretMeta(t.db, t.ring, acme(), name)!;
    return m.fields.map((f) => [f.key, f.sensitive, revealField(t.db, t.ring, m.id, f.key)]);
  };

  it('renders an orig_key hidden input per row, holding the stored key', async () => {
    const { name } = mk([{ key: 'host', value: 'h' }, { key: 'password', value: 'p', sensitive: true }]);
    const html = mainOf((await page(`/p/acme/secrets/${name}/edit`)).body);
    expect([...html.matchAll(/name="orig_key" value="([^"]*)"/g)].map((m) => m[1])).toEqual(['host', 'password']);
  });

  it('1. a plain resubmit of the unchanged form is a 302 and every value is intact', async () => {
    const { name } = mk([{ key: 'host', value: 'h1' }, { key: 'password', value: 'p1', sensitive: true }]);
    const res = await edit(name, [
      { key: 'host', orig: 'host', value: 'h1', sensitive: false },
      { key: 'password', orig: 'password', sensitive: true },
    ]);
    expect(res.statusCode).toBe(302);
    expect(state(name)).toEqual([['host', false, 'h1'], ['password', true, 'p1']]);
  });

  it('2. renaming a locked row with an empty box keeps the exact value under the new key and drops the old key', async () => {
    const { name, id } = mk([{ key: 'host', value: 'h1' }, { key: 'password', value: 'pa ss\nline2 \u00e9', sensitive: true }]);
    const res = await edit(name, [
      { key: 'host', orig: 'host', value: 'h1', sensitive: false },
      { key: 'passwd', orig: 'password', sensitive: true },
    ]);
    expect(res.statusCode).toBe(302);
    expect(state(name)).toEqual([['host', false, 'h1'], ['passwd', true, 'pa ss\nline2 \u00e9']]);
    expect(revealField(t.db, t.ring, id, 'password')).toBeNull();
    const audit = JSON.stringify(listAuditForTarget(t.db, 'secret', id, 5));
    expect(audit).toContain('"renamed":[{"from":"password","to":"passwd"}]');
    expect(audit).not.toContain('pa ss');
  });

  it('2. swapping the keys of two empty-box rows keeps each value with its new key', async () => {
    const { name } = mk([{ key: 'a_secret', value: 'AAA', sensitive: true }, { key: 'b_secret', value: 'BBB', sensitive: true }]);
    const res = await edit(name, [
      { key: 'b_secret', orig: 'a_secret', sensitive: true },
      { key: 'a_secret', orig: 'b_secret', sensitive: true },
    ]);
    expect(res.statusCode).toBe(302);
    expect(state(name)).toEqual([['b_secret', true, 'AAA'], ['a_secret', true, 'BBB']]);
  });

  it('3. the owner flipping Locked to Visible with an empty box keeps the value and changes the flag; Visible to Locked too', async () => {
    const { name } = mk([{ key: 'host', value: 'h1' }, { key: 'token', value: 'tok-1', sensitive: true }]);
    expect((await edit(name, [{ key: 'host', orig: 'host', sensitive: true }, { key: 'token', orig: 'token', sensitive: false }])).statusCode).toBe(302);
    expect(state(name)).toEqual([['host', true, 'h1'], ['token', false, 'tok-1']]);
  });

  it('4. a brand-new row with an empty box is skipped silently, with or without a typed key', async () => {
    const { name } = mk([{ key: 'host', value: 'h1' }]);
    const res = await edit(name, [
      { key: 'host', orig: 'host', value: 'h1', sensitive: false },
      { key: 'typed', orig: '', sensitive: true },
      { key: '', orig: '', sensitive: true },
    ]);
    expect(res.statusCode).toBe(302);
    expect(state(name)).toEqual([['host', false, 'h1']]);
  });

  it('5. a rename onto a key another row uses is a duplicate: 400 re-render, nothing changes', async () => {
    const { name } = mk([{ key: 'host', value: 'h1' }, { key: 'token', value: 'tok-1', sensitive: true }]);
    const res = await edit(name, [
      { key: 'host', orig: 'host', value: 'h1', sensitive: false },
      { key: 'host', orig: 'token', sensitive: true },
    ]);
    expect(res.statusCode).toBe(400);
    expect(mainOf(res.body)).toContain('duplicate field key');
    expect(state(name)).toEqual([['host', false, 'h1'], ['token', true, 'tok-1']]);
  });

  it('a hand-rolled POST without orig_key still treats a same-named empty row as unchanged', async () => {
    const { name } = mk([{ key: 'host', value: 'h1' }, { key: 'password', value: 'p1', sensitive: true }]);
    const res = await t.app.inject({
      method: 'POST',
      url: `/p/acme/secrets/${name}`,
      cookies: { blindkey_session: session },
      payload: { csrf, name, key: ['host', 'password'], value: ['h1', ''], sensitive: ['0', '1'] },
    });
    expect(res.statusCode).toBe(302);
    expect(state(name)).toEqual([['host', false, 'h1'], ['password', true, 'p1']]);
  });

  describe('members without full rights', () => {
    let bobS: { session: string; csrf: string };
    let daveS: { session: string; csrf: string };
    const login = async (username: string) => {
      const sess = createSession(t.db, getUserByUsername(t.db, username)!.id, 3_600_000, '127.0.0.1', 'test');
      const body = (await page2(sess, '/')).body;
      return { session: sess, csrf: csrfOf(body) };
    };
    const page2 = (sess: string, url: string) => t.app.inject({ method: 'GET', url, cookies: { blindkey_session: sess } });
    const grantTo = (username: string, secretId: number, perms: string[]) =>
      upsertGrant(t.db, { userId: getUserByUsername(t.db, username)!.id, targetType: 'secret', targetId: secretId, perms });

    beforeAll(async () => {
      for (const u of ['bob', 'dave']) {
        createUser(t.db, { username: u, passwordHash: await hashPassword(`${u}-password-1`) });
        t.enroll(u);
      }
      const seed = mk([{ key: 'host', value: 'seed' }]);
      grantTo('bob', seed.id, ['public.read']);
      grantTo('dave', seed.id, ['public.read']);
      bobS = await login('bob');
      daveS = await login('dave');
    });

    it('3. a grant-holder who may write but not reveal keeps a field locked on a flip and gets a notice, not an error', async () => {
      const { name, id } = mk([{ key: 'host', value: 'h1' }, { key: 'token', value: 'tok-1', sensitive: true }]);
      grantTo('bob', id, ['public.read', 'public.write', 'protected.write']);
      const res = await edit(name, [{ key: 'host', orig: 'host', value: 'h2', sensitive: false }, { key: 'token', orig: 'token', sensitive: false }], {}, bobS);
      expect(res.statusCode).toBe(302);
      expect(state(name)).toEqual([['host', false, 'h2'], ['token', true, 'tok-1']]);
      const next = await page2(bobS.session, res.headers.location as string);
      expect(next.statusCode).toBe(200);
      expect(mainOf(next.body)).toContain('token stayed locked: you can&#39;t reveal it');
      // The notice is only shown for keys that really are locked: a forged one is ignored.
      expect(mainOf((await page2(bobS.session, `/p/acme/secrets/${name}?stayed=host`)).body)).not.toContain('stayed locked');
    });

    it('3. the service refuses to un-lock a carried field without protected.read', async () => {
      const { name, id } = mk([{ key: 'token', value: 'tok-1', sensitive: true }]);
      grantTo('bob', id, ['public.read', 'public.write', 'protected.write']);
      const bobId = getUserByUsername(t.db, 'bob')!.id;
      const actor: Actor = { principal: { kind: 'admin', id: bobId, userId: bobId, isSuper: false, impersonatorId: null, scopes: ['admin'], projectIds: null, agent: false }, ip: '1.1.1.1', userAgent: 't' };
      expect(() => updateSecretFor(t.ctx, actor, 'acme', name, { carryFields: [{ from: 'token', to: 'token', sensitive: false }] })).toThrow(/protected\.read/);
      expect(state(name)).toEqual([['token', true, 'tok-1']]);
    });

    it('3. a grant-holder who may read protected values can unlock', async () => {
      const { name, id } = mk([{ key: 'token', value: 'tok-1', sensitive: true }]);
      grantTo('bob', id, ['public.read', 'public.write', 'protected.write', 'protected.read']);
      const res = await edit(name, [{ key: 'token', orig: 'token', sensitive: false }], {}, bobS);
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).not.toContain('stayed');
      expect(state(name)).toEqual([['token', false, 'tok-1']]);
    });

    it('a public.write-only member saves public changes and leaves sensitive fields as stored, whatever the form says', async () => {
      const { name, id } = mk([{ key: 'host', value: 'h1' }, { key: 'password', value: 'p1', sensitive: true }, { key: 'token', value: 't1', sensitive: true }]);
      grantTo('dave', id, ['public.read', 'public.write']);
      const res = await edit(
        name,
        [
          { key: 'host', orig: 'host', value: 'h2', sensitive: false },
          { key: 'pw2', orig: 'password', sensitive: true }, // rename: skipped
          { key: 'token', orig: 'token', sensitive: false }, // unlock: skipped
          { key: 'fresh', orig: '', sensitive: false }, // new and empty: skipped
        ],
        { description: 'edited by dave' },
        daveS,
      );
      expect(res.statusCode).toBe(302);
      expect(state(name)).toEqual([['host', false, 'h2'], ['password', true, 'p1'], ['token', true, 't1']]);
      expect(getSecretMeta(t.db, t.ring, acme(), name)!.description).toBe('edited by dave');
    });

    it('a public.write-only member still cannot write a new value into a sensitive field (service guard intact)', async () => {
      const { name, id } = mk([{ key: 'password', value: 'p1', sensitive: true }]);
      grantTo('dave', id, ['public.read', 'public.write']);
      const res = await edit(name, [{ key: 'password', orig: 'password', value: 'hacked', sensitive: true }], {}, daveS);
      expect(res.statusCode).not.toBe(302);
      expect(state(name)).toEqual([['password', true, 'p1']]);
    });
  });
});

describe('app.js add-row creates an empty orig_key', () => {
  it('appends a hidden orig_key input with an empty value to the new card', async () => {
    const source = (await t.app.inject({ method: 'GET', url: '/assets/app.js' })).body;
    interface El {
      tagName: string;
      name?: string;
      type?: string;
      value?: string;
      children: El[];
      classList: { toggle: () => void };
      className: string;
      setAttribute: () => void;
      appendChild: (c: El) => El;
    }
    const mkEl = (tagName: string): El => {
      const el: El = { tagName, children: [], className: '', classList: { toggle: () => {} }, setAttribute: () => {}, appendChild: (c) => (el.children.push(c), c) };
      return el;
    };
    const rows = mkEl('DIV');
    const listeners: Record<string, (e: unknown) => void> = {};
    class FakeEl {
      getAttribute(n: string) { return n === 'data-action' ? 'add-row' : n === 'data-key' ? 'host' : null; }
      closest(sel: string) { return sel === '[data-action]' ? this : null; }
    }
    const document = {
      addEventListener: (type: string, fn: (e: unknown) => void) => { listeners[type] = fn; },
      getElementById: (id: string) => (id === 'rows' ? { ...rows, getAttribute: () => '["host"]', appendChild: rows.appendChild } : null),
      createElement: mkEl,
      querySelectorAll: () => [],
    };
    runInNewContext(source, { document, location: { search: '', pathname: '/', hash: '' }, history: { state: null, replaceState: () => {} }, URLSearchParams, navigator: {}, Element: FakeEl, WeakMap, setTimeout: () => 0 });
    listeners.click!({ target: new FakeEl() });
    const card = rows.children[0]!;
    const orig = card.children.find((c) => c.name === 'orig_key')!;
    expect(orig.type).toBe('hidden');
    expect(orig.value).toBe('');
    // Positional order matters: key, orig_key, value, ... sensitive.
    expect(card.children.map((c) => c.name).filter(Boolean).slice(0, 3)).toEqual(['key', 'orig_key', 'value']);
  });
});
