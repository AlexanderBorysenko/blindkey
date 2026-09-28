// Agent-safe write commands (spec §2.3): project creation, document deletion, non-sensitive secret
// metadata and secret request links — the CLI counterparts of the MCP tools of the same purpose.
import { secretRequestPath, type SecretFieldInput } from '@pidb/shared';
import type { PidbClient } from '../client.js';
import { ApiError, scopedPath, seg } from '../client.js';
import type { PublicProject } from '../api-types.js';
import type { CommandResult } from '../output.js';
import { CliError } from '../errors.js';

export interface ProjectCreateOptions {
  name: string;
  summary?: string;
  tags?: string;
}

function splitList(raw: string | undefined): string[] {
  return (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

export async function runProjectsCreate(client: PidbClient, slug: string, opts: ProjectCreateOptions): Promise<CommandResult> {
  const project = await client.json<PublicProject>('POST', '/api/v1/projects', {
    body: { slug, name: opts.name, summary: opts.summary ?? '', tags: splitList(opts.tags) },
  });
  return { json: project, text: `created project ${project.slug} (${project.name})` };
}

export async function runDocsDelete(client: PidbClient, target: string, doc: string): Promise<CommandResult> {
  await client.empty('DELETE', scopedPath(target, 'docs', `/${seg(doc)}`));
  return { json: { deleted: doc, target }, text: `deleted ${target === 'global' ? '' : `${target}/`}${doc}` };
}

/** `key=value` → a field explicitly declared non-sensitive (the server refuses credential-looking keys). */
export function parseFieldArg(raw: string): SecretFieldInput {
  const i = raw.indexOf('=');
  if (i <= 0) throw new CliError(`--field expects key=value, got "${raw}"`);
  return { key: raw.slice(0, i), value: raw.slice(i + 1), sensitive: false };
}

async function secretExists(client: PidbClient, target: string, name: string): Promise<boolean> {
  try {
    await client.json('GET', scopedPath(target, 'secrets', `/${seg(name)}`));
    return true;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return false;
    throw err;
  }
}

export interface SecretMetaOptions {
  field?: string[];
  description?: string;
  tags?: string;
}

export async function runSecretsMeta(client: PidbClient, target: string, name: string, opts: SecretMetaOptions): Promise<CommandResult> {
  const fields = (opts.field ?? []).map(parseFieldArg);
  const tags = opts.tags === undefined ? undefined : splitList(opts.tags);
  // Create first and patch on 409, so this needs only secrets:meta-write (no metadata read) and has
  // no check-then-write race.
  if (fields.length > 0) {
    try {
      await client.json('POST', scopedPath(target, 'secrets'), {
        body: { name, description: opts.description ?? '', tags: tags ?? [], fields },
      });
      return { json: { created: name }, text: `created secret "${name}" (${fields.length} non-sensitive field(s))` };
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 409)) throw err;
    }
  }
  await client.json('PATCH', scopedPath(target, 'secrets', `/${seg(name)}`), {
    body: {
      ...(opts.description !== undefined ? { description: opts.description } : {}),
      ...(tags !== undefined ? { tags } : {}),
      ...(fields.length ? { fields } : {}),
    },
  });
  return { json: { updated: name }, text: `updated secret "${name}" (${fields.length} non-sensitive field(s))` };
}

export interface SecretRequestOptions {
  key?: string[];
  plainKey?: string[];
  description?: string;
  tags?: string;
}

export async function runSecretsRequest(client: PidbClient, target: string, name: string, opts: SecretRequestOptions): Promise<CommandResult> {
  const keys = [
    ...(opts.key ?? []).map((key) => ({ key, sensitive: true })),
    ...(opts.plainKey ?? []).map((key) => ({ key, sensitive: false })),
  ];
  if (keys.length === 0) throw new CliError('give at least one --key (sensitive) or --plain-key');
  const exists = await secretExists(client, target, name);
  const url = `${client.url}${secretRequestPath({
    project: target === 'global' ? null : target,
    name,
    exists,
    description: opts.description,
    tags: opts.tags === undefined ? undefined : splitList(opts.tags),
    keys,
  })}`;
  return { json: { url }, text: `Ask the user to open this link and enter the values:\n${url}` };
}
