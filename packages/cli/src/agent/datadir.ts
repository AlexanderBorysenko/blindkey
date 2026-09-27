import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Recognizes a path inside a Claude Code plugin marketplace cache:
 * `.../plugins/cache/<marketplace>/<plugin>/<version>/dist/<file>` (spec §2.1).
 * Segments are split on both `/` and `\` so a path built with either
 * separator style parses the same regardless of the host platform — the
 * caller may be inspecting its own `argv[1]` on Windows while this code runs
 * on a POSIX CI box, or vice versa.
 */
function pluginCacheSuffix(selfPath: string): string | null {
  const segments = selfPath.split(/[\\/]+/).filter(Boolean);
  const idx = segments.findIndex((s, i) => s === 'plugins' && segments[i + 1] === 'cache');
  if (idx === -1) return null;
  const marketplace = segments[idx + 2];
  const plugin = segments[idx + 3];
  const version = segments[idx + 4];
  const dist = segments[idx + 5];
  if (!marketplace || !plugin || !version || dist !== 'dist') return null;
  return `${plugin}-${marketplace}`;
}

/**
 * Resolves the plugin data directory (spec §2.1 "Plugin data dir resolution",
 * §2.2). The bin shims that launch the agent CLI don't receive
 * `CLAUDE_PLUGIN_DATA` (only hooks and the MCP bridge do, straight from the
 * environment), so the CLI instead:
 *   1. uses `PIDB_PLUGIN_DATA` if set,
 *   2. else derives `<plugin>-<marketplace>` from its own installed path
 *      under a plugin marketplace cache,
 *   3. else falls back to `pidb-pidb` (e.g. running from source in dev).
 */
export function resolveDataDir(env: NodeJS.ProcessEnv = process.env, selfPath: string = process.argv[1] ?? ''): string {
  if (env.PIDB_PLUGIN_DATA) return env.PIDB_PLUGIN_DATA;
  const suffix = pluginCacheSuffix(selfPath) ?? 'pidb-pidb';
  return join(env.HOME ?? homedir(), '.claude', 'plugins', 'data', suffix);
}
