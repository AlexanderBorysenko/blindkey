import type { DocCategory, ProjectStatus, Scope } from '@pidb/shared';

export interface PublicProject {
  slug: string;
  name: string;
  status: ProjectStatus;
  tags: string[];
  summary: string;
  created_at: number;
  updated_at: number;
}

export interface PublicDocSummary {
  slug: string;
  title: string;
  category: DocCategory;
  created_at: number;
  updated_at: number;
}

export interface ResolvedRef {
  ref: string;
  name: string;
  project: string | null;
  fields: { key: string; sensitive: boolean }[];
}

export interface PublicDoc extends PublicDocSummary {
  body_md: string;
  refs?: ResolvedRef[];
}

export interface SecretFieldMeta {
  key: string;
  sensitive: boolean;
  value?: string;
}

export interface PublicSecret {
  name: string;
  description: string;
  tags: string[];
  fields: SecretFieldMeta[];
  created_at: number;
  updated_at: number;
}

export interface ProjectDetail extends PublicProject {
  documents: PublicDocSummary[];
  secrets: PublicSecret[];
}

export interface RevealedFields {
  name: string;
  fields: Record<string, string>;
  /** Keys of `fields` that are sensitive (agent `/use` responses; absent from older servers and from `/fields`). */
  sensitive?: string[];
}

export interface PublicToken {
  id: number;
  name: string;
  prefix: string;
  scopes: Scope[];
  projects: string[] | null;
  expires_at: number | null;
  last_used_at: number | null;
  revoked_at: number | null;
  created_at: number;
}

export interface SearchResult {
  projects?: PublicProject[];
  documents?: { project: string | null; slug: string; title: string; category: string; snippet: string }[];
  secrets?: { project: string | null; name: string; tags: string[] }[];
}
