import type { Db } from '../db/connection.js';
import type { Principal } from '../auth/principal.js';
import { accessFor } from '../auth/access.js';

export interface NavProject {
  slug: string;
  name: string;
  status: 'active' | 'paused' | 'archived';
  docs: number;
  secrets: number;
}

export interface NavWorkspace {
  slug: string;
  name: string;
  owner: boolean;
}

export interface NavData {
  /** Every workspace the user can see (for the switcher). */
  workspaces: NavWorkspace[];
  /** The selected workspace; null when the user can see none yet. */
  active: NavWorkspace | null;
  /** At most `NAV_PROJECT_LIMIT` visible projects of the active workspace, most recently updated first. */
  projects: NavProject[];
  /** How many visible projects the active workspace has in total (drives "Show all"). */
  projectTotal: number;
  globalDocs: number;
  globalSecrets: number;
  tokens: number;
}

export const NAV_PROJECT_LIMIT = 10;

const EMPTY: NavData = { workspaces: [], active: null, projects: [], projectTotal: 0, globalDocs: 0, globalSecrets: 0, tokens: 0 };

/**
 * The sidebar for one user: their workspaces, and for the active one the projects they can see (with
 * counts of the items they can see) and its globals. `null` (no session) gives an empty sidebar.
 */
export function loadNav(db: Db, principal: Principal | null): NavData {
  if (!principal) return EMPTY;
  const access = accessFor(db, principal);
  const workspaces = access.visibleWorkspaces().map((w) => ({ slug: w.slug, name: w.name, owner: access.owns(w.id) }));
  const workspace = (() => {
    try {
      return access.resolveGlobalWorkspace(null);
    } catch {
      return null; // nothing visible yet (or ambiguous for a non-session caller): no workspace content
    }
  })();
  let active: NavWorkspace | null = null;
  let projects: NavProject[] = [];
  let projectTotal = 0;
  let globalDocs = 0;
  let globalSecrets = 0;
  if (workspace) {
    active = { slug: workspace.slug, name: workspace.name, owner: access.owns(workspace.id) };
    const visible = access.visibleProjectInWorkspace(workspace.id).sort((a, b) => b.updated_at - a.updated_at || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
    projectTotal = visible.length;
    projects = visible.slice(0, NAV_PROJECT_LIMIT).map((p) => {
      const docs = (db.prepare(`SELECT id, project_id, workspace_id FROM documents WHERE project_id = ?`).all(p.id) as { id: number; project_id: number; workspace_id: number }[]).filter((d) => access.docVisible(d)).length;
      const secrets = (db.prepare(`SELECT id, project_id, workspace_id FROM secrets WHERE project_id = ?`).all(p.id) as { id: number; project_id: number; workspace_id: number }[]).filter((s) => access.secretVisible(s)).length;
      return { slug: p.slug, name: p.name, status: p.status, docs, secrets };
    });
    const docs = db.prepare(`SELECT id, project_id, workspace_id FROM documents WHERE project_id IS NULL AND workspace_id = ?`).all(workspace.id) as { id: number; project_id: null; workspace_id: number }[];
    globalDocs = docs.filter((d) => access.docVisible(d)).length;
    const secrets = db.prepare(`SELECT id, project_id, workspace_id FROM secrets WHERE project_id IS NULL AND workspace_id = ?`).all(workspace.id) as { id: number; project_id: null; workspace_id: number }[];
    globalSecrets = secrets.filter((s) => access.secretVisible(s)).length;
  }
  const tokens = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM api_tokens WHERE user_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`)
      .get(principal.userId, Date.now()) as { n: number }
  ).n;
  return { workspaces, active, projects, projectTotal, globalDocs, globalSecrets, tokens };
}
