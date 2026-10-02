#!/usr/bin/env node
// Executable entry for the plugin's hooks (spec §2.1 `dist/hook.mjs`, invoked by Claude Code as
// `node .../hook.mjs <guard|redact|session-start>` with the hook JSON on stdin). Deliberately thin —
// all the real logic lives in `index.ts` (`runHook`), which has no top-level side effects, so
// bundling this file (Task 9) can't drag in `cli.ts`/`agent/cli.ts`/`bridge-main.ts`'s own
// self-executing entry blocks, the same lesson Task 5 learned the hard way for those three entries.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ensureDeps, pluginRootFrom } from '../deps.js';
import { resolveDataDir } from '../datadir.js';
import { runHook, type HookKind } from './index.js';

const VALID_KINDS: readonly HookKind[] = ['guard', 'redact', 'session-start'];

function isValidKind(k: string | undefined): k is HookKind {
  return k !== undefined && (VALID_KINDS as readonly string[]).includes(k);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Reads the hook kind from argv[2], the hook JSON from stdin, runs it, and writes the result —
 * always exiting 0 regardless of outcome (a hook that fails Claude Code's tool loop is worse than
 * one that silently allows/skips/degrades, spec §3.1–§3.3). Calls `process.exit(0)` itself — once the
 * stdout write has flushed (Fix round 4) — rather than only setting `process.exitCode`: a
 * `withDeadline`-bounded timer or an in-flight `fetch` that "lost" the race can otherwise keep an
 * open handle alive and prevent Node from ever exiting on its own, hanging Claude Code's hook call
 * until *that* work finishes minutes later, long after the JSON result was already written.
 */
export async function main(): Promise<void> {
  const kindArg = process.argv[2];
  if (!isValidKind(kindArg)) {
    console.error(`blindkey hook: unknown or missing kind "${kindArg ?? ''}" (expected guard|redact|session-start)`);
    process.exit(0);
  }

  let stdinText = '';
  try {
    stdinText = await readStdin();
  } catch {
    // No input available (e.g. stdin closed immediately) — runHook degrades gracefully per kind on
    // an empty/unparseable payload; nothing more to do here.
  }

  const env = process.env;
  // session-start installs the plugin's runtime deps into the data dir on first run (spec §2.1).
  const deps =
    kindArg === 'session-start'
      ? { ensureDeps: () => ensureDeps({ dataDir: env.CLAUDE_PLUGIN_DATA || resolveDataDir(env), pluginRoot: pluginRootFrom(env) }) }
      : {};
  const result = await runHook(kindArg, stdinText, env, deps);
  if (result.stderr) console.error(result.stderr);
  exitAfterWrite(result.stdout);
}

/**
 * Writes `text` to stdout and exits 0 only once it has been fully flushed (Fix round 4): calling
 * `process.exit` right after `stdout.write` truncates a large (>64 KB) payload when stdout is a pipe,
 * since pipe writes are asynchronous on POSIX. Exiting from the write callback still guarantees a
 * lingering timer/fetch can never keep the process alive once the result is out.
 */
function exitAfterWrite(text: string): void {
  process.exitCode = 0;
  if (!text) {
    process.exit(0);
  }
  process.stdout.write(text, () => process.exit(0));
}

// Run only when this module is the entry point, so tests can import it freely. See `cli.ts`'s own
// comment for why this compares realpaths rather than raw argv[1]/import.meta.url strings.
function isEntryPoint(): boolean {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    return fileURLToPath(import.meta.url) === realpathSync(arg);
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  void main().catch((err: unknown) => {
    // `runHook` itself is documented to never throw, but guard the process boundary too — a bug that
    // somehow escapes it must still never crash Claude Code's tool loop.
    console.error(`blindkey hook: unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(0);
  });
}
