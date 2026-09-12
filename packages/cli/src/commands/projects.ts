import type { PidbClient } from '../client.js';
import { seg } from '../client.js';
import type { ProjectDetail, PublicProject, SearchResult } from '../api-types.js';
import { fmtTime, table, type CommandResult } from '../output.js';

export async function runProjectsList(client: PidbClient): Promise<CommandResult> {
  const projects = await client.json<PublicProject[]>('GET', '/api/v1/projects');
  return {
    json: projects,
    text: table(
      ['SLUG', 'NAME', 'STATUS', 'TAGS', 'UPDATED'],
      projects.map((p) => [p.slug, p.name, p.status, p.tags.join(','), fmtTime(p.updated_at)]),
    ),
  };
}

export async function runProjectsGet(client: PidbClient, slug: string): Promise<CommandResult> {
  const detail = await client.json<ProjectDetail>('GET', `/api/v1/projects/${seg(slug)}`);
  const sections = [
    `${detail.slug}  ${detail.name}  [${detail.status}]${detail.tags.length ? `  tags: ${detail.tags.join(',')}` : ''}`,
  ];
  if (detail.summary) sections.push('', detail.summary);
  sections.push('', 'Documents:', table(['SLUG', 'TITLE', 'CATEGORY', 'UPDATED'],
    detail.documents.map((d) => [d.slug, d.title, d.category, fmtTime(d.updated_at)])));
  sections.push('', 'Secrets:', table(['NAME', 'FIELDS', 'TAGS', 'DESCRIPTION'],
    detail.secrets.map((s) => [
      s.name,
      s.fields.map((f) => (f.sensitive ? `${f.key}*` : f.key)).join(','),
      s.tags.join(','),
      s.description,
    ])));
  sections.push('', '* = sensitive; consume values with `pidb secret exec|write|env`');
  return { json: detail, text: sections.join('\n') };
}

export async function runSearch(client: PidbClient, query: string): Promise<CommandResult> {
  const result = await client.json<SearchResult>('GET', '/api/v1/search', { query: { q: query } });
  const sections: string[] = [];
  if (result.projects) {
    sections.push('Projects:', table(['SLUG', 'NAME', 'STATUS'], result.projects.map((p) => [p.slug, p.name, p.status])), '');
  }
  if (result.documents) {
    sections.push('Documents:', table(['PROJECT', 'SLUG', 'TITLE', 'SNIPPET'],
      result.documents.map((d) => [d.project ?? 'global', d.slug, d.title, d.snippet])), '');
  }
  if (result.secrets) {
    sections.push('Secrets:', table(['PROJECT', 'NAME', 'TAGS'],
      result.secrets.map((x) => [x.project ?? 'global', x.name, x.tags.join(',')])), '');
  }
  return { json: result, text: sections.join('\n').trimEnd() };
}
