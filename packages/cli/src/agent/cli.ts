#!/usr/bin/env node
// Agent entry point (spec §2.1 `bin/pidb`, §2.3): always builds the commander
// program in agent mode, regardless of `PIDB_AGENT` — the plugin's bin shims
// set `PIDB_AGENT=1` too, but this file is itself sufficient to select it.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildProgram, exitCodeOf } from '../cli.js';

export async function main(argv: string[] = process.argv): Promise<void> {
  try {
    await buildProgram({ agent: true }).parseAsync(argv);
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
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
