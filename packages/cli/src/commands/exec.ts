import { spawn } from 'node:child_process';
import { scopedPath, seg, type PidbClient } from '../client.js';
import type { RevealedFields } from '../api-types.js';
import { CliError } from '../errors.js';

/** Field keys allow [A-Za-z0-9_.-]; env vars do not, so `.` and `-` become `_`. */
export function envKeyFor(key: string): string {
  return `PIDB_${key.toUpperCase().replace(/[^A-Z0-9_]/g, '_')}`;
}

export function buildEnv(fields: Record<string, string>, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  const seen = new Map<string, string>();
  for (const [key, value] of Object.entries(fields)) {
    const name = envKeyFor(key);
    const previous = seen.get(name);
    if (previous !== undefined) {
      throw new CliError(`fields "${previous}" and "${key}" both map to ${name} — rename one of them`);
    }
    seen.set(name, key);
    env[name] = value;
  }
  return env;
}

export async function runSecretExec(
  client: PidbClient,
  target: string,
  name: string,
  command: string[],
): Promise<number> {
  const [bin, ...args] = command;
  if (!bin) throw new CliError('no command given — usage: pidb secret exec <target> "<name>" -- <command...>');

  const revealed = await client.json<RevealedFields>('GET', scopedPath(target, 'secrets', `/${seg(name)}/fields`));
  const env = buildEnv(revealed.fields, process.env);

  return await new Promise<number>((resolve, reject) => {
    const child = spawn(bin, args, { stdio: 'inherit', env });
    child.on('error', (err) => reject(new CliError(`cannot run ${bin}: ${err.message}`)));
    child.on('close', (code, signal) => {
      if (signal) {
        // Report the conventional 128+signal code without printing anything of the secret.
        resolve(128 + (typeof signal === 'string' ? signalNumber(signal) : 0));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

function signalNumber(signal: NodeJS.Signals): number {
  const table: Partial<Record<NodeJS.Signals, number>> = { SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 };
  return table[signal] ?? 1;
}
