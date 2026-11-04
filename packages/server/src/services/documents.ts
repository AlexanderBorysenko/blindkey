import { DOC_PERMS, docSlugSchema, lintForSecrets, parseSecretRefs, type DocumentInput, type Perm } from '@blindkey/shared';
import type { AppContext } from '../http/context.js';
import { assertScope, hasScope, type Actor, type Principal } from '../auth/principal.js';
import { accessFor, hasPerm, type Access } from '../auth/access.js';
import { NotFoundError, PermissionError, UnprocessableError, ValidationError } from '../errors.js';
import { getProjectBySlug, type ProjectRow } from '../repos/projects.js';
import { deleteDocument, getDocument, listDocuments, upsertDocument, type DocumentRow } from '../repos/documents.js';
import { getSecretMeta } from '../repos/secrets.js';
import { publicDoc, publicDocSummary, type PublicDoc, type PublicDocSummary } from '../http/serialize.js';
import { auditAs } from './common.js';

export interface ResolvedRef {
  ref: string;
  name: string;
  project: string | null;
  fields: { key: string; sensitive: boolean }[];
}

/** Where a call points: a project, or the globals of one workspace. Invisible projects/workspaces are a 404. */
export interface DocScope {
  project: ProjectRow | null;
  workspaceId: number;
}

export function resolveDocScope(ctx: AppContext, principal: Principal, projectSlug: string | null, workspaceSlug?: string | null): DocScope {
  const access = accessFor(ctx.db, principal);
  if (projectSlug !== null) {
    const project = access.project(getProjectBySlug(ctx.db, projectSlug));
    return { project, workspaceId: project.workspace_id };
  }
  return { project: null, workspaceId: access.resolveGlobalWorkspace(workspaceSlug).id };
}

/**
 * Resolves the `{{secret:…}}` references in a document living in `scope` (a project, or the globals
 * of `scope.workspaceId`: `global/X` always means the document's own workspace). A reference to a
 * secret the principal cannot see is reported exactly like one that does not exist, and its
 * fields are never listed.
 */
export function resolveRefs(
  ctx: AppContext,
  principal: Principal,
  scope: DocScope,
  md: string,
): { resolved: ResolvedRef[]; unresolved: string[] } {
  const access = accessFor(ctx.db, principal);
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
      if (!p || !access.projectVisible(p)) {
        unresolved.push(ref.raw);
        continue;
      }
      projectId = p.id;
      projectSlug = p.slug;
    } else {
      projectId = scope.project?.id ?? null;
      projectSlug = scope.project?.slug ?? null;
    }
    const s = getSecretMeta(ctx.db, ctx.ring, projectId, ref.name, scope.workspaceId);
    if (!s || !access.secretVisible(s)) {
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

function lookup(ctx: AppContext, scope: DocScope, slug: string): DocumentRow | null {
  return getDocument(ctx.db, scope.project?.id ?? null, slug, scope.workspaceId);
}

/** The document and the caller's effective perms; missing and invisible are the same 404. */
function mustGet(ctx: AppContext, access: Access, scope: DocScope, slug: string): { doc: DocumentRow; perms: Perm[] } {
  const doc = lookup(ctx, scope, slug);
  if (!doc) throw new NotFoundError('document not found');
  return { doc, perms: access.doc(doc) };
}

export function listDocumentsFor(ctx: AppContext, principal: Principal, projectSlug: string | null, workspaceSlug?: string | null): PublicDocSummary[] {
  assertScope(principal, 'docs:read');
  const access = accessFor(ctx.db, principal);
  const scope = resolveDocScope(ctx, principal, projectSlug, workspaceSlug);
  return listDocuments(ctx.db, scope.project?.id ?? null, scope.workspaceId)
    .filter((d) => access.docVisible(d))
    .map(publicDocSummary);
}

export function readDocumentFor(
  ctx: AppContext,
  principal: Principal,
  projectSlug: string | null,
  slug: string,
  withRefs: boolean,
  workspaceSlug?: string | null,
): PublicDoc & { refs?: ResolvedRef[] } {
  assertScope(principal, 'docs:read');
  const access = accessFor(ctx.db, principal);
  const scope = resolveDocScope(ctx, principal, projectSlug, workspaceSlug);
  const { doc, perms } = mustGet(ctx, access, scope, slug);
  if (!hasPerm(perms, 'docs.read')) throw new PermissionError('docs.read');
  const out: PublicDoc & { refs?: ResolvedRef[] } = publicDoc(doc);
  if (withRefs && hasScope(principal, 'secrets:meta')) out.refs = resolveRefs(ctx, principal, scope, doc.body_md).resolved;
  return out;
}

export function writeDocumentFor(
  ctx: AppContext,
  actor: Actor,
  projectSlug: string | null,
  slug: string,
  input: DocumentInput,
  workspaceSlug?: string | null,
): { doc: PublicDoc; created: boolean } {
  assertScope(actor.principal, 'docs:write');
  const access = accessFor(ctx.db, actor.principal);
  const scope = resolveDocScope(ctx, actor.principal, projectSlug, workspaceSlug);
  const cleanSlug = validSlug(slug);
  // Updating needs docs.write on the document (project grant or its own); creating needs it on the project
  // (owner only for globals). An existing document the caller cannot see is treated like a missing one,
  // so the answer never reveals it.
  const existing = lookup(ctx, scope, cleanSlug);
  const visible = existing !== null && access.docVisible(existing);
  const perms = visible ? access.docPerms(existing) : scope.project ? access.projectPerms(scope.project) : access.owns(scope.workspaceId) ? [...DOC_PERMS] : [];
  if (!hasPerm(perms, 'docs.write')) throw new PermissionError('docs.write');
  const findings = lintForSecrets(input.body_md);
  const { unresolved } = resolveRefs(ctx, actor.principal, scope, input.body_md);
  if (!input.force) {
    if (findings.length) throw new UnprocessableError('lint', { findings });
    if (unresolved.length) throw new UnprocessableError('unresolved_refs', { unresolved });
  }
  const { doc, created } = upsertDocument(ctx.db, {
    projectId: scope.project?.id ?? null,
    workspaceId: scope.workspaceId,
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
    workspace_id: doc.workspace_id,
    meta: forced ? { lint_forced: findings.length > 0, unresolved_refs: unresolved.length } : null,
  });
  return { doc: publicDoc(doc), created };
}

export function deleteDocumentFor(ctx: AppContext, actor: Actor, projectSlug: string | null, slug: string, workspaceSlug?: string | null): void {
  assertScope(actor.principal, 'docs:write');
  const access = accessFor(ctx.db, actor.principal);
  const scope = resolveDocScope(ctx, actor.principal, projectSlug, workspaceSlug);
  const { doc, perms } = mustGet(ctx, access, scope, slug);
  if (!hasPerm(perms, 'docs.write')) throw new PermissionError('docs.write');
  deleteDocument(ctx.db, scope.project?.id ?? null, slug, scope.workspaceId);
  auditAs(ctx, actor, { action: 'doc.delete', target_type: 'document', target_id: doc.id, workspace_id: doc.workspace_id, meta: { slug } });
}
