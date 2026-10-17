import { describe, it, expect } from 'vitest';
import { makeTestApp, auth } from './helpers.js';
import { createSecret } from '../src/repos/secrets.js';
import { upsertDocument } from '../src/repos/documents.js';
import { listAudit } from '../src/repos/audit.js';

describe('projects routes', () => {
  it('lists only accessible projects', async () => {
    const t = await makeTestApp();
    t.project('alpha');
    t.project('beta');
    const r = await t.app.inject({ method: 'GET', url: '/api/v1/projects', headers: auth(t.token(['projects:read'], ['alpha'])) });
    expect(r.statusCode).toBe(200);
    expect(r.json().map((p: { slug: string }) => p.slug)).toEqual(['alpha']);
    expect(r.json()[0]).not.toHaveProperty('id');
    const all = await t.app.inject({ method: 'GET', url: '/api/v1/projects', headers: auth(t.token(['projects:read'])) });
    expect(all.json()).toHaveLength(2);
  });
  it('requires projects:read', async () => {
    const t = await makeTestApp();
    const r = await t.app.inject({ method: 'GET', url: '/api/v1/projects', headers: auth(t.token(['docs:read'])) });
    expect(r.statusCode).toBe(403);
    expect(r.json()).toMatchObject({ error: 'missing_scope', scope: 'projects:read' });
  });
  it('returns 404 for unknown and out-of-scope projects alike', async () => {
    const t = await makeTestApp();
    t.project('alpha');
    t.project('beta');
    const tok = t.token(['projects:read'], ['alpha']);
    const a = await t.app.inject({ method: 'GET', url: '/api/v1/projects/beta', headers: auth(tok) });
    const b = await t.app.inject({ method: 'GET', url: '/api/v1/projects/zzz', headers: auth(tok) });
    expect(a.statusCode).toBe(404);
    expect(b.statusCode).toBe(404);
    expect(a.json()).toEqual(b.json());
  });
  it('returns detail with docs and secret meta depending on scopes', async () => {
    const t = await makeTestApp();
    const p = t.project('alpha');
    upsertDocument(t.db, { projectId: p.id, slug: 'context', title: 'Ctx', category: 'context', body_md: 'hello' });
    createSecret(t.db, t.ring, { projectId: p.id, name: 'Staging', description: '', tags: [], fields: [{ key: 'host', value: 'h' }, { key: 'password', value: 'p' }] });
    const full = await t.app.inject({ method: 'GET', url: '/api/v1/projects/alpha', headers: auth(t.token(['projects:read', 'docs:read', 'secrets:meta'])) });
    const body = full.json();
    expect(body.documents).toEqual([expect.objectContaining({ slug: 'context', title: 'Ctx' })]);
    expect(body.documents[0]).not.toHaveProperty('body_md');
    expect(body.secrets[0].fields).toEqual([{ key: 'host', sensitive: false, value: 'h' }, { key: 'password', sensitive: true }]);
    expect(JSON.stringify(body)).not.toContain('"p"');
    const minimal = await t.app.inject({ method: 'GET', url: '/api/v1/projects/alpha', headers: auth(t.token(['projects:read'])) });
    expect(minimal.json().documents).toEqual([]);
    expect(minimal.json().secrets).toEqual([]);
  });
  it('creates, updates, deletes with admin scope and audits', async () => {
    const t = await makeTestApp();
    const admin = auth(t.token(['admin']));
    const c = await t.app.inject({ method: 'POST', url: '/api/v1/projects', headers: admin, payload: { slug: 'gamma', name: 'Gamma', tags: ['x'] } });
    expect(c.statusCode).toBe(201);
    expect(c.json()).toMatchObject({ slug: 'gamma', status: 'active', tags: ['x'] });
    const dup = await t.app.inject({ method: 'POST', url: '/api/v1/projects', headers: admin, payload: { slug: 'gamma', name: 'Gamma' } });
    expect(dup.statusCode).toBe(409);
    const bad = await t.app.inject({ method: 'POST', url: '/api/v1/projects', headers: admin, payload: { slug: 'Bad Slug', name: 'x' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('validation');
    const u = await t.app.inject({ method: 'PATCH', url: '/api/v1/projects/gamma', headers: admin, payload: { status: 'paused' } });
    expect(u.json().status).toBe('paused');
    const d = await t.app.inject({ method: 'DELETE', url: '/api/v1/projects/gamma', headers: admin });
    expect(d.statusCode).toBe(204);
    expect(listAudit(t.db, {}).map((a) => a.action)).toEqual(['project.delete', 'project.update', 'project.create']);
    const noAdmin = await t.app.inject({ method: 'POST', url: '/api/v1/projects', headers: auth(t.token(['secrets:write'])), payload: { slug: 'z', name: 'z' } });
    expect(noAdmin.statusCode).toBe(403);
  });
  it('projects:write patches summary/tags/status/name of an accessible project but not the slug, another project, or create/delete', async () => {
    const t = await makeTestApp();
    t.project('alpha');
    t.project('beta');
    const w = auth(t.token(['projects:write'], ['alpha']));
    const patched = await t.app.inject({
      method: 'PATCH',
      url: '/api/v1/projects/alpha',
      headers: w,
      payload: { name: 'Alpha renamed', status: 'paused', tags: ['x'], summary: 'new summary' },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ name: 'Alpha renamed', status: 'paused', tags: ['x'], summary: 'new summary' });

    const slugPatch = await t.app.inject({ method: 'PATCH', url: '/api/v1/projects/alpha', headers: w, payload: { slug: 'alpha2' } });
    expect(slugPatch.statusCode).toBe(403);
    expect(slugPatch.json().scope).toBe('admin');

    const otherProject = await t.app.inject({ method: 'PATCH', url: '/api/v1/projects/beta', headers: w, payload: { name: 'nope' } });
    expect(otherProject.statusCode).toBe(404);

    const createAttempt = await t.app.inject({ method: 'POST', url: '/api/v1/projects', headers: w, payload: { slug: 'gamma', name: 'Gamma' } });
    expect(createAttempt.statusCode).toBe(403);

    const deleteAttempt = await t.app.inject({ method: 'DELETE', url: '/api/v1/projects/alpha', headers: w });
    expect(deleteAttempt.statusCode).toBe(403);
  });
  it('rejects a PATCH without projects:write or admin', async () => {
    const t = await makeTestApp();
    t.project('alpha');
    const r = await t.app.inject({ method: 'PATCH', url: '/api/v1/projects/alpha', headers: auth(t.token(['projects:read'], ['alpha'])), payload: { name: 'x' } });
    expect(r.statusCode).toBe(403);
    expect(r.json().scope).toBe('projects:write');
  });
});
