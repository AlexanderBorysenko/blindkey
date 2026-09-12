import type { FastifyInstance } from 'fastify';
import { PROJECT_STATUSES, projectInputSchema } from '@pidb/shared';
import type { AppContext } from '../../http/context.js';
import { createProjectFor, listProjectsFor } from '../../services/projects.js';
import { searchFor } from '../../services/search.js';
import { adminActor, requireAdmin } from '../session.js';
import { assertCsrf } from '../csrf.js';
import { body, pageContext, parseTags, str } from '../forms.js';
import { renderPage } from '../render.js';

type ListQs = { Querystring: { status?: string; q?: string } };

export function registerProjectRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get<ListQs>('/', async (req, reply) => {
    const principal = requireAdmin(req);
    const status = req.query.status ?? '';
    const all = listProjectsFor(ctx, principal);
    const projects = status ? all.filter((p) => p.status === status) : all;
    return reply.type('text/html').send(
      renderPage('projects', {
        ...pageContext(ctx, req, 'Projects'),
        projects,
        statuses: PROJECT_STATUSES,
        status,
        error: null,
        form: { slug: '', name: '', status: 'active', tags: '', summary: '' },
      }),
    );
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
        renderPage('projects', {
          ...pageContext(ctx, req, 'Projects'),
          projects: listProjectsFor(ctx, principal),
          statuses: PROJECT_STATUSES,
          status: '',
          error: message,
          form: { slug: str(b, 'slug'), name: str(b, 'name'), status: str(b, 'status', 'active'), tags: str(b, 'tags'), summary: str(b, 'summary') },
        }),
      );
    }
    const project = createProjectFor(ctx, adminActor(req), parsed.data);
    return reply.redirect(`/p/${encodeURIComponent(project.slug)}`, 302);
  });
}
