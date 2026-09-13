import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeTestApp, type TestCtx } from './helpers.js';
import { createAdmin } from '../src/repos/admin.js';
import { hashPassword } from '../src/crypto/passwords.js';
import { createSecret } from '../src/repos/secrets.js';
import { listAudit } from '../src/repos/audit.js';
import { getProjectBySlug } from '../src/repos/projects.js';

let t: TestCtx;
let session: string;
let csrf: string;
const page = (url: string) => t.app.inject({ method: 'GET', url, cookies: { pidb_session: session } });
const post = (url: string, payload: Record<string, unknown>) =>
  t.app.inject({ method: 'POST', url, cookies: { pidb_session: session }, payload });
const csrfOf = (b: string) => /name="csrf" value="([^"]+)"/.exec(b)?.[1] ?? '';

beforeAll(async () => {
  t = await makeTestApp();
  createAdmin(t.db, 'alex', await hashPassword('pw'));
  session = (await t.app.inject({ method: 'POST', url: '/login', payload: { username: 'alex', password: 'pw' } }))
    .cookies.find((c) => c.name === 'pidb_session')!.value;
  t.project('acme');
  createSecret(t.db, t.ring, {
    projectId: getProjectBySlug(t.db, 'acme')!.id,
    name: 'DB',
    description: 'main database',
    tags: ['prod'],
    fields: [{ key: 'host', value: 'db.internal' }, { key: 'password', value: 'hunter2hunter2' }],
  });
  createSecret(t.db, t.ring, { projectId: null, name: 'Cloudflare', description: '', tags: [], fields: [{ key: 'api_key', value: 'cf-key-value' }] });
  csrf = csrfOf((await page('/p/acme')).body);
});
afterAll(async () => {
  await t.app.close();
});

describe('ui secret page', () => {
  it('masks sensitive values and shows non-sensitive ones', async () => {
    const res = await page('/p/acme/secrets/DB');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('password');
    expect(res.body).toContain('db.internal');
    expect(res.body).not.toContain('hunter2hunter2');
    expect(res.body).toContain('Reveal');
  });

  it('lists global secrets and opens one without values', async () => {
    const list = await page('/global/secrets');
    expect(list.body).toContain('href="/global/secrets/Cloudflare"');
    const one = await page('/global/secrets/Cloudflare');
    expect(one.statusCode).toBe(200);
    expect(one.body).not.toContain('cf-key-value');
  });

  it('reveals exactly one field, audits it, and forbids caching', async () => {
    const before = listAudit(t.db, { limit: 50 }).filter((r) => r.action === 'secret.reveal').length;
    const res = await post('/p/acme/secrets/DB/reveal', { csrf, key: 'password' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('hunter2hunter2');
    expect(res.body).not.toContain('<!doctype html>');
    expect(res.headers['cache-control']).toContain('no-store');
    const rows = listAudit(t.db, { limit: 50 }).filter((r) => r.action === 'secret.reveal');
    expect(rows.length).toBe(before + 1);
    expect(rows[0]!.actor_type).toBe('admin');
    expect(rows[0]!.field_key).toBe('password');
  });

  it('lets a revealed value be hidden again', async () => {
    const view = await page('/p/acme/secrets/DB');
    expect(view.body).toContain('function hideField(');
    const res = await post('/p/acme/secrets/DB/reveal', { csrf, key: 'password' });
    expect(res.body).toContain('onclick="hideField(this)"');
    expect(res.body).toContain('>Hide</button>');
  });

  it('refuses to reveal without a CSRF token and writes no audit row', async () => {
    const before = listAudit(t.db, { limit: 50 }).filter((r) => r.action === 'secret.reveal').length;
    const res = await post('/p/acme/secrets/DB/reveal', { key: 'password' });
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain('hunter2hunter2');
    expect(listAudit(t.db, { limit: 50 }).filter((r) => r.action === 'secret.reveal').length).toBe(before);
  });

  it('refuses to reveal for an anonymous visitor', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/p/acme/secrets/DB/reveal', payload: { csrf, key: 'password' } });
    expect(res.statusCode).toBe(302);
    expect(res.body).not.toContain('hunter2hunter2');
  });

  it('404s on an unknown field and an unknown secret', async () => {
    expect((await post('/p/acme/secrets/DB/reveal', { csrf, key: 'nope' })).statusCode).toBe(404);
    expect((await page('/p/acme/secrets/Nope')).statusCode).toBe(404);
  });
});
