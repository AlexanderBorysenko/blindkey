import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Matches a file inside a Claude Code plugin marketplace cache:
 * `<prefix>/plugins/cache/<marketplace>/<plugin>/<version>/dist/<file>` (spec §2.1), on either
 * separator style — the caller may be inspecting its own `argv[1]` on Windows while this code runs
 * on a POSIX CI box, or vice versa. Captures `<prefix>/plugins` and the separator used right after
 * it, so the derived data dir can be built from the *actual* installed location (which may not be
 * under `$HOME` at all, e.g. a custom Claude config dir) rather than reconstructed from `$HOME`.
 */
const PLUGIN_CACHE_PATH = /^(.*[\\/]plugins)([\\/])cache[\\/]([^\\/]+)[\\/]([^\\/]+)[\\/]([^\\/]+)[\\/]dist[\\/][^\\/]+$/;

function derivedDataDir(selfPath: string): string | null {
  const m = PLUGIN_CACHE_PATH.exec(selfPath);
  if (!m) return null;
  const [, pluginsDir, sep, marketplace, plugin, version] = m;
  if (!pluginsDir || !sep || !marketplace || !plugin || !version) return null;
  return `${pluginsDir}${sep}data${sep}${plugin}-${marketplace}`;
}

/**
 * Resolves the plugin data directory (spec §2.1 "Plugin data dir resolution",
 * §2.2). The bin shims that launch the agent CLI don't receive
 * `CLAUDE_PLUGIN_DATA` (only hooks and the MCP bridge do, straight from the
 * environment), so the CLI instead:
 *   1. uses `BLINDKEY_PLUGIN_DATA` if set,
 *   2. else derives `<the plugin cache's own "plugins" dir>/data/<plugin>-<marketplace>` from its
 *      own installed path,
 *   3. else (selfPath isn't inside a plugin cache — dev/tsx, a truncated path, or the user's own
 *      `blindkey` install running in agent mode because `CLAUDECODE=1`, spec §2.3) falls back to
 *      `<Claude config dir>/plugins/data/blindkey-blindkey`, where the Claude config dir is
 *      `CLAUDE_CONFIG_DIR` if set, else `$HOME/.claude`.
 */
export function resolveDataDir(env: NodeJS.ProcessEnv = process.env, selfPath: string = process.argv[1] ?? ''): string {
  if (env.BLINDKEY_PLUGIN_DATA) return env.BLINDKEY_PLUGIN_DATA;
  const claudeDir = env.CLAUDE_CONFIG_DIR || join(env.HOME ?? homedir(), '.claude');
  return derivedDataDir(selfPath) ?? join(claudeDir, 'plugins', 'data', 'blindkey-blindkey');
}
