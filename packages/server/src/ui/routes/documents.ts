import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../http/context.js';
import { deleteDocumentFor, listDocumentsFor, readDocumentFor } from '../../services/documents.js';
import { adminActor, requireAdmin } from '../session.js';
import { assertCsrf } from '../csrf.js';
import { pageContext } from '../forms.js';
import { renderMarkdown } from '../markdown.js';
import { renderPage } from '../render.js';

/** Named UiScope so it cannot be confused with the token `Scope` type from @pidb/shared. */
export interface UiScope {
  projectSlug: string | null;
  prefix: string;
}

export function scopeOf(params: { slug?: string }): UiScope {
  return params.slug === undefined
    ? { projectSlug: null, prefix: '/global' }
    : { projectSlug: params.slug, prefix: `/p/${encodeURIComponent(params.slug)}` };
}

type DocParams = { Params: { slug?: string; doc: string } };

export function registerDocumentRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/global/docs', async (req, reply) => {
    const principal = requireAdmin(req);
    return reply.type('text/html').send(
      renderPage('documents', {
        ...pageContext(ctx, req, 'Global documents'),
        prefix: '/global',
        scopeLabel: 'global',
        documents: listDocumentsFor(ctx, principal, null),
      }),
    );
  });

  for (const base of ['/p/:slug/docs', '/global/docs']) {
    app.get<DocParams>(`${base}/:doc`, async (req, reply) => {
      const principal = requireAdmin(req);
      const scope = scopeOf(req.params);
      const doc = readDocumentFor(ctx, principal, scope.projectSlug, req.params.doc, true);
      return reply.type('text/html').send(
        renderPage('document', {
          ...pageContext(ctx, req, doc.title),
          prefix: scope.prefix,
          scopeLabel: scope.projectSlug ?? 'global',
          doc,
          html: renderMarkdown(doc.body_md, scope.prefix),
          refs: doc.refs ?? [],
        }),
      );
    });

    app.post<DocParams>(`${base}/:doc/delete`, async (req, reply) => {
      assertCsrf(ctx, req);
      requireAdmin(req);
      const scope = scopeOf(req.params);
      deleteDocumentFor(ctx, adminActor(req), scope.projectSlug, req.params.doc);
      return reply.redirect(scope.projectSlug ? scope.prefix : '/global/docs', 302);
    });
  }
}
