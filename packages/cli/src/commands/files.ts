import { chmodSync, writeFileSync } from 'node:fs';
import { scopedPath, seg, type PidbClient } from '../client.js';
import type { RevealedFields } from '../api-types.js';
import { CliError, EXIT_REFUSED } from '../errors.js';
import type { CommandResult } from '../output.js';

export function parseMode(mode: string | undefined): number {
  if (mode === undefined) return 0o600;
  if (!/^0?[0-7]{3}$/.test(mode)) throw new CliError(`invalid --mode "${mode}" — use an octal mode such as 600`);
  return Number.parseInt(mode, 8);
}

export function writeSecretFile(path: string, content: string, mode: number, force: boolean): void {
  try {
    writeFileSync(path, content, { mode, flag: force ? 'w' : 'wx' });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') throw new CliError(`${path} already exists — pass --force to overwrite`, EXIT_REFUSED);
    throw new CliError(`cannot write ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  chmodSync(path, mode); // writeFileSync's mode is ignored when overwriting an existing file
}

export async function runSecretWrite(
  client: PidbClient,
  target: string,
  name: string,
  field: string,
  opts: { out: string; mode?: string; force?: boolean },
): Promise<CommandResult> {
  const mode = parseMode(opts.mode);
  const value = await client.text('GET', scopedPath(target, 'secrets', `/${seg(name)}/fields/${seg(field)}`));
  writeSecretFile(opts.out, value, mode, opts.force === true);
  return {
    json: { path: opts.out, mode: mode.toString(8).padStart(4, '0'), secret: name, field, bytes: Buffer.byteLength(value) },
    text: `wrote ${name}.${field} to ${opts.out} (mode ${mode.toString(8).padStart(4, '0')})`,
  };
}

export async function runSecretEnv(
  client: PidbClient,
  target: string,
  name: string,
  opts: { out: string; mode?: string; force?: boolean },
): Promise<CommandResult> {
  const mode = parseMode(opts.mode);
  const revealed = await client.json<RevealedFields>('GET', scopedPath(target, 'secrets', `/${seg(name)}/fields`));
  const lines: string[] = [];
  for (const [key, value] of Object.entries(revealed.fields)) {
    if (value.includes('\n')) {
      throw new CliError(
        `field "${key}" spans multiple lines and cannot go into a key=value file — use: pidb secret write ${target} "${name}" ${key} --out <path>`,
      );
    }
    lines.push(`${key}=${value}`);
  }
  writeSecretFile(opts.out, `${lines.join('\n')}\n`, mode, opts.force === true);
  return {
    json: { path: opts.out, mode: mode.toString(8).padStart(4, '0'), secret: name, keys: Object.keys(revealed.fields) },
    text: `wrote ${lines.length} field(s) of ${name} to ${opts.out} (mode ${mode.toString(8).padStart(4, '0')})`,
  };
}
