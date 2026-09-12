import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeTestApp, type TestCtx } from './helpers.js';
import { createAdmin } from '../src/repos/admin.js';
import { hashPassword } from '../src/crypto/passwords.js';
import { createSecret, getSecretMeta, revealField } from '../src/repos/secrets.js';
import { getProjectBySlug } from '../src/repos/projects.js';

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
      sensitive: 'password',
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/p/acme/secrets/SMTP');
    const meta = getSecretMeta(t.db, t.ring, acme(), 'SMTP')!;
    expect(meta.fields.map((f) => [f.key, f.sensitive])).toEqual([['host', false], ['password', true]]);
    expect(revealField(t.db, t.ring, meta.id, 'password')).toBe('s3cret-mail');
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

  it('keeps a stored value when the box is left empty and updates one that is filled', async () => {
    const res = await post('/p/acme/secrets/DB', {
      csrf,
      name: 'DB',
      description: 'updated',
      tags: 'prod',
      key: ['host', 'password'],
      value: ['db2.internal', ''],
      sensitive: 'password',
    });
    expect(res.statusCode).toBe(302);
    const meta = getSecretMeta(t.db, t.ring, acme(), 'DB')!;
    expect(meta.description).toBe('updated');
    expect(revealField(t.db, t.ring, meta.id, 'host')).toBe('db2.internal');
    expect(revealField(t.db, t.ring, meta.id, 'password')).toBe('hunter2hunter2');
  });

  it('removes a field that was dropped from the form', async () => {
    await post('/p/acme/secrets/DB', { csrf, name: 'DB', key: ['host'], value: [''] });
    const meta = getSecretMeta(t.db, t.ring, acme(), 'DB')!;
    expect(meta.fields.map((f) => f.key)).toEqual(['host']);
  });

  it('deletes a secret and redirects to the project', async () => {
    createSecret(t.db, t.ring, { projectId: acme(), name: 'Doomed', description: '', tags: [], fields: [{ key: 'k', value: 'v' }] });
    const view = await page('/p/acme/secrets/Doomed');
    const res = await post('/p/acme/secrets/Doomed/delete', { csrf: csrfOf(view.body) });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/p/acme?tab=secrets');
    expect(getSecretMeta(t.db, t.ring, acme(), 'Doomed')).toBeNull();
  });
});
