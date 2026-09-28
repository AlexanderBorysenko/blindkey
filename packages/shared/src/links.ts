import { defaultSensitive } from './schemas.js';

export interface SecretRequestLinkInput {
  /** Project slug, or null for a global secret. */
  project: string | null;
  name: string;
  /** Whether a secret with this name already exists (edit page) or not (new-secret form). */
  exists: boolean;
  description?: string;
  tags?: string[];
  keys: { key: string; sensitive: boolean }[];
}

/**
 * Path + query of the admin-UI page where the user types a secret's values (spec §1.5), shared by
 * the MCP `secret_request_link` tool and `pidb secrets request`. `sensitive: false` is honoured only
 * for keys that are non-sensitive by default: an agent must not be able to make e.g. `password` a
 * visible field whose value list_secrets would then return to it. The user can still untick the row.
 */
export function secretRequestPath(input: SecretRequestLinkInput): string {
  const prefix = input.project ? `/p/${encodeURIComponent(input.project)}` : '/global';
  const qs = new URLSearchParams();
  qs.set('name', input.name);
  if (input.description) qs.set('description', input.description);
  if (input.tags && input.tags.length > 0) qs.set('tags', input.tags.join(','));
  qs.set('keys', input.keys.map((k) => (k.sensitive || defaultSensitive(k.key) ? k.key : `${k.key}!`)).join(','));
  const path = input.exists ? `${prefix}/secrets/${encodeURIComponent(input.name)}/edit` : `${prefix}/secrets/new`;
  return `${path}?${qs.toString()}`;
}
