import type { ProjectInput, ProjectPatch, ProjectStatus } from '@pidb/shared';
import type { Db } from '../db/connection.js';
import { ConflictError, NotFoundError } from '../errors.js';
import { inList, isUniqueViolation, now, parseJsonArray } from './util.js';

export interface ProjectRow {
  id: number;
  slug: string;
  name: string;
  status: ProjectStatus;
  tags: string[];
  summary: string;
  created_at: number;
  updated_at: number;
}

interface RawProject {
  id: number;
  slug: string;
  name: string;
  status: string;
  tags: string;
  summary: string;
  created_at: number;
  updated_at: number;
}

function toRow(r: RawProject): ProjectRow {
  return { ...r, status: r.status as ProjectStatus, tags: parseJsonArray<string>(r.tags) };
}

const COLS = 'id, slug, name, status, tags, summary, created_at, updated_at';

export function getProjectById(db: Db, id: number): ProjectRow | null {
  const r = db.prepare(`SELECT ${COLS} FROM projects WHERE id = ?`).get(id) as RawProject | undefined;
  return r ? toRow(r) : null;
}

export function getProjectBySlug(db: Db, slug: string): ProjectRow | null {
  const r = db.prepare(`SELECT ${COLS} FROM projects WHERE slug = ?`).get(slug) as RawProject | undefined;
  return r ? toRow(r) : null;
}

export function createProject(db: Db, input: ProjectInput): ProjectRow {
  const ts = now();
  try {
    const info = db
      .prepare(`INSERT INTO projects (slug, name, status, tags, summary, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(input.slug, input.name, input.status, JSON.stringify(input.tags), input.summary, ts, ts);
    return getProjectById(db, Number(info.lastInsertRowid))!;
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConflictError(`project slug "${input.slug}" already exists`);
    throw err;
  }
}

export function listProjects(db: Db, projectIds: number[] | null): ProjectRow[] {
  if (projectIds !== null && projectIds.length === 0) return [];
  const where = projectIds === null ? '' : `WHERE id IN (${inList(projectIds)})`;
  const rows = db.prepare(`SELECT ${COLS} FROM projects ${where} ORDER BY name COLLATE NOCASE`).all(...(projectIds ?? [])) as RawProject[];
  return rows.map(toRow);
}

export function updateProject(db: Db, id: number, patch: ProjectPatch): ProjectRow {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (patch.slug !== undefined) { sets.push('slug = ?'); values.push(patch.slug); }
  if (patch.name !== undefined) { sets.push('name = ?'); values.push(patch.name); }
  if (patch.status !== undefined) { sets.push('status = ?'); values.push(patch.status); }
  if (patch.tags !== undefined) { sets.push('tags = ?'); values.push(JSON.stringify(patch.tags)); }
  if (patch.summary !== undefined) { sets.push('summary = ?'); values.push(patch.summary); }
  sets.push('updated_at = ?');
  values.push(now());
  try {
    const info = db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
    if (info.changes === 0) throw new NotFoundError('project not found');
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConflictError(`project slug "${patch.slug}" already exists`);
    throw err;
  }
  return getProjectById(db, id)!;
}

/**
 * Deletes a project and scrubs its id from every token and pending connect approval. Project ids
 * are rowids that SQLite may hand out again, so a stale id left in `project_ids` would silently
 * grant an old token access to whichever project is created next with the same id.
 */
export function deleteProject(db: Db, id: number): boolean {
  return db.transaction(() => {
    const deleted = db.prepare(`DELETE FROM projects WHERE id = ?`).run(id).changes > 0;
    if (!deleted) return false;
    const scrub = (table: string, column: string) => {
      const rows = db.prepare(`SELECT id, ${column} AS ids FROM ${table} WHERE ${column} IS NOT NULL`).all() as { id: number; ids: string }[];
      const update = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE id = ?`);
      for (const r of rows) {
        const ids = parseJsonArray<number>(r.ids);
        if (ids.includes(id)) update.run(JSON.stringify(ids.filter((x) => x !== id)), r.id);
      }
    };
    scrub('api_tokens', 'project_ids');
    scrub('connect_requests', 'approved_project_ids');
    return true;
  })();
}
