import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Principal } from '../../auth/principal.js';
import type { AppContext } from '../../http/context.js';
import { labelActors } from '../actors.js';
import { NON_SENSITIVE_KEYS, defaultSensitive, secretInputSchema, secretKeySchema } from '@blindkey/shared';
import { deleteSecretFor, findVisibleSecretFor, getSecretFor, listSecretsFor, recentSecretAccessFor, revealFieldFor, updateSecretFor } from '../../services/secrets.js';
import { ConflictError, PermissionError } from '../../errors.js';
import { accessFor, hasPerm } from '../../auth/access.js';
import { hasScope } from '../../auth/principal.js';
import { secretEditPatchSchema } from '../../repos/secrets.js';
import { createSecretWithAccess } from '../../services/create-with-access.js';
import { adminActor, requireAdmin } from '../session.js';
import { accessEntries, globalMoveTargets, scopeAccessField } from '../workspace-ui.js';
import { createCaps, secretCaps } from '../caps.js';
import { assertCsrf } from '../csrf.js';
import { activeWorkspace, body, list, parseTags, pageContext, str, wsParam } from '../forms.js';
import { renderPage, renderPartial } from '../render.js';
import { scopeOf, type UiScope } from './documents.js';

type SecretParams = { Params: { slug?: string; name: string } };
/** `GET .../secrets/new` and `.../secrets/:name/edit` (spec §1.4): a prefill link, so the query is untyped and permissive. */
type SecretNewParams = { Params: { slug?: string }; Querystring: Record<string, unknown> };
type SecretEditParams = { Params: { slug?: string; name: string }; Querystring: Record<string, unknown> };

interface FieldRow {
  key: string;
  value: string;
  sensitive: boolean;
  /** The stored key this row started as ('' for a row added in the browser; rows are read positionally). */
  origKey?: string;
}

/**
 * Rows arrive as three parallel lists: `key`, `value` and `sensitive` (a per-row hidden input
 * toggled by the lock button, so it is always submitted and aligns positionally — no coupling
 * to the key string, which would otherwise go stale the moment a key is renamed). The sensitive
 * list is indexed by the row's ORIGINAL position, before any empty-key row is dropped, so
 * positions stay aligned with `values`. A missing entry (a truncated or hand-rolled POST) fails
 * safe via `defaultSensitive`.
 */
function fieldRows(b: Record<string, unknown>): FieldRow[] {
  const keys = list(b, 'key');
  const values = list(b, 'value');
  const sensitiveRaw = list(b, 'sensitive');
  // Absent entirely (a hand-rolled POST) means "no row was renamed": the key itself names the stored field.
  const origRaw = b.orig_key === undefined ? null : list(b, 'orig_key');
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
    rows.push({ key, value: (values[i] ?? '').replace(/\r\n?/g, '\n'), sensitive, origKey: origRaw === null ? key : (origRaw[i] ?? '').trim() });
  });
  return rows;
}

interface EditRights {
  /** `protected.write` (with the full write scope): may touch sensitive fields at all. */
  writeProtected: boolean;
  /** `protected.read`: may turn a locked field visible (which exposes its value). */
  readProtected: boolean;
}

function secretEditRights(ctx: AppContext, principal: Principal, projectSlug: string | null, name: string): EditRights {
  const secret = findVisibleSecretFor(ctx, principal, projectSlug, name);
  const perms = secret ? accessFor(ctx.db, principal).secretPerms(secret) : [];
  return {
    writeProtected: hasScope(principal, 'secrets:write') && hasPerm(perms, 'protected.write'),
    readProtected: hasPerm(perms, 'protected.read'),
  };
}

interface EditPlan {
  fields: { key: string; value: string; sensitive: boolean }[];
  removeFields: string[];
  carryFields: { from: string; to: string; sensitive?: boolean }[];
  order: string[];
  /** Locked fields that the user asked to make visible but may not reveal. */
  stayedLocked: string[];
  /** A key two rows end up with, or null. */
  duplicate: string | null;
}

/** Turns the submitted rows into one patch; see the comment at the call site for the rules. */
function planSecretEdit(stored: { key: string; sensitive: boolean }[], rows: FieldRow[], rights: EditRights): EditPlan {
  const byKey = new Map(stored.map((f) => [f.key, f]));
  const plan: EditPlan = { fields: [], removeFields: [], carryFields: [], order: [], stayedLocked: [], duplicate: null };
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.key)) {
      plan.duplicate = r.key;
      return plan;
    }
    seen.add(r.key);
  }
  const claimed = new Set<string>();
  const inPlace = new Set<string>();
  const finalKeys = new Set<string>();
  for (const row of rows) {
    const orig = row.origKey && byKey.has(row.origKey) && !claimed.has(row.origKey) ? row.origKey : '';
    if (orig) claimed.add(orig);
    const prior = orig ? byKey.get(orig)! : null;
    let finalKey = row.key;
    if (row.value !== '') {
      plan.fields.push({ key: row.key, value: row.value, sensitive: row.sensitive });
    } else if (!prior) {
      continue; // a new row with nothing in it: no field is created
    } else if ((prior.sensitive || row.sensitive) && !rights.writeProtected) {
      finalKey = orig; // may not touch sensitive fields: left exactly as stored
    } else {
      let sensitive = row.sensitive;
      if (prior.sensitive && !sensitive && !rights.readProtected) {
        sensitive = true; // un-locking would expose the value
        plan.stayedLocked.push(orig);
      }
      if (orig !== row.key || sensitive !== prior.sensitive) {
        plan.carryFields.push({ from: orig, to: row.key, ...(sensitive !== prior.sensitive ? { sensitive } : {}) });
      }
    }
    if (prior && finalKey === orig) inPlace.add(orig);
    if (finalKeys.has(finalKey)) {
      plan.duplicate = finalKey;
      return plan;
    }
    finalKeys.add(finalKey);
    plan.order.push(finalKey);
  }
  const carried = new Set(plan.carryFields.map((c) => c.from));
  plan.removeFields = stored.map((f) => f.key).filter((k) => !inPlace.has(k) && !carried.has(k));
  return plan;
}

/**
 * `keys` query param (spec §1.4, e.g. `host!,password`): one row per comma-separated key, empty
 * value, sensitive unless the key ends with `!` (which is stripped before validating) AND the key is
 * non-sensitive by default (`defaultSensitive`) — `password!` still renders sensitive. A key that
 * doesn't match `secretKeySchema`, or repeats an earlier key in the same list, is dropped rather
 * than rejecting the whole request — this is a prefill hint, not a submission.
 */
function parseKeyRows(raw: string): FieldRow[] {
  const rows: FieldRow[] = [];
  const seen = new Set<string>();
  for (const rawKey of raw.split(',')) {
    const trimmed = rawKey.trim();
    if (!trimmed) continue;
    const marked = trimmed.endsWith('!');
    const key = marked ? trimmed.slice(0, -1) : trimmed;
    if (!secretKeySchema.safeParse(key).success) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    // The "!" marker is honoured only for keys that are non-sensitive by default (spec §1.4): a link
    // (built by an agent) must never pre-untick e.g. `password`, which would let list_secrets return
    // the value the user then types. The user can still untick the row in the form themselves.
    rows.push({ key, value: '', sensitive: !marked || defaultSensitive(key) });
  }
  return rows;
}

/** `GET .../secrets/new?keys=...`: no keys survive parsing → the single empty sensitive row the plain "new secret" form always started with. */
function prefillRowsForNew(raw: string): FieldRow[] {
  const rows = parseKeyRows(raw);
  return rows.length > 0 ? rows : [{ key: '', value: '', sensitive: true }];
}

/** The secret page; `moveError` shows an inline message when a move from it was refused. */
export function secretPage(ctx: AppContext, req: FastifyRequest, principal: Principal, scope: UiScope, name: string, moveError: string | null): string {
  const secret = getSecretFor(ctx, principal, scope.projectSlug, name);
  // `?stayed=a,b` (set by the edit save): shown only for keys that really are locked on this secret.
  const lockedKeys = new Set(secret.fields.filter((f) => f.sensitive).map((f) => f.key));
  const stayed = str((req.query ?? {}) as Record<string, unknown>, 'stayed').split(',').filter((k) => lockedKeys.has(k));
  return renderPage('secret', {
    ...pageContext(ctx, req, secret.name),
    notice: stayed.length ? `${stayed.join(', ')} stayed locked: you can't reveal ${stayed.length > 1 ? 'them' : 'it'}.` : null,
    prefix: scope.prefix,
    scopeLabel: scope.projectSlug ?? 'global',
    secret,
    access: labelActors(ctx, recentSecretAccessFor(ctx, principal, scope.projectSlug, secret.name)),
    ...secretCaps(ctx, principal, scope.projectSlug, secret.name),
    moveTargets: scope.projectSlug === null ? globalMoveTargets(ctx, principal) : [],
    moveError,
  });
}

export function registerSecretRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/global/secrets', async (req, reply) => {
    const principal = requireAdmin(req);
    if (activeWorkspace(ctx, principal) === null) return reply.type('text/html').send(renderPage('no-workspace', { ...pageContext(ctx, req, 'Global secrets') }));
    return reply.type('text/html').send(
      renderPage('secrets', {
        ...pageContext(ctx, req, 'Global secrets'),
        prefix: '/global',
        secrets: listSecretsFor(ctx, principal, null),
        ...createCaps(ctx, principal, null),
      }),
    );
  });

  for (const base of ['/p/:slug/secrets', '/global/secrets']) {
    app.get<SecretNewParams>(`${base}/new`, async (req, reply) => {
      const principal = requireAdmin(req);
      const scope = scopeOf(req.params);
      if (!createCaps(ctx, principal, scope.projectSlug).canCreateSecret) throw new PermissionError('public.write');
      // Prefill only: name/description/tags/keys, never a value (spec §1.4 — `value*` query
      // params are simply never read here, whatever a caller sends).
      const q = req.query;
      return reply.type('text/html').send(
        renderPage('secret-edit', {
          ...pageContext(ctx, req, 'New secret'),
          prefix: scope.prefix,
          scopeLabel: scope.projectSlug ?? 'global',
          isNew: true,
          originalName: null,
          action: `${scope.prefix}/secrets`,
          hintKeys: NON_SENSITIVE_KEYS,
          access: scopeAccessField(ctx, principal, scope.projectSlug, 'secret'),
          error: null,
          form: {
            name: str(q, 'name'),
            description: str(q, 'description'),
            tags: str(q, 'tags'),
            rows: prefillRowsForNew(str(q, 'keys')),
          },
        }),
      );
    });

    app.post<SecretParams>(base, async (req, reply) => {
      assertCsrf(ctx, req);
      const principal = requireAdmin(req);
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
            originalName: null,
            action: `${scope.prefix}/secrets`,
            hintKeys: NON_SENSITIVE_KEYS,
            access: scopeAccessField(ctx, principal, scope.projectSlug, 'secret'),
            error: parsed.error.issues.map((i) => `${i.path.join('.') || 'form'}: ${i.message}`).join('; '),
            form: { name: str(b, 'name'), description: str(b, 'description'), tags: str(b, 'tags'), rows },
          }),
        );
      }
      let created;
      try {
        created = createSecretWithAccess(ctx, adminActor(req), scope.projectSlug, parsed.data, accessEntries(req));
      } catch (err) {
        if (!(err instanceof ConflictError)) throw err;
        // A name collision: the typed-in values (possibly sensitive) are never echoed back into
        // the re-rendered HTML — only the keys and their sensitivity survive, values blanked —
        // unlike the edit-form rerender below, which re-echoes because those values are already
        // the admin's own draft of an existing secret, not a fresh secret about to be duplicated.
        return reply.status(409).type('text/html').send(
          renderPage('secret-edit', {
            ...pageContext(ctx, req, 'New secret'),
            prefix: scope.prefix,
            scopeLabel: scope.projectSlug ?? 'global',
            isNew: true,
            originalName: null,
            action: `${scope.prefix}/secrets`,
            hintKeys: NON_SENSITIVE_KEYS,
            access: scopeAccessField(ctx, principal, scope.projectSlug, 'secret'),
            error: 'A secret with this name already exists — open it to edit.',
            form: {
              name: str(b, 'name'),
              description: str(b, 'description'),
              tags: str(b, 'tags'),
              rows: rows.map((r) => ({ key: r.key, value: '', sensitive: r.sensitive })),
            },
          }),
        );
      }
      return reply.redirect(`${scope.prefix}/secrets/${encodeURIComponent(created.name)}?done=created${wsParam(req, scope.projectSlug === null)}`, 302);
    });
  }

  for (const base of ['/p/:slug/secrets', '/global/secrets']) {
    app.get<SecretParams>(`${base}/:name`, async (req, reply) => {
      const principal = requireAdmin(req);
      return reply.type('text/html').send(secretPage(ctx, req, principal, scopeOf(req.params), req.params.name, null));
    });

    app.get<SecretEditParams>(`${base}/:name/edit`, async (req, reply) => {
      const principal = requireAdmin(req);
      const scope = scopeOf(req.params);
      const secret = getSecretFor(ctx, principal, scope.projectSlug, req.params.name);
      // Without write permission the form would only show blank rows that every save refuses.
      if (!secretCaps(ctx, principal, scope.projectSlug, secret.name).canEdit) throw new PermissionError('public.write');
      const existingKeys = new Set(secret.fields.map((f) => f.key));
      // `secret_request_link` (spec §1.5) for a name that already exists points here instead of
      // `/new`, with the same `keys` param: any key not already on the secret gets an extra empty
      // row (sensitivity per the `!` rule); an already-present key is left alone, never duplicated
      // or reset — the stored field (and its sensitivity) wins.
      const extraRows = parseKeyRows(str(req.query, 'keys')).filter((r) => !existingKeys.has(r.key));
      return reply.type('text/html').send(
        renderPage('secret-edit', {
          ...pageContext(ctx, req, `Edit ${secret.name}`),
          prefix: scope.prefix,
          scopeLabel: scope.projectSlug ?? 'global',
          isNew: false,
          originalName: req.params.name,
          action: `${scope.prefix}/secrets/${encodeURIComponent(secret.name)}`,
          hintKeys: NON_SENSITIVE_KEYS,
          error: null,
          // A stored sensitive value is never sent to the browser: its box starts empty.
          form: {
            name: secret.name,
            description: secret.description,
            tags: secret.tags.join(', '),
            rows: [...secret.fields.map((f) => ({ key: f.key, value: f.sensitive ? '' : (f.value ?? ''), sensitive: f.sensitive, origKey: f.key })), ...extraRows],
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
            originalName: req.params.name,
            action: `${scope.prefix}/secrets/${encodeURIComponent(req.params.name)}`,
            hintKeys: NON_SENSITIVE_KEYS,
            error,
            form: { name: str(b, 'name'), description: str(b, 'description'), tags: str(b, 'tags'), rows },
          }),
        );
      // An empty value box never errors: it means "do not change the value". The stored value is
      // never read back into the form, so a renamed or re-flagged row is carried over server-side
      // (decrypt + re-encrypt in one transaction) and a brand-new empty row is simply skipped.
      const plan = planSecretEdit(existing.fields, rows, secretEditRights(ctx, principal, scope.projectSlug, existing.name));
      if (plan.duplicate) return rerender(`Field "${plan.duplicate}": duplicate field key`);
      const patch = secretEditPatchSchema.safeParse({
        name: str(b, 'name', req.params.name),
        description: str(b, 'description'),
        tags: parseTags(b.tags),
        fields: plan.fields,
        removeFields: plan.removeFields,
        ...(plan.carryFields.length ? { carryFields: plan.carryFields } : {}),
        // Rows with an empty box are not in `fields`, so the form order is sent separately.
        order: plan.order,
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
      return reply.redirect(`${scope.prefix}/secrets/${encodeURIComponent(updated.name)}?done=saved${plan.stayedLocked.length ? `&stayed=${encodeURIComponent(plan.stayedLocked.join(','))}` : ''}${wsParam(req, scope.projectSlug === null)}`, 302);
    });

    app.post<SecretParams>(`${base}/:name/delete`, async (req, reply) => {
      assertCsrf(ctx, req);
      requireAdmin(req);
      const scope = scopeOf(req.params);
      deleteSecretFor(ctx, adminActor(req), scope.projectSlug, req.params.name);
      return reply.redirect(scope.projectSlug ? `${scope.prefix}?tab=secrets&done=deleted` : `/global/secrets?done=deleted${wsParam(req, true)}`, 302);
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
