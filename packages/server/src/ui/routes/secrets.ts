import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../http/context.js';
import { NON_SENSITIVE_KEYS, defaultSensitive, secretInputSchema, secretPatchSchema } from '@pidb/shared';
import { createSecretFor, deleteSecretFor, getSecretFor, listSecretsFor, recentSecretAccessFor, revealFieldFor, updateSecretFor } from '../../services/secrets.js';
import { ConflictError } from '../../errors.js';
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

/**
 * Rows arrive as three parallel lists: `key`, `value` and `sensitive` (a per-row <select>,
 * so it is always submitted and aligns positionally — no coupling to the key string, which
 * would otherwise go stale the moment a key is renamed). The sensitive list is indexed by
 * the row's ORIGINAL position, before any empty-key row is dropped, so positions stay aligned
 * with `values`. A missing entry (a truncated or hand-rolled POST) fails safe via `defaultSensitive`.
 */
/** POSIX single-quote a string for safe use in a shell command line (each `'` becomes `'\''`). */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function fieldRows(b: Record<string, unknown>): FieldRow[] {
  const keys = list(b, 'key');
  const values = list(b, 'value');
  const sensitiveRaw = list(b, 'sensitive');
  const rows: FieldRow[] = [];
  keys.forEach((rawKey, i) => {
    const key = rawKey.trim();
    if (!key) return;
    const sv = sensitiveRaw[i];
    // Only an explicit "visible" token may mean false; anything unrecognised (missing, or a
    // stale key string from the old checkbox encoding) falls back to the safe default rather
    // than silently becoming non-sensitive.
    const sensitive =
      sv === '0' || sv === 'false' || sv === 'off'
        ? false
        : sv === '1' || sv === 'true' || sv === 'on'
          ? true
          : defaultSensitive(key);
    // Browsers submit <textarea> line breaks as CRLF; store LF so multi-line values
    // (SSH keys, certificates) come back byte-identical to what was pasted.
    rows.push({ key, value: (values[i] ?? '').replace(/\r\n?/g, '\n'), sensitive });
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
          access: recentSecretAccessFor(ctx, principal, scope.projectSlug, secret.name),
          // A runnable `pidb secret env <target> <name> --out .env`: `target` is the project slug
          // or the literal `global` (see packages/cli/src/client.ts `scopedPath`), and `name` is
          // POSIX single-quoted so a name containing spaces or quotes still pastes as one argument.
          cliRef: `${scope.projectSlug ?? 'global'} ${shQuote(secret.name)} --out .env`,
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
      const rerender = (error: string) =>
        reply.status(400).type('text/html').send(
          renderPage('secret-edit', {
            ...pageContext(ctx, req, 'Edit secret'),
            prefix: scope.prefix,
            scopeLabel: scope.projectSlug ?? 'global',
            isNew: false,
            action: `${scope.prefix}/secrets/${encodeURIComponent(req.params.name)}`,
            hintKeys: NON_SENSITIVE_KEYS,
            error,
            form: { name: str(b, 'name'), description: str(b, 'description'), tags: str(b, 'tags'), rows },
          }),
        );
      // An empty value box means "leave the stored value alone" ONLY for a row that still
      // names an existing stored field with the same sensitivity. A rename, a new row, or a
      // sensitivity flip with no value supplied cannot be resolved safely (the stored sensitive
      // value is never read back into the form), so it must be re-entered instead of silently
      // dropped or silently kept under a mismatched key/flag.
      const existingByKey = new Map(existing.fields.map((f) => [f.key, f]));
      for (const row of rows) {
        if (row.value === '') {
          const stored = existingByKey.get(row.key);
          if (!stored || stored.sensitive !== row.sensitive) {
            return rerender(`Field "${row.key}": value must be re-entered (its key or sensitivity changed)`);
          }
        }
      }
      const keep = new Set(rows.map((r) => r.key));
      const patch = secretPatchSchema.safeParse({
        name: str(b, 'name', req.params.name),
        description: str(b, 'description'),
        tags: parseTags(b.tags),
        // An empty box means "leave the stored value alone", so those rows are not sent.
        fields: rows.filter((r) => r.value !== '').map((r) => ({ key: r.key, value: r.value, sensitive: r.sensitive })),
        removeFields: existing.fields.map((f) => f.key).filter((k) => !keep.has(k)),
        // Rows with an empty box are not in `fields`, so the form order is sent separately.
        order: rows.map((r) => r.key),
      });
      if (!patch.success) {
        return rerender(patch.error.issues.map((i) => `${i.path.join('.') || 'form'}: ${i.message}`).join('; '));
      }
      let updated;
      try {
        updated = updateSecretFor(ctx, adminActor(req), scope.projectSlug, req.params.name, patch.data);
      } catch (err) {
        // A rename onto a taken name: keep the form so the edit is not lost.
        if (err instanceof ConflictError) return rerender(err.message);
        throw err;
      }
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
