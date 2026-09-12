import type { DocCategory, ProjectStatus } from '@pidb/shared';
import type { ProjectRow } from '../repos/projects.js';
import type { DocumentRow, DocumentSummary } from '../repos/documents.js';
import type { SecretFieldMeta, SecretMeta } from '../repos/secrets.js';

export interface PublicProject {
  slug: string;
  name: string;
  status: ProjectStatus;
  tags: string[];
  summary: string;
  created_at: number;
  updated_at: number;
}
export function publicProject(p: ProjectRow): PublicProject {
  return { slug: p.slug, name: p.name, status: p.status, tags: p.tags, summary: p.summary, created_at: p.created_at, updated_at: p.updated_at };
}

export interface PublicDocSummary {
  slug: string;
  title: string;
  category: DocCategory;
  created_at: number;
  updated_at: number;
}
export function publicDocSummary(d: DocumentSummary): PublicDocSummary {
  return { slug: d.slug, title: d.title, category: d.category, created_at: d.created_at, updated_at: d.updated_at };
}

export interface PublicDoc extends PublicDocSummary {
  body_md: string;
}
export function publicDoc(d: DocumentRow): PublicDoc {
  return { ...publicDocSummary(d), body_md: d.body_md };
}

export interface PublicSecret {
  name: string;
  description: string;
  tags: string[];
  fields: SecretFieldMeta[];
  created_at: number;
  updated_at: number;
}
export function publicSecret(s: SecretMeta): PublicSecret {
  return { name: s.name, description: s.description, tags: s.tags, fields: s.fields, created_at: s.created_at, updated_at: s.updated_at };
}
