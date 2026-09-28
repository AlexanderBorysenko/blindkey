import { spawn, type ChildProcess, type StdioOptions } from 'node:child_process';
import { scopedPath, seg, type PidbClient } from '../client.js';
import type { RevealedFields } from '../api-types.js';
import { CliError } from '../errors.js';
import { createRedactor } from '../agent/redact.js';

/** Field keys allow [A-Za-z0-9_.-]; env vars do not, so `.` and `-` become `_`. */
export function envKeyFor(key: string): string {
  return `PIDB_${key.toUpperCase().replace(/[^A-Z0-9_]/g, '_')}`;
}

/** Variables the CLI itself reads for its own configuration — never let a secret field overwrite one of these. */
const RESERVED_ENV_VARS = ['PIDB_TOKEN', 'PIDB_URL', 'PIDB_CONFIG_HOME'];

export function buildEnv(fields: Record<string, string>, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  // The child gets only the one secret it opted into, never the caller's own API token.
  delete env.PIDB_TOKEN;
  const seen = new Map<string, string>();
  for (const [key, value] of Object.entries(fields)) {
    const name = envKeyFor(key);
    const previous = seen.get(name);
    if (previous !== undefined) {
      throw new CliError(`fields "${previous}" and "${key}" both map to ${name} — rename one of them`);
    }
    if (RESERVED_ENV_VARS.includes(name)) {
      throw new CliError(`field "${key}" maps to the reserved variable ${name} — rename the field`);
    }
    seen.set(name, key);
    env[name] = value;
  }
  return env;
}

export interface RunSecretExecOptions {
  /** Agent mode (spec §2.3): fetch via the substitution-only `/use` endpoint (purpose `exec`) instead
   * of the reveal endpoint, and redact the child's stdout/stderr before relaying it. */
  agent?: boolean;
}

/**
 * Spawns `bin args` with `stdio`/`env`, optionally wiring up stdout/stderr listeners (`attach`, called
 * right after spawn, before any data can arrive) and a hook to run just before resolving (`beforeExit`,
 * e.g. to flush pending redactor output) — shared by both the normal and agent-mode paths of
 * `runSecretExec` (fix round 1, Minor 8) so the error/close/signal-to-exit-code bookkeeping exists in
 * exactly one place.
 */
function spawnAndAwaitExit(
  bin: string,
  args: string[],
  spawnOpts: { stdio: StdioOptions; env: NodeJS.ProcessEnv },
  attach?: (child: ChildProcess) => void,
  beforeExit?: () => void,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const child = spawn(bin, args, spawnOpts);
    attach?.(child);
    child.on('error', (err) => reject(new CliError(`cannot run ${bin}: ${err.message}`)));
    child.on('close', (code, signal) => {
      beforeExit?.();
      if (signal) {
        // Report the conventional 128+signal code without printing anything of the secret.
        resolve(128 + (typeof signal === 'string' ? signalNumber(signal) : 0));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

export async function runSecretExec(
  client: PidbClient,
  target: string,
  name: string,
  command: string[],
  opts: RunSecretExecOptions = {},
): Promise<number> {
  const [bin, ...args] = command;
  if (!bin) throw new CliError('no command given — usage: pidb secret exec <target> "<name>" -- <command...>');

  const revealed = opts.agent
    ? await client.json<RevealedFields>('POST', scopedPath(target, 'secrets', `/${seg(name)}/use`), {
        body: { purpose: 'exec' },
      })
    : await client.json<RevealedFields>('GET', scopedPath(target, 'secrets', `/${seg(name)}/fields`));
  const env = buildEnv(revealed.fields, process.env);

  if (!opts.agent) {
    return await spawnAndAwaitExit(bin, args, { stdio: 'inherit', env });
  }

  // Agent mode: stdin is still inherited, but stdout/stderr are piped through a redactor (each stream
  // gets its own instance — they must not share held-back state) before being relayed to our own
  // stdout/stderr, so a value the child prints verbatim or in an encoded form never reaches the agent.
  const values = Object.values(revealed.fields);
  const stdoutRedactor = createRedactor(values);
  const stderrRedactor = createRedactor(values);
  return await spawnAndAwaitExit(
    bin,
    args,
    { stdio: ['inherit', 'pipe', 'pipe'], env },
    (child) => {
      child.stdout!.on('data', (chunk: Buffer) => process.stdout.write(stdoutRedactor.push(chunk)));
      child.stderr!.on('data', (chunk: Buffer) => process.stderr.write(stderrRedactor.push(chunk)));
    },
    () => {
      const tailOut = stdoutRedactor.flush();
      if (tailOut) process.stdout.write(tailOut);
      const tailErr = stderrRedactor.flush();
      if (tailErr) process.stderr.write(tailErr);
    },
  );
}

function signalNumber(signal: NodeJS.Signals): number {
  const table: Partial<Record<NodeJS.Signals, number>> = { SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 };
  return table[signal] ?? 1;
}
