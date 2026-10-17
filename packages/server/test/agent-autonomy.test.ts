import { describe, it, expect } from 'vitest';
import { makeTestApp, auth, type TestCtx } from './helpers.js';
import { createAdmin } from '../src/repos/admin.js';
import { hashPassword } from '../src/crypto/passwords.js';
import { listTokens } from '../src/repos/tokens.js';
import { listAudit } from '../src/repos/audit.js';

const main = (html: string) => html.split('<main')[1]?.split('</main>')[0] ?? html;

async function adminSession(t: TestCtx) {
  createAdmin(t.db, 'alex', await hashPassword('pw'));
  const login = await t.app.inject({ method: 'POST', url: '/login', payload: { username: 'alex', password: 'pw' } });
  const session = login.cookies.find((c) => c.name === 'blindkey_session')!.value;
  const page = await t.app.inject({ method: 'GET', url: '/', cookies: { blindkey_session: session } });
  const csrf = /name="csrf" value="([^"]+)"/.exec(page.body)![1]!;
  const get = (url: string) => t.app.inject({ method: 'GET', url, cookies: { blindkey_session: session } });
  const post = (url: string, payload: Record<string, unknown>) =>
    t.app.inject({ method: 'POST', url, cookies: { blindkey_session: session }, payload: { csrf, ...payload } });
  return { get, post };
}

async function startConnect(t: TestCtx, name = 'claude') {
  const res = await t.app.inject({ method: 'POST', url: '/api/v1/connect/start', payload: { name, scopes: ['projects:read'] } });
  return res.json() as { user_code: string; device_code: string };
}

describe('agents can create projects (projects:create)', () => {
  it('a project-scoped token with projects:create creates a project and can use it at once', async () => {
    const t = await makeTestApp();
    t.project('alpha');
    const tok = t.token(['projects:read', 'projects:create', 'docs:write'], ['alpha'], 'agent');
    const r = await t.app.inject({ method: 'POST', url: '/api/v1/projects', headers: auth(tok), payload: { slug: 'fresh', name: 'Fresh' } });
    expect(r.statusCode).toBe(201);
    const list = await t.app.inject({ method: 'GET', url: '/api/v1/projects', headers: auth(tok) });
    expect(list.json().map((p: { slug: string }) => p.slug).sort()).toEqual(['alpha', 'fresh']);
    const doc = await t.app.inject({
      method: 'PUT',
      url: '/api/v1/projects/fresh/docs/context',
      headers: auth(tok),
      payload: { title: 'Ctx', category: 'context', body_md: 'hello' },
    });
    expect(doc.statusCode).toBe(201);
    const audit = listAudit(t.db, { limit: 10 }).find((a) => a.action === 'project.create')!;
    expect(audit.meta).toMatchObject({ slug: 'fresh', granted_to_token: listTokens(t.db)[0]!.id });
  });

  it('deleting a project scrubs its id from tokens, so a later project reusing the id is not inherited', async () => {
    const t = await makeTestApp();
    t.project('alpha');
    const doomed = t.project('doomed');
    const old = t.token(['projects:read'], ['alpha', 'doomed']);
    const admin = t.token(['admin']);
    expect((await t.app.inject({ method: 'DELETE', url: '/api/v1/projects/doomed', headers: auth(admin) })).statusCode).toBe(204);
    const creator = t.token(['projects:read', 'projects:create'], [], 'agent');
    const r = await t.app.inject({ method: 'POST', url: '/api/v1/projects', headers: auth(creator), payload: { slug: 'newcomer', name: 'N' } });
    expect(r.statusCode).toBe(201);
    // SQLite reuses the freed rowid for the next project.
    expect(listTokens(t.db).find((x) => x.name === 'test' && x.scopes.includes('projects:create'))!.project_ids).toEqual([doomed.id]);
    const seen = await t.app.inject({ method: 'GET', url: '/api/v1/projects', headers: auth(old) });
    expect(seen.json().map((p: { slug: string }) => p.slug)).toEqual(['alpha']);
  });

  it('a token with no projects at all gets exactly the one it creates', async () => {
    const t = await makeTestApp();
    t.project('other');
    const tok = t.token(['projects:read', 'projects:create'], [], 'agent');
    await t.app.inject({ method: 'POST', url: '/api/v1/projects', headers: auth(tok), payload: { slug: 'mine', name: 'Mine' } });
    const list = await t.app.inject({ method: 'GET', url: '/api/v1/projects', headers: auth(tok) });
    expect(list.json().map((p: { slug: string }) => p.slug)).toEqual(['mine']);
  });

  it('without projects:create (or admin) creation is refused with the scope named', async () => {
    const t = await makeTestApp();
    const r = await t.app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: auth(t.token(['projects:read', 'projects:write'])),
      payload: { slug: 'x', name: 'X' },
    });
    expect(r.statusCode).toBe(403);
    expect(r.json()).toMatchObject({ error: 'missing_scope', scope: 'projects:create' });
  });

  it('an all-projects token keeps project_ids null after creating', async () => {
    const t = await makeTestApp();
    const tok = t.token(['projects:create'], null);
    await t.app.inject({ method: 'POST', url: '/api/v1/projects', headers: auth(tok), payload: { slug: 'y', name: 'Y' } });
    expect(listTokens(t.db)[0]!.project_ids).toBeNull();
  });
});

describe('meta-write may declare fields non-sensitive, but never credential-looking ones', () => {
  it('stores sensitive:false fields with visible values', async () => {
    const t = await makeTestApp();
    t.project('alpha');
    const tok = t.token(['secrets:meta', 'secrets:meta-write'], ['alpha'], 'agent');
    const r = await t.app.inject({
      method: 'POST',
      url: '/api/v1/projects/alpha/secrets',
      headers: auth(tok),
      payload: { name: 'Site', fields: [{ key: 'web_root', value: '/home/x', sensitive: false }, { key: 'host', value: 'h' }] },
    });
    expect(r.statusCode).toBe(201);
    expect(r.json().fields).toEqual([
      { key: 'web_root', sensitive: false, value: '/home/x' },
      { key: 'host', sensitive: false, value: 'h' },
    ]);
  });

  it.each(['db_password', 'api_token', 'ssh_private', 'wp_salt', 'AUTH_KEY', 'pw', 'jwt', 'dsn', 'bearer', 'apiToken', 'passphrase'])('refuses %s as sensitive:false (create and patch)', async (key) => {
    const t = await makeTestApp();
    t.project('alpha');
    const tok = t.token(['secrets:meta', 'secrets:meta-write'], ['alpha'], 'agent');
    const create = await t.app.inject({
      method: 'POST',
      url: '/api/v1/projects/alpha/secrets',
      headers: auth(tok),
      payload: { name: 'S', fields: [{ key, value: 'v', sensitive: false }] },
    });
    expect(create.statusCode).toBe(403);
    await t.app.inject({ method: 'POST', url: '/api/v1/projects/alpha/secrets', headers: auth(tok), payload: { name: 'S', fields: [{ key: 'host', value: 'h' }] } });
    const patch = await t.app.inject({
      method: 'PATCH',
      url: '/api/v1/projects/alpha/secrets/S',
      headers: auth(tok),
      payload: { fields: [{ key, value: 'v', sensitive: false }] },
    });
    expect(patch.statusCode).toBe(403);
  });
});

describe('meta-write guard edge cases', () => {
  it('allows ordinary words that merely contain a credential word (author, mapping, monkey)', async () => {
    const t = await makeTestApp();
    t.project('alpha');
    const tok = t.token(['secrets:meta', 'secrets:meta-write'], ['alpha'], 'agent');
    const r = await t.app.inject({
      method: 'POST',
      url: '/api/v1/projects/alpha/secrets',
      headers: auth(tok),
      payload: { name: 'S', fields: ['author', 'mapping', 'monkey'].map((key) => ({ key, value: 'v', sensitive: false })) },
    });
    expect(r.statusCode).toBe(201);
  });

  it('refuses a URL with an embedded password in a visible field, even under a default-visible key', async () => {
    const t = await makeTestApp();
    t.project('alpha');
    const tok = t.token(['secrets:meta', 'secrets:meta-write'], ['alpha'], 'agent');
    for (const field of [{ key: 'url', value: 'postgres://app:hunter2@db/x' }, { key: 'database_url', value: 'mysql://u:p@h/d', sensitive: false }]) {
      const r = await t.app.inject({ method: 'POST', url: '/api/v1/projects/alpha/secrets', headers: auth(tok), payload: { name: 'S', fields: [field] } });
      expect(r.statusCode).toBe(403);
      expect(r.json().message).toMatch(/URL with a password/);
    }
    const ok = await t.app.inject({
      method: 'POST',
      url: '/api/v1/projects/alpha/secrets',
      headers: auth(tok),
      payload: { name: 'S', fields: [{ key: 'url', value: 'https://site.example/path' }] },
    });
    expect(ok.statusCode).toBe(201);
  });

  it('cannot flip an existing sensitive field to sensitive:false', async () => {
    const t = await makeTestApp();
    t.project('alpha');
    const writer = t.token(['secrets:write'], ['alpha']);
    await t.app.inject({ method: 'POST', url: '/api/v1/projects/alpha/secrets', headers: auth(writer), payload: { name: 'S', fields: [{ key: 'notes', value: 'real secret' }] } });
    const tok = t.token(['secrets:meta', 'secrets:meta-write'], ['alpha'], 'agent');
    const r = await t.app.inject({
      method: 'PATCH',
      url: '/api/v1/projects/alpha/secrets/S',
      headers: auth(tok),
      payload: { fields: [{ key: 'notes', value: 'x', sensitive: false }] },
    });
    expect(r.statusCode).toBe(403);
  });
});

describe('connect approval without projects', () => {
  it('without projects:create the page names the real problem instead of "validation failed"', async () => {
    const t = await makeTestApp();
    const { post } = await adminSession(t);
    const { user_code } = await startConnect(t);
    const res = await post('/connect/approve', { code: user_code, scopes: ['projects:read'], projects: [], expires_days: '90' });
    expect(res.statusCode).toBe(400);
    expect(main(res.body)).toContain('pick at least one project, or grant projects:create');
    expect(main(res.body)).not.toContain('validation failed');
  });

  it('with projects:create it is approved and the minted token has an empty project list', async () => {
    const t = await makeTestApp();
    const { post } = await adminSession(t);
    const { user_code, device_code } = await startConnect(t);
    const res = await post('/connect/approve', { code: user_code, scopes: ['projects:read', 'projects:create'], projects: [], expires_days: '90' });
    expect(res.statusCode).toBe(302);
    const poll = await t.app.inject({ method: 'POST', url: '/api/v1/connect/poll', payload: { device_code } });
    expect(poll.statusCode).toBe(200);
    const row = listTokens(t.db).find((x) => x.kind === 'agent')!;
    expect(row.project_ids).toEqual([]);
    expect(row.scopes).toContain('projects:create');
  });
});

describe('tokens page', () => {
  it('shows an approved-but-unclaimed agent token with auto-refresh until the agent polls', async () => {
    const t = await makeTestApp();
    t.project('alpha');
    const { get, post } = await adminSession(t);
    const { user_code, device_code } = await startConnect(t, 'claude-prod@mac');
    await post('/connect/approve', { code: user_code, scopes: ['projects:read'], projects: ['alpha'], expires_days: '90' });
    const before = main((await get('/tokens?done=approved')).body);
    expect(before).toContain('waiting for the agent');
    expect(before).toContain('claude-prod@mac');
    expect(before).toContain('data-auto-refresh');
    await t.app.inject({ method: 'POST', url: '/api/v1/connect/poll', payload: { device_code } });
    const after = main((await get('/tokens')).body);
    expect(after).not.toContain('waiting for the agent');
    expect(after).toContain('claude-prod@mac');
  });

  it('does not auto-refresh away a freshly created token shown once', async () => {
    const t = await makeTestApp();
    t.project('alpha');
    const { post } = await adminSession(t);
    const { user_code } = await startConnect(t, 'waiting-agent');
    await post('/connect/approve', { code: user_code, scopes: ['projects:read'], projects: ['alpha'], expires_days: '90' });
    const created = main((await post('/tokens', { name: 'manual', scopes: ['projects:read'], projects: '', days: '90' })).body);
    expect(created).toContain('shown once');
    expect(created).toContain('waiting-agent');
    expect(created).not.toContain('data-auto-refresh');
  });

  it('edits which projects a token can reach, including back to all projects', async () => {
    const t = await makeTestApp();
    t.project('alpha');
    t.project('beta');
    const { get, post } = await adminSession(t);
    t.token(['projects:read'], ['alpha']);
    const id = listTokens(t.db)[0]!.id;
    expect(main((await get('/tokens')).body)).toContain(`action="/tokens/${id}/projects"`);

    const r1 = await post(`/tokens/${id}/projects`, { projects: ['alpha', 'beta'] });
    expect(r1.statusCode).toBe(302);
    expect(listTokens(t.db)[0]!.project_ids).toHaveLength(2);

    await post(`/tokens/${id}/projects`, { all: 'on', projects: ['alpha'] });
    expect(listTokens(t.db)[0]!.project_ids).toBeNull();

    await post(`/tokens/${id}/projects`, {});
    expect(listTokens(t.db)[0]!.project_ids).toEqual([]);

    const bad = await post(`/tokens/${id}/projects`, { projects: ['nope'] });
    expect(bad.statusCode).toBe(400);
    expect(main(bad.body)).toContain('unknown project');
    expect(listAudit(t.db, { limit: 20 }).filter((a) => a.action === 'token.update_projects')).toHaveLength(3);
  });

  it('refuses to edit a revoked token', async () => {
    const t = await makeTestApp();
    t.project('alpha');
    const { post } = await adminSession(t);
    t.token(['projects:read'], ['alpha']);
    const id = listTokens(t.db)[0]!.id;
    await post(`/tokens/${id}/revoke`, {});
    const r = await post(`/tokens/${id}/projects`, { projects: ['alpha'] });
    expect(r.statusCode).toBe(404);
  });

  it('a label given at approval is used, and a reconnect of the same session keeps the latest label', async () => {
    const t = await makeTestApp();
    t.project('alpha');
    const { post } = await adminSession(t);
    const first = await startConnect(t, 'claude-prod@box');
    await post('/connect/approve', { code: first.user_code, scopes: ['projects:read'], projects: ['alpha'], expires_days: '90', label: 'Home PC' });
    await t.app.inject({ method: 'POST', url: '/api/v1/connect/poll', payload: { device_code: first.device_code } });
    expect(listTokens(t.db).find((x) => x.revoked_at === null)!.label).toBe('Home PC');
    const again = await startConnect(t, 'claude-prod@box');
    await post('/connect/approve', { code: again.user_code, scopes: ['projects:read'], projects: ['alpha'], expires_days: '90' });
    await t.app.inject({ method: 'POST', url: '/api/v1/connect/poll', payload: { device_code: again.device_code } });
    const live = listTokens(t.db).filter((x) => x.revoked_at === null);
    expect(live).toHaveLength(1);
    expect(live[0]!.label).toBe('Home PC');
  });
});
