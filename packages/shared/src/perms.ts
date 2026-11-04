/** Per-user grant permissions (multi-user workspaces). `*` is only an input shorthand — never stored. */
export const PERMS = ['public.read', 'public.write', 'protected.read', 'protected.write', 'cli', 'docs.read', 'docs.write'] as const;
export type Perm = (typeof PERMS)[number];

export const GRANT_TARGET_TYPES = ['project', 'secret', 'document'] as const;
export type GrantTargetType = (typeof GRANT_TARGET_TYPES)[number];

export const SECRET_PERMS = ['public.read', 'public.write', 'protected.read', 'protected.write', 'cli'] as const satisfies readonly Perm[];
export const DOC_PERMS = ['docs.read', 'docs.write'] as const satisfies readonly Perm[];

const GROUPS: Record<string, readonly Perm[]> = {
  '*': PERMS,
  'public.*': ['public.read', 'public.write'],
  'protected.*': ['protected.read', 'protected.write'],
  'docs.*': ['docs.read', 'docs.write'],
};

export function isPerm(s: string): s is Perm {
  return (PERMS as readonly string[]).includes(s);
}

/** Expands one perm string or wildcard (`*`, `public.*`, `protected.*`, `docs.*`); null when unknown. */
export function expandPerms(p: string): Perm[] | null {
  const group = GROUPS[p];
  if (group) return [...group];
  return isPerm(p) ? [p] : null;
}

/** Expands wildcards and returns a sorted, de-duplicated array in canonical PERMS order. Throws on an unknown perm. */
export function normalizePerms(input: readonly string[] | string): Perm[] {
  const list = typeof input === 'string' ? [input] : input;
  const set = new Set<Perm>();
  for (const p of list) {
    const expanded = expandPerms(p);
    if (!expanded) throw new Error(`unknown permission "${p}"`);
    for (const e of expanded) set.add(e);
  }
  return PERMS.filter((p) => set.has(p));
}

/** Returns an error message when `perms` is not legal for the target type, otherwise null. */
export function validatePermsForTarget(targetType: GrantTargetType, perms: readonly Perm[]): string | null {
  if (perms.length === 0) return 'at least one permission is required';
  if (targetType === 'secret') {
    const bad = perms.find((p) => p === 'docs.read' || p === 'docs.write');
    if (bad) return `permission "${bad}" is not valid on a secret`;
  } else if (targetType === 'document') {
    const bad = perms.find((p) => p !== 'docs.read' && p !== 'docs.write');
    if (bad) return `permission "${bad}" is not valid on a document`;
  }
  return null;
}
