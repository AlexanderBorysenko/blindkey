import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Principal } from '../../auth/principal.js';
import { DOC_CATEGORIES, PROJECT_STATUSES, projectInputSchema, projectPatchSchema } from '@blindkey/shared';
import type { AppContext } from '../../http/context.js';
import { AppError, ValidationError } from '../../errors.js';
import { deleteProjectFor, getProjectDetailFor, listProjectsFor, updateProjectFor } from '../../services/projects.js';
import { searchFor } from '../../services/search.js';
import { createProjectWithAccess } from '../../services/create-with-access.js';
import { accessFor } from '../../auth/access.js';
import { getWorkspaceBySlug } from '../../repos/workspaces.js';
import { adminActor, requireAdmin } from '../session.js';
import { accessEntries, accessFieldFor, activeWorkspace, moveTargets } from '../workspace-ui.js';
import { assertCsrf } from '../csrf.js';
import { body, pageContext, parseTags, str } from '../forms.js';
import { renderPage } from '../render.js';
import { projectCaps } from '../caps.js';

type ListQs = { Querystring: { status?: string; q?: string } };

export function registerProjectRoutes(app: FastifyInstance, ctx: AppContext): void {
  type NewProjectForm = { slug: string; name: string; status: string; tags: string; summary: string };
  const emptyForm: NewProjectForm = { slug: '', name: '', status: 'active', tags: '', summary: '' };

  /** The projects list of the active workspace, with the create dialog (open on an error or when asked for). */
  function listPage(req: FastifyRequest, principal: Principal, status: string, error: string | null, form: NewProjectForm, openNew: boolean) {
    const workspace = activeWorkspace(ctx, principal);
    if (workspace === null) return renderPage('no-workspace', { ...pageContext(ctx, req, 'Projects'), error });
    const all = listProjectsFor(ctx, principal);
    const inWorkspace = workspace ? all.filter((p) => p.workspace === workspace.slug) : all;
    const canCreate = workspace !== null && accessFor(ctx.db, principal).owns(workspace.id);
    return renderPage('projects', {
      ...pageContext(ctx, req, 'Projects'),
      projects: status ? inWorkspace.filter((p) => p.status === status) : inWorkspace,
      statuses: PROJECT_STATUSES,
      status,
      workspace,
      canCreate,
      access: canCreate ? accessFieldFor(ctx, principal, workspace.id, 'project') : null,
      openNew: canCreate && (openNew || error !== null),
      error,
      form,
    });
  }

  app.get<ListQs & { Querystring: { new?: string } }>('/', async (req, reply) => {
    const principal = requireAdmin(req);
    return reply.type('text/html').send(listPage(req, principal, req.query.status ?? '', null, emptyForm, req.query.new !== undefined));
  });

  app.get<ListQs>('/search', async (req, reply) => {
    const principal = requireAdmin(req);
    const q = req.query.q ?? '';
    return reply.type('text/html').send(
      renderPage('search', { ...pageContext(ctx, req, `Search: ${q}`), q, result: q ? searchFor(ctx, principal, q) : {} }),
    );
  });

  app.post('/projects', async (req, reply) => {
    assertCsrf(ctx, req);
    const principal = requireAdmin(req);
    const b = body(req);
    const parsed = projectInputSchema.safeParse({
      slug: str(b, 'slug'),
      name: str(b, 'name'),
      status: str(b, 'status', 'active'),
      tags: parseTags(b.tags),
      summary: str(b, 'summary'),
    });
    if (!parsed.success) {
      const message = parsed.error.issues.map((i) => `${i.path.join('.') || 'form'}: ${i.message}`).join('; ');
      return reply.status(400).type('text/html').send(
        listPage(req, principal, '', message, { slug: str(b, 'slug'), name: str(b, 'name'), status: str(b, 'status', 'active'), tags: str(b, 'tags'), summary: str(b, 'summary') }, true),
      );
    }
    // The form names the workspace it was rendered for (hidden field); never guess another one.
    const workspace = str(b, 'workspace');
    let project;
    try {
      project = createProjectWithAccess(ctx, adminActor(req), { ...parsed.data, ...(workspace ? { workspace } : {}) }, accessEntries(req));
    } catch (err) {
      if (!(err instanceof AppError) || err.status !== 403) throw err;
      return reply.status(403).type('text/html').send(
        listPage(req, principal, '', err.message, { slug: str(b, 'slug'), name: str(b, 'name'), status: str(b, 'status', 'active'), tags: str(b, 'tags'), summary: str(b, 'summary') }, false),
      );
    }
    return reply.redirect(`/p/${encodeURIComponent(project.slug)}?done=created`, 302);
  });

  const moveTargetsFor = (req: FastifyRequest, workspaceSlug: string) => {
    const w = getWorkspaceBySlug(ctx.db, workspaceSlug);
    return w ? moveTargets(ctx, requireAdmin(req), w.id) : [];
  };

  type SlugParams = { Params: { slug: string }; Querystring: { tab?: string } };

  app.get<SlugParams>('/p/:slug', async (req, reply) => {
    const principal = requireAdmin(req);
    const detail = getProjectDetailFor(ctx, principal, req.params.slug);
    const tab = req.query.tab === 'secrets' ? 'secrets' : 'docs';
    return reply.type('text/html').send(
      renderPage('project', {
        ...pageContext(ctx, req, detail.slug),
        project: detail,
        moveTargets: moveTargetsFor(req, detail.workspace),
        ...projectCaps(ctx, principal, detail.slug),
        tab,
        statuses: PROJECT_STATUSES,
        categories: DOC_CATEGORIES,
      }),
    );
  });

  app.post<SlugParams>('/p/:slug', async (req, reply) => {
    assertCsrf(ctx, req);
    requireAdmin(req);
    const b = body(req);
    const parsed = projectPatchSchema.safeParse({
      name: str(b, 'name'),
      status: str(b, 'status', 'active'),
      tags: parseTags(b.tags),
      summary: str(b, 'summary'),
    });
    if (!parsed.success) throw new ValidationError(parsed.error.issues);
    updateProjectFor(ctx, adminActor(req), req.params.slug, parsed.data);
    return reply.redirect(`/p/${encodeURIComponent(req.params.slug)}?done=saved`, 302);
  });

  app.post<SlugParams>('/p/:slug/delete', async (req, reply) => {
    assertCsrf(ctx, req);
    requireAdmin(req);
    deleteProjectFor(ctx, adminActor(req), req.params.slug);
    return reply.redirect('/?done=deleted', 302);
  });
}
