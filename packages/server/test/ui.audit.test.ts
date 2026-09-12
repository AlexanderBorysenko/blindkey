import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeTestApp, type TestCtx } from './helpers.js';
import { createAdmin } from '../src/repos/admin.js';
import { hashPassword } from '../src/crypto/passwords.js';
import { writeAudit, listAudit } from '../src/repos/audit.js';

let t: TestCtx;
let session: string;
const page = (url: string) => t.app.inject({ method: 'GET', url, cookies: { pidb_session: session } });

beforeAll(async () => {
  t = await makeTestApp();
  createAdmin(t.db, 'alex', await hashPassword('pw'));
  session = (await t.app.inject({ method: 'POST', url: '/login', payload: { username: 'alex', password: 'pw' } }))
    .cookies.find((c) => c.name === 'pidb_session')!.value;
  for (let i = 0; i < 5; i++) {
    writeAudit(t.db, { actor_type: 'token', actor_id: null, action: 'secret.reveal', target_type: 'secret', target_id: i, field_key: 'password', ip: '10.0.0.1', user_agent: 'agent' });
  }
  writeAudit(t.db, { actor_type: 'admin', actor_id: 1, action: 'doc.write', target_type: 'document', target_id: 1, ip: '10.0.0.2', user_agent: 'browser' });
});
afterAll(async () => {
  await t.app.close();
});

describe('ui audit', () => {
  it('lists the newest rows first', async () => {
    const res = await page('/audit');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('doc.write');
    expect(res.body).toContain('secret.reveal');
    expect(res.body.indexOf('doc.write')).toBeLessThan(res.body.indexOf('secret.reveal'));
  });

  it('filters by action and by actor', async () => {
    const byAction = await page('/audit?action=doc.write');
    expect(byAction.body).toContain('<td>doc.write</td>');
    expect(byAction.body).not.toContain('secret.reveal');
    const byActor = await page('/audit?actor=admin');
    expect(byActor.body).toContain('<td>doc.write</td>');
    expect(byActor.body).not.toContain('secret.reveal');
  });

  it('pages with an id cursor', async () => {
    const first = await page('/audit?limit=2');
    const older = /href="\/audit\?[^"]*before=(\d+)[^"]*"/.exec(first.body)?.[1];
    expect(older).toBeTruthy();
    const second = await page(`/audit?limit=2&before=${older}`);
    expect(second.statusCode).toBe(200);
    const ids = listAudit(t.db, { limit: 100 }).map((r) => r.id);
    expect(ids.length).toBeGreaterThan(2);
    expect(second.body).not.toContain(`<td>${ids[0]}</td>`);
  });

  it('never shows a secret value, only the field key', async () => {
    const res = await page('/audit');
    expect(res.body).toContain('password');       // the field key is metadata
    expect(res.body).not.toContain('hunter2');    // no value ever reaches the audit table
  });
});
