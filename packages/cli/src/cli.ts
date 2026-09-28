#!/usr/bin/env node
// Normal (non-plugin) bin entry. Deliberately thin: everything reusable lives in `program.ts`, which
// has no top-level side effects, so bundling `agent/cli.ts` (the plugin's entry, spec §2.1) never
// pulls in this file's `if (isEntryPoint()) void main()` — that would otherwise run a second, unwanted
// copy of the normal program against `import.meta.url`, since both files would share one bundle.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildProgram, exitCodeOf } from './program.js';

export * from './program.js';

export async function main(argv: string[] = process.argv): Promise<void> {
  try {
    // Agent mode (spec §2.3) is entered via `PIDB_AGENT=1` (set by the plugin's bin shim) or by
    // running the dedicated agent entry (agent/cli.ts), which always passes `{ agent: true }`.
    await buildProgram({ agent: process.env.PIDB_AGENT === '1' }).parseAsync(argv);
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
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
