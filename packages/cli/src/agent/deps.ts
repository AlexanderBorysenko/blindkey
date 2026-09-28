// First-run runtime dependency install (spec §2.1): the plugin bundles everything except the native
// `@napi-rs/keyring`, which is installed with npm into the plugin data dir the first time a session
// starts. The bundles then load it through `createRequire(<data>/package.json)` (see tokenstore.ts).
// The install runs detached in the background so SessionStart never waits on npm; the hook reports
// "installing…" in the session context and the next session (or the next CLI call, once npm is done)
// finds the module in place.
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, openSync, closeSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { writeJsonAtomic } from './state.js';

/** Minimal slice of `child_process.spawn` used here — injectable for tests. */
export type SpawnFn = (
  command: string,
  args: readonly string[],
  opts: {
    cwd: string;
    detached: boolean;
    stdio: ['ignore', number, number];
    windowsHide: boolean;
    windowsVerbatimArguments?: boolean;
  },
) => { unref(): void; on(event: 'error', listener: (err: Error) => void): unknown };

export interface EnsureDepsOptions {
  dataDir: string;
  pluginRoot: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  spawnImpl?: SpawnFn;
  now?: () => number;
}

const NPM_ARGS = ['install', '--omit=dev', '--no-audit', '--no-fund'] as const;
/** An install marker younger than this means "still running" — don't start a second npm. */
const STALE_MS = 10 * 60_000;
const MARKER = 'deps-install.json';
const LOG = 'deps-install.log';

export interface NpmSpawnSpec {
  command: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
}

/**
 * How to launch npm without a shell. On Windows npm is `npm.cmd`, and Node ≥ 20 refuses to spawn a
 * `.cmd` without a shell (CVE-2024-27980), so it goes through `cmd.exe /d /s /c` with a completely
 * fixed command line — no paths or user input in it (the data dir is passed as `cwd`).
 */
export function npmSpawnSpec(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): NpmSpawnSpec {
  if (platform === 'win32') {
    return { command: env.ComSpec ?? env.COMSPEC ?? 'cmd.exe', args: ['/d', '/s', '/c', `npm.cmd ${NPM_ARGS.join(' ')}`], windowsVerbatimArguments: true };
  }
  return { command: 'npm', args: [...NPM_ARGS] };
}

/** The plugin install dir: `CLAUDE_PLUGIN_ROOT`, else the parent of the bundle's `dist/`. */
export function pluginRootFrom(env: NodeJS.ProcessEnv, selfPath: string = process.argv[1] ?? ''): string {
  return env.CLAUDE_PLUGIN_ROOT || dirname(dirname(selfPath));
}

export function depsInstalled(dataDir: string): boolean {
  return existsSync(join(dataDir, 'node_modules', '@napi-rs', 'keyring', 'package.json'));
}

function markerStartedAt(dataDir: string): number | null {
  try {
    const parsed = JSON.parse(readFileSync(join(dataDir, MARKER), 'utf8')) as { startedAt?: unknown };
    return typeof parsed.startedAt === 'number' ? parsed.startedAt : null;
  } catch {
    return null;
  }
}

/**
 * Ensures `@napi-rs/keyring` is installed in the data dir. Returns a one-line status for the session
 * context when something is (or couldn't be) happening, `undefined` when all is well or when this
 * isn't an installed plugin (dev/tests: no `.claude-plugin/plugin.json` + `package.json` at the root).
 * Never throws.
 */
export function ensureDeps(opts: EnsureDepsOptions): string | undefined {
  const { dataDir, pluginRoot } = opts;
  const now = opts.now ?? Date.now;
  try {
    if (depsInstalled(dataDir)) return undefined;
    const pkg = join(pluginRoot, 'package.json');
    if (!existsSync(pkg) || !existsSync(join(pluginRoot, '.claude-plugin', 'plugin.json'))) return undefined;

    const startedAt = markerStartedAt(dataDir);
    if (startedAt !== null && now() - startedAt >= 0 && now() - startedAt < STALE_MS) {
      const secs = Math.round((now() - startedAt) / 1000);
      return `pidb: plugin dependencies are still installing (started ${secs}s ago) — \`pidb connect\` and token access work once npm finishes.`;
    }

    mkdirSync(dataDir, { recursive: true });
    copyFileSync(pkg, join(dataDir, 'package.json'));
    const spec = npmSpawnSpec(opts.platform ?? process.platform, opts.env ?? process.env);
    const logFd = openSync(join(dataDir, LOG), 'a');
    try {
      const child = (opts.spawnImpl ?? (spawn as unknown as SpawnFn))(spec.command, spec.args, {
        cwd: dataDir,
        detached: true,
        stdio: ['ignore', logFd, logFd],
        windowsHide: true,
        ...(spec.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      });
      child.on('error', () => {
        // Reported via the log / next session's "still missing" retry; the hook must not crash.
      });
      child.unref();
    } finally {
      closeSync(logFd);
    }
    writeJsonAtomic(join(dataDir, MARKER), { startedAt: now() });
    return 'pidb: installing plugin dependencies (@napi-rs/keyring) in the background — `pidb connect` and token access work once it finishes (usually under a minute; otherwise next session).';
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `pidb: could not start npm to install plugin dependencies (${message}) — ask the user to run \`npm install --omit=dev\` in the plugin data dir (${dataDir}).`;
  }
}
