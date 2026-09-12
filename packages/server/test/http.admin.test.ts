import { describe, it, expect } from 'vitest';
import { makeTestApp, auth } from './helpers.js';
import { createAdmin } from '../src/repos/admin.js';
import { hashPassword } from '../src/crypto/passwords.js';
import { listAudit } from '../src/repos/audit.js';

describe('admin routes', () => {
  it('creates, lists, revokes tokens (admin only) with project slugs', async () => {
    const t = await makeTestApp();
    t.project('alpha');
    const admin = auth(t.token(['admin']));
    const c = await t.app.inject({ method: 'POST', url: '/api/v1/tokens', headers: admin, payload: { name: 'cc', scopes: ['docs:read', 'secrets:reveal'], projects: ['alpha'] } });
    expect(c.statusCode).toBe(201);
    expect(c.json().token).toMatch(/^pidb_/);
    expect(c.json().projects).toEqual(['alpha']);
    const bad = await t.app.inject({ method: 'POST', url: '/api/v1/tokens', headers: admin, payload: { name: 'cc', scopes: ['docs:read'], projects: ['nope'] } });
    expect(bad.statusCode).toBe(400);
    const l = await t.app.inject({ method: 'GET', url: '/api/v1/tokens', headers: admin });
    expect(l.json().map((x: { name: string }) => x.name)).toEqual(['test', 'cc']);
    expect(JSON.stringify(l.json())).not.toContain('pidb_');
    const useNew = await t.app.inject({ method: 'GET', url: '/api/v1/projects/alpha/docs', headers: auth(c.json().token) });
    expect(useNew.statusCode).toBe(200);
    const d = await t.app.inject({ method: 'DELETE', url: `/api/v1/tokens/${c.json().id}`, headers: admin });
    expect(d.statusCode).toBe(204);
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/projects/alpha/docs', headers: auth(c.json().token) })).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'DELETE', url: `/api/v1/tokens/${c.json().id}`, headers: admin })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/tokens', headers: auth(t.token(['secrets:reveal'])) })).statusCode).toBe(403);
  });
  it('lists audit with filters', async () => {
    const t = await makeTestApp();
    const admin = auth(t.token(['admin']));
    await t.app.inject({ method: 'POST', url: '/api/v1/projects', headers: admin, payload: { slug: 'a', name: 'A' } });
    const r = await t.app.inject({ method: 'GET', url: '/api/v1/audit?action=project.create&limit=5', headers: admin });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual([expect.objectContaining({ action: 'project.create', actor_type: 'token' })]);
  });
  it('exchanges admin password for an admin token', async () => {
    const t = await makeTestApp();
    createAdmin(t.db, 'alex', await hashPassword('correct horse'));
    const bad = await t.app.inject({ method: 'POST', url: '/api/v1/auth/token', payload: { username: 'alex', password: 'wrong' } });
    expect(bad.statusCode).toBe(401);
    const ok = await t.app.inject({ method: 'POST', url: '/api/v1/auth/token', payload: { username: 'alex', password: 'correct horse', name: 'cli-mac' } });
    expect(ok.statusCode).toBe(201);
    const me = await t.app.inject({ method: 'GET', url: '/api/v1/me', headers: auth(ok.json().token) });
    expect(me.json()).toEqual({ kind: 'token', scopes: ['admin'], projects: null });
    expect(listAudit(t.db, {}).map((a) => a.action)).toEqual(['auth.login', 'auth.login_failed']);
    expect(listAudit(t.db, { action: 'auth.login' })[0]?.actor_type).toBe('admin');
  });
});
