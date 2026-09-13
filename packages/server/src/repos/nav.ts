import type { Db } from '../db/connection.js';

export interface NavProject {
  slug: string;
  name: string;
  status: 'active' | 'paused' | 'archived';
  docs: number;
  secrets: number;
}

export interface NavData {
  projects: NavProject[];
  globalDocs: number;
  globalSecrets: number;
  tokens: number;
}

interface RawNavProject {
  slug: string;
  name: string;
  status: string;
  docs: number;
  secrets: number;
}

const PROJECTS_SQL = `
  SELECT
    p.slug AS slug,
    p.name AS name,
    p.status AS status,
    (SELECT COUNT(*) FROM documents d WHERE d.project_id = p.id) AS docs,
    (SELECT COUNT(*) FROM secrets s WHERE s.project_id = p.id) AS secrets
  FROM projects p
  ORDER BY CASE p.status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 WHEN 'archived' THEN 2 ELSE 3 END, p.slug
`;

export function loadNav(db: Db): NavData {
  const projects = db.prepare(PROJECTS_SQL).all() as RawNavProject[];
  const globalDocs = (db.prepare(`SELECT COUNT(*) AS n FROM documents WHERE project_id IS NULL`).get() as { n: number }).n;
  const globalSecrets = (db.prepare(`SELECT COUNT(*) AS n FROM secrets WHERE project_id IS NULL`).get() as { n: number }).n;
  const tokens = (db.prepare(`SELECT COUNT(*) AS n FROM api_tokens WHERE revoked_at IS NULL`).get() as { n: number }).n;
  return {
    projects: projects.map((p) => ({ slug: p.slug, name: p.name, status: p.status as NavProject['status'], docs: p.docs, secrets: p.secrets })),
    globalDocs,
    globalSecrets,
    tokens,
  };
}
