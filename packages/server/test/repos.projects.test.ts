import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db/connection.js';
import { createProject, getProjectBySlug, listProjects, updateProject, deleteProject } from '../src/repos/projects.js';
import { ConflictError, NotFoundError } from '../src/errors.js';

const input = (slug: string) => ({ slug, name: slug.toUpperCase(), status: 'active' as const, tags: ['wp'], summary: 's' });

describe('projects repo', () => {
  it('creates and reads', () => {
    const db = openDb(':memory:');
    const p = createProject(db, input('alpha'));
    expect(p.id).toBeGreaterThan(0);
    expect(p.tags).toEqual(['wp']);
    expect(getProjectBySlug(db, 'alpha')?.name).toBe('ALPHA');
    expect(getProjectBySlug(db, 'nope')).toBeNull();
  });
  it('rejects duplicate slug', () => {
    const db = openDb(':memory:');
    createProject(db, input('alpha'));
    expect(() => createProject(db, input('alpha'))).toThrow(ConflictError);
  });
  it('lists all or a subset', () => {
    const db = openDb(':memory:');
    const a = createProject(db, input('alpha'));
    createProject(db, input('beta'));
    expect(listProjects(db, null).map((p) => p.slug)).toEqual(['alpha', 'beta']);
    expect(listProjects(db, [a.id]).map((p) => p.slug)).toEqual(['alpha']);
    expect(listProjects(db, [])).toEqual([]);
  });
  it('updates partial fields and bumps updated_at', () => {
    const db = openDb(':memory:');
    const a = createProject(db, input('alpha'));
    const u = updateProject(db, a.id, { status: 'archived', tags: [] });
    expect(u.status).toBe('archived');
    expect(u.tags).toEqual([]);
    expect(u.name).toBe('ALPHA');
    expect(u.updated_at).toBeGreaterThanOrEqual(a.updated_at);
    expect(() => updateProject(db, 999, { name: 'x' })).toThrow(NotFoundError);
  });
  it('deletes', () => {
    const db = openDb(':memory:');
    const a = createProject(db, input('alpha'));
    expect(deleteProject(db, a.id)).toBe(true);
    expect(deleteProject(db, a.id)).toBe(false);
  });
});
