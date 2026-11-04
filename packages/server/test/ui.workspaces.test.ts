import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeTestApp, auth, type TestCtx } from './helpers.js';
import { createAdmin, createSession, createUser, getUserByUsername } from '../src/repos/admin.js';
import { createSecret, getSecretMeta } from '../src/repos/secrets.js';
import { getDocument, upsertDocument } from '../src/repos/documents.js';
import { getProjectBySlug } from '../src/repos/projects.js';
import { getWorkspaceBySlug } from '../src/repos/workspaces.js';
import { getGrant, listGrantsForUser, upsertGrant } from '../src/repos/grants.js';
import { createToken } from '../src/repos/tokens.js';
import { hashPassword } from '../src/crypto/passwords.js';

let t: TestCtx;
let alex: string; // owner (super) session
let bob: string; // member session
let alexCsrf: string;
let bobCsrf: string;

const csrfOf = (b: string) => /name="csrf" value="([^"]+)"/.exec(b)?.[1] ?? '';
const main = (html: string): string => html.split('<main')[1]!.split('</main>')[0]!;
const sidebar = (html: string): string => html.split('<aside class="sidebar">')[1]!.split('</aside>')[0]!;
const userId = (name: string) => getUserByUsername(t.db, name)!.id;
const get = (session: string, url: string, cookies: Record<string, string> = {}) =>
  t.app.inject({ method: 'GET', url, cookies: { blindkey_session: session, ...cookies } });
const post = (session: string, url: string, payload: Record<string, unknown>, cookies: Record<string, string> = {}) =>
  t.app.inject({ method: 'POST', url, cookies: { blindkey_session: session, ...cookies }, payload });
const asAlex = (url: string, payload: Record<string, unknown> = {}, cookies: Record<string, string> = {}) => post(alex, url, { csrf: alexCsrf, ...payload }, cookies);
const sessionFor = (username: string) => createSession(t.db, userId(username), 3_600_000, '127.0.0.1', 'test');

function secretIn(projectSlug: string | null, name: string, workspaceId = t.workspaceId) {
  return createSecret(t.db, t.ring, {
    projectId: projectSlug === null ? null : getProjectBySlug(t.db, projectSlug)!.id,
    workspaceId,
    name,
    description: '',
    tags: [],
    fields: [{ key: 'host', value: 'h.example' }, { key: 'password', value: 'pw-123456789' }],
  });
}

beforeAll(async () => {
  t = await makeTestApp();
  createAdmin(t.db, 'alex', await hashPassword('super-password-1'));
  createUser(t.db, { username: 'bob', passwordHash: await hashPassword('bob-password-1') });
  createUser(t.db, { username: 'carol', passwordHash: await hashPassword('carol-password-1') });
  for (const u of ['alex', 'bob', 'carol']) t.enroll(u);
  alex = sessionFor('alex');
  bob = sessionFor('bob');
  alexCsrf = csrfOf((await get(alex, '/')).body);
  // bob has no workspace yet, so his page has the sidebar but csrf comes from the layout form after a grant below.
});
afterAll(async () => {
  await t.app.close();
});

describe('sidebar: switcher, projects, global', () => {
  it('shows at most 10 most recently updated projects of the active workspace, with + and Show all for owners', async () => {
    for (let i = 1; i <= 12; i++) {
      t.project(`proj-${String(i).padStart(2, '0')}`);
      t.db.prepare(`UPDATE projects SET updated_at = ? WHERE slug = ?`).run(1_000_000 + i, `proj-${String(i).padStart(2, '0')}`);
    }
    const res = await get(alex, '/');
    const side = sidebar(res.body);
    for (let i = 3; i <= 12; i++) expect(side).toContain(`href="/p/proj-${String(i).padStart(2, '0')}"`);
    expect(side).not.toContain('href="/p/proj-01"');
    expect(side).not.toContain('href="/p/proj-02"');
    // most recent first
    expect(side.indexOf('/p/proj-12')).toBeLessThan(side.indexOf('/p/proj-03'));
    expect(side).toContain('class="nav-add"');
    expect(side).toContain('href="/?new=project&amp;workspace=default"');
    expect(side).toContain('Show all');
    expect(side).toContain('href="/?workspace=default"');
    expect(side).toContain('href="/global/docs?workspace=default"');
    expect(side).toContain('href="/global/secrets?workspace=default"');
    expect(side).toContain('href="/w/default/members"');
    // footer and admin group unchanged
    expect(side).toContain('<span class="tag">alex</span>');
    expect(side).toContain('<span class="tag">super</span>');
    expect(side).toContain('href="/tokens"');
    expect(side).toContain('href="/admin/users"');
  });

  it('the switcher posts to /workspace/switch with csrf and a safe next path; works without JS', async () => {
    const side = sidebar((await get(alex, '/?status=active')).body);
    expect(side).toContain('action="/workspace/switch"');
    expect(side).toContain('<details class="ws-switch">');
    expect(side).toContain('aria-label="Switch workspace"');
    expect(side).not.toContain('<select');
    expect(side).not.toContain('data-autosubmit');
    expect(side).toContain('class="ws-role">owner<');
    expect(side).toContain(`name="csrf" value="${alexCsrf}"`);
    expect(side).toContain('name="next" value="/?status=active"');
    // item pages would 404 in another workspace, so they send you to the list
    const onProject = sidebar((await get(alex, '/p/proj-12')).body);
    expect(onProject).toContain('name="next" value="/"');
    expect(side).toContain('New workspace');
  });

  it('creating a workspace makes it active; switching changes the sidebar', async () => {
    const created = await asAlex('/workspaces', { name: 'Side Hustle', slug: '' });
    expect(created.statusCode).toBe(302);
    expect(created.headers.location).toBe('/w/side-hustle/members?done=created');
    const cookie = created.cookies.find((c) => c.name === 'blindkey_ws')!.value;
    expect(cookie).toBe('side-hustle');
    const wsId = getWorkspaceBySlug(t.db, 'side-hustle')!.id;
    t.db.prepare(`INSERT INTO projects (slug, name, status, tags, summary, workspace_id, created_at, updated_at) VALUES ('side-one', 'S', 'active', '[]', '', ?, 1, 1)`).run(wsId);

    const inSide = sidebar((await get(alex, '/', { blindkey_ws: 'side-hustle' })).body);
    expect(inSide).toContain('href="/p/side-one"');
    expect(inSide).not.toContain('href="/p/proj-12"');
    expect(inSide).toContain('href="/global/docs?workspace=side-hustle"');
    expect(inSide).toContain('<span class="ws-name">Side Hustle</span>');
    expect(inSide).toContain('value="default" name="workspace"');
    expect(inSide).toContain('class="ws-row active" type="submit" value="side-hustle" name="workspace" aria-current="true"');

    const sw = await asAlex('/workspace/switch', { workspace: 'default', next: '/' }, { blindkey_ws: 'side-hustle' });
    expect(sw.statusCode).toBe(302);
    expect(sw.cookies.find((c) => c.name === 'blindkey_ws')!.value).toBe('default');
    const back = sidebar((await get(alex, '/', { blindkey_ws: 'default' })).body);
    expect(back).toContain('href="/p/proj-12"');
    expect(back).not.toContain('href="/p/side-one"');
  });

  it('projects list is filtered to the active workspace and names it in the heading', async () => {
    const side = await get(alex, '/', { blindkey_ws: 'side-hustle' });
    expect(main(side.body)).toContain('<span class="ws-name">· Side Hustle</span>');
    expect(main(side.body)).toContain('href="/p/side-one"');
    expect(main(side.body)).not.toContain('href="/p/proj-12"');
    const viaQuery = await get(alex, '/?workspace=default', { blindkey_ws: 'side-hustle' });
    expect(main(viaQuery.body)).toContain('· Default');
    expect(main(viaQuery.body)).toContain('href="/p/proj-12"');
    expect(main(viaQuery.body)).not.toContain('href="/p/side-one"');
  });
});

describe('member view', () => {
  let secretId: number;
  beforeAll(async () => {
    t.project('shared-app');
    secretIn('shared-app', 'APP_DB');
    secretIn('shared-app', 'APP_HIDDEN');
    secretId = getSecretMeta(t.db, t.ring, getProjectBySlug(t.db, 'shared-app')!.id, 'APP_DB')!.id;
    upsertGrant(t.db, { userId: userId('bob'), targetType: 'secret', targetId: secretId, perms: ['public.read', 'protected.read'] });
    bobCsrf = csrfOf((await get(bob, '/')).body);
  });

  it('sees only granted items in the sidebar and lists, no + and no Members link', async () => {
    const home = await get(bob, '/');
    const side = sidebar(home.body);
    expect(side).toContain('href="/p/shared-app"');
    expect(side).not.toContain('href="/p/proj-12"');
    expect(side).not.toContain('class="nav-add"');
    expect(side).not.toContain('/members');
    expect(side).not.toContain('/settings"');
    expect(side).toContain('class="ws-role">member<');
    expect(side).toContain('href="/workspaces/new"');
    expect(side).toContain('Show all');
    expect(main(home.body)).toContain('href="/p/shared-app"');
    expect(main(home.body)).not.toContain('href="/p/proj-12"');
    expect(main(home.body)).not.toContain('New project');
    const project = await get(bob, '/p/shared-app?tab=secrets');
    expect(main(project.body)).toContain('APP_DB');
    expect(main(project.body)).not.toContain('APP_HIDDEN');
  });

  it('gets 404 on the Members, settings and grant pages and on every owner-only post', async () => {
    for (const url of ['/w/default/members', '/w/default/settings', '/w/default/members/carol']) {
      expect((await get(bob, url)).statusCode).toBe(404);
    }
    expect((await post(bob, '/w/default/members', { csrf: bobCsrf, username: 'carol' })).statusCode).toBe(404);
    expect((await post(bob, '/w/default/members/carol', { csrf: bobCsrf, access: `secret:${secretId}`, [`perm:secret:${secretId}`]: '*' })).statusCode).toBe(404);
    expect((await post(bob, '/w/default/owners', { csrf: bobCsrf, username: 'bob' })).statusCode).toBe(404);
    expect(listGrantsForUser(t.db, userId('carol'))).toHaveLength(0);
  });
});

describe('members page', () => {
  it('lists owners and members with a summary of their grants; owners can open it', async () => {
    const res = await get(alex, '/w/default/members');
    expect(res.statusCode).toBe(200);
    const m = main(res.body);
    expect(m).toContain('<strong>alex</strong>');
    expect(m).toContain('<strong>bob</strong>');
    expect(m).toContain('secret shared-app/APP_DB');
    expect(m).toContain('public.read, protected.read');
    expect(m).toContain('href="/w/default/members/bob"');
  });

  it('adds an owner, refuses to remove the last owner with the service message, then removes one', async () => {
    const lastOwner = await asAlex('/w/side-hustle/owners/alex/remove');
    expect(lastOwner.statusCode).toBe(409);
    expect(main(lastOwner.body)).toContain('a workspace needs at least one owner');

    expect((await asAlex('/w/side-hustle/owners', { username: 'carol' })).statusCode).toBe(302);
    expect(main((await get(alex, '/w/side-hustle/members')).body)).toContain('<strong>carol</strong>');
    expect((await asAlex('/w/side-hustle/owners/carol/remove')).statusCode).toBe(302);
    expect(main((await get(alex, '/w/side-hustle/members')).body)).not.toContain('<strong>carol</strong>');
  });

  it('"Add user" needs an exact username and leads to the grant editor', async () => {
    const ok = await asAlex('/w/default/members', { username: 'carol' });
    expect(ok.statusCode).toBe(302);
    expect(ok.headers.location).toBe('/w/default/members/carol');
    const missing = await asAlex('/w/default/members', { username: 'car' });
    expect(missing.statusCode).toBe(404);
    expect(main(missing.body)).toContain('user not found');
  });

  it('renames the workspace (owner only) and keeps the selected-workspace cookie in step', async () => {
    const res = await asAlex('/w/side-hustle/settings', { name: 'Side Gig', slug: 'side-gig' }, { blindkey_ws: 'side-hustle' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/w/side-gig/settings?done=saved');
    expect(res.cookies.find((c) => c.name === 'blindkey_ws')!.value).toBe('side-gig');
    expect(getWorkspaceBySlug(t.db, 'side-gig')!.name).toBe('Side Gig');
    const clash = await asAlex('/w/side-gig/settings', { name: 'X', slug: 'default' });
    expect(clash.statusCode).toBe(409);
  });
});

describe('grant editor', () => {
  let projectId: number;
  let cliSecret: number;
  beforeAll(() => {
    t.project('editor-app');
    projectId = getProjectBySlug(t.db, 'editor-app')!.id;
    secretIn('editor-app', 'EDITOR_DB');
    cliSecret = getSecretMeta(t.db, t.ring, projectId, 'EDITOR_DB')!.id;
    upsertDocument(t.db, { projectId: null, workspaceId: t.workspaceId, slug: 'editor-doc', title: 'D', category: 'notes', body_md: 'x' });
  });

  const carolToken = () => createToken(t.db, { userId: userId('carol'), name: 'c', scopes: ['secrets:use', 'secrets:meta', 'secrets:reveal'], projectIds: null, expiresAt: null, kind: 'user' }).token;
  const use = (tok: string) => t.app.inject({ method: 'POST', url: '/api/v1/projects/editor-app/secrets/EDITOR_DB/use', headers: auth(tok), payload: { purpose: 'exec' } });
  const reveal = (tok: string) => t.app.inject({ method: 'GET', url: '/api/v1/projects/editor-app/secrets/EDITOR_DB/fields/password', headers: auth(tok) });

  it('renders the resource tree with labelled checkboxes and the CLI note', async () => {
    const res = await get(alex, '/w/default/members/carol');
    expect(res.statusCode).toBe(200);
    const m = main(res.body);
    expect(m).toContain('Global documents');
    expect(m).toContain('Global secrets');
    expect(m).toContain('<details class="grant-children"');
    expect(m).toContain(`name="access" value="secret:${cliSecret}"`);
    expect(m).toContain(`name="perm:secret:${cliSecret}" value="*" data-perm-all checked`);
    expect(m).toContain("Lets this user run commands with the secret's values (blindkey secret exec / env / write) without showing them in the UI. The values do reach the user's machine.");
    expect(m).toContain('value="protected.*" data-perm-parent');
    expect(m).toContain('value="docs.*" data-perm-parent'); // projects only
    const boxes = m.match(/<input type="checkbox"/g)!.length;
    const labelled = m.match(/<label class="check"><input type="checkbox"/g)!.length;
    expect(labelled).toBe(boxes);
    // no inline script/handler/style, as the CSP forbids them
    expect(m).not.toMatch(/<script|\son[a-z]+=|\sstyle=/);
  });

  it('round trip: CLI only lets the member use but not reveal; unchecking removes the access', async () => {
    const tok = carolToken();
    expect((await use(tok)).statusCode).toBe(404);

    const saved = await asAlex('/w/default/members/carol', { access: `secret:${cliSecret}`, [`perm:secret:${cliSecret}`]: 'cli' });
    expect(saved.statusCode).toBe(302);
    expect(getGrant(t.db, userId('carol'), 'secret', cliSecret)!.perms).toEqual(['cli']);
    const used = await use(tok);
    expect(used.statusCode).toBe(200);
    expect(used.json().fields.password).toBe('pw-123456789');
    expect((await reveal(tok)).statusCode).toBe(403);

    // the editor now pre-checks exactly that
    const again = main((await get(alex, '/w/default/members/carol')).body);
    expect(again).toContain(`name="access" value="secret:${cliSecret}" checked`);
    expect(again).toMatch(new RegExp(`name="perm:secret:${cliSecret}" value="cli" checked`));
    expect(again).not.toContain(`name="perm:secret:${cliSecret}" value="*" data-perm-all checked`);

    const removed = await asAlex('/w/default/members/carol', {});
    expect(removed.statusCode).toBe(302);
    expect(getGrant(t.db, userId('carol'), 'secret', cliSecret)).toBeNull();
    expect((await use(tok)).statusCode).toBe(404);
    expect(listGrantsForUser(t.db, userId('carol'))).toHaveLength(0);
  });

  it('without JS a checked parent counts as both children, "*" as everything the target allows', async () => {
    await asAlex('/w/default/members/carol', {
      access: [`secret:${cliSecret}`, `project:${projectId}`],
      [`perm:secret:${cliSecret}`]: ['protected.*', 'public.read'],
      [`perm:project:${projectId}`]: '*',
    });
    expect(getGrant(t.db, userId('carol'), 'secret', cliSecret)!.perms).toEqual(['public.read', 'protected.read', 'protected.write']);
    expect(getGrant(t.db, userId('carol'), 'project', projectId)!.perms).toHaveLength(7);
    // a partial child selection stays partial
    await asAlex('/w/default/members/carol', { access: `project:${projectId}`, [`perm:project:${projectId}`]: ['docs.*', 'protected.read'] });
    expect(getGrant(t.db, userId('carol'), 'project', projectId)!.perms).toEqual(['protected.read', 'docs.read', 'docs.write']);
    expect(getGrant(t.db, userId('carol'), 'secret', cliSecret)).toBeNull();
    // the editor shows the partial state with the parent ticked only where both children are
    const m = main((await get(alex, '/w/default/members/carol')).body);
    expect(m).toMatch(new RegExp(`name="perm:project:${projectId}" value="docs\\.\\*" data-perm-parent checked`));
    expect(m).not.toMatch(new RegExp(`name="perm:project:${projectId}" value="protected\\.\\*" data-perm-parent checked`));
  });

  it('global documents take Read/Write only; an empty selection is refused and changes nothing', async () => {
    const docId = getDocument(t.db, null, 'editor-doc', t.workspaceId)!.id;
    expect((await asAlex('/w/default/members/carol', { access: `document:${docId}`, [`perm:document:${docId}`]: 'docs.read' })).statusCode).toBe(302);
    expect(getGrant(t.db, userId('carol'), 'document', docId)!.perms).toEqual(['docs.read']);
    const bad = await asAlex('/w/default/members/carol', { access: `document:${docId}` });
    expect(bad.statusCode).toBe(400);
    expect(main(bad.body)).toContain('at least one permission is required');
    expect(getGrant(t.db, userId('carol'), 'document', docId)!.perms).toEqual(['docs.read']);
    // a resource from another workspace is a 404
    const otherId = t.db.prepare(`SELECT id FROM projects WHERE slug = 'side-one'`).get() as { id: number };
    expect((await asAlex('/w/default/members/carol', { access: `project:${otherId.id}`, [`perm:project:${otherId.id}`]: '*' })).statusCode).toBe(404);
    expect((await asAlex('/w/default/members/carol/remove')).statusCode).toBe(302);
    expect(listGrantsForUser(t.db, userId('carol'))).toHaveLength(0);
  });
});

describe('Access field on create forms', () => {
  beforeAll(async () => {
    // carol becomes a member of default through any grant
    const id = getSecretMeta(t.db, t.ring, getProjectBySlug(t.db, 'shared-app')!.id, 'APP_DB')!.id;
    upsertGrant(t.db, { userId: userId('carol'), targetType: 'secret', targetId: id, perms: ['public.read'] });
  });

  it('is shown to owners only, lists the members and says owners always have access', async () => {
    const dialog = main((await get(alex, '/')).body);
    expect(dialog).toContain('<legend>Access</legend>');
    expect(dialog).toContain('name="access_user" value="bob"');
    expect(dialog).toContain('name="access_user" value="carol"');
    expect(dialog).not.toContain('name="access_user" value="alex"');
    expect(dialog).toContain('Workspace owners always have access.');
    expect(dialog).toContain('<option value="cli">CLI only</option>');
    const secretForm = main((await get(alex, '/p/shared-app/secrets/new')).body);
    expect(secretForm).toContain('name="access_user" value="bob"');
    const docForm = main((await get(alex, '/global/docs/new/edit')).body);
    expect(docForm).toContain('name="access_user" value="bob"');
    expect(docForm).not.toContain('CLI only');
    // a member who is not an owner never sees it
    expect(main((await get(bob, '/p/shared-app/secrets/new')).body)).not.toContain('Access');
  });

  it('creating a project grants the ticked members in the same step', async () => {
    const res = await asAlex('/projects', { slug: 'with-access', name: 'WA', status: 'active', tags: '', summary: '', workspace: 'default', access_user: ['bob'], access_preset: 'cli' });
    expect(res.statusCode).toBe(302);
    const pid = getProjectBySlug(t.db, 'with-access')!.id;
    expect(getGrant(t.db, userId('bob'), 'project', pid)!.perms).toEqual(['cli']);
    expect(getGrant(t.db, userId('carol'), 'project', pid)).toBeNull();
  });

  it('creating a secret (project and global) and a document grants with the preset', async () => {
    const s = await asAlex('/p/with-access/secrets', { name: 'NEW_S', key: ['host'], value: ['x.example'], sensitive: ['0'], access_user: ['carol'], access_preset: 'read' });
    expect(s.statusCode).toBe(302);
    const sid = getSecretMeta(t.db, t.ring, getProjectBySlug(t.db, 'with-access')!.id, 'NEW_S')!.id;
    expect(getGrant(t.db, userId('carol'), 'secret', sid)!.perms).toEqual(['public.read', 'protected.read']);

    const g = await asAlex('/global/secrets', { name: 'GLOB_S', key: ['host'], value: ['y.example'], sensitive: ['0'], access_user: ['bob'], access_preset: 'cli', workspace: 'default' });
    expect(g.statusCode).toBe(302);
    const gid = getSecretMeta(t.db, t.ring, null, 'GLOB_S', t.workspaceId)!.id;
    expect(getGrant(t.db, userId('bob'), 'secret', gid)!.perms).toEqual(['cli']);

    const d = await asAlex('/global/docs/new', { slug: 'new-doc', title: 'T', category: 'notes', body_md: 'hello', access_user: ['bob'], access_preset: 'read', workspace: 'default' });
    expect(d.statusCode).toBe(302);
    const did = getDocument(t.db, null, 'new-doc', t.workspaceId)!.id;
    expect(getGrant(t.db, userId('bob'), 'document', did)!.perms).toEqual(['docs.read']);
  });

  it('a failed grant rolls the item back', async () => {
    const res = await asAlex('/projects', { slug: 'ghost', name: 'G', status: 'active', tags: '', summary: '', workspace: 'default', access_user: ['nobody'], access_preset: 'all' });
    expect(res.statusCode).toBe(404);
    expect(getProjectBySlug(t.db, 'ghost')).toBeNull();
  });

  it('a non-owner cannot create a project and the new-project dialog is absent', async () => {
    const res = await post(bob, '/projects', { csrf: bobCsrf, slug: 'bobs', name: 'B', status: 'active', tags: '', summary: '', workspace: 'default' });
    // bob can see `default` but owns no workspace: refused, with a message rather than a validation error
    expect(res.statusCode).toBe(403);
    expect(main(res.body)).toContain('own this workspace');
    expect(getProjectBySlug(t.db, 'bobs')).toBeNull();
  });
});

describe('move to another workspace', () => {
  it('lists other owned workspaces; moving a project keeps its grants and lands on the new location', async () => {
    const page = await get(alex, '/p/with-access');
    expect(main(page.body)).toContain('Move to workspace');
    expect(main(page.body)).toContain('<option value="side-gig">Side Gig</option>');
    expect(main(page.body)).not.toContain('<option value="default">');
    const pid = getProjectBySlug(t.db, 'with-access')!.id;
    const res = await asAlex('/p/with-access/move', { target: 'side-gig' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/p/with-access?done=moved');
    expect(res.cookies.find((c) => c.name === 'blindkey_ws')!.value).toBe('side-gig');
    expect(getProjectBySlug(t.db, 'with-access')!.workspace_id).toBe(getWorkspaceBySlug(t.db, 'side-gig')!.id);
    expect(getGrant(t.db, userId('bob'), 'project', pid)!.perms).toEqual(['cli']);
    const inNew = sidebar((await get(alex, '/p/with-access', { blindkey_ws: 'side-gig' })).body);
    expect(inNew).toContain('href="/p/with-access"');
  });

  it('moves global secrets and documents; a name conflict shows the 409 message', async () => {
    secretIn(null, 'MOVE_ME');
    const res = await asAlex('/global/secrets/MOVE_ME/move', { target: 'side-gig', workspace: 'default' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/global/secrets/MOVE_ME?workspace=side-gig&done=moved');
    expect(getSecretMeta(t.db, t.ring, null, 'MOVE_ME', getWorkspaceBySlug(t.db, 'side-gig')!.id)).not.toBeNull();

    secretIn(null, 'CLASH');
    secretIn(null, 'CLASH', getWorkspaceBySlug(t.db, 'side-gig')!.id);
    const clash = await asAlex('/global/secrets/CLASH/move', { target: 'side-gig', workspace: 'default' });
    expect(clash.statusCode).toBe(409);
    expect(clash.body).toContain('already');

    const doc = await asAlex('/global/docs/new-doc/move', { target: 'side-gig', workspace: 'default' });
    expect(doc.statusCode).toBe(302);
    expect(getDocument(t.db, null, 'new-doc', getWorkspaceBySlug(t.db, 'side-gig')!.id)).not.toBeNull();
  });

  it('global item pages offer the move; non-owners do not', async () => {
    secretIn(null, 'PAGE_S');
    expect(main((await get(alex, '/global/secrets/PAGE_S?workspace=default')).body)).toContain('Move to workspace');
    const id = getSecretMeta(t.db, t.ring, null, 'PAGE_S', t.workspaceId)!.id;
    upsertGrant(t.db, { userId: userId('bob'), targetType: 'secret', targetId: id, perms: ['public.read'] });
    const asBob = await get(bob, '/global/secrets/PAGE_S?workspace=default');
    expect(asBob.statusCode).toBe(200);
    expect(main(asBob.body)).not.toContain('Move to workspace');
    expect((await post(bob, '/global/secrets/PAGE_S/move', { csrf: bobCsrf, target: 'side-gig', workspace: 'default' })).statusCode).toBe(403);
  });
});

describe('secret page', () => {
  it('has no "Use without revealing" panel', async () => {
    secretIn('shared-app', 'PANEL');
    const res = await get(alex, '/p/shared-app/secrets/PANEL');
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('Use without revealing');
    expect(main(res.body)).toContain('Recent access');
  });
});

describe('CSRF', () => {
  it('every new POST rejects a missing token', async () => {
    const urls = [
      '/workspaces',
      '/w/default/settings',
      '/w/default/owners',
      '/w/default/owners/alex/remove',
      '/w/default/members',
      '/w/default/members/bob',
      '/w/default/members/bob/remove',
      '/p/shared-app/move',
      '/global/secrets/PAGE_S/move',
      '/global/docs/ghandbook/move',
    ];
    for (const url of urls) {
      const res = await post(alex, url, { target: 'side-gig', name: 'x', username: 'bob' });
      expect(res.statusCode, url).toBe(403);
    }
    const wrong = await post(alex, '/w/default/members/bob', { csrf: 'nope' });
    expect(wrong.statusCode).toBe(403);
  });
});
