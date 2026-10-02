#!/usr/bin/env node
// Normal (non-plugin) bin entry. Deliberately thin: everything reusable lives in `program.ts`, which
// has no top-level side effects, so bundling `agent/cli.ts` (the plugin's entry, spec §2.1) never
// pulls in this file's `if (isEntryPoint()) void main()` — that would otherwise run a second, unwanted
// copy of the normal program against `import.meta.url`, since both files would share one bundle.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CommanderError } from 'commander';
import { buildProgram, exitCodeOf } from './program.js';

export * from './program.js';

/**
 * Whether the normal entry runs in agent mode (spec §2.3):
 *   - `BLINDKEY_AGENT=1` (set by the plugin's bin shim) always selects it;
 *   - `CLAUDECODE=1` (set by Claude Code for its Bash tool's commands) selects it too, because Claude
 *     Code appends the plugin's `bin/` to the *end* of PATH — a user-installed `blindkey` (npm link /
 *     global install) earlier on PATH would otherwise run ungated, unredacted, as the user;
 *   - `BLINDKEY_ALLOW_USER_MODE=1` opts out of the `CLAUDECODE` rule (the user's own `!blindkey …` runs).
 */
export function agentModeFromEnv(env: NodeJS.ProcessEnv): boolean {
  if (env.BLINDKEY_AGENT === '1') return true;
  return env.CLAUDECODE === '1' && env.BLINDKEY_ALLOW_USER_MODE !== '1';
}

export async function main(argv: string[] = process.argv): Promise<void> {
  try {
    // The dedicated agent entry (agent/cli.ts) always passes `{ agent: true }`; this one decides
    // from the environment — see agentModeFromEnv.
    await buildProgram({ agent: agentModeFromEnv(process.env) }).parseAsync(argv);
  } catch (err) {
    // Commander (via .exitOverride()) already wrote its own message/usage/help — for --help, a
    // missing argument, an unknown command, etc. — so printing another "error: ..." line here would
    // duplicate or garble it (e.g. "error: error: missing required argument 'url'", or a spurious
    // "error: (outputHelp)" for a successful --help). Only our own thrown errors need this line.
    if (!(err instanceof CommanderError)) {
      console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    }
    // process.exit() can truncate a long console.error write when stderr is a pipe (exactly how
    // the e2e tests invoke the CLI); setting exitCode and returning lets Node flush before exiting.
    process.exitCode = exitCodeOf(err);
    return;
  }
}

// Run only when this module is the entry point, so tests can import it freely.
// Compares realpaths (not raw argv[1]/import.meta.url strings) because npm
// materializes `bin` entries as symlinks: argv[1] is the symlink path while
// import.meta.url resolves to the target's realpath, so a naive string
// comparison never matches for an installed bin.
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
  void main();
}
