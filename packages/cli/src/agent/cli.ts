#!/usr/bin/env node
// Agent entry point (spec §2.1 `bin/pidb`, §2.3): always builds the commander program in agent mode,
// regardless of `PIDB_AGENT` — the plugin's bin shims set `PIDB_AGENT=1` too, but this file is itself
// sufficient to select it. Imports only `../program.js` (side-effect-free) — never `../cli.js` — so
// that when esbuild bundles this file as its own entry point (spec §2.1, `dist/pidb.mjs`), the
// bundle doesn't also contain `cli.ts`'s `if (isEntryPoint()) void main()` top-level side effect,
// which would otherwise fire too (same bundle, same `import.meta.url`) and run the normal program a
// second time — reading `PIDB_URL`/`PIDB_TOKEN`/`~/.config/pidb` and running every command twice.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CommanderError } from 'commander';
import { buildProgram, exitCodeOf } from '../program.js';

export async function main(argv: string[] = process.argv): Promise<void> {
  try {
    await buildProgram({ agent: true }).parseAsync(argv);
  } catch (err) {
    // See cli.ts's main() for why a CommanderError (--help, missing argument, ...) doesn't get an
    // extra "error: ..." line here — commander already printed its own message.
    if (!(err instanceof CommanderError)) {
      console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    }
    // See cli.ts's main() for why this sets exitCode + returns rather than calling process.exit().
    process.exitCode = exitCodeOf(err);
    return;
  }
}

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
