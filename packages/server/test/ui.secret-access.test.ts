import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeTestApp, type TestCtx } from './helpers.js';
import { createAdmin } from '../src/repos/admin.js';
import { hashPassword } from '../src/crypto/passwords.js';
import { createSecret } from '../src/repos/secrets.js';
import { writeAudit, listAuditForTarget } from '../src/repos/audit.js';
import { getProjectBySlug } from '../src/repos/projects.js';
import { recentSecretAccessFor } from '../src/services/secrets.js';
import { ForbiddenError } from '../src/errors.js';
import type { Principal } from '../src/auth/principal.js';

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
  createSecret(t.db, t.ring, {
    projectId: getProjectBySlug(t.db, 'acme')!.id,
    name: 'Other',
    description: '',
    tags: [],
    fields: [{ key: 'password', value: 'other-secret-value' }],
  });
  csrf = csrfOf((await page('/p/acme')).body);
});
afterAll(async () => {
  await t.app.close();
});

describe('secret page: recent access panel', () => {
  it('(a) after a reveal, the secret page shows it in recent access without leaking the value', async () => {
    const reveal = await post('/p/acme/secrets/DB/reveal', { csrf, key: 'password' });
    expect(reveal.statusCode).toBe(200);

    const view = await page('/p/acme/secrets/DB');
    expect(view.statusCode).toBe(200);
    const main = /<main[^>]*>([\s\S]*)<\/main>/.exec(view.body)?.[1] ?? view.body;
    expect(main).toContain('revealed');
    expect(main).toContain('password');
    expect(main).not.toContain('hunter2hunter2');
  });

  it('(b) access rows of a different secret do not appear', async () => {
    // "DB" was revealed above; "Other" (same project, different secret) never was.
    const other = await page('/p/acme/secrets/Other');
    expect(other.statusCode).toBe(200);
    const main = /<main[^>]*>([\s\S]*)<\/main>/.exec(other.body)?.[1] ?? other.body;
    expect(main).toContain('No access recorded yet.');
    expect(main).not.toContain('other-secret-value');
  });

  it('(c) listAuditForTarget respects limit and order', async () => {
    const secret = createSecret(t.db, t.ring, { projectId: null, name: 'AuditTarget', description: '', tags: [], fields: [{ key: 'k', value: 'v' }] });
    const ids: number[] = [];
    for (let i = 0; i < 7; i++) {
      ids.push(writeAudit(t.db, { actor_type: 'admin', actor_id: 1, action: 'secret.reveal', target_type: 'secret', target_id: secret.id, field_key: 'k' }, 1_000 + i));
    }
    const rows = listAuditForTarget(t.db, 'secret', secret.id, 5);
    expect(rows.map((r) => r.id)).toEqual([...ids].reverse().slice(0, 5));
  });

  it('(d) a token principal lacking admin scope is forbidden from recentSecretAccessFor', () => {
    const principal: Principal = { kind: 'token', id: 1, scopes: ['secrets:meta'], projectIds: null };
    expect(() => recentSecretAccessFor(t.ctx, principal, 'acme', 'DB')).toThrow(ForbiddenError);
  });

  it('(e) the reveal partial has the auto-hiding markup', async () => {
    const res = await post('/p/acme/secrets/DB/reveal', { csrf, key: 'password' });
    expect(res.body).toContain('class="kv-row revealed"');
    expect(res.body).toContain('data-seconds="30"');
    expect(res.body).toContain('>Hide</button>');
    expect(res.body).toContain('onclick="hideField(this)"');
  });

  it('(f) the secret page has exactly one masked-row template for the sensitive field, none for the non-sensitive one', async () => {
    const view = await page('/p/acme/secrets/DB');
    const passwordTemplates = view.body.match(/<template data-masked-row="password">/g) ?? [];
    expect(passwordTemplates.length).toBe(1);
    expect(view.body).not.toContain('<template data-masked-row="host">');
    const templateMatch = /<template data-masked-row="password">([\s\S]*?)<\/template>/.exec(view.body);
    expect(templateMatch).not.toBeNull();
    const templateBody = templateMatch![1]!;
    expect(templateBody).toContain('name="csrf"');
    expect(templateBody).toContain('/reveal');
  });
});
