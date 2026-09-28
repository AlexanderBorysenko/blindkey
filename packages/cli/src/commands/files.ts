import { chmodSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { scopedPath, seg, type PidbClient } from '../client.js';
import type { RevealedFields } from '../api-types.js';
import { CliError, EXIT_REFUSED } from '../errors.js';
import type { CommandResult } from '../output.js';
import { isPathInside, recordWritten } from '../agent/state.js';

export function parseMode(mode: string | undefined): number {
  if (mode === undefined) return 0o600;
  if (!/^0?[0-7]{3}$/.test(mode)) throw new CliError(`invalid --mode "${mode}" — use an octal mode such as 600`);
  return Number.parseInt(mode, 8);
}

export function writeSecretFile(path: string, content: string, mode: number, force: boolean): void {
  if (!force) {
    try {
      writeFileSync(path, content, { mode, flag: 'wx' });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') throw new CliError(`${path} already exists — pass --force to overwrite`, EXIT_REFUSED);
      throw new CliError(`cannot write ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
    chmodSync(path, mode); // the process umask can narrow the mode passed to writeFileSync, so re-apply it explicitly
    return;
  }

  // --force: never write into an existing (possibly wide-mode) inode in place — writeFileSync's
  // mode is ignored on an existing file, so the secret would briefly sit under the old mode.
  // Instead write to a fresh, exclusively-created temp file at the target mode in the same
  // directory (so the rename below is atomic and same-filesystem), then rename it over the
  // destination.
  const tmp = join(dirname(path), `.${basename(path)}.pidb-${process.pid}-${randomBytes(6).toString('hex')}`);
  try {
    writeFileSync(tmp, content, { mode, flag: 'wx' });
    chmodSync(tmp, mode); // umask safety
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw new CliError(`cannot write ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export interface FileCommandAgentOptions {
  /** Agent mode (spec §2.3): fetch via the substitution-only `/use` endpoint instead of the reveal
   * endpoints, record the output path in `written.json`, and refuse a path inside the plugin data dir. */
  agent?: boolean;
  /** The plugin data dir — required when `agent` is true. */
  dataDir?: string;
}

/** Refuses (spec §2.3) an agent-mode write whose destination is inside the plugin data dir itself —
 * that's where `written.json`/`profiles.json`/the keyring-adjacent state lives, and the PreToolUse
 * guard hook protects paths recorded here, so a secret must never land inside it. */
function guardAgentOut(out: string, opts: FileCommandAgentOptions): string {
  const absOut = resolve(out);
  if (opts.agent && opts.dataDir && isPathInside(opts.dataDir, absOut)) {
    throw new CliError(`refusing to write inside the plugin data dir: ${out}`, EXIT_REFUSED);
  }
  return absOut;
}

export async function runSecretWrite(
  client: PidbClient,
  target: string,
  name: string,
  field: string,
  opts: { out: string; mode?: string; force?: boolean } & FileCommandAgentOptions,
): Promise<CommandResult> {
  const mode = parseMode(opts.mode);
  const absOut = guardAgentOut(opts.out, opts);
  const value = opts.agent
    ? (
        await client.json<RevealedFields>('POST', scopedPath(target, 'secrets', `/${seg(name)}/use`), {
          body: { purpose: 'write', fields: [field] },
        })
      ).fields[field]!
    : await client.text('GET', scopedPath(target, 'secrets', `/${seg(name)}/fields/${seg(field)}`));
  writeSecretFile(opts.out, value, mode, opts.force === true);
  if (opts.agent && opts.dataDir) recordWritten(opts.dataDir, absOut);
  return {
    json: { path: opts.out, mode: mode.toString(8).padStart(4, '0'), secret: name, field, bytes: Buffer.byteLength(value) },
    text: `wrote ${name}.${field} to ${opts.out} (mode ${mode.toString(8).padStart(4, '0')})`,
  };
}

export async function runSecretEnv(
  client: PidbClient,
  target: string,
  name: string,
  opts: { out: string; mode?: string; force?: boolean } & FileCommandAgentOptions,
): Promise<CommandResult> {
  const mode = parseMode(opts.mode);
  const absOut = guardAgentOut(opts.out, opts);
  const revealed = opts.agent
    ? await client.json<RevealedFields>('POST', scopedPath(target, 'secrets', `/${seg(name)}/use`), { body: { purpose: 'env' } })
    : await client.json<RevealedFields>('GET', scopedPath(target, 'secrets', `/${seg(name)}/fields`));
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
  if (opts.agent && opts.dataDir) recordWritten(opts.dataDir, absOut);
  return {
    json: { path: opts.out, mode: mode.toString(8).padStart(4, '0'), secret: name, keys: Object.keys(revealed.fields) },
    text: `wrote ${lines.length} field(s) of ${name} to ${opts.out} (mode ${mode.toString(8).padStart(4, '0')})`,
  };
}
