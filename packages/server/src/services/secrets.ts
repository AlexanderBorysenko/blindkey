import { defaultSensitive, type SecretInput, type SecretPatch } from '@pidb/shared';
import type { AppContext } from '../http/context.js';
import { assertScope, hasScope, type Actor, type Principal } from '../auth/principal.js';
import { AppError, ForbiddenError, NotFoundError } from '../errors.js';
import type { ProjectRow } from '../repos/projects.js';
import { createSecret, deleteSecret, getSecretMeta, listSecrets, revealAllFields, revealField, updateSecret, type SecretMeta } from '../repos/secrets.js';
import { listAuditForTarget, type AuditRow } from '../repos/audit.js';
import { publicSecret, type PublicSecret } from '../http/serialize.js';
import { auditAs, loadProjectFor } from './common.js';

function scopeProject(ctx: AppContext, principal: Principal, projectSlug: string | null): ProjectRow | null {
  return projectSlug === null ? null : loadProjectFor(ctx, principal, projectSlug);
}

function mustGet(ctx: AppContext, projectId: number | null, name: string): SecretMeta {
  const s = getSecretMeta(ctx.db, ctx.ring, projectId, name);
  if (!s) throw new NotFoundError('secret not found');
  return s;
}

export function listSecretsFor(ctx: AppContext, principal: Principal, projectSlug: string | null): PublicSecret[] {
  assertScope(principal, 'secrets:meta');
  const project = scopeProject(ctx, principal, projectSlug);
  return listSecrets(ctx.db, ctx.ring, project?.id ?? null).map(publicSecret);
}

export function getSecretFor(ctx: AppContext, principal: Principal, projectSlug: string | null, name: string): PublicSecret {
  assertScope(principal, 'secrets:meta');
  const project = scopeProject(ctx, principal, projectSlug);
  return publicSecret(mustGet(ctx, project?.id ?? null, name));
}

/**
 * Recent audit rows for one secret, for the secret page's "recent access" panel. Reuses the
 * same scope/permission resolution as `getSecretFor` (so a non-admin scoped to another project
 * still gets NotFoundError rather than leaking existence), and additionally requires the `admin`
 * scope: the audit log is admin-only, unlike secret metadata.
 *
 * Bounded by the secret's own `created_at`: `secrets.id` has no `AUTOINCREMENT`, so a deleted
 * secret's id can be reused by a later one, and without this bound the newer secret's page would
 * show its predecessor's audit rows (a history leak across reused ids).
 */
export function recentSecretAccessFor(ctx: AppContext, principal: Principal, projectSlug: string | null, name: string, limit = 5): AuditRow[] {
  assertScope(principal, 'secrets:meta');
  const project = scopeProject(ctx, principal, projectSlug);
  const secret = mustGet(ctx, project?.id ?? null, name);
  assertScope(principal, 'admin');
  return listAuditForTarget(ctx.db, 'secret', secret.id, limit, secret.created_at);
}

export function revealFieldFor(ctx: AppContext, actor: Actor, projectSlug: string | null, name: string, key: string): string {
  if (!hasScope(actor.principal, 'secrets:meta') && !hasScope(actor.principal, 'secrets:reveal')) {
    throw new ForbiddenError('secrets:meta');
  }
  const project = scopeProject(ctx, actor.principal, projectSlug);
  const secret = mustGet(ctx, project?.id ?? null, name);
  const field = secret.fields.find((f) => f.key === key);
  if (!field) throw new NotFoundError('field not found');
  assertScope(actor.principal, field.sensitive ? 'secrets:reveal' : 'secrets:meta');
  const value = revealField(ctx.db, ctx.ring, secret.id, key);
  if (value === null) throw new NotFoundError('field not found');
  if (field.sensitive) auditAs(ctx, actor, { action: 'secret.reveal', target_type: 'secret', target_id: secret.id, field_key: key });
  return value;
}

export function revealAllFor(ctx: AppContext, actor: Actor, projectSlug: string | null, name: string): { name: string; fields: Record<string, string> } {
  assertScope(actor.principal, 'secrets:reveal');
  const project = scopeProject(ctx, actor.principal, projectSlug);
  const secret = mustGet(ctx, project?.id ?? null, name);
  const fields: Record<string, string> = {};
  for (const f of revealAllFields(ctx.db, ctx.ring, secret.id)) {
    fields[f.key] = f.value;
    if (f.sensitive) auditAs(ctx, actor, { action: 'secret.reveal', target_type: 'secret', target_id: secret.id, field_key: f.key });
  }
  return { name: secret.name, fields };
}

/** 403 `forbidden` raised where `secrets:meta-write` is not enough — a sensitive field would be created, touched or removed (spec §1.1). */
const SENSITIVE_FORBIDDEN = () => new AppError(403, 'forbidden', 'sensitive fields need secrets:write');

/**
 * `secrets:meta-write` (spec §1.1) may create a secret only when every field resolves to
 * non-sensitive (explicit `sensitive: false`, or a key outside `NON_SENSITIVE_KEYS` defaulting
 * to sensitive would fail this).
 */
function assertMetaWriteCreateAllowed(input: SecretInput): void {
  const hasSensitive = input.fields.some((f) => f.sensitive ?? defaultSensitive(f.key));
  if (hasSensitive) throw SENSITIVE_FORBIDDEN();
}

/**
 * `secrets:meta-write` may PATCH name/description/tags/order freely, and `fields`/`removeFields`
 * only for keys that are non-sensitive both before and after the patch (Review Focus 2: flipping
 * a field from non-sensitive to sensitive, or touching/adding/removing a sensitive field, is
 * refused — that always needs `secrets:write`).
 */
function assertMetaWritePatchAllowed(existing: SecretMeta, patch: SecretPatch): void {
  const priorSensitive = new Map(existing.fields.map((f) => [f.key, f.sensitive]));
  for (const f of patch.fields ?? []) {
    const wasSensitive = priorSensitive.get(f.key) ?? false;
    const willBeSensitive = f.sensitive ?? priorSensitive.get(f.key) ?? defaultSensitive(f.key);
    if (wasSensitive || willBeSensitive) throw SENSITIVE_FORBIDDEN();
  }
  for (const k of patch.removeFields ?? []) {
    if (priorSensitive.get(k)) throw SENSITIVE_FORBIDDEN();
  }
}

export function createSecretFor(ctx: AppContext, actor: Actor, projectSlug: string | null, input: SecretInput): PublicSecret {
  if (!hasScope(actor.principal, 'secrets:write')) {
    assertScope(actor.principal, 'secrets:meta-write');
    assertMetaWriteCreateAllowed(input);
  }
  const project = scopeProject(ctx, actor.principal, projectSlug);
  const s = createSecret(ctx.db, ctx.ring, { ...input, projectId: project?.id ?? null });
  auditAs(ctx, actor, { action: 'secret.create', target_type: 'secret', target_id: s.id, meta: { name: s.name, keys: s.fields.map((f) => f.key) } });
  return publicSecret(s);
}

export function updateSecretFor(ctx: AppContext, actor: Actor, projectSlug: string | null, name: string, patch: SecretPatch): PublicSecret {
  if (!hasScope(actor.principal, 'secrets:write')) {
    assertScope(actor.principal, 'secrets:meta-write');
  }
  const project = scopeProject(ctx, actor.principal, projectSlug);
  const existing = mustGet(ctx, project?.id ?? null, name);
  if (!hasScope(actor.principal, 'secrets:write')) {
    assertMetaWritePatchAllowed(existing, patch);
  }
  const s = updateSecret(ctx.db, ctx.ring, existing.id, patch);
  auditAs(ctx, actor, {
    action: 'secret.update',
    target_type: 'secret',
    target_id: s.id,
    meta: { fields: patch.fields?.map((f) => f.key) ?? [], removed: patch.removeFields ?? [], meta: Object.keys(patch).filter((k) => k !== 'fields' && k !== 'removeFields') },
  });
  return publicSecret(s);
}

export function deleteSecretFor(ctx: AppContext, actor: Actor, projectSlug: string | null, name: string): void {
  assertScope(actor.principal, 'secrets:write');
  const project = scopeProject(ctx, actor.principal, projectSlug);
  const existing = mustGet(ctx, project?.id ?? null, name);
  deleteSecret(ctx.db, project?.id ?? null, name);
  auditAs(ctx, actor, { action: 'secret.delete', target_type: 'secret', target_id: existing.id, meta: { name } });
}
