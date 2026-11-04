import type { AppContext } from '../http/context.js';
import { hasScope, type Principal } from '../auth/principal.js';
import { accessFor, hasPerm } from '../auth/access.js';
import { getProjectById } from '../repos/projects.js';
import { searchDocuments } from '../repos/documents.js';
import { searchSecretNames } from '../repos/secrets.js';
import { publicProject, type PublicProject } from '../http/serialize.js';
import { workspaceSlugResolver } from './common.js';

export interface SearchResult {
  projects?: PublicProject[];
  /** `workspace` is set on global hits only (a project hit lives in its project's workspace). */
  documents?: { project: string | null; workspace?: string; slug: string; title: string; category: string; snippet: string }[];
  secrets?: { project: string | null; workspace?: string; name: string; tags: string[] }[];
}

const RESULT_LIMIT = 20;

export function searchFor(ctx: AppContext, principal: Principal, q: string): SearchResult {
  const term = q.trim().toLowerCase();
  const out: SearchResult = {};
  const access = accessFor(ctx.db, principal);
  const wsSlug = workspaceSlugResolver(ctx);
  const slugCache = new Map<number, string | null>();
  const slugOf = (id: number | null): string | null => {
    if (id === null) return null;
    if (!slugCache.has(id)) slugCache.set(id, getProjectById(ctx.db, id)?.slug ?? null);
    return slugCache.get(id) ?? null;
  };
  if (hasScope(principal, 'projects:read')) {
    out.projects = term
      ? access
          .visibleProjects()
          .filter((p) => p.slug.includes(term) || p.name.toLowerCase().includes(term) || p.tags.some((t) => t.toLowerCase().includes(term)))
          .map((p) => publicProject(p, wsSlug(p.workspace_id)))
      : [];
  }
  if (hasScope(principal, 'docs:read')) {
    out.documents = searchDocuments(ctx.db, q, principal.projectIds, RESULT_LIMIT, access.itemVisibility('document'))
      .filter((h) => access.docVisible(h) && hasPerm(access.docPerms(h), 'docs.read'))
      .slice(0, RESULT_LIMIT)
      .map((h) => ({ project: slugOf(h.project_id), ...(h.project_id === null ? { workspace: wsSlug(h.workspace_id) } : {}), slug: h.slug, title: h.title, category: h.category, snippet: h.snippet }));
  }
  if (hasScope(principal, 'secrets:meta')) {
    out.secrets = searchSecretNames(ctx.db, q, principal.projectIds, RESULT_LIMIT, access.itemVisibility('secret'))
      .filter((s) => access.secretVisible(s))
      .slice(0, RESULT_LIMIT)
      .map((s) => ({ project: slugOf(s.project_id), ...(s.project_id === null ? { workspace: wsSlug(s.workspace_id) } : {}), name: s.name, tags: s.tags }));
  }
  return out;
}
