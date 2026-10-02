import { SCOPES, type Scope } from '@blindkey/shared';
import type { BlindkeyClient } from '../client.js';
import type { PublicToken } from '../api-types.js';
import { CliError } from '../errors.js';
import { fmtTime, table, type CommandResult } from '../output.js';

export interface TokenCreateOptions {
  name: string;
  scopes: string;
  projects?: string;
  expires?: string;
  /** commander sets this to false for --no-expiry */
  expiry?: boolean;
}

export function parseScopes(raw: string): Scope[] {
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length === 0) throw new CliError(`--scopes is required — one or more of: ${SCOPES.join(', ')}`);
  for (const part of parts) {
    if (!(SCOPES as readonly string[]).includes(part)) {
      throw new CliError(`unknown scope "${part}" — one of: ${SCOPES.join(', ')}`);
    }
  }
  return parts as Scope[];
}

const UNITS: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000 };

export function parseExpires(raw: string | undefined, now: number = Date.now()): number | undefined {
  if (raw === undefined) return undefined;
  const m = /^(\d+)([dhm])$/.exec(raw.trim());
  const unit = m ? UNITS[m[2] as string] : undefined;
  if (!m || unit === undefined) throw new CliError(`invalid --expires "${raw}" — use 90d, 12h or 30m`);
  return now + Number.parseInt(m[1] as string, 10) * unit;
}

export async function runTokenCreate(client: BlindkeyClient, opts: TokenCreateOptions): Promise<CommandResult> {
  const scopes = parseScopes(opts.scopes);
  const projects =
    opts.projects === undefined
      ? null
      : opts.projects
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
  if (opts.projects !== undefined && projects !== null && projects.length === 0) {
    throw new CliError('--projects was given but lists no project — omit the flag entirely for a token covering all projects');
  }
  if (opts.expiry === false && opts.expires !== undefined) {
    throw new CliError('use either --expires or --no-expiry, not both');
  }
  const expires_at = opts.expiry === false ? null : parseExpires(opts.expires);
  const body: Record<string, unknown> = { name: opts.name, scopes, projects };
  if (expires_at !== undefined) body.expires_at = expires_at; // omitted → server default (90 days)
  const created = await client.json<PublicToken & { token: string }>('POST', '/api/v1/tokens', { body });
  return {
    json: created,
    text: [
      `created token ${created.id} "${created.name}"`,
      `  scopes:   ${created.scopes.join(',')}`,
      `  projects: ${created.projects === null ? 'all' : created.projects.join(',')}`,
      `  expires:  ${created.expires_at === null ? 'never' : fmtTime(created.expires_at)}`,
      '',
      created.token,
      '',
      'This value is shown once and cannot be retrieved again.',
    ].join('\n'),
  };
}

export async function runTokenList(client: BlindkeyClient): Promise<CommandResult> {
  const tokens = await client.json<PublicToken[]>('GET', '/api/v1/tokens');
  return {
    json: tokens,
    text: table(
      ['ID', 'NAME', 'PREFIX', 'SCOPES', 'PROJECTS', 'EXPIRES', 'LAST USED', 'STATE'],
      tokens.map((t) => [
        t.id,
        t.name,
        t.prefix,
        t.scopes.join(','),
        t.projects === null ? 'all' : t.projects.join(','),
        t.expires_at === null ? 'never' : fmtTime(t.expires_at),
        fmtTime(t.last_used_at),
        t.revoked_at === null ? 'active' : `revoked ${fmtTime(t.revoked_at)}`,
      ]),
    ),
  };
}

export async function runTokenRevoke(client: BlindkeyClient, id: string): Promise<CommandResult> {
  if (!/^\d+$/.test(id.trim())) throw new CliError(`invalid token id "${id}" — expected a number (see \`blindkey token list\`)`);
  await client.empty('DELETE', `/api/v1/tokens/${id.trim()}`);
  return { json: { id: Number.parseInt(id, 10), revoked: true }, text: `revoked token ${id.trim()}` };
}
