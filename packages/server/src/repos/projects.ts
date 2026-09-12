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

export function deleteProject(db: Db, id: number): boolean {
  return db.prepare(`DELETE FROM projects WHERE id = ?`).run(id).changes > 0;
}
