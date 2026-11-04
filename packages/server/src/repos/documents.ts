import type { DocCategory } from '@blindkey/shared';
import type { Db } from '../db/connection.js';
import { ConflictError, NotFoundError } from '../errors.js';
import { itemWorkspaceId, requireWorkspaceId } from './projects.js';
import { getWorkspaceById } from './workspaces.js';
import { inList, isUniqueViolation, now, visibilitySql, type ItemVisibility } from './util.js';

export interface DocumentRow {
  id: number;
  project_id: number | null;
  workspace_id: number;
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
  workspace_id: number;
  slug: string;
  title: string;
  category: DocCategory;
  snippet: string;
}

export interface DocumentUpsert {
  projectId: number | null;
  /** Needed for globals only (project items inherit their project's). */
  workspaceId?: number;
  slug: string;
  title: string;
  category: DocCategory;
  body_md: string;
}

const COLS = 'id, project_id, workspace_id, slug, title, category, body_md, created_at, updated_at';

/** Globals (projectId null) are scoped to a workspace; `workspaceId` is ignored for project items. */
export function getDocument(db: Db, projectId: number | null, slug: string, workspaceId?: number): DocumentRow | null {
  const r =
    projectId === null
      ? (db.prepare(`SELECT ${COLS} FROM documents WHERE project_id IS NULL AND workspace_id = ? AND slug = ?`).get(requireWorkspaceId(workspaceId), slug) as DocumentRow | undefined)
      : (db.prepare(`SELECT ${COLS} FROM documents WHERE project_id = ? AND slug = ?`).get(projectId, slug) as DocumentRow | undefined);
  return r ?? null;
}

export function upsertDocument(db: Db, input: DocumentUpsert): { doc: DocumentRow; created: boolean } {
  const ts = now();
  const workspaceId = itemWorkspaceId(db, input.projectId, input.workspaceId);
  const existing = getDocument(db, input.projectId, input.slug, workspaceId);
  if (existing) {
    db.prepare(`UPDATE documents SET title = ?, category = ?, body_md = ?, updated_at = ? WHERE id = ?`).run(
      input.title, input.category, input.body_md, ts, existing.id,
    );
    return { doc: getDocument(db, input.projectId, input.slug, workspaceId)!, created: false };
  }
  db.prepare(`INSERT INTO documents (project_id, workspace_id, slug, title, category, body_md, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    input.projectId, workspaceId, input.slug, input.title, input.category, input.body_md, ts, ts,
  );
  return { doc: getDocument(db, input.projectId, input.slug, workspaceId)!, created: true };
}

export function listDocuments(db: Db, projectId: number | null, workspaceId?: number): DocumentSummary[] {
  const cols = 'id, project_id, workspace_id, slug, title, category, created_at, updated_at';
  if (projectId === null) {
    return db
      .prepare(`SELECT ${cols} FROM documents WHERE project_id IS NULL AND workspace_id = ? ORDER BY category, title COLLATE NOCASE`)
      .all(requireWorkspaceId(workspaceId)) as DocumentSummary[];
  }
  return db.prepare(`SELECT ${cols} FROM documents WHERE project_id = ? ORDER BY category, title COLLATE NOCASE`).all(projectId) as DocumentSummary[];
}

export function deleteDocument(db: Db, projectId: number | null, slug: string, workspaceId?: number): boolean {
  if (projectId === null) {
    return db.prepare(`DELETE FROM documents WHERE project_id IS NULL AND workspace_id = ? AND slug = ?`).run(requireWorkspaceId(workspaceId), slug).changes > 0;
  }
  return db.prepare(`DELETE FROM documents WHERE project_id = ? AND slug = ?`).run(projectId, slug).changes > 0;
}

/** Moves a global document to another workspace (grants are kept); 409 when the slug is taken there. */
export function moveGlobalDocument(db: Db, id: number, workspaceId: number): DocumentRow {
  const row = db.prepare(`SELECT ${COLS} FROM documents WHERE id = ?`).get(id) as DocumentRow | undefined;
  if (!row) throw new NotFoundError('document not found');
  if (row.project_id !== null) throw new ConflictError('project documents move with their project');
  if (!getWorkspaceById(db, workspaceId)) throw new NotFoundError('workspace not found');
  try {
    db.prepare(`UPDATE documents SET workspace_id = ?, updated_at = ? WHERE id = ?`).run(workspaceId, now(), id);
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConflictError(`document "${row.slug}" already exists in the target workspace`);
    throw err;
  }
  return db.prepare(`SELECT ${COLS} FROM documents WHERE id = ?`).get(id) as DocumentRow;
}

export function toFtsQuery(q: string): string {
  return q
    .split(/\s+/)
    .map((t) => t.replace(/"/g, ''))
    .filter(Boolean)
    .map((t) => `"${t}"`)
    .join(' ');
}

/** `visible`, when given, limits hits to what one user may see (SQL-side, so `limit` counts visible hits only). */
export function searchDocuments(db: Db, query: string, projectIds: number[] | null, limit = 20, visible?: ItemVisibility): DocumentSearchHit[] {
  const fts = toFtsQuery(query);
  if (!fts) return [];
  const scope = projectIds === null ? '1=1' : projectIds.length === 0 ? 'd.project_id IS NULL' : `(d.project_id IS NULL OR d.project_id IN (${inList(projectIds)}))`;
  const vis = visible ? visibilitySql(visible, 'd') : null;
  const params: unknown[] = [fts, ...(projectIds ?? []), ...(vis?.params ?? []), limit];
  return db
    .prepare(
      `SELECT d.id, d.project_id, d.workspace_id, d.slug, d.title, d.category, snippet(documents_fts, 1, '[', ']', '…', 12) AS snippet
       FROM documents_fts f JOIN documents d ON d.id = f.rowid
       WHERE documents_fts MATCH ? AND ${scope}${vis ? ` AND ${vis.sql}` : ''}
       ORDER BY bm25(documents_fts) LIMIT ?`,
    )
    .all(...params) as DocumentSearchHit[];
}
