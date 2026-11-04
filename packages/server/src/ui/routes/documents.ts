import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Principal } from '../../auth/principal.js';
import { DOC_CATEGORIES, docSlugSchema, documentInputSchema, lintForSecrets } from '@blindkey/shared';
import type { AppContext } from '../../http/context.js';
import { deleteDocumentFor, listDocumentsFor, readDocumentFor, resolveDocScope, resolveRefs } from '../../services/documents.js';
import { writeDocumentWithAccess } from '../../services/create-with-access.js';
import { adminActor, requireAdmin } from '../session.js';
import { assertCsrf } from '../csrf.js';
import { activeWorkspace, body, bool, pageContext, str, wsParam } from '../forms.js';
import { accessEntries, globalMoveTargets, scopeAccessField } from '../workspace-ui.js';
import { createCaps, docCaps } from '../caps.js';
import { renderMarkdown } from '../markdown.js';
import { renderPage, renderPartial } from '../render.js';
import { PermissionError, UnprocessableError } from '../../errors.js';

/** Named UiScope so it cannot be confused with the token `Scope` type from @blindkey/shared. */
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

/** The document page; `moveError` shows an inline message when a move from it was refused. */
export function docPage(ctx: AppContext, req: FastifyRequest, principal: Principal, scope: UiScope, slug: string, moveError: string | null): string {
  const doc = readDocumentFor(ctx, principal, scope.projectSlug, slug, true);
  return renderPage('document', {
    ...pageContext(ctx, req, doc.title),
    prefix: scope.prefix,
    scopeLabel: scope.projectSlug ?? 'global',
    doc,
    moveTargets: scope.projectSlug === null ? globalMoveTargets(ctx, principal) : [],
    ...docCaps(ctx, principal, scope.projectSlug, doc.slug),
    html: renderMarkdown(doc.body_md, scope.prefix),
    refs: doc.refs ?? [],
    moveError,
  });
}

export function registerDocumentRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/global/docs', async (req, reply) => {
    const principal = requireAdmin(req);
    if (activeWorkspace(ctx, principal) === null) return reply.type('text/html').send(renderPage('no-workspace', { ...pageContext(ctx, req, 'Global documents') }));
    return reply.type('text/html').send(
      renderPage('documents', {
        ...pageContext(ctx, req, 'Global documents'),
        prefix: '/global',
        scopeLabel: 'global',
        documents: listDocumentsFor(ctx, principal, null),
        ...createCaps(ctx, principal, null),
      }),
    );
  });

  for (const base of ['/p/:slug/docs', '/global/docs']) {
    app.get<DocParams>(`${base}/:doc`, async (req, reply) => {
      const principal = requireAdmin(req);
      return reply.type('text/html').send(docPage(ctx, req, principal, scopeOf(req.params), req.params.doc, null));
    });

    app.post<DocParams>(`${base}/:doc/delete`, async (req, reply) => {
      assertCsrf(ctx, req);
      requireAdmin(req);
      const scope = scopeOf(req.params);
      deleteDocumentFor(ctx, adminActor(req), scope.projectSlug, req.params.doc);
      return reply.redirect(scope.projectSlug ? `${scope.prefix}?done=deleted` : `/global/docs?done=deleted${wsParam(req, true)}`, 302);
    });

    app.get<DocParams>(`${base}/:doc/edit`, async (req, reply) => {
      const principal = requireAdmin(req);
      const scope = scopeOf(req.params);
      const isNew = req.params.doc === 'new';
      const doc = isNew
        ? { slug: '', title: '', category: 'notes' as const, body_md: '' }
        : readDocumentFor(ctx, principal, scope.projectSlug, req.params.doc, false);
      // Without write permission the form could only be refused on save.
      if (isNew ? !createCaps(ctx, principal, scope.projectSlug).canCreateDoc : !docCaps(ctx, principal, scope.projectSlug, doc.slug).canEdit) throw new PermissionError('docs.write');
      return reply.type('text/html').send(
        renderPage('document-edit', {
          ...pageContext(ctx, req, isNew ? 'New document' : `Edit ${doc.slug}`),
          prefix: scope.prefix,
          scopeLabel: scope.projectSlug ?? 'global',
          isNew,
          action: `${scope.prefix}/docs/${isNew ? 'new' : encodeURIComponent(doc.slug)}`,
          categories: DOC_CATEGORIES,
          form: { slug: doc.slug, title: doc.title, category: doc.category, body_md: doc.body_md },
          access: isNew ? scopeAccessField(ctx, principal, scope.projectSlug, 'document') : null,
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
            access: isNew ? scopeAccessField(ctx, principal, scope.projectSlug, 'document') : null,
            findings: [],
            unresolved: [],
            error: message,
          }),
        );
      }

      try {
        writeDocumentWithAccess(ctx, adminActor(req), scope.projectSlug, slug, parsed.data, isNew ? accessEntries(req) : []);
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
            access: req.params.doc === 'new' ? scopeAccessField(ctx, principal, scope.projectSlug, 'document') : null,
            findings: details.findings ?? [],
            unresolved: details.unresolved ?? [],
            error: null,
          }),
        );
      }
      return reply.redirect(`${scope.prefix}/docs/${encodeURIComponent(slug)}?done=saved${wsParam(req, scope.projectSlug === null)}`, 302);
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
