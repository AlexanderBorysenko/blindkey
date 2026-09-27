import { describe, it, expect } from 'vitest';
import { makeTestApp, auth } from './helpers.js';
import { listAudit } from '../src/repos/audit.js';
import { FailureLimiter, ExpiredTokenThrottle } from '../src/http/auth.js';

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
  it('audits the request user_agent header on a token failure', async () => {
    const t = await makeTestApp();
    await t.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { ...auth('pidb_AAAAAAAA_' + 'B'.repeat(43)), 'user-agent': 'test-agent/1.0' },
    });
    const audit = listAudit(t.db, { action: 'auth.token_failed' });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.user_agent).toBe('test-agent/1.0');
  });
  it('ignores X-Forwarded-For when trustProxy is not enabled', async () => {
    const t = await makeTestApp();
    await t.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { ...auth('pidb_AAAAAAAA_' + 'B'.repeat(43)), 'x-forwarded-for': '9.9.9.9' },
      remoteAddress: '10.0.0.5',
    });
    const audit = listAudit(t.db, { action: 'auth.token_failed' });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.ip).toBe('10.0.0.5');
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

describe('ExpiredTokenThrottle', () => {
  it('allows one write per token per hour, then another once the window elapses', () => {
    const th = new ExpiredTokenThrottle();
    expect(th.shouldAudit(1, 0)).toBe(true);
    expect(th.shouldAudit(1, 1_000)).toBe(false);
    expect(th.shouldAudit(1, 59 * 60_000)).toBe(false);
    expect(th.shouldAudit(1, 60 * 60_000)).toBe(true);
  });
  it('tracks each token id independently', () => {
    const th = new ExpiredTokenThrottle();
    expect(th.shouldAudit(1, 0)).toBe(true);
    expect(th.shouldAudit(2, 0)).toBe(true);
    expect(th.shouldAudit(1, 0)).toBe(false);
    expect(th.shouldAudit(2, 0)).toBe(false);
  });
  it('prunes entries older than the window once the map grows past 1000', () => {
    const th = new ExpiredTokenThrottle();
    for (let i = 0; i < 1001; i++) th.shouldAudit(i, 0);
    expect(th.size).toBe(1001);
    // The next call sees size > 1000 and sweeps every entry whose window has elapsed
    // before recording its own — only the fresh entry survives.
    th.shouldAudit(5000, 2 * 60 * 60_000);
    expect(th.size).toBe(1);
  });
});
