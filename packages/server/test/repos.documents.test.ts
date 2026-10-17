import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db/connection.js';
import { createProject } from '../src/repos/projects.js';
import { upsertDocument, getDocument, listDocuments, deleteDocument, searchDocuments, toFtsQuery } from '../src/repos/documents.js';

function setup() {
  const db = openDb(':memory:');
  const p = createProject(db, { slug: 'alpha', name: 'A', status: 'active', tags: [], summary: '' });
  const q = createProject(db, { slug: 'beta', name: 'B', status: 'active', tags: [], summary: '' });
  return { db, p, q };
}

describe('documents repo', () => {
  it('upserts (create then update) and reads project + global docs', () => {
    const { db, p } = setup();
    const c = upsertDocument(db, { projectId: p.id, slug: 'context', title: 'Ctx', category: 'context', body_md: 'v1' });
    expect(c.created).toBe(true);
    const u = upsertDocument(db, { projectId: p.id, slug: 'context', title: 'Ctx2', category: 'context', body_md: 'v2' });
    expect(u.created).toBe(false);
    expect(u.doc.id).toBe(c.doc.id);
    expect(getDocument(db, p.id, 'context')?.body_md).toBe('v2');
    upsertDocument(db, { projectId: null, slug: 'guidelines', title: 'G', category: 'guidelines', body_md: 'global' });
    expect(getDocument(db, null, 'guidelines')?.body_md).toBe('global');
    expect(getDocument(db, p.id, 'guidelines')).toBeNull();
  });
  it('lists summaries without body', () => {
    const { db, p } = setup();
    upsertDocument(db, { projectId: p.id, slug: 'a', title: 'A', category: 'notes', body_md: 'x' });
    const list = listDocuments(db, p.id);
    expect(list).toHaveLength(1);
    expect(list[0]).not.toHaveProperty('body_md');
  });
  it('deletes', () => {
    const { db, p } = setup();
    upsertDocument(db, { projectId: p.id, slug: 'a', title: 'A', category: 'notes', body_md: 'x' });
    expect(deleteDocument(db, p.id, 'a')).toBe(true);
    expect(deleteDocument(db, p.id, 'a')).toBe(false);
  });
  it('searches with project scoping and includes global docs', () => {
    const { db, p, q } = setup();
    upsertDocument(db, { projectId: p.id, slug: 'a', title: 'Deploy', category: 'deploy', body_md: 'uses caddy for tls' });
    upsertDocument(db, { projectId: q.id, slug: 'b', title: 'Deploy', category: 'deploy', body_md: 'uses caddy too' });
    upsertDocument(db, { projectId: null, slug: 'g', title: 'Guide', category: 'guidelines', body_md: 'caddy is the proxy' });
    expect(searchDocuments(db, 'caddy', null)).toHaveLength(3);
    const scoped = searchDocuments(db, 'caddy', [p.id]);
    expect(scoped.map((h) => h.project_id).sort()).toEqual([null, p.id].sort());
    expect(scoped[0]?.snippet).toContain('caddy');
    expect(searchDocuments(db, 'caddy', [])).toHaveLength(1);
  });
  it('does not throw on FTS-special characters', () => {
    const { db } = setup();
    expect(toFtsQuery('a "b" (c) OR')).toBe('"a" "b" "(c)" "OR"');
    expect(searchDocuments(db, '"unbalanced (', null)).toEqual([]);
    expect(searchDocuments(db, '   ', null)).toEqual([]);
  });
});
