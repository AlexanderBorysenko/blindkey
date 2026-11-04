import { afterEach, describe, expect, it } from 'vitest';
import { actorOf, makeShared, jsonAs, type Shared } from './access.fixture.js';
import {
  addWorkspaceOwnerFor, createWorkspaceFor, listMembersFor, moveGlobalDocumentFor, moveGlobalSecretFor, moveProjectFor,
  removeGrantFor, removeWorkspaceOwnerFor, renameWorkspaceFor, searchUsersFor, setGrantFor, slugify,
} from '../src/services/workspaces.js';
import { listAudit } from '../src/repos/audit.js';
import { getGrant } from '../src/repos/grants.js';
import { setUserDisabled } from '../src/repos/admin.js';
import { getWorkspaceBySlug } from '../src/repos/workspaces.js';
import { getProjectBySlug } from '../src/repos/projects.js';
import { createSecret, getSecretMeta } from '../src/repos/secrets.js';
import { getDocument, upsertDocument } from '../src/repos/documents.js';
import { AppError, ConflictError, NotFoundError, PermissionError, ValidationError } from '../src/errors.js';

let t: Shared;
afterEach(async () => {
  await t?.app.close();
});

describe('workspace management', () => {
  it('slugify derives a valid slug and refuses names with nothing usable', () => {
    expect(slugify('  Third! ')).toBe('third');
    expect(() => slugify('!!!')).toThrow(ValidationError);
  });

  it('any user creates a workspace and becomes its only owner; it is audited with its workspace id', async () => {
    t = await makeShared();
    const w = createWorkspaceFor(t.ctx, actorOf(t.erin), { name: 'Erin Lab' });
    expect(w).toEqual({ slug: 'erin-lab', name: 'Erin Lab', role: 'owner' });
    const row = getWorkspaceBySlug(t.db, 'erin-lab')!;
    const audit = listAudit(t.db, { action: 'workspace.create' })[0]!;
    expect(audit.workspace_id).toBe(row.id);
    expect(audit.actor_id).toBe(t.erin.id);
    expect(jsonAs<{ slug: string; role: string }[]>(await t.call(t.erin, 'GET', '/api/v1/workspaces'))).toEqual([{ slug: 'erin-lab', name: 'Erin Lab', role: 'owner' }]);
    expect(() => createWorkspaceFor(t.ctx, actorOf(t.erin), { name: 'Again', slug: 'erin-lab' })).toThrow(ConflictError);
    expect(() => createWorkspaceFor(t.ctx, actorOf(t.erin), { name: 'Bad', slug: 'Not A Slug' })).toThrow(ValidationError);
  });

  it('rename is owner-only: a member gets 403, an outsider 404', async () => {
    t = await makeShared();
    const owner = t.owner();
    expect(renameWorkspaceFor(t.ctx, actorOf(owner), 'default', { name: 'Default Ltd' })).toEqual({ slug: 'default', name: 'Default Ltd', role: 'owner' });
    expect(() => renameWorkspaceFor(t.ctx, actorOf(t.bob), 'default', { name: 'Mine now' })).toThrow(PermissionError);
    expect(() => renameWorkspaceFor(t.ctx, actorOf(t.erin), 'default', { name: 'Mine now' })).toThrow(NotFoundError);
    expect(() => renameWorkspaceFor(t.ctx, actorOf(owner), 'default', { slug: 'BAD SLUG' })).toThrow(ValidationError);
    expect(getWorkspaceBySlug(t.db, 'default')!.name).toBe('Default Ltd');
    // a token without the admin scope cannot manage workspaces at all
    expect(() => renameWorkspaceFor(t.ctx, actorOf(owner, ['projects:read']), 'default', { name: 'x' })).toThrow(AppError);
  });

  it('owners: add, refuse a duplicate, and never remove the last one', async () => {
    t = await makeShared();
    const owner = t.owner();
    expect(() => addWorkspaceOwnerFor(t.ctx, actorOf(t.bob), 'default', 'erin')).toThrow(PermissionError);
    addWorkspaceOwnerFor(t.ctx, actorOf(owner), 'default', 'bob');
    expect(() => addWorkspaceOwnerFor(t.ctx, actorOf(owner), 'default', 'bob')).toThrow(ConflictError);
    expect(() => addWorkspaceOwnerFor(t.ctx, actorOf(owner), 'default', 'nobody')).toThrow(NotFoundError);
    // bob now owns it: he sees everything and may create projects
    expect((await t.call(t.bob, 'POST', '/api/v1/projects', { workspace: 'default', slug: 'bobs', name: 'Bobs' })).status).toBe(201);
    expect(jsonAs<{ slug: string }[]>(await t.call(t.bob, 'GET', '/api/v1/projects')).map((p) => p.slug)).toEqual(['alpha', 'beta', 'bobs', 'gamma']);
    removeWorkspaceOwnerFor(t.ctx, actorOf(owner), 'default', 'alex');
    // bob is the last owner now
    expect(() => removeWorkspaceOwnerFor(t.ctx, actorOf(t.bob), 'default', 'bob')).toThrow(ConflictError);
    expect(() => removeWorkspaceOwnerFor(t.ctx, actorOf(t.bob), 'default', 'carol')).toThrow(NotFoundError);
    expect(listAudit(t.db, { action: 'workspace.owner_remove' })).toHaveLength(1);
  });

  it('grants: owner-only, normalised, validated per target type and confined to the workspace', async () => {
    t = await makeShared();
    const owner = t.owner();
    const beta = getProjectBySlug(t.db, 'beta')!;
    const other = createWorkspaceFor(t.ctx, actorOf(owner), { name: 'Elsewhere' });
    expect(other.slug).toBe('elsewhere');
    const elsewhereProject = (await t.call(owner, 'POST', '/api/v1/projects', { workspace: 'elsewhere', slug: 'away', name: 'Away' })).json as { slug: string };
    const away = getProjectBySlug(t.db, elsewhereProject.slug)!;

    const g = setGrantFor(t.ctx, actorOf(owner), 'default', 'erin', { type: 'project', id: beta.id }, ['protected.*', 'public.read']);
    expect(g.perms).toEqual(['public.read', 'protected.read', 'protected.write']);
    expect(getGrant(t.db, t.erin.id, 'project', beta.id)!.perms).toEqual(g.perms);
    expect(listAudit(t.db, { action: 'grant.set' })[0]!.workspace_id).toBe(getWorkspaceBySlug(t.db, 'default')!.id);
    // replaces, never merges
    expect(setGrantFor(t.ctx, actorOf(owner), 'default', 'erin', { type: 'project', id: beta.id }, ['*']).perms).toHaveLength(7);

    expect(() => setGrantFor(t.ctx, actorOf(t.bob), 'default', 'erin', { type: 'project', id: beta.id }, ['*'])).toThrow(PermissionError);
    expect(() => setGrantFor(t.ctx, actorOf(t.erin), 'elsewhere', 'bob', { type: 'project', id: away.id }, ['*'])).toThrow(NotFoundError);
    // a target of another workspace (or one that does not exist) is the same 404
    expect(() => setGrantFor(t.ctx, actorOf(owner), 'default', 'erin', { type: 'project', id: away.id }, ['*'])).toThrow(NotFoundError);
    expect(() => setGrantFor(t.ctx, actorOf(owner), 'default', 'erin', { type: 'project', id: 99999 }, ['*'])).toThrow(NotFoundError);
    const secretId = getSecretMeta(t.db, t.ring, beta.id, 'DB')!.id;
    expect(() => setGrantFor(t.ctx, actorOf(owner), 'default', 'erin', { type: 'secret', id: secretId }, ['docs.read'])).toThrow(ValidationError);
    expect(() => setGrantFor(t.ctx, actorOf(owner), 'default', 'erin', { type: 'secret', id: secretId }, ['nonsense'])).toThrow(ValidationError);
    expect(() => setGrantFor(t.ctx, actorOf(owner), 'default', 'erin', { type: 'secret', id: secretId }, [])).toThrow(ValidationError);
    expect(() => setGrantFor(t.ctx, actorOf(owner), 'default', 'ghost', { type: 'secret', id: secretId }, ['cli'])).toThrow(NotFoundError);

    removeGrantFor(t.ctx, actorOf(owner), 'default', 'erin', { type: 'project', id: beta.id });
    expect(getGrant(t.db, t.erin.id, 'project', beta.id)).toBeNull();
    expect(() => removeGrantFor(t.ctx, actorOf(owner), 'default', 'erin', { type: 'project', id: beta.id })).toThrow(NotFoundError);
    expect(listAudit(t.db, { action: 'grant.remove' })).toHaveLength(1);
  });

  it('members: owners plus everyone holding a grant, with their grants', async () => {
    t = await makeShared();
    const owner = t.owner();
    const members = listMembersFor(t.ctx, actorOf(owner).principal, 'default');
    expect(members.owners.map((o) => o.username)).toEqual(['alex']);
    expect(members.members.map((m) => m.user.username)).toEqual(['bob', 'carol', 'dave']);
    expect(members.members.find((m) => m.user.username === 'carol')!.grants).toEqual([
      { target_type: 'secret', target_id: getSecretMeta(t.db, t.ring, getProjectBySlug(t.db, 'beta')!.id, 'DB')!.id, perms: ['cli'] },
    ]);
    expect(() => listMembersFor(t.ctx, actorOf(t.bob).principal, 'default')).toThrow(PermissionError);
    expect(() => listMembersFor(t.ctx, actorOf(t.erin).principal, 'default')).toThrow(NotFoundError);
  });

  it('user lookup for the add-user box: owners only, exact username only, unknown and disabled look the same', async () => {
    t = await makeShared();
    const owner = actorOf(t.owner()).principal;
    expect(searchUsersFor(t.ctx, owner, 'bob')).toEqual([{ username: 'bob' }]);
    expect(searchUsersFor(t.ctx, owner, ' bob ')).toEqual([{ username: 'bob' }]);
    // no substring / prefix matching, no listing
    for (const q of ['o', 'bo', 'ob', '%', '', '  ']) expect(() => searchUsersFor(t.ctx, owner, q)).toThrow(NotFoundError);
    setUserDisabled(t.db, t.carol.id, true);
    const disabled = (() => { try { searchUsersFor(t.ctx, owner, 'carol'); } catch (e) { return e as AppError; } throw new Error('did not throw'); })();
    const unknown = (() => { try { searchUsersFor(t.ctx, owner, 'nobody'); } catch (e) { return e as AppError; } throw new Error('did not throw'); })();
    expect(disabled).toBeInstanceOf(NotFoundError);
    expect({ status: disabled.status, code: disabled.code, message: disabled.message }).toEqual({ status: unknown.status, code: unknown.code, message: unknown.message });
    // adding an owner / a grant answers the same way
    expect(() => addWorkspaceOwnerFor(t.ctx, actorOf(t.owner()), 'default', 'carol')).toThrow(NotFoundError);
    expect(() => addWorkspaceOwnerFor(t.ctx, actorOf(t.owner()), 'default', 'nobody')).toThrow(NotFoundError);
    expect(() => searchUsersFor(t.ctx, actorOf(t.erin).principal, 'bob')).toThrow(NotFoundError);
  });
});

describe('moving things between workspaces', () => {
  it('moves a project with its items and grants; needs ownership of both sides', async () => {
    t = await makeShared();
    const owner = t.owner();
    createWorkspaceFor(t.ctx, actorOf(owner), { name: 'Target' });
    createWorkspaceFor(t.ctx, actorOf(t.erin), { name: 'Erins' });
    const alpha = getProjectBySlug(t.db, 'alpha')!;

    expect(() => moveProjectFor(t.ctx, actorOf(t.bob), 'alpha', 'target')).toThrow(PermissionError); // bob sees the project but does not own its workspace
    expect(() => moveProjectFor(t.ctx, actorOf(owner), 'alpha', 'erins')).toThrow(NotFoundError); // cannot see the target at all
    expect(() => moveProjectFor(t.ctx, actorOf(owner), 'alpha', 'default')).toThrow(ValidationError);
    expect(moveProjectFor(t.ctx, actorOf(owner), 'alpha', 'target').workspace).toBe('target');

    const moved = getProjectBySlug(t.db, 'alpha')!;
    const targetId = getWorkspaceBySlug(t.db, 'target')!.id;
    expect(moved.workspace_id).toBe(targetId);
    expect(getSecretMeta(t.db, t.ring, alpha.id, 'ADB')!.workspace_id).toBe(targetId);
    expect(getDocument(t.db, alpha.id, 'notes')!.workspace_id).toBe(targetId);
    // bob's grant went along: he now sees the project in the new workspace
    expect(jsonAs<{ slug: string; workspace: string }[]>(await t.call(t.bob, 'GET', '/api/v1/projects'))).toMatchObject([{ slug: 'alpha', workspace: 'target' }]);
    expect((await t.call(t.bob, 'GET', '/api/v1/projects/alpha/secrets/ADB')).status).toBe(200);
    // both workspaces' owners find the move in their audit log
    const rows = listAudit(t.db, { action: 'project.move' });
    expect(rows.map((r) => r.workspace_id).sort()).toEqual([getWorkspaceBySlug(t.db, 'default')!.id, targetId].sort());
    // moving back is refused to a member who owns neither side
    expect(() => moveProjectFor(t.ctx, actorOf(t.bob), 'alpha', 'default')).toThrow(PermissionError);
  });

  it('moves global secrets and documents; a name clash is a 409 and nothing moves', async () => {
    t = await makeShared();
    const owner = t.owner();
    createWorkspaceFor(t.ctx, actorOf(owner), { name: 'Target' });
    const targetId = getWorkspaceBySlug(t.db, 'target')!.id;
    createSecret(t.db, t.ring, { projectId: null, workspaceId: targetId, name: 'GLOBAL_S', description: '', tags: [], fields: [{ key: 'host', value: 'h' }] });
    expect(() => moveGlobalSecretFor(t.ctx, actorOf(owner), 'default', 'GLOBAL_S', 'target')).toThrow(ConflictError);
    expect(getSecretMeta(t.db, t.ring, null, 'GLOBAL_S', t.workspaceId)).not.toBeNull();
    createSecret(t.db, t.ring, { projectId: null, workspaceId: t.workspaceId, name: 'MOVER', description: '', tags: [], fields: [{ key: 'host', value: 'h' }] });
    moveGlobalSecretFor(t.ctx, actorOf(owner), 'default', 'MOVER', 'target');
    expect(getSecretMeta(t.db, t.ring, null, 'MOVER', targetId)).not.toBeNull();
    expect(getSecretMeta(t.db, t.ring, null, 'MOVER', t.workspaceId)).toBeNull();

    upsertDocument(t.db, { projectId: null, workspaceId: targetId, slug: 'ghandbook', title: 'x', category: 'notes', body_md: 'x' });
    expect(() => moveGlobalDocumentFor(t.ctx, actorOf(owner), 'default', 'ghandbook', 'target')).toThrow(ConflictError);
    expect(() => moveGlobalDocumentFor(t.ctx, actorOf(t.bob), 'default', 'ghandbook', 'target')).toThrow(AppError);
    expect(() => moveGlobalDocumentFor(t.ctx, actorOf(owner), 'default', 'missing', 'target')).toThrow(NotFoundError);
  });
});
