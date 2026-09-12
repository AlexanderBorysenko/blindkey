import { readFileSync } from 'node:fs';
import { ApiError, scopedPath, seg, type PidbClient } from '../client.js';
import type { PublicSecret } from '../api-types.js';
import { CliError, EXIT_REFUSED } from '../errors.js';
import { table, type CommandResult } from '../output.js';

export interface SecretSetOptions {
  fromFile?: string;
  sensitive?: boolean;
  nonSensitive?: boolean;
  create?: boolean;
}

export async function runSecretsList(client: PidbClient, target: string): Promise<CommandResult> {
  const secrets = await client.json<PublicSecret[]>('GET', scopedPath(target, 'secrets'));
  return {
    json: secrets,
    text: [
      table(
        ['NAME', 'FIELDS', 'TAGS', 'DESCRIPTION'],
        secrets.map((s) => [
          s.name,
          s.fields.map((f) => (f.sensitive ? `${f.key}*` : f.key)).join(','),
          s.tags.join(','),
          s.description,
        ]),
      ),
      '',
      '* = sensitive; consume values with `pidb secret exec|write|env`',
    ].join('\n'),
  };
}

export async function runSecretGet(
  client: PidbClient,
  target: string,
  name: string,
  field: string,
  opts: { print?: boolean },
): Promise<CommandResult> {
  if (opts.print !== true) {
    throw new CliError(
      [
        'refusing to print a secret value without --print.',
        'Prefer a command that never puts the value on screen:',
        `  pidb secret exec ${target} "${name}" -- <command>     # value as $PIDB_${field.toUpperCase()}`,
        `  pidb secret write ${target} "${name}" ${field} --out <path>`,
        `  pidb secret env ${target} "${name}" --out <path>`,
        'Re-run with --print if you really want it on stdout.',
      ].join('\n'),
      EXIT_REFUSED,
    );
  }
  const value = await client.text('GET', scopedPath(target, 'secrets', `/${seg(name)}/fields/${seg(field)}`));
  return { json: { key: field, value }, text: value };
}

async function readStdin(stdin: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString('utf8');
}

export async function readSecretValue(opts: SecretSetOptions, stdin: NodeJS.ReadableStream): Promise<string> {
  if (opts.fromFile !== undefined) {
    try {
      return readFileSync(opts.fromFile, 'utf8'); // verbatim, trailing newline included
    } catch (err) {
      throw new CliError(`cannot read ${opts.fromFile}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const raw = await readStdin(stdin);
  return raw.replace(/\n$/, ''); // one trailing newline, so `echo v | pidb secret set` does the obvious thing
}

export async function runSecretSet(
  client: PidbClient,
  target: string,
  name: string,
  field: string,
  opts: SecretSetOptions,
  stdin: NodeJS.ReadableStream = process.stdin,
): Promise<CommandResult> {
  if (opts.sensitive === true && opts.nonSensitive === true) {
    throw new CliError('--sensitive and --non-sensitive are mutually exclusive');
  }
  const value = await readSecretValue(opts, stdin);
  if (!value) throw new CliError('refusing to store an empty value', EXIT_REFUSED);
  const sensitive = opts.sensitive === true ? true : opts.nonSensitive === true ? false : undefined;
  const fieldInput = { key: field, value, ...(sensitive === undefined ? {} : { sensitive }) };

  try {
    const secret = await client.json<PublicSecret>('PATCH', scopedPath(target, 'secrets', `/${seg(name)}`), {
      body: { fields: [fieldInput] },
    });
    return { json: secret, text: `updated ${target}/${secret.name} field "${field}"` };
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 404 || opts.create !== true) throw err;
    const secret = await client.json<PublicSecret>('POST', scopedPath(target, 'secrets'), {
      body: { name, fields: [fieldInput] },
    });
    return { json: secret, text: `created ${target}/${secret.name} with field "${field}"` };
  }
}
