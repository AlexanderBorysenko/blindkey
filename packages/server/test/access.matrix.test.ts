import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { auth } from './helpers.js';
import { jsonAs, makeShared, type Shared } from './access.fixture.js';
import { addOwner, createWorkspace } from '../src/repos/workspaces.js';
import { deleteGrant, upsertGrant } from '../src/repos/grants.js';
import { setUserDisabled } from '../src/repos/admin.js';
import { listAudit } from '../src/repos/audit.js';
import { getDocument } from '../src/repos/documents.js';
import { createSecret, getSecretMeta } from '../src/repos/secrets.js';
import { getProjectBySlug } from '../src/repos/projects.js';

let t: Shared;
afterEach(async () => {
  await t?.app.close();
});

interface Proj { slug: string; workspace: string }
interface Sec { name: string; fields: { key: string; sensitive: boolean; value?: string }[] }
interface Doc { slug: string }
interface Ws { slug: string; name: string; role: string }

const names = (r: { json: unknown }): string[] => jsonAs<{ name: string }[]>(r).map((x) => x.name);
const slugs = (r: { json: unknown }): string[] => jsonAs<{ slug: string }[]>(r).map((x) => x.slug);

describe('access matrix over REST', () => {
  it('bob (project grant *): sees only alpha, with values, and can work inside it', async () => {
    t = await makeShared();
    const projects = await t.call(t.bob, 'GET', '/api/v1/projects');
    expect(jsonAs<Proj[]>(projects).map((p) => [p.slug, p.workspace])).toEqual([['alpha', 'default']]);
    expect(jsonAs<Ws[]>(await t.call(t.bob, 'GET', '/api/v1/workspaces'))).toEqual([{ slug: 'default', name: 'Default', role: 'member' }]);
    const secrets = await t.call(t.bob, 'GET', '/api/v1/projects/alpha/secrets');
    expect(jsonAs<Sec[]>(secrets)[0]!.fields).toEqual([{ key: 'host', sensitive: false, value: '10.0.0.1' }, { key: 'password', sensitive: true }]);
    expect(slugs(await t.call(t.bob, 'GET', '/api/v1/projects/alpha/docs'))).toEqual(['notes']);
    expect((await t.call(t.bob, 'GET', '/api/v1/projects/alpha/secrets/ADB/fields/password')).status).toBe(200);
    expect((await t.call(t.bob, 'POST', '/api/v1/projects/alpha/secrets/ADB/use', { purpose: 'exec' })).status).toBe(200);
    // search sees alpha things only
    const search = jsonAs<{ projects: Proj[]; secrets: { name: string }[] }>(await t.call(t.bob, 'GET', '/api/v1/search?q=DB'));
    expect(search.secrets.map((s) => s.name)).toEqual(['ADB']);
    expect((await t.call(t.bob, 'GET', '/api/v1/search?q=beta')).json).toEqual({ projects: [], documents: [], secrets: [] });
    // write inside the project
    const created = await t.call(t.bob, 'POST', '/api/v1/projects/alpha/secrets', { name: 'NEW', fields: [{ key: 'password', value: 'x1' }] });
    expect(created.status).toBe(201);
    expect((await t.call(t.bob, 'PATCH', '/api/v1/projects/alpha/secrets/NEW', { description: 'd' })).status).toBe(200);
    expect((await t.call(t.bob, 'DELETE', '/api/v1/projects/alpha/secrets/NEW')).status).toBe(204);
    expect((await t.call(t.bob, 'PUT', '/api/v1/projects/alpha/docs/more', { title: 'More', category: 'notes', body_md: 'hi' })).status).toBe(201);
    expect((await t.call(t.bob, 'PATCH', '/api/v1/projects/alpha', { summary: 'new summary' })).status).toBe(200);
    // owner-only things
    expect((await t.call(t.bob, 'PATCH', '/api/v1/projects/alpha', { slug: 'alpha2' })).status).toBe(403);
    expect((await t.call(t.bob, 'DELETE', '/api/v1/projects/alpha')).status).toBe(403);
    expect((await t.call(t.bob, 'POST', '/api/v1/projects', { workspace: 'default', slug: 'mine', name: 'Mine' })).status).toBe(403);
    // globals: visible workspace resolves to default, but nothing global is visible and nothing can be created
    expect(jsonAs<Sec[]>(await t.call(t.bob, 'GET', '/api/v1/secrets'))).toEqual([]);
    expect((await t.call(t.bob, 'GET', '/api/v1/secrets/GLOBAL_S')).status).toBe(404);
    expect((await t.call(t.bob, 'POST', '/api/v1/secrets', { name: 'G2', fields: [{ key: 'host', value: 'h' }] })).status).toBe(403);
    expect((await t.call(t.bob, 'PUT', '/api/v1/docs/g2', { title: 'G2', category: 'notes', body_md: 'x' })).status).toBe(403);
  });

  it('other projects are 404, never 403, and look exactly like missing ones', async () => {
    t = await makeShared();
    for (const url of ['/api/v1/projects/beta', '/api/v1/projects/beta/secrets', '/api/v1/projects/beta/secrets/DB', '/api/v1/projects/beta/docs/bdoc', '/api/v1/projects/beta/docs']) {
      const hidden = await t.call(t.bob, 'GET', url);
      const missing = await t.call(t.bob, 'GET', url.replace('beta', 'nope'));
      expect(hidden.status, url).toBe(404);
      expect(hidden.json, url).toEqual(missing.json);
    }
    for (const [method, url] of [['PATCH', '/api/v1/projects/beta'], ['DELETE', '/api/v1/projects/beta'], ['POST', '/api/v1/projects/beta/secrets/DB/use']] as const) {
      expect((await t.call(t.bob, method, url, method === 'POST' ? { purpose: 'exec' } : method === 'PATCH' ? { summary: 'x' } : undefined)).status, url).toBe(404);
    }
  });

  it('carol (cli on one secret): sees that secret and its project only, can use but not read or write', async () => {
    t = await makeShared();
    expect(slugs(await t.call(t.carol, 'GET', '/api/v1/projects'))).toEqual(['beta']);
    const detail = jsonAs<{ secrets: Sec[]; documents: Doc[] }>(await t.call(t.carol, 'GET', '/api/v1/projects/beta'));
    expect(detail.documents).toEqual([]);
    expect(detail.secrets.map((s) => s.name)).toEqual(['DB']);
    // no public.read: keys and sensitivity, no values
    expect(detail.secrets[0]!.fields).toEqual([{ key: 'host', sensitive: false }, { key: 'password', sensitive: true }]);
    expect(names(await t.call(t.carol, 'GET', '/api/v1/projects/beta/secrets'))).toEqual(['DB']);
    expect((await t.call(t.carol, 'GET', '/api/v1/projects/beta/secrets/OTHER')).status).toBe(404);
    expect((await t.call(t.carol, 'GET', '/api/v1/projects/beta/docs/bdoc')).status).toBe(404);
    expect(slugs(await t.call(t.carol, 'GET', '/api/v1/projects/beta/docs'))).toEqual([]);
    // reveal is refused even with a full-scope token
    expect((await t.call(t.carol, 'GET', '/api/v1/projects/beta/secrets/DB/fields/password')).status).toBe(403);
    expect((await t.call(t.carol, 'GET', '/api/v1/projects/beta/secrets/DB/fields/host')).status).toBe(403);
    expect((await t.call(t.carol, 'GET', '/api/v1/projects/beta/secrets/DB/fields')).status).toBe(403);
    const use = await t.call(t.carol, 'POST', '/api/v1/projects/beta/secrets/DB/use', { purpose: 'env' });
    expect(use.status).toBe(200);
    expect(jsonAs<{ fields: Record<string, string> }>(use).fields).toEqual({ host: 'db.example', password: 'beta-pw' });
    expect((await t.call(t.carol, 'POST', '/api/v1/projects/beta/secrets/OTHER/use', { purpose: 'env' })).status).toBe(404);
    // no writes of any kind
    expect((await t.call(t.carol, 'PATCH', '/api/v1/projects/beta/secrets/DB', { description: 'x' })).status).toBe(403);
    expect((await t.call(t.carol, 'DELETE', '/api/v1/projects/beta/secrets/DB')).status).toBe(403);
    expect((await t.call(t.carol, 'POST', '/api/v1/projects/beta/secrets', { name: 'N', fields: [{ key: 'host', value: 'h' }] })).status).toBe(403);
    expect((await t.call(t.carol, 'PATCH', '/api/v1/projects/beta', { summary: 'x' })).status).toBe(403);
    expect((await t.call(t.carol, 'PUT', '/api/v1/projects/beta/docs/new', { title: 'N', category: 'notes', body_md: 'x' })).status).toBe(403);
    // search finds the visible secret, not its sibling
    expect(jsonAs<{ secrets: { name: string }[] }>(await t.call(t.carol, 'GET', '/api/v1/search?q=DB')).secrets.map((s) => s.name)).toEqual(['DB']);
    expect(jsonAs<{ secrets: { name: string }[] }>(await t.call(t.carol, 'GET', '/api/v1/search?q=OTHER')).secrets).toEqual([]);
  });

  it('dave (docs.read on one document): sees that document only', async () => {
    t = await makeShared();
    expect(slugs(await t.call(t.dave, 'GET', '/api/v1/projects'))).toEqual(['gamma']);
    const detail = jsonAs<{ secrets: Sec[]; documents: Doc[] }>(await t.call(t.dave, 'GET', '/api/v1/projects/gamma'));
    expect(detail.documents.map((d) => d.slug)).toEqual(['gdoc']);
    expect(detail.secrets).toEqual([]);
    expect(slugs(await t.call(t.dave, 'GET', '/api/v1/projects/gamma/docs'))).toEqual(['gdoc']);
    expect(jsonAs<{ body_md: string }>(await t.call(t.dave, 'GET', '/api/v1/projects/gamma/docs/gdoc')).body_md).toBe('gamma doc');
    expect((await t.call(t.dave, 'GET', '/api/v1/projects/gamma/docs/gother')).status).toBe(404);
    expect(names(await t.call(t.dave, 'GET', '/api/v1/projects/gamma/secrets'))).toEqual([]);
    expect((await t.call(t.dave, 'GET', '/api/v1/projects/gamma/secrets/GS')).status).toBe(404);
    expect(jsonAs<{ documents: { slug: string }[] }>(await t.call(t.dave, 'GET', '/api/v1/search?q=gamma')).documents.map((d) => d.slug)).toEqual(['gdoc']);
    // read-only: writing the granted doc is 403; an existing-but-hidden slug answers exactly like a brand-new one
    const body = { title: 'T', category: 'notes', body_md: 'x' };
    expect((await t.call(t.dave, 'PUT', '/api/v1/projects/gamma/docs/gdoc', body)).status).toBe(403);
    const hidden = await t.call(t.dave, 'PUT', '/api/v1/projects/gamma/docs/gother', body);
    const fresh = await t.call(t.dave, 'PUT', '/api/v1/projects/gamma/docs/brand-new', body);
    expect(hidden.status).toBe(403);
    expect(hidden.json).toEqual(fresh.json);
    expect((await t.call(t.dave, 'DELETE', '/api/v1/projects/gamma/docs/gother')).status).toBe(404);
    expect((await t.call(t.dave, 'DELETE', '/api/v1/projects/gamma/docs/gdoc')).status).toBe(403);
    expect(getDocument(t.db, getProjectBySlug(t.db, 'gamma')!.id, 'gother')!.body_md).toBe('gamma other');
  });

  it('erin (no grants): sees nothing and everything is a 404', async () => {
    t = await makeShared();
    expect(jsonAs<Proj[]>(await t.call(t.erin, 'GET', '/api/v1/projects'))).toEqual([]);
    expect(jsonAs<Ws[]>(await t.call(t.erin, 'GET', '/api/v1/workspaces'))).toEqual([]);
    expect((await t.call(t.erin, 'GET', '/api/v1/projects/alpha')).status).toBe(404);
    expect(jsonAs<unknown[]>(await t.call(t.erin, 'GET', '/api/v1/search?q=a')).length).toBe(undefined);
    expect((await t.call(t.erin, 'GET', '/api/v1/search?q=alpha')).json).toEqual({ projects: [], documents: [], secrets: [] });
    // no visible workspace: omitted -> 400; a real but invisible one looks like an unknown one
    expect((await t.call(t.erin, 'GET', '/api/v1/secrets')).status).toBe(400);
    const hidden = await t.call(t.erin, 'GET', '/api/v1/secrets?workspace=default');
    const missing = await t.call(t.erin, 'GET', '/api/v1/secrets?workspace=nope');
    expect(hidden.status).toBe(404);
    expect(hidden.json).toEqual(missing.json);
    expect((await t.call(t.erin, 'PUT', '/api/v1/docs/x?workspace=default', { title: 'X', category: 'notes', body_md: 'x' })).status).toBe(404);
    expect((await t.call(t.erin, 'POST', '/api/v1/projects', { workspace: 'default', slug: 'p', name: 'P' })).status).toBe(404);
  });

  it('removing a grant takes effect on the very next request, with the same token', async () => {
    t = await makeShared();
    const token = t.as(t.bob);
    const get = () => t.app.inject({ method: 'GET', url: '/api/v1/projects/alpha/secrets/ADB', headers: auth(token) });
    expect((await get()).statusCode).toBe(200);
    const alpha = getProjectBySlug(t.db, 'alpha')!;
    deleteGrant(t.db, t.bob.id, 'project', alpha.id);
    expect((await get()).statusCode).toBe(404);
    expect(jsonAs<Proj[]>(await t.call(t.bob, 'GET', '/api/v1/projects', undefined, token))).toEqual([]);
  });

  it('a disabled user token is a 401 immediately, and works again once re-enabled', async () => {
    t = await makeShared();
    const token = t.as(t.bob);
    const get = () => t.app.inject({ method: 'GET', url: '/api/v1/projects', headers: auth(token) });
    expect((await get()).statusCode).toBe(200);
    setUserDisabled(t.db, t.bob.id, true);
    const res = await get();
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'unauthorized', message: 'unauthorized' });
    setUserDisabled(t.db, t.bob.id, false);
    expect((await get()).statusCode).toBe(200);
  });

  it('token scopes intersect with the user permissions', async () => {
    t = await makeShared();
    // carol only has cli: a reveal-scoped token does not give her reveal
    const reveal = t.as(t.carol, ['secrets:meta', 'secrets:reveal']);
    expect((await t.call(t.carol, 'GET', '/api/v1/projects/beta/secrets/DB/fields/password', undefined, reveal)).status).toBe(403);
    expect((await t.call(t.carol, 'GET', '/api/v1/projects/beta/secrets/DB/fields', undefined, reveal)).status).toBe(403);
    // bob has everything on alpha: a meta-only token still cannot reveal (scope), a reveal token can
    const meta = t.as(t.bob, ['secrets:meta']);
    const denied = await t.call(t.bob, 'GET', '/api/v1/projects/alpha/secrets/ADB/fields/password', undefined, meta);
    expect(denied.status).toBe(403);
    expect(jsonAs<{ error: string }>(denied).error).toBe('missing_scope');
    expect((await t.call(t.bob, 'GET', '/api/v1/projects/alpha/secrets/ADB/fields/password', undefined, t.as(t.bob, ['secrets:meta', 'secrets:reveal']))).status).toBe(200);
    // a token restricted to alpha cannot see another project even where the user could
    const owner = t.owner();
    const scoped = t.as(owner, ['projects:read'], ['alpha']);
    expect(slugs(await t.call(owner, 'GET', '/api/v1/projects', undefined, scoped))).toEqual(['alpha']);
    expect((await t.call(owner, 'GET', '/api/v1/projects/beta', undefined, scoped)).status).toBe(404);
  });

  it('an agent token of a granted user can use a secret but never reveal it', async () => {
    t = await makeShared();
    const agentCarol = t.as(t.carol, ['secrets:meta', 'secrets:use'], null, 'agent');
    expect((await t.call(t.carol, 'POST', '/api/v1/projects/beta/secrets/DB/use', { purpose: 'exec' }, agentCarol)).status).toBe(200);
    expect((await t.call(t.carol, 'GET', '/api/v1/projects/beta/secrets/DB/fields/password', undefined, agentCarol)).status).toBe(403);
    // even bob, who may read everything in alpha, gets nothing through an agent token's reveal endpoints
    const agentBob = t.as(t.bob, ['secrets:meta', 'secrets:use'], null, 'agent');
    expect((await t.call(t.bob, 'GET', '/api/v1/projects/alpha/secrets/ADB/fields/password', undefined, agentBob)).status).toBe(403);
    expect((await t.call(t.bob, 'GET', '/api/v1/projects/alpha/secrets/ADB/fields', undefined, agentBob)).status).toBe(403);
    expect((await t.call(t.bob, 'POST', '/api/v1/projects/alpha/secrets/ADB/use', { purpose: 'exec' }, agentBob)).status).toBe(200);
  });

  it('public.write alone edits non-sensitive fields only; protected fields stay out of reach', async () => {
    t = await makeShared();
    const beta = getProjectBySlug(t.db, 'beta')!;
    upsertGrant(t.db, { userId: t.erin.id, targetType: 'project', targetId: beta.id, perms: ['public.read', 'public.write'] });
    const ok = await t.call(t.erin, 'POST', '/api/v1/projects/beta/secrets', { name: 'PUB', fields: [{ key: 'host', value: 'h' }] });
    expect(ok.status).toBe(201);
    const sensitive = await t.call(t.erin, 'POST', '/api/v1/projects/beta/secrets', { name: 'PRIV', fields: [{ key: 'password', value: 'p' }] });
    expect(sensitive.status).toBe(403);
    expect((await t.call(t.erin, 'PATCH', '/api/v1/projects/beta/secrets/DB', { fields: [{ key: 'password', value: 'hacked' }] })).status).toBe(403);
    expect((await t.call(t.erin, 'PATCH', '/api/v1/projects/beta/secrets/DB', { fields: [{ key: 'host', value: 'new.example' }] })).status).toBe(200);
    expect((await t.call(t.erin, 'DELETE', '/api/v1/projects/beta/secrets/DB')).status).toBe(403);
    expect((await t.call(t.erin, 'GET', '/api/v1/projects/beta/secrets/DB/fields/password')).status).toBe(403);
    expect(jsonAs<{ value: string }>(await t.call(t.erin, 'GET', '/api/v1/projects/beta/secrets/DB/fields/host')).value).toBe('new.example');
  });

  it('use needs cli (or full read); a grant without either cannot use the secret', async () => {
    t = await makeShared();
    const db = getSecretMeta(t.db, t.ring, getProjectBySlug(t.db, 'beta')!.id, 'DB')!;
    const use = () => t.call(t.erin, 'POST', '/api/v1/projects/beta/secrets/DB/use', { purpose: 'exec' });
    upsertGrant(t.db, { userId: t.erin.id, targetType: 'secret', targetId: db.id, perms: ['public.read', 'public.write', 'protected.write'] });
    expect((await use()).status).toBe(403);
    upsertGrant(t.db, { userId: t.erin.id, targetType: 'secret', targetId: db.id, perms: ['public.read', 'protected.read'] });
    expect((await use()).status).toBe(200); // reads everything anyway
    upsertGrant(t.db, { userId: t.erin.id, targetType: 'secret', targetId: db.id, perms: ['cli'] });
    expect((await use()).status).toBe(200);
  });

  it('project meta update: a project grant with docs.write may, one without may not', async () => {
    t = await makeShared();
    const gamma = getProjectBySlug(t.db, 'gamma')!;
    upsertGrant(t.db, { userId: t.erin.id, targetType: 'project', targetId: gamma.id, perms: ['docs.read'] });
    expect((await t.call(t.erin, 'PATCH', '/api/v1/projects/gamma', { summary: 'nope' })).status).toBe(403);
    upsertGrant(t.db, { userId: t.erin.id, targetType: 'project', targetId: gamma.id, perms: ['docs.*'] });
    const ok = await t.call(t.erin, 'PATCH', '/api/v1/projects/gamma', { summary: 'yes', status: 'paused' });
    expect(ok.status).toBe(200);
    expect(jsonAs<{ summary: string }>(ok).summary).toBe('yes');
  });
});

describe('globals and workspaces', () => {
  it('?workspace= addresses globals; omission follows the design rules', async () => {
    t = await makeShared();
    const owner = t.owner();
    const second = createWorkspace(t.db, { slug: 'second', name: 'Second' });
    addOwner(t.db, second.id, owner.id);
    createSecret(t.db, t.ring, { projectId: null, workspaceId: second.id, name: 'GLOBAL_S', description: 'other one', tags: [], fields: [{ key: 'host', value: 'second.example' }] });
    // two visible workspaces and nothing to disambiguate: 400
    const ambiguous = await t.call(owner, 'GET', '/api/v1/secrets');
    expect(ambiguous.status).toBe(400);
    expect(ambiguous.body).toContain('workspace required');
    expect((await t.call(owner, 'GET', '/api/v1/docs')).status).toBe(400);
    // explicit workspace picks the right namespace even for the same name
    const inDefault = jsonAs<Sec>(await t.call(owner, 'GET', '/api/v1/secrets/GLOBAL_S?workspace=default'));
    const inSecond = jsonAs<Sec>(await t.call(owner, 'GET', '/api/v1/secrets/GLOBAL_S?workspace=second'));
    expect(inDefault.fields[0]).toEqual({ key: 'host', sensitive: false, value: 'g.example' });
    expect(inSecond.fields[0]).toEqual({ key: 'host', sensitive: false, value: 'second.example' });
    expect(slugs(await t.call(owner, 'GET', '/api/v1/docs?workspace=default'))).toEqual(['ghandbook']);
    expect(slugs(await t.call(owner, 'GET', '/api/v1/docs?workspace=second'))).toEqual([]);
    // a project-scoped token whose projects share one workspace resolves it by itself
    const scoped = t.as(owner, ['secrets:meta', 'docs:read'], ['alpha']);
    expect(names(await t.call(owner, 'GET', '/api/v1/secrets', undefined, scoped))).toEqual(['GLOBAL_S']);
    expect(slugs(await t.call(owner, 'GET', '/api/v1/docs', undefined, scoped))).toEqual(['ghandbook']);
    // workspace listing carries roles
    expect(jsonAs<Ws[]>(await t.call(owner, 'GET', '/api/v1/workspaces')).map((w) => [w.slug, w.role])).toEqual([['default', 'owner'], ['second', 'owner']]);
    // a workspace owner creates globals; the ?workspace= wins over the only-visible rule
    const created = await t.call(owner, 'POST', '/api/v1/secrets?workspace=second', { name: 'FRESH', fields: [{ key: 'host', value: 'h' }] });
    expect(created.status).toBe(201);
    expect((await t.call(owner, 'GET', '/api/v1/secrets/FRESH?workspace=default')).status).toBe(404);
  });

  it('a user with one global grant sees that workspace and that item only', async () => {
    t = await makeShared();
    const g = getSecretMeta(t.db, t.ring, null, 'GLOBAL_S', t.workspaceId)!;
    upsertGrant(t.db, { userId: t.erin.id, targetType: 'secret', targetId: g.id, perms: ['public.read'] });
    expect(jsonAs<Ws[]>(await t.call(t.erin, 'GET', '/api/v1/workspaces')).map((w) => w.slug)).toEqual(['default']);
    expect(names(await t.call(t.erin, 'GET', '/api/v1/secrets'))).toEqual(['GLOBAL_S']);
    const secret = jsonAs<Sec>(await t.call(t.erin, 'GET', '/api/v1/secrets/GLOBAL_S'));
    expect(secret.fields).toEqual([{ key: 'host', sensitive: false, value: 'g.example' }, { key: 'token', sensitive: true }]);
    expect(slugs(await t.call(t.erin, 'GET', '/api/v1/docs'))).toEqual([]);
    expect(jsonAs<Proj[]>(await t.call(t.erin, 'GET', '/api/v1/projects'))).toEqual([]);
  });

  it('document refs resolve {{secret:global/X}} in the document\'s workspace and never reveal invisible secrets', async () => {
    t = await makeShared();
    const owner = t.owner();
    const second = createWorkspace(t.db, { slug: 'second', name: 'Second' });
    addOwner(t.db, second.id, owner.id);
    createSecret(t.db, t.ring, { projectId: null, workspaceId: second.id, name: 'ONLY_SECOND', description: '', tags: [], fields: [{ key: 'host', value: 'h' }] });
    const body = (md: string) => ({ title: 'R', category: 'notes', body_md: md });
    // a doc in `second` resolves global/ONLY_SECOND there; the same ref in default is unresolved (422)
    expect((await t.call(owner, 'PUT', '/api/v1/docs/refs?workspace=second', body('see {{secret:global/ONLY_SECOND}}'))).status).toBe(201);
    expect((await t.call(owner, 'PUT', '/api/v1/docs/refs?workspace=default', body('see {{secret:global/ONLY_SECOND}}'))).status).toBe(422);
    const read = jsonAs<{ refs: { ref: string }[] }>(await t.call(owner, 'GET', '/api/v1/docs/refs?workspace=second&resolve=meta'));
    expect(read.refs.map((r) => r.ref)).toEqual(['{{secret:global/ONLY_SECOND}}']);
    // bob may write docs in alpha but a ref to beta/DB (invisible) is exactly as unresolved as a ref to a missing secret
    const hiddenRef = await t.call(t.bob, 'PUT', '/api/v1/projects/alpha/docs/refs', body('{{secret:beta/DB}}'));
    const missingRef = await t.call(t.bob, 'PUT', '/api/v1/projects/alpha/docs/refs', body('{{secret:beta/NOPE}}'));
    expect(hiddenRef.status).toBe(422);
    expect(jsonAs<{ unresolved: string[] }>(hiddenRef).unresolved).toEqual(['{{secret:beta/DB}}']);
    expect(jsonAs<{ unresolved: string[] }>(missingRef).unresolved).toEqual(['{{secret:beta/NOPE}}']);
    // resolved refs of a doc never list fields of secrets the reader cannot see
    expect((await t.call(t.bob, 'PUT', '/api/v1/projects/alpha/docs/refs2', { ...body('{{secret:beta/DB}} {{secret:ADB}}'), force: true })).status).toBe(201);
    const refs = jsonAs<{ refs: { ref: string }[] }>(await t.call(t.bob, 'GET', '/api/v1/projects/alpha/docs/refs2?resolve=meta')).refs;
    expect(refs.map((r) => r.ref)).toEqual(['{{secret:ADB}}']);
  });

  it('project creation: workspace is required unless the principal owns exactly one; it needs ownership', async () => {
    t = await makeShared();
    const owner = t.owner();
    const created = await t.call(owner, 'POST', '/api/v1/projects', { slug: 'solo', name: 'Solo' });
    expect(created.status).toBe(201);
    expect(jsonAs<Proj>(created).workspace).toBe('default');
    const second = createWorkspace(t.db, { slug: 'second', name: 'Second' });
    addOwner(t.db, second.id, owner.id);
    const ambiguous = await t.call(owner, 'POST', '/api/v1/projects', { slug: 'duo', name: 'Duo' });
    expect(ambiguous.status).toBe(400);
    const named = await t.call(owner, 'POST', '/api/v1/projects', { slug: 'duo', name: 'Duo', workspace: 'second' });
    expect(jsonAs<Proj>(named).workspace).toBe('second');
    expect(jsonAs<Proj[]>(await t.call(owner, 'GET', '/api/v1/projects')).filter((p) => p.workspace === 'second').map((p) => p.slug)).toEqual(['duo']);
    // a member (grant) who sees the workspace but does not own it
    expect((await t.call(t.bob, 'POST', '/api/v1/projects', { workspace: 'default', slug: 'bobs', name: 'Bobs' })).status).toBe(403);
  });
});

describe('access matrix over MCP', () => {
  async function connect(token: string): Promise<Client> {
    const address = t.app.server.listening ? `http://127.0.0.1:${(t.app.server.address() as { port: number }).port}` : await t.app.listen({ port: 0, host: '127.0.0.1' });
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${address}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    return client;
  }
  const text = (r: Awaited<ReturnType<Client['callTool']>>): string => (r.content as { text?: string }[])[0]?.text ?? '';
  const data = <T>(r: Awaited<ReturnType<Client['callTool']>>): T => JSON.parse(text(r)) as T;

  it('lists only what the user can see, workspaces with roles, and hides values without public.read', async () => {
    t = await makeShared();
    const bob = await connect(t.as(t.bob));
    expect(data<Proj[]>(await bob.callTool({ name: 'list_projects', arguments: {} })).map((p) => p.slug)).toEqual(['alpha']);
    expect(data<Ws[]>(await bob.callTool({ name: 'list_workspaces', arguments: {} }))).toEqual([{ slug: 'default', name: 'Default', role: 'member' }]);
    const carol = await connect(t.as(t.carol));
    const secrets = data<Sec[]>(await carol.callTool({ name: 'list_secrets', arguments: { project: 'beta' } }));
    expect(secrets.map((s) => s.name)).toEqual(['DB']);
    expect(secrets[0]!.fields).toEqual([{ key: 'host', sensitive: false }, { key: 'password', sensitive: true }]);
    const hidden = await carol.callTool({ name: 'list_secrets', arguments: { project: 'alpha' } });
    const missing = await carol.callTool({ name: 'list_secrets', arguments: { project: 'nope' } });
    expect(hidden.isError).toBe(true);
    expect(text(hidden)).toBe(text(missing));
    const erin = await connect(t.as(t.erin));
    expect(data<Proj[]>(await erin.callTool({ name: 'list_projects', arguments: {} }))).toEqual([]);
    const search = data<{ projects: unknown[]; secrets: unknown[]; documents: unknown[] }>(await erin.callTool({ name: 'search', arguments: { query: 'alpha' } }));
    expect(search).toEqual({ projects: [], documents: [], secrets: [] });
    const dave = await connect(t.as(t.dave));
    expect(data<Doc[]>(await dave.callTool({ name: 'list_documents', arguments: { project: 'gamma' } })).map((d) => d.slug)).toEqual(['gdoc']);
    expect((await dave.callTool({ name: 'read_document', arguments: { project: 'gamma', slug: 'gother' } })).isError).toBe(true);
    for (const c of [bob, carol, erin, dave]) await c.close();
  });

  it('upsert_secret_meta cannot tell a hidden secret from a missing one', async () => {
    t = await makeShared();
    const carol = await connect(t.as(t.carol));
    const args = (name: string) => ({ project: 'beta', name, fields: [{ key: 'host', value: 'x', sensitive: false as const }] });
    const onVisible = await carol.callTool({ name: 'upsert_secret_meta', arguments: args('DB') });
    const onHidden = await carol.callTool({ name: 'upsert_secret_meta', arguments: args('OTHER') });
    const onMissing = await carol.callTool({ name: 'upsert_secret_meta', arguments: args('NOPE') });
    expect(onVisible.isError).toBe(true);
    expect(text(onVisible)).toContain('forbidden');
    expect(text(onHidden)).toBe(text(onMissing));
    expect(text(onHidden)).toContain('forbidden');
    // the hidden secret is untouched
    expect(getSecretMeta(t.db, t.ring, getProjectBySlug(t.db, 'beta')!.id, 'OTHER')!.fields[0]).toEqual({ key: 'host', sensitive: false, value: 'other.example' });
    await carol.close();
  });

  it('create_project needs ownership of the workspace; globals take an optional workspace', async () => {
    t = await makeShared();
    const owner = t.owner();
    const ownerClient = await connect(t.as(owner));
    const made = data<Proj>(await ownerClient.callTool({ name: 'create_project', arguments: { slug: 'viamcp', name: 'Via MCP' } }));
    expect(made.workspace).toBe('default');
    const bob = await connect(t.as(t.bob));
    const denied = await bob.callTool({ name: 'create_project', arguments: { workspace: 'default', slug: 'nope', name: 'Nope' } });
    expect(denied.isError).toBe(true);
    expect(text(denied)).toContain('forbidden');
    const denyDoc = await bob.callTool({ name: 'write_document', arguments: { workspace: 'default', slug: 'g', title: 'G', category: 'notes', body_md: 'x' } });
    expect(denyDoc.isError).toBe(true);
    const globals = data<{ slug: string }[]>(await ownerClient.callTool({ name: 'list_documents', arguments: { workspace: 'default' } }));
    expect(globals.map((d) => d.slug)).toEqual(['ghandbook']);
    await ownerClient.close();
    await bob.close();
  });
});

describe('grants and reused ids', () => {
  it('a deleted secret\'s grant never leaks to a later row that reuses the id', async () => {
    t = await makeShared();
    const owner = t.owner();
    const before = createSecret(t.db, t.ring, { projectId: null, workspaceId: t.workspaceId, name: 'TEMP', description: '', tags: [], fields: [{ key: 'host', value: 'h' }] });
    upsertGrant(t.db, { userId: t.erin.id, targetType: 'secret', targetId: before.id, perms: ['public.read'] });
    expect(names(await t.call(t.erin, 'GET', '/api/v1/secrets'))).toEqual(['TEMP']);
    expect((await t.call(owner, 'DELETE', '/api/v1/secrets/TEMP?workspace=default')).status).toBe(204);
    const after = createSecret(t.db, t.ring, { projectId: null, workspaceId: t.workspaceId, name: 'LATER', description: '', tags: [], fields: [{ key: 'host', value: 'h' }] });
    expect(after.id).toBe(before.id);
    expect((await t.call(t.erin, 'GET', '/api/v1/secrets/LATER?workspace=default')).status).toBe(404);
    expect((await t.call(t.erin, 'GET', '/api/v1/workspaces')).json).toEqual([]);
  });

  it('deleting a project through the service drops the grants of everything inside it', async () => {
    t = await makeShared();
    const owner = t.owner();
    const gamma = getProjectBySlug(t.db, 'gamma')!;
    const gdoc = getDocument(t.db, gamma.id, 'gdoc')!;
    expect((await t.call(owner, 'DELETE', '/api/v1/projects/gamma')).status).toBe(204);
    expect(t.db.prepare(`SELECT COUNT(*) AS n FROM grants WHERE target_type = 'document' AND target_id = ?`).get(gdoc.id)).toEqual({ n: 0 });
    // a new project and document land on the freed ids; dave must not see them
    const fresh = await t.call(owner, 'POST', '/api/v1/projects', { slug: 'fresh', name: 'Fresh' });
    expect(fresh.status).toBe(201);
    expect((await t.call(owner, 'PUT', '/api/v1/projects/fresh/docs/d', { title: 'D', category: 'notes', body_md: 'x' })).status).toBe(201);
    expect(jsonAs<Proj[]>(await t.call(t.dave, 'GET', '/api/v1/projects'))).toEqual([]);
  });
});

describe('audit rows carry the workspace', () => {
  it('writes workspace_id for item actions', async () => {
    t = await makeShared();
    await t.call(t.bob, 'GET', '/api/v1/projects/alpha/secrets/ADB/fields/password');
    const row = listAudit(t.db, { action: 'secret.reveal' })[0]!;
    expect(row.workspace_id).toBe(t.workspaceId);
    expect(row.actor_type).toBe('token');
  });

  it('uses no numeric workspace id in any API payload', async () => {
    t = await makeShared();
    for (const url of ['/api/v1/workspaces', '/api/v1/projects', '/api/v1/projects/alpha', '/api/v1/projects/alpha/secrets', '/api/v1/docs']) {
      expect((await t.call(t.owner(), 'GET', url)).body, url).not.toContain('workspace_id');
    }
  });
});
