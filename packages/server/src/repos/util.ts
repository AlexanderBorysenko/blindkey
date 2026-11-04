export function now(): number {
  return Date.now();
}

export function parseJsonArray<T>(s: string | null): T[] {
  if (!s) return [];
  try {
    const v: unknown = JSON.parse(s);
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

export function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE'
  );
}

/**
 * Which secrets / documents one user can see, as ids for an SQL filter: everything in `workspaceIds`
 * (owned workspaces), project items of `projectIds` (a project grant carrying the perm) and the single
 * `itemIds` (an item grant carrying it).
 */
export interface ItemVisibility {
  workspaceIds: number[];
  projectIds: number[];
  itemIds: number[];
  /** Global (project-less) items must sit in one of these workspaces; null = no such limit. */
  globalWorkspaceIds: number[] | null;
}

/** `AND (...)` SQL for `ItemVisibility` against a table whose columns are `workspace_id`, `project_id` and `id` (optionally aliased). */
export function visibilitySql(v: ItemVisibility, alias = ''): { sql: string; params: number[] } {
  const c = alias ? `${alias}.` : '';
  const parts: string[] = [];
  const params: number[] = [];
  if (v.workspaceIds.length) { parts.push(`${c}workspace_id IN (${inList(v.workspaceIds)})`); params.push(...v.workspaceIds); }
  if (v.projectIds.length) { parts.push(`${c}project_id IN (${inList(v.projectIds)})`); params.push(...v.projectIds); }
  if (v.itemIds.length) { parts.push(`${c}id IN (${inList(v.itemIds)})`); params.push(...v.itemIds); }
  let sql = parts.length ? `(${parts.join(' OR ')})` : '0';
  if (v.globalWorkspaceIds !== null) {
    const g = v.globalWorkspaceIds;
    sql += ` AND (${c}project_id IS NOT NULL${g.length ? ` OR ${c}workspace_id IN (${inList(g)})` : ''})`;
    params.push(...g);
  }
  return { sql: `(${sql})`, params };
}

export function inList(ids: number[]): string {
  return ids.map(() => '?').join(',');
}
