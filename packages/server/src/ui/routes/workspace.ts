import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { DOC_PERMS, PERMS, SECRET_PERMS, type GrantTargetType, type Perm } from '@blindkey/shared';
import type { AppContext } from '../../http/context.js';
import type { Principal } from '../../auth/principal.js';
import { accessFor } from '../../auth/access.js';
import { AppError, ConflictError, NotFoundError, ValidationError } from '../../errors.js';
import type { WorkspaceRow } from '../../repos/workspaces.js';
import {
  addWorkspaceOwnerFor,
  applyUserGrantsFor,
  createWorkspaceFor,
  membersOverviewFor,
  moveGlobalDocumentFor,
  moveGlobalSecretFor,
  moveProjectFor,
  removeWorkspaceOwnerFor,
  renameWorkspaceFor,
  resourceTreeFor,
  searchUsersFor,
  removeUserGrantsFor,
  userGrantsFor,
  type DesiredGrant,
} from '../../services/workspaces.js';
import { assertCsrf } from '../csrf.js';
import { adminActor, requireAdmin, WORKSPACE_COOKIE } from '../session.js';
import { body, errorText, list, pageContext, str } from '../forms.js';
import { renderPage } from '../render.js';
import { secretPage } from './secrets.js';
import { docPage } from './documents.js';

const PRINTABLE_ASCII_RE = /^[\x21-\x7e]+$/;

/** A same-origin absolute path only: one leading slash, no `//`, no backslash, printable ASCII. Anything else becomes `/`. */
export function safeLocalPath(raw: string): string {
  if (raw.length === 0 || raw.length > 2000 || !PRINTABLE_ASCII_RE.test(raw)) return '/';
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return '/';
  return raw;
}

function setWorkspaceCookie(req: FastifyRequest, reply: FastifyReply, slug: string): void {
  reply.setCookie(WORKSPACE_COOKIE, slug, { path: '/', httpOnly: true, sameSite: 'lax', secure: req.protocol === 'https' });
}

/**
 * A workspace the caller owns. One they cannot see or only share in is the same 404 (these pages are
 * owner-only, and a member must not learn they exist). Also makes it the active workspace of this request.
 */
function ownedOr404(ctx: AppContext, principal: Principal, slug: string): WorkspaceRow {
  const access = accessFor(ctx.db, principal);
  const w = access.workspaceBySlug(slug);
  if (!access.owns(w.id)) throw new NotFoundError('workspace not found');
  principal.workspaceHint = w.slug;
  return w;
}

interface GrantNode {
  type: GrantTargetType;
  kind: string;
  key: string;
  name: string;
  label: string;
  granted: boolean;
  all: boolean;
  has: Record<string, boolean>;
  children?: GrantNode[];
  childrenOpen?: boolean;
}

const FULL: Record<GrantTargetType, readonly Perm[]> = { project: PERMS, secret: SECRET_PERMS, document: DOC_PERMS };

function nodeFor(type: GrantTargetType, id: number, label: string, kind: string, grants: Map<string, Perm[]>): GrantNode {
  const key = `${type}:${id}`;
  const perms = grants.get(key);
  const has: Record<string, boolean> = {};
  for (const p of perms ?? []) has[p] = true;
  // A resource without a grant starts as "All"; one with every perm also shows as "All".
  const all = perms === undefined || FULL[type].every((p) => has[p]);
  return { type, kind, key, name: `perm:${key}`, label, granted: perms !== undefined, all, has };
}

export function registerWorkspaceRoutes(app: FastifyInstance, ctx: AppContext): void {
  // The only place the workspace cookie is written (besides creating or moving into a workspace). A workspace the user cannot see is a 404.
  app.post('/workspace/switch', async (req, reply) => {
    assertCsrf(ctx, req);
    const principal = requireAdmin(req);
    const b = body(req);
    const w = accessFor(ctx.db, principal).workspaceBySlug(str(b, 'workspace'));
    setWorkspaceCookie(req, reply, w.slug);
    return reply.redirect(safeLocalPath(str(b, 'next', '/')), 302);
  });

  // --- create / settings ------------------------------------------------------------------

  const newForm = (req: FastifyRequest, form: { name: string; slug: string }, error: string | null) =>
    renderPage('workspace-new', { ...pageContext(ctx, req, 'New workspace'), form, error });

  app.get('/workspaces/new', async (req, reply) => {
    requireAdmin(req);
    return reply.type('text/html').send(newForm(req, { name: '', slug: '' }, null));
  });

  app.post('/workspaces', async (req, reply) => {
    assertCsrf(ctx, req);
    requireAdmin(req);
    const b = body(req);
    const form = { name: str(b, 'name'), slug: str(b, 'slug').trim() };
    try {
      const w = createWorkspaceFor(ctx, adminActor(req), { name: form.name, ...(form.slug ? { slug: form.slug } : {}) });
      setWorkspaceCookie(req, reply, w.slug);
      return reply.redirect(`/w/${encodeURIComponent(w.slug)}/members?done=created`, 302);
    } catch (err) {
      if (!(err instanceof ValidationError || err instanceof ConflictError)) throw err;
      const message = errorText(err);
      return reply.status(err.status).type('text/html').send(newForm(req, form, message));
    }
  });

  const settingsPage = (req: FastifyRequest, w: WorkspaceRow, form: { name: string; slug: string }, error: string | null) =>
    renderPage('workspace-settings', { ...pageContext(ctx, req, 'Workspace settings'), workspace: w, form, error });

  type WsParams = { Params: { ws: string } };

  app.get<WsParams>('/w/:ws/settings', async (req, reply) => {
    const w = ownedOr404(ctx, requireAdmin(req), req.params.ws);
    return reply.type('text/html').send(settingsPage(req, w, { name: w.name, slug: w.slug }, null));
  });

  app.post<WsParams>('/w/:ws/settings', async (req, reply) => {
    assertCsrf(ctx, req);
    const principal = requireAdmin(req);
    const w = ownedOr404(ctx, principal, req.params.ws);
    const b = body(req);
    const form = { name: str(b, 'name'), slug: str(b, 'slug').trim() };
    try {
      const updated = renameWorkspaceFor(ctx, adminActor(req), w.slug, { name: form.name, slug: form.slug });
      // The selected workspace is remembered by slug, so a rename must follow it.
      if (req.cookies?.[WORKSPACE_COOKIE] === w.slug) setWorkspaceCookie(req, reply, updated.slug);
      return reply.redirect(`/w/${encodeURIComponent(updated.slug)}/settings?done=saved`, 302);
    } catch (err) {
      if (!(err instanceof ValidationError || err instanceof ConflictError)) throw err;
      return reply.status(err.status).type('text/html').send(settingsPage(req, w, form, errorText(err)));
    }
  });

  // --- members ----------------------------------------------------------------------------

  const membersPage = (req: FastifyRequest, w: WorkspaceRow, principal: Principal, error: string | null) => {
    const overview = membersOverviewFor(ctx, principal, w.slug);
    return renderPage('workspace-members', { ...pageContext(ctx, req, 'Members'), workspace: w, owners: overview.owners, members: overview.members, error });
  };

  app.get<WsParams>('/w/:ws/members', async (req, reply) => {
    const principal = requireAdmin(req);
    const w = ownedOr404(ctx, principal, req.params.ws);
    return reply.type('text/html').send(membersPage(req, w, principal, null));
  });

  /** Runs a members-page action; a service refusal (e.g. removing the last owner) shows on the page. */
  async function memberAction(req: FastifyRequest<WsParams>, reply: FastifyReply, run: (slug: string) => string): Promise<unknown> {
    assertCsrf(ctx, req);
    const principal = requireAdmin(req);
    const w = ownedOr404(ctx, principal, req.params.ws);
    try {
      return reply.redirect(run(w.slug), 302);
    } catch (err) {
      if (!(err instanceof AppError) || err.status >= 500 || err.status === 403) throw err;
      return reply.status(err.status).type('text/html').send(membersPage(req, w, principal, errorText(err)));
    }
  }

  app.post<WsParams>('/w/:ws/owners', (req, reply) =>
    memberAction(req, reply, (slug) => {
      addWorkspaceOwnerFor(ctx, adminActor(req), slug, str(body(req), 'username').trim());
      return `/w/${encodeURIComponent(slug)}/members?done=added`;
    }),
  );

  app.post<{ Params: { ws: string; username: string } }>('/w/:ws/owners/:username/remove', (req, reply) =>
    memberAction(req, reply, (slug) => {
      removeWorkspaceOwnerFor(ctx, adminActor(req), slug, req.params.username);
      return `/w/${encodeURIComponent(slug)}/members?done=removed`;
    }),
  );

  // "Add user": an exact username, then straight into the access editor.
  app.post<WsParams>('/w/:ws/members', (req, reply) =>
    memberAction(req, reply, (slug) => {
      const [found] = searchUsersFor(ctx, requireAdmin(req), str(body(req), 'username').trim());
      if (!found) throw new NotFoundError('user not found');
      return `/w/${encodeURIComponent(slug)}/members/${encodeURIComponent(found.username)}`;
    }),
  );

  app.post<{ Params: { ws: string; username: string } }>('/w/:ws/members/:username/remove', (req, reply) =>
    memberAction(req, reply, (slug) => {
      removeUserGrantsFor(ctx, adminActor(req), slug, req.params.username);
      return `/w/${encodeURIComponent(slug)}/members?done=removed`;
    }),
  );

  // --- grant editor -----------------------------------------------------------------------

  type MemberParams = { Params: { ws: string; username: string } };

  function editorPage(req: FastifyRequest, w: WorkspaceRow, principal: Principal, username: string, error: string | null) {
    const tree = resourceTreeFor(ctx, principal, w.slug);
    const grants = new Map(userGrantsFor(ctx, principal, w.slug, username).map((g) => [`${g.target_type}:${g.target_id}`, g.perms]));
    const projects = tree.projects.map((p) => {
      const node = nodeFor('project', p.id, p.slug, 'project', grants);
      node.children = [
        ...p.secrets.map((s) => nodeFor('secret', s.id, s.name, 'secret', grants)),
        ...p.docs.map((d) => nodeFor('document', d.id, d.slug, 'document', grants)),
      ];
      node.childrenOpen = node.children.some((c) => c.granted);
      return node;
    });
    return renderPage('workspace-grants', {
      ...pageContext(ctx, req, `Access for ${username}`),
      workspace: w,
      username,
      globalDocs: tree.globalDocs.map((d) => nodeFor('document', d.id, d.slug, 'document', grants)),
      globalSecrets: tree.globalSecrets.map((s) => nodeFor('secret', s.id, s.name, 'secret', grants)),
      projects,
      error,
    });
  }

  app.get<MemberParams>('/w/:ws/members/:username', async (req, reply) => {
    const principal = requireAdmin(req);
    const w = ownedOr404(ctx, principal, req.params.ws);
    return reply.type('text/html').send(editorPage(req, w, principal, req.params.username, null));
  });

  app.post<MemberParams>('/w/:ws/members/:username', async (req, reply) => {
    assertCsrf(ctx, req);
    const principal = requireAdmin(req);
    const w = ownedOr404(ctx, principal, req.params.ws);
    const b = body(req);
    const desired: DesiredGrant[] = [];
    for (const key of new Set(list(b, 'access'))) {
      const m = /^(project|secret|document):(\d+)$/.exec(key);
      if (!m) throw new ValidationError([{ path: ['access'], message: `unknown resource "${key}"` }]);
      const type = m[1] as GrantTargetType;
      // A parent (`protected.*`) stands for both of its children; the service expands it.
      desired.push({ type, id: Number(m[2]), perms: list(b, `perm:${key}`) });
    }
    try {
      applyUserGrantsFor(ctx, adminActor(req), w.slug, req.params.username, desired);
    } catch (err) {
      if (!(err instanceof ValidationError || err instanceof ConflictError)) throw err;
      return reply.status(err.status).type('text/html').send(editorPage(req, w, principal, req.params.username, errorText(err)));
    }
    return reply.redirect(`/w/${encodeURIComponent(w.slug)}/members?done=saved`, 302);
  });

  // --- move to another workspace ----------------------------------------------------------

  app.post<{ Params: { slug: string } }>('/p/:slug/move', async (req, reply) => {
    assertCsrf(ctx, req);
    requireAdmin(req);
    const target = str(body(req), 'target');
    moveProjectFor(ctx, adminActor(req), req.params.slug, target);
    setWorkspaceCookie(req, reply, target);
    return reply.redirect(`/p/${encodeURIComponent(req.params.slug)}?done=moved`, 302);
  });

  /** Runs a global-item move; a refusal (name taken in the target, not an owner of it) shows on the item's page. */
  async function globalMove(req: FastifyRequest, reply: FastifyReply, kind: 'secrets' | 'docs', name: string): Promise<unknown> {
    assertCsrf(ctx, req);
    const principal = requireAdmin(req);
    const target = str(body(req), 'target');
    const from = accessFor(ctx.db, principal).resolveGlobalWorkspace(str(body(req), 'workspace') || null);
    try {
      if (kind === 'secrets') moveGlobalSecretFor(ctx, adminActor(req), from.slug, name, target);
      else moveGlobalDocumentFor(ctx, adminActor(req), from.slug, name, target);
    } catch (err) {
      if (!(err instanceof AppError) || (err.status !== 409 && err.status !== 403 && err.status !== 400)) throw err;
      const scope = { projectSlug: null, prefix: '/global' };
      const page = kind === 'secrets' ? secretPage(ctx, req, principal, scope, name, errorText(err)) : docPage(ctx, req, principal, scope, name, errorText(err));
      return reply.status(err.status).type('text/html').send(page);
    }
    setWorkspaceCookie(req, reply, target);
    return reply.redirect(`/global/${kind}/${encodeURIComponent(name)}?workspace=${encodeURIComponent(target)}&done=moved`, 302);
  }

  app.post<{ Params: { name: string } }>('/global/secrets/:name/move', (req, reply) => globalMove(req, reply, 'secrets', req.params.name));
  app.post<{ Params: { doc: string } }>('/global/docs/:doc/move', (req, reply) => globalMove(req, reply, 'docs', req.params.doc));
}
