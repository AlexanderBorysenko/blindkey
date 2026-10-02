import type { DocCategory } from '@blindkey/shared';
import type { Db } from '../db/connection.js';
import { inList, now } from './util.js';

export interface DocumentRow {
  id: number;
  project_id: number | null;
  slug: string;
  title: string;
  category: DocCategory;
  body_md: string;
  created_at: number;
  updated_at: number;
}
export type DocumentSummary = Omit<DocumentRow, 'body_md'>;
export interface DocumentSearchHit {
  id: number;
  project_id: number | null;
  slug: string;
  title: string;
  category: DocCategory;
  snippet: string;
}

export interface DocumentUpsert {
  projectId: number | null;
  slug: string;
  title: string;
  category: DocCategory;
  body_md: string;
}

const COLS = 'id, project_id, slug, title, category, body_md, created_at, updated_at';

export function getDocument(db: Db, projectId: number | null, slug: string): DocumentRow | null {
  const r = db.prepare(`SELECT ${COLS} FROM documents WHERE project_id IS ? AND slug = ?`).get(projectId, slug) as DocumentRow | undefined;
  return r ?? null;
}

export function upsertDocument(db: Db, input: DocumentUpsert): { doc: DocumentRow; created: boolean } {
  const ts = now();
  const existing = getDocument(db, input.projectId, input.slug);
  if (existing) {
    db.prepare(`UPDATE documents SET title = ?, category = ?, body_md = ?, updated_at = ? WHERE id = ?`).run(
      input.title, input.category, input.body_md, ts, existing.id,
    );
    return { doc: getDocument(db, input.projectId, input.slug)!, created: false };
  }
  db.prepare(`INSERT INTO documents (project_id, slug, title, category, body_md, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    input.projectId, input.slug, input.title, input.category, input.body_md, ts, ts,
  );
  return { doc: getDocument(db, input.projectId, input.slug)!, created: true };
}

export function listDocuments(db: Db, projectId: number | null): DocumentSummary[] {
  return db
    .prepare(`SELECT id, project_id, slug, title, category, created_at, updated_at FROM documents WHERE project_id IS ? ORDER BY category, title COLLATE NOCASE`)
    .all(projectId) as DocumentSummary[];
}

export function deleteDocument(db: Db, projectId: number | null, slug: string): boolean {
  return db.prepare(`DELETE FROM documents WHERE project_id IS ? AND slug = ?`).run(projectId, slug).changes > 0;
}

export function toFtsQuery(q: string): string {
  return q
    .split(/\s+/)
    .map((t) => t.replace(/"/g, ''))
    .filter(Boolean)
    .map((t) => `"${t}"`)
    .join(' ');
}

export function searchDocuments(db: Db, query: string, projectIds: number[] | null, limit = 20): DocumentSearchHit[] {
  const fts = toFtsQuery(query);
  if (!fts) return [];
  const scope = projectIds === null ? '1=1' : projectIds.length === 0 ? 'd.project_id IS NULL' : `(d.project_id IS NULL OR d.project_id IN (${inList(projectIds)}))`;
  const params: unknown[] = [fts, ...(projectIds ?? []), limit];
  return db
    .prepare(
      `SELECT d.id, d.project_id, d.slug, d.title, d.category, snippet(documents_fts, 1, '[', ']', '…', 12) AS snippet
       FROM documents_fts f JOIN documents d ON d.id = f.rowid
       WHERE documents_fts MATCH ? AND ${scope}
       ORDER BY bm25(documents_fts) LIMIT ?`,
    )
    .all(...params) as DocumentSearchHit[];
}
