#!/usr/bin/env node
// Executable entry for the MCP bridge (spec §2.1 `dist/mcp.mjs`, launched by the plugin's `.mcp.json`
// over stdio). Deliberately thin: everything reusable/testable lives in `bridge.ts`, which has no
// top-level side effects, so bundling this file (Task 9) never risks pulling in another entry's own
// side-effecting top-level code the way sharing `cli.ts` would (see `cli.ts`/`agent/cli.ts`'s own
// comments on this exact lesson from Task 5).
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createBridge } from './bridge.js';
import { resolveDataDir } from './datadir.js';
import { keyringStore } from './tokenstore.js';

export async function main(): Promise<void> {
  const env = process.env;
  const dataDir = resolveDataDir(env);
  // Polls (while unconnected) so Claude is told to re-list tools once `pidb connect` completes.
  const server = createBridge({ cwd: process.cwd(), env, store: keyringStore(dataDir), dataDir, watchIntervalMs: 15_000 });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Run only when this module is the entry point, so tests can import it freely. See `cli.ts` for why
// this compares realpaths rather than raw argv[1]/import.meta.url strings.
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
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
}
