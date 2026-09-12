import { describe, it, expect } from 'vitest';
import { makeTestApp, auth } from './helpers.js';
import { createSecret } from '../src/repos/secrets.js';
import { listAudit } from '../src/repos/audit.js';

const doc = (body_md: string, extra: Record<string, unknown> = {}) => ({ title: 'Deploy', category: 'deploy', body_md, ...extra });

describe('documents routes', () => {
  it('creates (201) then updates (200) a project doc and reads it back', async () => {
    const t = await makeTestApp();
    t.project('alpha');
    const tok = auth(t.token(['docs:read', 'docs:write'], ['alpha']));
    const c = await t.app.inject({ method: 'PUT', url: '/api/v1/projects/alpha/docs/deploy', headers: tok, payload: doc('v1') });
    expect(c.statusCode).toBe(201);
    const u = await t.app.inject({ method: 'PUT', url: '/api/v1/projects/alpha/docs/deploy', headers: tok, payload: doc('v2') });
    expect(u.statusCode).toBe(200);
    const g = await t.app.inject({ method: 'GET', url: '/api/v1/projects/alpha/docs/deploy', headers: tok });
    expect(g.json()).toMatchObject({ slug: 'deploy', title: 'Deploy', category: 'deploy', body_md: 'v2' });
    const l = await t.app.inject({ method: 'GET', url: '/api/v1/projects/alpha/docs', headers: tok });
    expect(l.json()).toEqual([expect.objectContaining({ slug: 'deploy' })]);
    expect(listAudit(t.db, { action: 'doc.write' })).toHaveLength(2);
  });
  it('handles global docs and 404s', async () => {
    const t = await makeTestApp();
    const tok = auth(t.token(['docs:read', 'docs:write']));
    expect((await t.app.inject({ method: 'PUT', url: '/api/v1/docs/guidelines', headers: tok, payload: doc('g', { category: 'guidelines' }) })).statusCode).toBe(201);
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/docs/guidelines', headers: tok })).json().body_md).toBe('g');
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/docs/nope', headers: tok })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'DELETE', url: '/api/v1/docs/guidelines', headers: tok })).statusCode).toBe(204);
    expect((await t.app.inject({ method: 'DELETE', url: '/api/v1/docs/guidelines', headers: tok })).statusCode).toBe(404);
  });
  it('enforces scopes and project access', async () => {
    const t = await makeTestApp();
    t.project('alpha');
    t.project('beta');
    const ro = auth(t.token(['docs:read'], ['alpha']));
    expect((await t.app.inject({ method: 'PUT', url: '/api/v1/projects/alpha/docs/x', headers: ro, payload: doc('v') })).statusCode).toBe(403);
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/projects/beta/docs', headers: ro })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'PUT', url: '/api/v1/projects/alpha/docs/Bad', headers: auth(t.token(['docs:write'])), payload: doc('v') })).statusCode).toBe(400);
  });
  it('rejects secret-looking content with 422 unless forced, and audits the force', async () => {
    const t = await makeTestApp();
    t.project('alpha');
    const tok = auth(t.token(['docs:write'], ['alpha']));
    const r = await t.app.inject({ method: 'PUT', url: '/api/v1/projects/alpha/docs/x', headers: tok, payload: doc('password: Tr0ub4dor&3') });
    expect(r.statusCode).toBe(422);
    expect(r.json()).toMatchObject({ error: 'lint', findings: [{ line: 1, reason: 'credential assignment' }] });
    const f = await t.app.inject({ method: 'PUT', url: '/api/v1/projects/alpha/docs/x', headers: tok, payload: doc('password: Tr0ub4dor&3', { force: true }) });
    expect(f.statusCode).toBe(201);
    expect(listAudit(t.db, { action: 'doc.write' })[0]?.meta).toEqual({ lint_forced: true, unresolved_refs: 0 });
  });
  it('validates secret refs and returns ref meta on ?resolve=meta', async () => {
    const t = await makeTestApp();
    const p = t.project('alpha');
    t.project('beta');
    createSecret(t.db, t.ring, { projectId: p.id, name: 'Staging server', description: '', tags: [], fields: [{ key: 'host', value: 'h' }, { key: 'password', value: 'p' }] });
    createSecret(t.db, t.ring, { projectId: null, name: 'GitHub PAT', description: '', tags: [], fields: [{ key: 'token', value: 't' }] });
    const tok = auth(t.token(['docs:read', 'docs:write', 'secrets:meta'], ['alpha']));
    const bad = await t.app.inject({ method: 'PUT', url: '/api/v1/projects/alpha/docs/x', headers: tok, payload: doc('{{secret:Nope}} {{secret:beta/X}}') });
    expect(bad.statusCode).toBe(422);
    expect(bad.json()).toEqual({ error: 'unresolved_refs', message: 'unresolved_refs', unresolved: ['{{secret:Nope}}', '{{secret:beta/X}}'] });
    const ok = await t.app.inject({ method: 'PUT', url: '/api/v1/projects/alpha/docs/x', headers: tok, payload: doc('ssh via {{secret:Staging server}}, push with {{secret:global/GitHub PAT}}') });
    expect(ok.statusCode).toBe(201);
    const g = await t.app.inject({ method: 'GET', url: '/api/v1/projects/alpha/docs/x?resolve=meta', headers: tok });
    expect(g.json().refs).toEqual([
      { ref: '{{secret:Staging server}}', name: 'Staging server', project: 'alpha', fields: [{ key: 'host', sensitive: false }, { key: 'password', sensitive: true }] },
      { ref: '{{secret:global/GitHub PAT}}', name: 'GitHub PAT', project: null, fields: [{ key: 'token', sensitive: true }] },
    ]);
    expect(JSON.stringify(g.json())).not.toContain('"h"');
  });
});

describe('search route', () => {
  it('searches per scope and never matches secret values', async () => {
    const t = await makeTestApp();
    const p = t.project('alpha');
    t.project('beta');
    await t.app.inject({ method: 'PUT', url: '/api/v1/projects/alpha/docs/d', headers: auth(t.token(['docs:write'])), payload: doc('deploy with caddy') });
    createSecret(t.db, t.ring, { projectId: p.id, name: 'Caddy admin', description: '', tags: ['web'], fields: [{ key: 'password', value: 'caddy-secret-value' }] });
    const full = await t.app.inject({ method: 'GET', url: '/api/v1/search?q=caddy', headers: auth(t.token(['projects:read', 'docs:read', 'secrets:meta'], ['alpha'])) });
    expect(full.json()).toEqual({
      projects: [],
      documents: [{ project: 'alpha', slug: 'd', title: 'Deploy', category: 'deploy', snippet: expect.stringContaining('caddy') }],
      secrets: [{ project: 'alpha', name: 'Caddy admin', tags: ['web'] }],
    });
    const none = await t.app.inject({ method: 'GET', url: '/api/v1/search?q=caddy-secret-value', headers: auth(t.token(['admin'])) });
    expect(none.json().secrets).toEqual([]);
    const docsOnly = await t.app.inject({ method: 'GET', url: '/api/v1/search?q=caddy', headers: auth(t.token(['docs:read'])) });
    expect(Object.keys(docsOnly.json())).toEqual(['documents']);
    const byName = await t.app.inject({ method: 'GET', url: '/api/v1/search?q=alp', headers: auth(t.token(['projects:read'])) });
    expect(byName.json().projects.map((x: { slug: string }) => x.slug)).toEqual(['alpha']);
  });
});
