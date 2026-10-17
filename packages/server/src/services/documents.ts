import { docSlugSchema, lintForSecrets, parseSecretRefs, type DocumentInput } from '@blindkey/shared';
import type { AppContext } from '../http/context.js';
import { assertScope, canAccessProject, hasScope, type Actor, type Principal } from '../auth/principal.js';
import { NotFoundError, UnprocessableError, ValidationError } from '../errors.js';
import { getProjectBySlug, type ProjectRow } from '../repos/projects.js';
import { deleteDocument, getDocument, listDocuments, upsertDocument } from '../repos/documents.js';
import { getSecretMeta } from '../repos/secrets.js';
import { publicDoc, publicDocSummary, type PublicDoc, type PublicDocSummary } from '../http/serialize.js';
import { auditAs, loadProjectFor } from './common.js';

export interface ResolvedRef {
  ref: string;
  name: string;
  project: string | null;
  fields: { key: string; sensitive: boolean }[];
}

export function resolveDocScope(ctx: AppContext, principal: Principal, projectSlug: string | null): ProjectRow | null {
  return projectSlug === null ? null : loadProjectFor(ctx, principal, projectSlug);
}

export function resolveRefs(
  ctx: AppContext,
  principal: Principal,
  project: ProjectRow | null,
  md: string,
): { resolved: ResolvedRef[]; unresolved: string[] } {
  const resolved: ResolvedRef[] = [];
  const unresolved: string[] = [];
  for (const ref of parseSecretRefs(md)) {
    let projectId: number | null;
    let projectSlug: string | null;
    if (ref.global) {
      projectId = null;
      projectSlug = null;
    } else if (ref.project !== null) {
      const p = getProjectBySlug(ctx.db, ref.project);
      if (!p || !canAccessProject(principal, p.id)) {
        unresolved.push(ref.raw);
        continue;
      }
      projectId = p.id;
      projectSlug = p.slug;
    } else {
      projectId = project?.id ?? null;
      projectSlug = project?.slug ?? null;
    }
    const s = getSecretMeta(ctx.db, ctx.ring, projectId, ref.name);
    if (!s) {
      unresolved.push(ref.raw);
      continue;
    }
    resolved.push({ ref: ref.raw, name: s.name, project: projectSlug, fields: s.fields.map((f) => ({ key: f.key, sensitive: f.sensitive })) });
  }
  return { resolved, unresolved };
}

function validSlug(slug: string): string {
  const r = docSlugSchema.safeParse(slug);
  if (!r.success) throw new ValidationError(r.error.issues);
  return r.data;
}

export function listDocumentsFor(ctx: AppContext, principal: Principal, projectSlug: string | null): PublicDocSummary[] {
  assertScope(principal, 'docs:read');
  const project = resolveDocScope(ctx, principal, projectSlug);
  return listDocuments(ctx.db, project?.id ?? null).map(publicDocSummary);
}

export function readDocumentFor(
  ctx: AppContext,
  principal: Principal,
  projectSlug: string | null,
  slug: string,
  withRefs: boolean,
): PublicDoc & { refs?: ResolvedRef[] } {
  assertScope(principal, 'docs:read');
  const project = resolveDocScope(ctx, principal, projectSlug);
  const doc = getDocument(ctx.db, project?.id ?? null, slug);
  if (!doc) throw new NotFoundError('document not found');
  const out: PublicDoc & { refs?: ResolvedRef[] } = publicDoc(doc);
  if (withRefs && hasScope(principal, 'secrets:meta')) out.refs = resolveRefs(ctx, principal, project, doc.body_md).resolved;
  return out;
}

export function writeDocumentFor(
  ctx: AppContext,
  actor: Actor,
  projectSlug: string | null,
  slug: string,
  input: DocumentInput,
): { doc: PublicDoc; created: boolean } {
  assertScope(actor.principal, 'docs:write');
  const project = resolveDocScope(ctx, actor.principal, projectSlug);
  const cleanSlug = validSlug(slug);
  const findings = lintForSecrets(input.body_md);
  const { unresolved } = resolveRefs(ctx, actor.principal, project, input.body_md);
  if (!input.force) {
    if (findings.length) throw new UnprocessableError('lint', { findings });
    if (unresolved.length) throw new UnprocessableError('unresolved_refs', { unresolved });
  }
  const { doc, created } = upsertDocument(ctx.db, {
    projectId: project?.id ?? null,
    slug: cleanSlug,
    title: input.title,
    category: input.category,
    body_md: input.body_md,
  });
  const forced = input.force && (findings.length > 0 || unresolved.length > 0);
  auditAs(ctx, actor, {
    action: 'doc.write',
    target_type: 'document',
    target_id: doc.id,
    meta: forced ? { lint_forced: findings.length > 0, unresolved_refs: unresolved.length } : null,
  });
  return { doc: publicDoc(doc), created };
}

export function deleteDocumentFor(ctx: AppContext, actor: Actor, projectSlug: string | null, slug: string): void {
  assertScope(actor.principal, 'docs:write');
  const project = resolveDocScope(ctx, actor.principal, projectSlug);
  const doc = getDocument(ctx.db, project?.id ?? null, slug);
  if (!doc) throw new NotFoundError('document not found');
  deleteDocument(ctx.db, project?.id ?? null, slug);
  auditAs(ctx, actor, { action: 'doc.delete', target_type: 'document', target_id: doc.id, meta: { slug } });
}
