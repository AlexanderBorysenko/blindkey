import type { AppContext } from '../http/context.js';
import { hasScope, type Principal } from '../auth/principal.js';
import { getProjectById, listProjects } from '../repos/projects.js';
import { searchDocuments } from '../repos/documents.js';
import { searchSecretNames } from '../repos/secrets.js';
import { publicProject, type PublicProject } from '../http/serialize.js';

export interface SearchResult {
  projects?: PublicProject[];
  documents?: { project: string | null; slug: string; title: string; category: string; snippet: string }[];
  secrets?: { project: string | null; name: string; tags: string[] }[];
}

export function searchFor(ctx: AppContext, principal: Principal, q: string): SearchResult {
  const term = q.trim().toLowerCase();
  const out: SearchResult = {};
  const slugCache = new Map<number, string | null>();
  const slugOf = (id: number | null): string | null => {
    if (id === null) return null;
    if (!slugCache.has(id)) slugCache.set(id, getProjectById(ctx.db, id)?.slug ?? null);
    return slugCache.get(id) ?? null;
  };
  if (hasScope(principal, 'projects:read')) {
    out.projects = term
      ? listProjects(ctx.db, principal.projectIds)
          .filter((p) => p.slug.includes(term) || p.name.toLowerCase().includes(term) || p.tags.some((t) => t.toLowerCase().includes(term)))
          .map(publicProject)
      : [];
  }
  if (hasScope(principal, 'docs:read')) {
    out.documents = searchDocuments(ctx.db, q, principal.projectIds).map((h) => ({
      project: slugOf(h.project_id), slug: h.slug, title: h.title, category: h.category, snippet: h.snippet,
    }));
  }
  if (hasScope(principal, 'secrets:meta')) {
    out.secrets = searchSecretNames(ctx.db, q, principal.projectIds).map((s) => ({ project: slugOf(s.project_id), name: s.name, tags: s.tags }));
  }
  return out;
}
