import type { SecretInput, SecretPatch } from '@pidb/shared';
import type { AppContext } from '../http/context.js';
import { assertScope, type Actor, type Principal } from '../auth/principal.js';
import { NotFoundError } from '../errors.js';
import type { ProjectRow } from '../repos/projects.js';
import { createSecret, deleteSecret, getSecretMeta, listSecrets, revealAllFields, revealField, updateSecret, type SecretMeta } from '../repos/secrets.js';
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

export function revealFieldFor(ctx: AppContext, actor: Actor, projectSlug: string | null, name: string, key: string): string {
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

export function createSecretFor(ctx: AppContext, actor: Actor, projectSlug: string | null, input: SecretInput): PublicSecret {
  assertScope(actor.principal, 'secrets:write');
  const project = scopeProject(ctx, actor.principal, projectSlug);
  const s = createSecret(ctx.db, ctx.ring, { ...input, projectId: project?.id ?? null });
  auditAs(ctx, actor, { action: 'secret.create', target_type: 'secret', target_id: s.id, meta: { name: s.name, keys: s.fields.map((f) => f.key) } });
  return publicSecret(s);
}

export function updateSecretFor(ctx: AppContext, actor: Actor, projectSlug: string | null, name: string, patch: SecretPatch): PublicSecret {
  assertScope(actor.principal, 'secrets:write');
  const project = scopeProject(ctx, actor.principal, projectSlug);
  const existing = mustGet(ctx, project?.id ?? null, name);
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
