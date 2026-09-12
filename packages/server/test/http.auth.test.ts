import { describe, it, expect } from 'vitest';
import { makeTestApp, auth } from './helpers.js';
import { listAudit } from '../src/repos/audit.js';
import { FailureLimiter } from '../src/http/auth.js';

describe('http auth', () => {
  it('serves /health without auth', async () => {
    const t = await makeTestApp();
    const r = await t.app.inject({ method: 'GET', url: '/health' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true });
  });
  it('returns 401 for missing, malformed, unknown tokens and audits failures', async () => {
    const t = await makeTestApp();
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/me' })).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/me', headers: { authorization: 'Basic x' } })).statusCode).toBe(401);
    const bad = await t.app.inject({ method: 'GET', url: '/api/v1/me', headers: auth('pidb_AAAAAAAA_' + 'B'.repeat(43)) });
    expect(bad.statusCode).toBe(401);
    expect(bad.json()).toEqual({ error: 'unauthorized', message: 'unauthorized' });
    const audit = listAudit(t.db, { action: 'auth.token_failed' });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.meta).toEqual({ prefix: 'AAAAAAAA' });
  });
  it('returns principal info on /me and touches last_used_at', async () => {
    const t = await makeTestApp();
    t.project('alpha');
    const tok = t.token(['docs:read'], ['alpha']);
    const r = await t.app.inject({ method: 'GET', url: '/api/v1/me', headers: auth(tok) });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ kind: 'token', scopes: ['docs:read'], projects: ['alpha'] });
    const row = t.db.prepare(`SELECT last_used_at FROM api_tokens`).get() as { last_used_at: number | null };
    expect(row.last_used_at).not.toBeNull();
  });
  it('rate limits repeated auth failures per IP', async () => {
    const t = await makeTestApp();
    let last = 0;
    for (let i = 0; i < 21; i++) {
      last = (await t.app.inject({ method: 'GET', url: '/api/v1/me', headers: auth('pidb_AAAAAAAA_' + 'B'.repeat(43)) })).statusCode;
    }
    expect(last).toBe(429);
  });
  it('returns JSON 404 for unknown routes when authenticated', async () => {
    const t = await makeTestApp();
    const r = await t.app.inject({ method: 'GET', url: '/api/v1/nope', headers: auth(t.token(['admin'])) });
    expect(r.statusCode).toBe(404);
    expect(r.json()).toEqual({ error: 'not_found' });
  });
});

describe('FailureLimiter', () => {
  it('evicts idle IPs once their window elapses', () => {
    const l = new FailureLimiter(2, 1000);
    l.record('a', 0);
    l.record('a', 0);
    expect(l.isBlocked('a', 0)).toBe(true);
    expect(l.size).toBe(1);
    expect(l.isBlocked('a', 2000)).toBe(false);
    expect(l.size).toBe(0);
  });
});
