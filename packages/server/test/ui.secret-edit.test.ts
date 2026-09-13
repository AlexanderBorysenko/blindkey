import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeTestApp, type TestCtx } from './helpers.js';
import { createAdmin } from '../src/repos/admin.js';
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
    expect(html).toContain('a\\u003c/script>b');
    expect(html).not.toContain('a</script>b');
  });
});

let t: TestCtx;
let session: string;
let csrf: string;
const page = (url: string) => t.app.inject({ method: 'GET', url, cookies: { pidb_session: session } });
const post = (url: string, payload: Record<string, unknown>) =>
  t.app.inject({ method: 'POST', url, cookies: { pidb_session: session }, payload });
const csrfOf = (b: string) => /name="csrf" value="([^"]+)"/.exec(b)?.[1] ?? '';
const acme = () => getProjectBySlug(t.db, 'acme')!.id;

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

  it('rejects a renamed field submitted with an empty value box, leaving the original field intact', async () => {
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
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain('p1');
    const meta = getSecretMeta(t.db, t.ring, acme(), 'EditProbe')!;
    expect(meta.fields.map((f) => f.key)).toEqual(['host', 'password']);
    expect(revealField(t.db, t.ring, meta.id, 'password')).toBe('p1');
  });

  it('rejects flipping a field to Sensitive with an empty value box, leaving the stored field unchanged', async () => {
    const res = await post('/p/acme/secrets/EditProbe', {
      csrf,
      name: 'EditProbe',
      key: ['host', 'password'],
      value: ['', 'p1'],
      sensitive: ['1', '1'],
    });
    expect(res.statusCode).toBe(400);
    const meta = getSecretMeta(t.db, t.ring, acme(), 'EditProbe')!;
    expect(meta.fields.map((f) => [f.key, f.sensitive])).toEqual([['host', false], ['password', true]]);
    expect(revealField(t.db, t.ring, meta.id, 'host')).toBe('h1');
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
    expect(res.body).toContain('moveRow(this, -1)');
    expect(res.body).toContain('moveRow(this, 1)');
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
