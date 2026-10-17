// First-run runtime dependency install (spec §2.1): the plugin bundles everything except the native
// `@napi-rs/keyring`, which is installed with npm into the plugin data dir the first time a session
// starts. The bundles then load it through `createRequire(<data>/package.json)` (see tokenstore.ts).
// The install runs detached in the background so SessionStart never waits on npm; the hook reports
// "installing…" in the session context and the next session (or the next CLI call, once npm is done)
// finds the module in place.
//
// State lives in `<data>/deps-install.json`:
//   { startedAt }                          — an install is running (created with `wx` before the
//                                             spawn, so two concurrent sessions never both install)
//   { startedAt, finishedAt, exitCode }    — written by the wrapper process when npm exits
// npm's output goes to `<data>/deps-install.log`.
import { spawn } from 'node:child_process';
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/** Minimal slice of `child_process.spawn` used here — injectable for tests. */
export type SpawnFn = (
  command: string,
  args: readonly string[],
  opts: {
    cwd: string;
    detached: boolean;
    stdio: ['ignore', number, number];
    windowsHide: boolean;
  },
) => { unref(): void; on(event: 'error', listener: (err: Error) => void): unknown };

export interface EnsureDepsOptions {
  dataDir: string;
  pluginRoot: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  spawnImpl?: SpawnFn;
  now?: () => number;
  /** Whether `@napi-rs/keyring` actually loads from the data dir (tests inject; default: require it). */
  canLoad?: (dataDir: string) => boolean;
  /** Node binary running the wrapper (default: `process.execPath`). */
  nodePath?: string;
}

const NPM_ARGS = ['install', '--omit=dev', '--no-audit', '--no-fund'] as const;
/** A running install older than this is considered dead; a failed one is retried after this long. */
const RETRY_MS = 10 * 60_000;
export const MARKER = 'deps-install.json';
export const LOG = 'deps-install.log';

export interface NpmSpawnSpec {
  command: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
}

/**
 * How to launch npm. On Windows npm is `npm.cmd`, and Node ≥ 20 refuses to spawn a `.cmd` without a
 * shell (CVE-2024-27980), so it goes through `cmd.exe /d /s /c` with a completely fixed command line
 * — no paths or user input in it (the data dir is passed as `cwd`). Elsewhere, `npm` without a shell.
 */
export function npmSpawnSpec(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): NpmSpawnSpec {
  if (platform === 'win32') {
    return { command: env.ComSpec ?? env.COMSPEC ?? 'cmd.exe', args: ['/d', '/s', '/c', `npm.cmd ${NPM_ARGS.join(' ')}`], windowsVerbatimArguments: true };
  }
  return { command: 'npm', args: [...NPM_ARGS] };
}

/**
 * Detached wrapper (`node -e WRAPPER_SCRIPT <spec-json> <startedAt>`, cwd = data dir, stdout/stderr =
 * the log): runs npm per the spec, then records its exit status in the marker (atomically).
 */
export const WRAPPER_SCRIPT = [
  "const { spawn } = require('child_process');",
  "const fs = require('fs');",
  'const spec = JSON.parse(process.argv[1]);',
  'const startedAt = Number(process.argv[2]);',
  'let recorded = false;',
  'const done = (exitCode) => {',
  '  if (recorded) return;',
  '  recorded = true;',
  `  const tmp = ${JSON.stringify(MARKER)} + '.' + process.pid + '.tmp';`,
  '  fs.writeFileSync(tmp, JSON.stringify({ startedAt, finishedAt: Date.now(), exitCode }));',
  `  fs.renameSync(tmp, ${JSON.stringify(MARKER)});`,
  '};',
  'let child;',
  'try {',
  "  child = spawn(spec.command, spec.args, { stdio: 'inherit', windowsHide: true, windowsVerbatimArguments: !!spec.windowsVerbatimArguments });",
  '} catch (err) { console.error(String(err)); done(-1); process.exit(0); }',
  "child.on('error', (err) => { console.error(String(err)); done(-1); });",
  "child.on('close', (code) => done(code === null ? -1 : code));",
].join('\n');

/** The plugin install dir: `CLAUDE_PLUGIN_ROOT`, else the parent of the bundle's `dist/`. */
export function pluginRootFrom(env: NodeJS.ProcessEnv, selfPath: string = process.argv[1] ?? ''): string {
  return env.CLAUDE_PLUGIN_ROOT || dirname(dirname(selfPath));
}

function defaultCanLoad(dataDir: string): boolean {
  try {
    createRequire(join(dataDir, 'package.json'))('@napi-rs/keyring');
    return true;
  } catch {
    return false;
  }
}

/** The keyring package is present in the data dir AND loads (its platform binding is there too). */
export function depsInstalled(dataDir: string, canLoad: (dataDir: string) => boolean = defaultCanLoad): boolean {
  return existsSync(join(dataDir, 'node_modules', '@napi-rs', 'keyring', 'package.json')) && canLoad(dataDir);
}

interface Marker {
  startedAt: number;
  finishedAt?: number;
  exitCode?: number;
}

function readMarker(path: string): Marker | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<Marker>;
    if (typeof parsed.startedAt !== 'number') return null;
    return {
      startedAt: parsed.startedAt,
      finishedAt: typeof parsed.finishedAt === 'number' ? parsed.finishedAt : undefined,
      exitCode: typeof parsed.exitCode === 'number' ? parsed.exitCode : undefined,
    };
  } catch {
    return null;
  }
}

/** Creates the marker exclusively; `false` when another session already holds it. */
function claimMarker(path: string, startedAt: number): boolean {
  let fd: number;
  try {
    fd = openSync(path, 'wx', 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
  try {
    writeSync(fd, JSON.stringify({ startedAt }));
  } finally {
    closeSync(fd);
  }
  return true;
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
  const markerPath = join(dataDir, MARKER);
  const logPath = join(dataDir, LOG);
  try {
    if (depsInstalled(dataDir, opts.canLoad)) return undefined;
    const pkg = join(pluginRoot, 'package.json');
    if (!existsSync(pkg) || !existsSync(join(pluginRoot, '.claude-plugin', 'plugin.json'))) return undefined;

    const marker = existsSync(markerPath) ? readMarker(markerPath) : null;
    if (marker) {
      const running = marker.exitCode === undefined;
      const since = running ? marker.startedAt : (marker.finishedAt ?? marker.startedAt);
      const age = now() - since;
      if (age >= 0 && age < RETRY_MS) {
        if (running) {
          return `blindkey: plugin dependencies are still installing (started ${Math.round(age / 1000)}s ago) — \`blindkey connect\` and token access work once npm finishes.`;
        }
        const retryMin = Math.max(1, Math.ceil((RETRY_MS - age) / 60_000));
        return `blindkey: plugin dependency install failed (npm exit ${marker.exitCode}) — see ${logPath}; it is retried on a session start in ~${retryMin} min, or the user can run \`npm install --omit=dev\` in ${dataDir}.`;
      }
    }
    // No marker, a corrupt one, a dead install, or a failure old enough to retry: start over.
    if (existsSync(markerPath)) unlinkSync(markerPath);

    mkdirSync(dataDir, { recursive: true });
    const startedAt = now();
    if (!claimMarker(markerPath, startedAt)) {
      return 'blindkey: plugin dependencies are being installed by another session — `blindkey connect` and token access work once npm finishes.';
    }
    try {
      copyFileSync(pkg, join(dataDir, 'package.json'));
      const spec = npmSpawnSpec(opts.platform ?? process.platform, opts.env ?? process.env);
      const logFd = openSync(logPath, 'a');
      try {
        const child = (opts.spawnImpl ?? (spawn as unknown as SpawnFn))(
          opts.nodePath ?? process.execPath,
          ['-e', WRAPPER_SCRIPT, JSON.stringify(spec), String(startedAt)],
          { cwd: dataDir, detached: true, stdio: ['ignore', logFd, logFd], windowsHide: true },
        );
        child.on('error', () => {
          // The marker stays "running" and goes stale after RETRY_MS; the hook must not crash.
        });
        child.unref();
      } finally {
        closeSync(logFd);
      }
    } catch (err) {
      // Nothing started: release the claim so the next session retries right away.
      try {
        unlinkSync(markerPath);
      } catch {
        // ignore
      }
      throw err;
    }
    return 'blindkey: installing plugin dependencies (@napi-rs/keyring) in the background — `blindkey connect` and token access work once it finishes (usually under a minute; otherwise next session).';
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `blindkey: could not start the plugin dependency install (${message}) — ask the user to run \`npm install --omit=dev\` in the plugin data dir (${dataDir}).`;
  }
}
