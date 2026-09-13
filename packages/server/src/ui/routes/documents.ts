import type { FastifyInstance } from 'fastify';
import { DOC_CATEGORIES, docSlugSchema, documentInputSchema, lintForSecrets } from '@pidb/shared';
import type { AppContext } from '../../http/context.js';
import { deleteDocumentFor, listDocumentsFor, readDocumentFor, resolveDocScope, resolveRefs, writeDocumentFor } from '../../services/documents.js';
import { adminActor, requireAdmin } from '../session.js';
import { assertCsrf } from '../csrf.js';
import { body, bool, pageContext, str } from '../forms.js';
import { renderMarkdown } from '../markdown.js';
import { renderPage, renderPartial } from '../render.js';
import { UnprocessableError } from '../../errors.js';

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
      return reply.redirect(scope.projectSlug ? `${scope.prefix}?done=deleted` : '/global/docs?done=deleted', 302);
    });

    app.get<DocParams>(`${base}/:doc/edit`, async (req, reply) => {
      const principal = requireAdmin(req);
      const scope = scopeOf(req.params);
      const isNew = req.params.doc === 'new';
      const doc = isNew
        ? { slug: '', title: '', category: 'notes' as const, body_md: '' }
        : readDocumentFor(ctx, principal, scope.projectSlug, req.params.doc, false);
      return reply.type('text/html').send(
        renderPage('document-edit', {
          ...pageContext(ctx, req, isNew ? 'New document' : `Edit ${doc.slug}`),
          prefix: scope.prefix,
          scopeLabel: scope.projectSlug ?? 'global',
          isNew,
          action: `${scope.prefix}/docs/${isNew ? 'new' : encodeURIComponent(doc.slug)}`,
          categories: DOC_CATEGORIES,
          form: { slug: doc.slug, title: doc.title, category: doc.category, body_md: doc.body_md },
          findings: [],
          unresolved: [],
        }),
      );
    });

    app.post<DocParams>(`${base}/:doc`, async (req, reply) => {
      assertCsrf(ctx, req);
      const principal = requireAdmin(req);
      const scope = scopeOf(req.params);
      const b = body(req);
      const slug = str(b, 'slug', req.params.doc);
      const form = { slug, title: str(b, 'title'), category: str(b, 'category', 'notes'), body_md: str(b, 'body_md') };
      const force = bool(b, 'force');
      const isNew = req.params.doc === 'new';

      const slugCheck = docSlugSchema.safeParse(slug);
      const slugMismatch = !isNew && slug !== req.params.doc;
      const parsed = documentInputSchema.safeParse({ title: form.title, category: form.category, body_md: form.body_md, force });
      if (!slugCheck.success || slugMismatch || !parsed.success) {
        const message = slugMismatch
          ? 'Slug cannot be changed on an existing document.'
          : !slugCheck.success
            ? 'Slug must be lowercase letters, digits and dashes.'
            : !parsed.success
              ? parsed.error.issues.map((i) => `${i.path.join('.') || 'form'}: ${i.message}`).join('; ')
              : '';
        return reply.status(400).type('text/html').send(
          renderPage('document-edit', {
            ...pageContext(ctx, req, 'Edit document'),
            prefix: scope.prefix,
            scopeLabel: scope.projectSlug ?? 'global',
            isNew,
            action: `${scope.prefix}/docs/${isNew ? 'new' : encodeURIComponent(req.params.doc)}`,
            categories: DOC_CATEGORIES,
            form,
            findings: [],
            unresolved: [],
            error: message,
          }),
        );
      }

      try {
        writeDocumentFor(ctx, adminActor(req), scope.projectSlug, slug, parsed.data);
      } catch (err) {
        if (!(err instanceof UnprocessableError)) throw err;
        const details = err.details as { findings?: { line: number; reason: string }[]; unresolved?: string[] };
        return reply.status(422).type('text/html').send(
          renderPage('document-edit', {
            ...pageContext(ctx, req, 'Edit document'),
            prefix: scope.prefix,
            scopeLabel: scope.projectSlug ?? 'global',
            isNew: req.params.doc === 'new',
            action: `${scope.prefix}/docs/${req.params.doc === 'new' ? 'new' : encodeURIComponent(req.params.doc)}`,
            categories: DOC_CATEGORIES,
            form,
            findings: details.findings ?? [],
            unresolved: details.unresolved ?? [],
            error: null,
          }),
        );
      }
      return reply.redirect(`${scope.prefix}/docs/${encodeURIComponent(slug)}?done=saved`, 302);
    });
  }

  type PreviewBody = { Body: { body_md?: string; scope?: string } };

  app.post<PreviewBody>('/preview', async (req, reply) => {
    assertCsrf(ctx, req);
    const principal = requireAdmin(req);
    const b = body(req);
    const md = str(b, 'body_md');
    const scopePrefix = str(b, 'scope', '/global');
    const projectSlug = scopePrefix.startsWith('/p/') ? decodeURIComponent(scopePrefix.slice(3)) : null;
    const project = resolveDocScope(ctx, principal, projectSlug);
    const { unresolved } = resolveRefs(ctx, principal, project, md);
    return reply.type('text/html').send(
      renderPartial('preview', { html: renderMarkdown(md, scopePrefix), findings: lintForSecrets(md), unresolved }),
    );
  });
}
