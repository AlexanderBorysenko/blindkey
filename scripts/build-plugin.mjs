#!/usr/bin/env node
// Bundles the Claude Code plugin's three executables (spec §2.1) from packages/cli/src/agent into
// plugin/dist: blindkey.mjs (agent CLI), mcp.mjs (stdio MCP bridge), hook.mjs (hook dispatcher).
// Everything is bundled except the native `@napi-rs/keyring`, which the SessionStart hook installs
// into the plugin data dir on first run and the bundles load via createRequire(<data>/package.json).
// Only these three entry modules self-execute (each guards on isEntryPoint()); never add a bundle
// entry that imports another entry module. The output is committed — run `npm run build:plugin`
// after any change under packages/cli/src/** or packages/shared/src/**; the local test run
// (packages/cli/test/plugin.bundle.test.ts) fails on a stale bundle.
import { build } from 'esbuild';
import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const agentSrc = join(repoRoot, 'packages', 'cli', 'src', 'agent');

export const ENTRIES = {
  blindkey: join(agentSrc, 'cli.ts'),
  mcp: join(agentSrc, 'bridge-main.ts'),
  hook: join(agentSrc, 'hooks', 'main.ts'),
};

// ESM output still contains CommonJS dependencies (commander, MCP SDK deps) that call require();
// give them a real one.
const BANNER = "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);";

/** Builds all three bundles into `outDir` (default: plugin/dist). */
export async function buildPlugin(outDir = join(repoRoot, 'plugin', 'dist')) {
  await build({
    absWorkingDir: repoRoot,
    entryPoints: Object.entries(ENTRIES).map(([out, input]) => ({ in: input, out })),
    outdir: outDir,
    outExtension: { '.js': '.mjs' },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    external: ['@napi-rs/keyring'],
    // Bundle shared from source (no dependency on packages/shared/dist being built first).
    alias: { '@blindkey/shared': join(repoRoot, 'packages', 'shared', 'src', 'index.ts') },
    banner: { js: BANNER },
    legalComments: 'none',
    charset: 'utf8',
    logLevel: 'warning',
  });
  return outDir;
}

function isEntryPoint() {
  try {
    return realpathSync(process.argv[1] ?? '') === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  const out = await buildPlugin(process.argv[2]);
  console.log(`plugin bundles written to ${out}`);
}
