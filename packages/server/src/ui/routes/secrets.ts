import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../http/context.js';
import { NON_SENSITIVE_KEYS, secretInputSchema, secretPatchSchema } from '@pidb/shared';
import { createSecretFor, deleteSecretFor, getSecretFor, listSecretsFor, revealFieldFor, updateSecretFor } from '../../services/secrets.js';
import { adminActor, requireAdmin } from '../session.js';
import { assertCsrf } from '../csrf.js';
import { body, list, parseTags, pageContext, str } from '../forms.js';
import { renderPage, renderPartial } from '../render.js';
import { scopeOf } from './documents.js';

type SecretParams = { Params: { slug?: string; name: string } };

interface FieldRow {
  key: string;
  value: string;
  sensitive: boolean;
}

/** Rows arrive as parallel `key`/`value` lists; `sensitive` holds the keys whose box was checked. */
function fieldRows(b: Record<string, unknown>): FieldRow[] {
  const keys = list(b, 'key');
  const values = list(b, 'value');
  const sensitiveKeys = new Set(list(b, 'sensitive'));
  const rows: FieldRow[] = [];
  keys.forEach((rawKey, i) => {
    const key = rawKey.trim();
    if (!key) return;
    rows.push({ key, value: values[i] ?? '', sensitive: sensitiveKeys.has(key) });
  });
  return rows;
}

export function registerSecretRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/global/secrets', async (req, reply) => {
    const principal = requireAdmin(req);
    return reply.type('text/html').send(
      renderPage('secrets', {
        ...pageContext(ctx, req, 'Global secrets'),
        prefix: '/global',
        secrets: listSecretsFor(ctx, principal, null),
      }),
    );
  });

  for (const base of ['/p/:slug/secrets', '/global/secrets']) {
    app.get<SecretParams>(`${base}/new`, async (req, reply) => {
      requireAdmin(req);
      const scope = scopeOf(req.params);
      return reply.type('text/html').send(
        renderPage('secret-edit', {
          ...pageContext(ctx, req, 'New secret'),
          prefix: scope.prefix,
          scopeLabel: scope.projectSlug ?? 'global',
          isNew: true,
          action: `${scope.prefix}/secrets`,
          hintKeys: NON_SENSITIVE_KEYS,
          error: null,
          form: { name: '', description: '', tags: '', rows: [{ key: '', value: '', sensitive: true }] },
        }),
      );
    });

    app.post<SecretParams>(base, async (req, reply) => {
      assertCsrf(ctx, req);
      requireAdmin(req);
      const scope = scopeOf(req.params);
      const b = body(req);
      const rows = fieldRows(b);
      const parsed = secretInputSchema.safeParse({
        name: str(b, 'name'),
        description: str(b, 'description'),
        tags: parseTags(b.tags),
        fields: rows.map((r) => ({ key: r.key, value: r.value, sensitive: r.sensitive })),
      });
      if (!parsed.success) {
        return reply.status(400).type('text/html').send(
          renderPage('secret-edit', {
            ...pageContext(ctx, req, 'New secret'),
            prefix: scope.prefix,
            scopeLabel: scope.projectSlug ?? 'global',
            isNew: true,
            action: `${scope.prefix}/secrets`,
            hintKeys: NON_SENSITIVE_KEYS,
            error: parsed.error.issues.map((i) => `${i.path.join('.') || 'form'}: ${i.message}`).join('; '),
            form: { name: str(b, 'name'), description: str(b, 'description'), tags: str(b, 'tags'), rows },
          }),
        );
      }
      const created = createSecretFor(ctx, adminActor(req), scope.projectSlug, parsed.data);
      return reply.redirect(`${scope.prefix}/secrets/${encodeURIComponent(created.name)}`, 302);
    });
  }

  for (const base of ['/p/:slug/secrets', '/global/secrets']) {
    app.get<SecretParams>(`${base}/:name`, async (req, reply) => {
      const principal = requireAdmin(req);
      const scope = scopeOf(req.params);
      const secret = getSecretFor(ctx, principal, scope.projectSlug, req.params.name);
      return reply.type('text/html').send(
        renderPage('secret', {
          ...pageContext(ctx, req, secret.name),
          prefix: scope.prefix,
          scopeLabel: scope.projectSlug ?? 'global',
          secret,
        }),
      );
    });

    app.get<SecretParams>(`${base}/:name/edit`, async (req, reply) => {
      const principal = requireAdmin(req);
      const scope = scopeOf(req.params);
      const secret = getSecretFor(ctx, principal, scope.projectSlug, req.params.name);
      return reply.type('text/html').send(
        renderPage('secret-edit', {
          ...pageContext(ctx, req, `Edit ${secret.name}`),
          prefix: scope.prefix,
          scopeLabel: scope.projectSlug ?? 'global',
          isNew: false,
          action: `${scope.prefix}/secrets/${encodeURIComponent(secret.name)}`,
          hintKeys: NON_SENSITIVE_KEYS,
          error: null,
          // A stored sensitive value is never sent to the browser: its box starts empty.
          form: {
            name: secret.name,
            description: secret.description,
            tags: secret.tags.join(', '),
            rows: secret.fields.map((f) => ({ key: f.key, value: f.sensitive ? '' : (f.value ?? ''), sensitive: f.sensitive })),
          },
        }),
      );
    });

    app.post<SecretParams>(`${base}/:name`, async (req, reply) => {
      assertCsrf(ctx, req);
      const principal = requireAdmin(req);
      const scope = scopeOf(req.params);
      const b = body(req);
      const rows = fieldRows(b);
      const existing = getSecretFor(ctx, principal, scope.projectSlug, req.params.name);
      const keep = new Set(rows.map((r) => r.key));
      const patch = secretPatchSchema.safeParse({
        name: str(b, 'name', req.params.name),
        description: str(b, 'description'),
        tags: parseTags(b.tags),
        // An empty box means "leave the stored value alone", so those rows are not sent.
        fields: rows.filter((r) => r.value !== '').map((r) => ({ key: r.key, value: r.value, sensitive: r.sensitive })),
        removeFields: existing.fields.map((f) => f.key).filter((k) => !keep.has(k)),
      });
      if (!patch.success) {
        return reply.status(400).type('text/html').send(
          renderPage('secret-edit', {
            ...pageContext(ctx, req, 'Edit secret'),
            prefix: scope.prefix,
            scopeLabel: scope.projectSlug ?? 'global',
            isNew: false,
            action: `${scope.prefix}/secrets/${encodeURIComponent(req.params.name)}`,
            hintKeys: NON_SENSITIVE_KEYS,
            error: patch.error.issues.map((i) => `${i.path.join('.') || 'form'}: ${i.message}`).join('; '),
            form: { name: str(b, 'name'), description: str(b, 'description'), tags: str(b, 'tags'), rows },
          }),
        );
      }
      const updated = updateSecretFor(ctx, adminActor(req), scope.projectSlug, req.params.name, patch.data);
      return reply.redirect(`${scope.prefix}/secrets/${encodeURIComponent(updated.name)}`, 302);
    });

    app.post<SecretParams>(`${base}/:name/delete`, async (req, reply) => {
      assertCsrf(ctx, req);
      requireAdmin(req);
      const scope = scopeOf(req.params);
      deleteSecretFor(ctx, adminActor(req), scope.projectSlug, req.params.name);
      return reply.redirect(scope.projectSlug ? `${scope.prefix}?tab=secrets` : '/global/secrets', 302);
    });

    app.post<SecretParams>(`${base}/:name/reveal`, async (req, reply) => {
      assertCsrf(ctx, req);
      requireAdmin(req);
      const scope = scopeOf(req.params);
      const key = str(body(req), 'key');
      // One field per request: revealFieldFor writes the audit row for a sensitive read.
      const value = revealFieldFor(ctx, adminActor(req), scope.projectSlug, req.params.name, key);
      return reply
        .header('cache-control', 'no-store')
        .type('text/html')
        .send(renderPartial('revealed', { key, value }));
    });
  }
}
