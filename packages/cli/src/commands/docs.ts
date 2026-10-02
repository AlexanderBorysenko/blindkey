import { readFileSync } from 'node:fs';
import { DOC_CATEGORIES, type DocCategory } from '@blindkey/shared';
import { scopedPath, seg, type BlindkeyClient } from '../client.js';
import type { PublicDoc, PublicDocSummary } from '../api-types.js';
import { CliError } from '../errors.js';
import { fmtTime, table, type CommandResult } from '../output.js';

export interface DocsPutOptions {
  file: string;
  title: string;
  category: string;
  force?: boolean;
}

/** `blindkey docs get guidelines` is the global doc; `blindkey docs get acme deploy` is the project one. */
export function resolveDocTarget(a: string, b?: string): { target: string; doc: string } {
  return b === undefined ? { target: 'global', doc: a } : { target: a, doc: b };
}

export async function runDocsList(client: BlindkeyClient, target: string): Promise<CommandResult> {
  const docs = await client.json<PublicDocSummary[]>('GET', scopedPath(target, 'docs'));
  return {
    json: docs,
    text: table(['SLUG', 'TITLE', 'CATEGORY', 'UPDATED'], docs.map((d) => [d.slug, d.title, d.category, fmtTime(d.updated_at)])),
  };
}

export async function runDocsGet(
  client: BlindkeyClient,
  target: string,
  doc: string,
  opts: { refs?: boolean },
): Promise<CommandResult> {
  const result = await client.json<PublicDoc>('GET', scopedPath(target, 'docs', `/${seg(doc)}`), {
    query: { resolve: opts.refs ? 'meta' : undefined },
  });
  let text = result.body_md;
  if (opts.refs) {
    const refs = result.refs ?? [];
    const rows = refs.map((r) => [
      r.ref,
      r.project ?? 'global',
      r.name,
      r.fields.map((f) => (f.sensitive ? `${f.key}*` : f.key)).join(','),
    ]);
    text = [
      text.replace(/\n+$/, ''),
      '',
      '--- secret references ---',
      table(['REF', 'PROJECT', 'SECRET', 'FIELDS'], rows),
      '',
      'consume values with: blindkey secret exec <project|global> "<secret>" -- <command>',
    ].join('\n');
  }
  return { json: result, text };
}

export async function runDocsPut(
  client: BlindkeyClient,
  target: string,
  doc: string,
  opts: DocsPutOptions,
): Promise<CommandResult> {
  if (!(DOC_CATEGORIES as readonly string[]).includes(opts.category)) {
    throw new CliError(`unknown category "${opts.category}" — one of: ${DOC_CATEGORIES.join(', ')}`);
  }
  let body_md: string;
  try {
    body_md = readFileSync(opts.file, 'utf8');
  } catch (err) {
    throw new CliError(`cannot read ${opts.file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const { status, data: saved } = await client.jsonStatus<PublicDoc>('PUT', scopedPath(target, 'docs', `/${seg(doc)}`), {
    body: { title: opts.title, category: opts.category as DocCategory, body_md, force: opts.force === true },
  });
  const created = status === 201; // the server answers 201 on create, 200 on update
  return {
    json: saved,
    text: `${created ? 'created' : 'updated'} ${target === 'global' ? '' : `${target}/`}${saved.slug} (${saved.category})`,
  };
}
