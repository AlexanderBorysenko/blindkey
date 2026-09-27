import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeTestApp, type TestCtx } from './helpers.js';
import { createAdmin } from '../src/repos/admin.js';
import { hashPassword } from '../src/crypto/passwords.js';
import { getSecretMeta } from '../src/repos/secrets.js';
import { getProjectBySlug } from '../src/repos/projects.js';

let t: TestCtx;
let session: string;
const page = (url: string) => t.app.inject({ method: 'GET', url, cookies: { pidb_session: session } });
const acmeId = () => getProjectBySlug(t.db, 'acme')!.id;
const rowsSection = (body: string) => body.slice(body.indexOf('id="rows"'), body.indexOf('row-actions'));

beforeAll(async () => {
  t = await makeTestApp();
  createAdmin(t.db, 'alex', await hashPassword('pw'));
  session = (await t.app.inject({ method: 'POST', url: '/login', payload: { username: 'alex', password: 'pw' } }))
    .cookies.find((c) => c.name === 'pidb_session')!.value;
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
});
