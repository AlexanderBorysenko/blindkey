import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeTestApp, auth, type TestCtx } from './helpers.js';
import { createAdmin } from '../src/repos/admin.js';
import { hashPassword } from '../src/crypto/passwords.js';
import { createToken } from '../src/repos/tokens.js';
import { listAudit } from '../src/repos/audit.js';

const DAY = 86_400_000;
let t: TestCtx;
let admin: string;

beforeAll(async () => {
  t = await makeTestApp();
  createAdmin(t.db, 'alex', await hashPassword('pw'));
  admin = t.token(['admin']);
});
afterAll(async () => {
  await t.app.close();
});

const near = (value: number, expected: number) => expect(Math.abs(value - expected)).toBeLessThan(60_000);

describe('login tokens', () => {
  it('expire after 30 days by default', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/v1/auth/token', payload: { username: 'alex', password: 'pw', name: 'cli' } });
    expect(res.statusCode).toBe(201);
    near(res.json().expires_at, Date.now() + 30 * DAY);
  });

  it('accept expires_days between 1 and 365 only', async () => {
    const ok = await t.app.inject({ method: 'POST', url: '/api/v1/auth/token', payload: { username: 'alex', password: 'pw', expires_days: 365 } });
    near(ok.json().expires_at, Date.now() + 365 * DAY);
    for (const bad of [0, 366, 1.5]) {
      const res = await t.app.inject({ method: 'POST', url: '/api/v1/auth/token', payload: { username: 'alex', password: 'pw', expires_days: bad } });
      expect(res.statusCode).toBe(400);
    }
  });
});

describe('created tokens', () => {
  const create = (body: Record<string, unknown>) =>
    t.app.inject({ method: 'POST', url: '/api/v1/tokens', headers: auth(admin), payload: { name: 'x', scopes: ['docs:read'], ...body } });

  it('default to 90 days when expires_at is omitted', async () => {
    const res = await create({});
    expect(res.statusCode).toBe(201);
    near(res.json().expires_at, Date.now() + 90 * DAY);
  });

  it('never expire only with an explicit null', async () => {
    const res = await create({ expires_at: null });
    expect(res.json().expires_at).toBeNull();
  });

  it('reject an expiry in the past', async () => {
    const res = await create({ expires_at: Date.now() - 1000 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation');
  });
});

describe('expired tokens', () => {
  it('get 401 token_expired, are audited, and do not trip the failure limiter', async () => {
    const { token } = createToken(t.db, { name: 'old', scopes: ['projects:read'], projectIds: null, expiresAt: Date.now() - 1 });
    for (let i = 0; i < 25; i++) {
      const res = await t.app.inject({ method: 'GET', url: '/api/v1/projects', headers: auth(token) });
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe('token_expired');
    }
    const valid = await t.app.inject({ method: 'GET', url: '/api/v1/projects', headers: auth(t.token(['projects:read'])) });
    expect(valid.statusCode).toBe(200);
    expect(listAudit(t.db, { action: 'auth.token_expired', limit: 5 }).length).toBeGreaterThan(0);
  });

  it('throttles: 3 uses of one expired token write exactly one auth.token_expired row, all 3 responses 401', async () => {
    const { token, row } = createToken(t.db, { name: 'old-throttled', scopes: ['projects:read'], projectIds: null, expiresAt: Date.now() - 1 });
    for (let i = 0; i < 3; i++) {
      const res = await t.app.inject({ method: 'GET', url: '/api/v1/projects', headers: auth(token) });
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe('token_expired');
    }
    const rows = listAudit(t.db, { action: 'auth.token_expired', limit: 1000 }).filter((r) => r.actor_id === row.id);
    expect(rows).toHaveLength(1);
  });

  it('keeps unknown tokens generic', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/projects', headers: auth('bk_nope_nope') });
    expect(res.json().error).toBe('unauthorized');
  });
});
