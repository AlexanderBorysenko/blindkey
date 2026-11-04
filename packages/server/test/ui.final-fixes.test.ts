import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeTestApp, type TestCtx } from './helpers.js';
import { createAdmin, createSession, createUser, getUserByUsername, setUserDisabled } from '../src/repos/admin.js';
import { createSecret } from '../src/repos/secrets.js';
import { upsertDocument } from '../src/repos/documents.js';
import { getProjectBySlug } from '../src/repos/projects.js';
import { addOwner, createWorkspace, getWorkspaceBySlug } from '../src/repos/workspaces.js';
import { listGrantsForUser, upsertGrant } from '../src/repos/grants.js';
import { listAudit } from '../src/repos/audit.js';
import { accessFor } from '../src/auth/access.js';
import type { Principal } from '../src/auth/principal.js';
import { csrfTokenFor } from '../src/ui/csrf.js';
import { hashPassword } from '../src/crypto/passwords.js';

let t: TestCtx;
let alex: string;

const main = (html: string): string => html.split('<main')[1]!.split('</main>')[0]!;
const userId = (name: string) => getUserByUsername(t.db, name)!.id;
const sessionFor = (username: string) => createSession(t.db, userId(username), 3_600_000, '127.0.0.1', 'test');
const get = (session: string, url: string, cookies: Record<string, string> = {}) =>
  t.app.inject({ method: 'GET', url, cookies: { blindkey_session: session, ...cookies } });
const post = (session: string, url: string, payload: Record<string, unknown>, cookies: Record<string, string> = {}) =>
  t.app.inject({ method: 'POST', url, cookies: { blindkey_session: session, ...cookies }, payload: { csrf: csrfTokenFor(t.ctx, session), ...payload } });

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
  for (const name of ['dave', 'fay', 'cliuser', 'docwriter', 'reader', 'docreader', 'gone']) {
    createUser(t.db, { username: name, passwordHash: await hashPassword(`${name}-password-1`) });
  }
  alex = sessionFor('alex');
  t.project('qa-proj');
});
afterAll(async () => {
  await t.app.close();
});

describe('users without any workspace', () => {
  it('/, /global/secrets and /global/docs show a friendly empty state, with no switcher', async () => {
    const dave = sessionFor('dave');
    for (const url of ['/', '/global/secrets', '/global/docs']) {
      const res = await get(dave, url);
      expect(res.statusCode, url).toBe(200);
      expect(main(res.body), url).toContain("You don't have access to any workspace yet. Ask an owner to share something, or create your own workspace.");
      expect(res.body, url).not.toContain('ws-switch');
    }
  });

  it('POST /projects answers 403 with a message, not "validation failed"', async () => {
    const res = await post(sessionFor('dave'), '/projects', { slug: 'mine', name: 'Mine', status: 'active', tags: '', summary: '' });
    expect(res.statusCode).toBe(403);
    expect(main(res.body)).toMatch(/own any workspace/);
    expect(main(res.body)).not.toContain('validation failed');
    expect(getProjectBySlug(t.db, 'mine')).toBeNull();
  });
});

describe('creating a project never falls back to another owned workspace', () => {
  let fayWs: number;
  beforeAll(() => {
    const w = createWorkspace(t.db, { slug: 'fay-ws', name: 'Fay WS' });
    fayWs = w.id;
    addOwner(t.db, w.id, userId('fay'));
    // fay is only a member of `default`
    upsertGrant(t.db, { userId: userId('fay'), targetType: 'project', targetId: getProjectBySlug(t.db, 'qa-proj')!.id, perms: ['docs.read'] });
  });

  it('a posted workspace fay does not own is a 403, and nothing lands in her own workspace', async () => {
    const res = await post(sessionFor('fay'), '/projects', { slug: 'sneaky', name: 'S', status: 'active', tags: '', summary: '', workspace: 'default' });
    expect(res.statusCode).toBe(403);
    expect(main(res.body)).toContain('own this workspace');
    expect(getProjectBySlug(t.db, 'sneaky')).toBeNull();
  });

  it('a posted workspace fay owns works', async () => {
    const res = await post(sessionFor('fay'), '/projects', { slug: 'fay-proj', name: 'F', status: 'active', tags: '', summary: '', workspace: 'fay-ws' });
    expect(res.statusCode).toBe(302);
    expect(getProjectBySlug(t.db, 'fay-proj')!.workspace_id).toBe(fayWs);
  });

  it('resolveProjectWorkspace: a selected (hint) workspace that is not owned is a 403, never another owned one', () => {
    const principal = (hint: string | null): Principal => ({
      kind: 'admin', id: userId('fay'), userId: userId('fay'), isSuper: false, impersonatorId: null, workspaceHint: hint, scopes: ['admin'], projectIds: null, agent: false,
    });
    const status = (fn: () => unknown): number | string => {
      try {
        fn();
        return 'ok';
      } catch (e) {
        return (e as { status?: number }).status ?? 'other';
      }
    };
    expect(status(() => accessFor(t.db, principal('default')).resolveProjectWorkspace(undefined))).toBe(403);
    expect(status(() => accessFor(t.db, principal(null)).resolveProjectWorkspace('default'))).toBe(403);
    expect(accessFor(t.db, principal('default')).resolveProjectWorkspace('fay-ws').slug).toBe('fay-ws');
    expect(accessFor(t.db, principal('fay-ws')).resolveProjectWorkspace(undefined).slug).toBe('fay-ws');
    expect(accessFor(t.db, principal(null)).resolveProjectWorkspace(undefined).slug).toBe('fay-ws');
  });

  it('a global move into a workspace the user sees but does not own shows the 403 inline', async () => {
    secretIn(null, 'FAY_G', fayWs);
    const res = await post(sessionFor('fay'), '/global/secrets/FAY_G/move', { target: 'default', workspace: 'fay-ws' });
    expect(res.statusCode).toBe(403);
    expect(main(res.body)).toContain('role="alert"');
    expect(main(res.body)).toContain('FAY_G');
  });
});

describe('controls the user cannot use are hidden', () => {
  let proj: number;
  beforeAll(() => {
    proj = getProjectBySlug(t.db, 'qa-proj')!.id;
    secretIn('qa-proj', 'QA');
    upsertDocument(t.db, { projectId: proj, workspaceId: t.workspaceId, slug: 'notes', title: 'Notes', category: 'notes', body_md: 'hello' });
    upsertGrant(t.db, { userId: userId('cliuser'), targetType: 'project', targetId: proj, perms: ['cli'] });
    upsertGrant(t.db, { userId: userId('docwriter'), targetType: 'project', targetId: proj, perms: ['docs.read', 'docs.write'] });
    upsertGrant(t.db, { userId: userId('reader'), targetType: 'project', targetId: proj, perms: ['public.read', 'protected.read', 'docs.read'] });
    upsertGrant(t.db, { userId: userId('docreader'), targetType: 'project', targetId: proj, perms: ['docs.read'] });
  });

  it('a cli-only user sees no value, no Copy, no Reveal, no Edit and no Delete on a secret; its edit page is a 403', async () => {
    const s = sessionFor('cliuser');
    const res = await get(s, '/p/qa-proj/secrets/QA');
    expect(res.statusCode).toBe(200);
    const m = main(res.body);
    expect(m).not.toContain('undefined');
    expect(m).not.toContain('h.example');
    expect(m).toContain('data-field-row="host"');
    expect(m).toContain('class="masked"');
    expect(m).not.toContain('copy-field');
    expect(m).not.toContain('/reveal');
    expect(m).not.toContain('Reveal');
    expect(m).not.toContain('/secrets/QA/edit');
    expect(m).not.toContain('delete-secret');
    expect((await get(s, '/p/qa-proj/secrets/QA/edit')).statusCode).toBe(403);
    expect((await get(s, '/p/qa-proj/secrets/new')).statusCode).toBe(403);
  });

  it('a reader can reveal and copy but not edit or delete', async () => {
    const m = main((await get(sessionFor('reader'), '/p/qa-proj/secrets/QA')).body);
    expect(m).toContain('/secrets/QA/reveal');
    expect(m).toContain('copy-field');
    expect(m).not.toContain('/secrets/QA/edit');
    expect(m).not.toContain('delete-secret');
  });

  it('the owner sees everything', async () => {
    const m = main((await get(alex, '/p/qa-proj/secrets/QA')).body);
    for (const needle of ['/secrets/QA/edit', 'delete-secret', '/secrets/QA/reveal', 'copy-field']) expect(m).toContain(needle);
    const p = main((await get(alex, '/p/qa-proj')).body);
    for (const needle of ['edit-project', 'delete-project', 'docs/new/edit']) expect(p).toContain(needle);
  });

  it('project page: cli-only has no edit/delete/new buttons; docs.write can edit and add documents but not delete or add secrets', async () => {
    const cli = main((await get(sessionFor('cliuser'), '/p/qa-proj?tab=secrets')).body);
    for (const needle of ['edit-project', 'delete-project', 'secrets/new', 'docs/new']) expect(cli, needle).not.toContain(needle);

    const dw = sessionFor('docwriter');
    const docs = main((await get(dw, '/p/qa-proj')).body);
    expect(docs).toContain('data-open-dialog="edit-project"');
    expect(docs).toContain('docs/new/edit');
    expect(docs).not.toContain('delete-project');
    const secrets = main((await get(dw, '/p/qa-proj?tab=secrets')).body);
    expect(secrets).not.toContain('secrets/new');
  });

  it('document page: only docs.write shows Edit and Delete, and the edit page is a 403 without it', async () => {
    const reader = sessionFor('docreader');
    const m = main((await get(reader, '/p/qa-proj/docs/notes')).body);
    expect(m).not.toContain('/docs/notes/edit');
    expect(m).not.toContain('delete-document');
    expect((await get(reader, '/p/qa-proj/docs/notes/edit')).statusCode).toBe(403);
    expect((await get(reader, '/p/qa-proj/docs/new/edit')).statusCode).toBe(403);

    const w = sessionFor('docwriter');
    const mw = main((await get(w, '/p/qa-proj/docs/notes')).body);
    expect(mw).toContain('/docs/notes/edit');
    expect(mw).toContain('delete-document');
    expect((await get(w, '/p/qa-proj/docs/notes/edit')).statusCode).toBe(200);
  });

  it('global lists: members get no New buttons', async () => {
    const g = secretIn(null, 'GLOBAL_Q');
    upsertGrant(t.db, { userId: userId('reader'), targetType: 'secret', targetId: g.id, perms: ['public.read'] });
    const res = await get(sessionFor('reader'), '/global/secrets');
    expect(res.statusCode).toBe(200);
    expect(main(res.body)).toContain('GLOBAL_Q');
    expect(main(res.body)).not.toContain('secrets/new');
    expect(main((await get(alex, '/global/secrets')).body)).toContain('secrets/new');
  });
});

describe('members page: disabled users', () => {
  it('a disabled member is tagged, cannot be edited, and their grants can still be removed', async () => {
    const proj = getProjectBySlug(t.db, 'qa-proj')!.id;
    upsertGrant(t.db, { userId: userId('gone'), targetType: 'project', targetId: proj, perms: ['cli'] });
    setUserDisabled(t.db, userId('gone'), true);

    const page = main((await get(alex, '/w/default/members')).body);
    expect(page).toContain('<span class="tag">disabled</span>');
    expect(page).not.toContain('/w/default/members/gone"');
    expect(page).toContain('/w/default/members/gone/remove');

    const res = await post(alex, '/w/default/members/gone/remove', {});
    expect(res.statusCode).toBe(302);
    expect(listGrantsForUser(t.db, userId('gone'))).toEqual([]);
    expect(listAudit(t.db, { action: 'grant.remove' }).some((r) => r.meta !== null && (r.meta as { user?: string }).user === 'gone')).toBe(true);
    expect(main((await get(alex, '/w/default/members')).body)).not.toContain('gone');
  });

  it('an empty members list says so', async () => {
    const w = createWorkspace(t.db, { slug: 'lonely', name: 'Lonely' });
    addOwner(t.db, w.id, userId('alex'));
    expect(main((await get(alex, '/w/lonely/members')).body)).toContain('No members besides the owners.');
  });
});

describe('move dialog', () => {
  it('tells owners that global references resolve in the new workspace', async () => {
    createWorkspace(t.db, { slug: 'elsewhere', name: 'Elsewhere' });
    addOwner(t.db, getWorkspaceBySlug(t.db, 'elsewhere')!.id, userId('alex'));
    secretIn(null, 'DIALOG_S');
    const m = main((await get(alex, '/global/secrets/DIALOG_S?workspace=default')).body);
    expect(m).toContain('References to global items ({{secret:global/…}}, bare <code>global</code> in CLI) will resolve in the new workspace.');
  });
});

describe('workspace settings change name and slug', () => {
  it('owners can change both; an invalid slug is a 400 and a taken one a 409', async () => {
    createWorkspace(t.db, { slug: 'taken', name: 'Taken' });
    const ok = await post(alex, '/w/lonely/settings', { name: 'Lonelier', slug: 'lonelier' });
    expect(ok.statusCode).toBe(302);
    const w = getWorkspaceBySlug(t.db, 'lonelier')!;
    expect(w.name).toBe('Lonelier');
    expect(getWorkspaceBySlug(t.db, 'lonely')).toBeNull();
    expect((await post(alex, '/w/lonelier/settings', { name: 'X', slug: 'Not Valid' })).statusCode).toBe(400);
    expect((await post(alex, '/w/lonelier/settings', { name: 'X', slug: 'taken' })).statusCode).toBe(409);
  });
});
