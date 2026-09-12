export const SCOPES = [
  'projects:read',
  'docs:read',
  'docs:write',
  'secrets:meta',
  'secrets:reveal',
  'secrets:write',
  'admin',
] as const;
export type Scope = (typeof SCOPES)[number];

export const PROJECT_STATUSES = ['active', 'paused', 'archived'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const DOC_CATEGORIES = [
  'context',
  'architecture',
  'deploy',
  'conventions',
  'client',
  'notes',
  'guidelines',
] as const;
export type DocCategory = (typeof DOC_CATEGORIES)[number];

export const NON_SENSITIVE_KEYS = ['host', 'port', 'url', 'username', 'database', 'public_key'] as const;

export function defaultSensitive(key: string): boolean {
  return !(NON_SENSITIVE_KEYS as readonly string[]).includes(key);
}
