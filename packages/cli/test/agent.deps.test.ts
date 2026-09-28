import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { LOG, MARKER, WRAPPER_SCRIPT, ensureDeps, npmSpawnSpec, pluginRootFrom, type SpawnFn } from '../src/agent/deps.js';
import { sessionContext } from '../src/agent/hooks/session-start.js';
import { memoryStore } from '../src/agent/tokenstore.js';

function fakePluginRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'pidb-plugin-root-'));
  mkdirSync(join(root, '.claude-plugin'));
  writeFileSync(join(root, '.claude-plugin', 'plugin.json'), '{"name":"pidb"}');
  writeFileSync(join(root, 'package.json'), '{"name":"pidb-plugin-runtime","private":true,"dependencies":{"@napi-rs/keyring":"^2.1.0"}}');
  return root;
}

interface Call {
  command: string;
  args: string[];
  opts: Record<string, unknown>;
}

function recordingSpawn(calls: Call[]): SpawnFn {
  return (command, args, opts) => {
    calls.push({ command, args: [...args], opts: opts as Record<string, unknown> });
    return { unref() {}, on() {} };
  };
}

describe('npmSpawnSpec', () => {
  it('posix: npm with fixed args, no shell', () => {
    const s = npmSpawnSpec('darwin', {});
    expect(s.command).toBe('npm');
    expect(s.args).toEqual(['install', '--omit=dev', '--no-audit', '--no-fund']);
    expect(s.windowsVerbatimArguments).toBeUndefined();
  });

  it('win32: npm.cmd through cmd.exe with a fixed command line (no user input, no paths)', () => {
    const s = npmSpawnSpec('win32', { ComSpec: 'C:\\Windows\\system32\\cmd.exe' });
    expect(s.command).toBe('C:\\Windows\\system32\\cmd.exe');
    expect(s.args).toEqual(['/d', '/s', '/c', 'npm.cmd install --omit=dev --no-audit --no-fund']);
    expect(s.windowsVerbatimArguments).toBe(true);
  });
});

describe('pluginRootFrom', () => {
  it('prefers CLAUDE_PLUGIN_ROOT, else two levels above the bundle', () => {
    expect(pluginRootFrom({ CLAUDE_PLUGIN_ROOT: '/x/root' }, '/y/dist/hook.mjs')).toBe('/x/root');
    expect(pluginRootFrom({}, join('/y', 'root', 'dist', 'hook.mjs'))).toBe(join('/y', 'root'));
  });
});

describe('ensureDeps', () => {
  const never = (): boolean => false;

  it('does nothing when the keyring module is installed and loads', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'pidb-deps-'));
    mkdirSync(join(dataDir, 'node_modules', '@napi-rs', 'keyring'), { recursive: true });
    writeFileSync(join(dataDir, 'node_modules', '@napi-rs', 'keyring', 'package.json'), '{}');
    const calls: Call[] = [];
    expect(ensureDeps({ dataDir, pluginRoot: fakePluginRoot(), spawnImpl: recordingSpawn(calls), canLoad: () => true })).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('reinstalls when the package is present but does not load (e.g. missing platform binding)', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'pidb-deps-'));
    mkdirSync(join(dataDir, 'node_modules', '@napi-rs', 'keyring'), { recursive: true });
    writeFileSync(join(dataDir, 'node_modules', '@napi-rs', 'keyring', 'package.json'), '{}');
    const calls: Call[] = [];
    // Default canLoad: the fake package has no entry point, so require() fails.
    expect(ensureDeps({ dataDir, pluginRoot: fakePluginRoot(), env: {}, spawnImpl: recordingSpawn(calls) })).toMatch(/installing plugin dependencies/);
    expect(calls).toHaveLength(1);
  });

  it('does nothing outside an installed plugin (dev: no plugin.json next to package.json)', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'pidb-deps-'));
    const calls: Call[] = [];
    expect(ensureDeps({ dataDir, pluginRoot: mkdtempSync(join(tmpdir(), 'nope-')), spawnImpl: recordingSpawn(calls), canLoad: never })).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('claims the marker (wx) BEFORE spawning, copies package.json, and spawns the detached node wrapper around npm', () => {
    const base = mkdtempSync(join(tmpdir(), 'pidb-deps-'));
    const dataDir = join(base, 'data', 'pidb-pidb'); // not created yet
    const root = fakePluginRoot();
    const calls: Call[] = [];
    let markerAtSpawn: string | null = null;
    const spawnImpl: SpawnFn = (command, args, opts) => {
      markerAtSpawn = existsSync(join(dataDir, MARKER)) ? readFileSync(join(dataDir, MARKER), 'utf8') : null;
      return recordingSpawn(calls)(command, args, opts);
    };
    const note = ensureDeps({ dataDir, pluginRoot: root, platform: 'darwin', env: {}, spawnImpl, now: () => 1000, canLoad: never, nodePath: '/usr/bin/node' });
    expect(note).toMatch(/installing plugin dependencies/);
    expect(markerAtSpawn).toBe(JSON.stringify({ startedAt: 1000 }));
    expect(readFileSync(join(dataDir, 'package.json'), 'utf8')).toBe(readFileSync(join(root, 'package.json'), 'utf8'));
    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.command).toBe('/usr/bin/node');
    expect(c.args[0]).toBe('-e');
    expect(c.args[1]).toBe(WRAPPER_SCRIPT);
    expect(JSON.parse(c.args[2]!)).toEqual({ command: 'npm', args: ['install', '--omit=dev', '--no-audit', '--no-fund'] });
    expect(c.args[3]).toBe('1000');
    expect(c.opts.cwd).toBe(dataDir);
    expect(c.opts.detached).toBe(true);
    expect(c.opts.shell).toBeUndefined();
  });

  it('never starts a second install while one is running; retries once it is 10 min stale', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'pidb-deps-'));
    const root = fakePluginRoot();
    const calls: Call[] = [];
    const spawnImpl = recordingSpawn(calls);
    ensureDeps({ dataDir, pluginRoot: root, env: {}, spawnImpl, now: () => 1_000, canLoad: never });
    const again = ensureDeps({ dataDir, pluginRoot: root, env: {}, spawnImpl, now: () => 61_000, canLoad: never });
    expect(again).toMatch(/still installing/);
    expect(calls).toHaveLength(1);
    ensureDeps({ dataDir, pluginRoot: root, env: {}, spawnImpl, now: () => 1_000 + 11 * 60_000, canLoad: never });
    expect(calls).toHaveLength(2);
  });

  it('a running marker left by another session is respected (no second install)', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'pidb-deps-'));
    const calls: Call[] = [];
    writeFileSync(join(dataDir, MARKER), JSON.stringify({ startedAt: 5_000 }));
    expect(ensureDeps({ dataDir, pluginRoot: fakePluginRoot(), env: {}, spawnImpl: recordingSpawn(calls), now: () => 6_000, canLoad: never })).toMatch(/still installing/);
    expect(calls).toHaveLength(0);
  });

  it('reports a failed install with the log path, and retries after 10 min', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'pidb-deps-'));
    writeFileSync(join(dataDir, MARKER), JSON.stringify({ startedAt: 1_000, finishedAt: 2_000, exitCode: 1 }));
    const calls: Call[] = [];
    const root = fakePluginRoot();
    const note = ensureDeps({ dataDir, pluginRoot: root, env: {}, spawnImpl: recordingSpawn(calls), now: () => 3_000, canLoad: never });
    expect(note).toMatch(/dependency install failed/);
    expect(note).toContain(join(dataDir, LOG));
    expect(calls).toHaveLength(0);
    const retry = ensureDeps({ dataDir, pluginRoot: root, env: {}, spawnImpl: recordingSpawn(calls), now: () => 2_000 + 10 * 60_000, canLoad: never });
    expect(retry).toMatch(/installing plugin dependencies/);
    expect(calls).toHaveLength(1);
  });

  it('reports (never throws) when the wrapper cannot be started, and releases the claim', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'pidb-deps-'));
    const note = ensureDeps({
      dataDir,
      pluginRoot: fakePluginRoot(),
      env: {},
      canLoad: never,
      spawnImpl: () => {
        throw new Error('spawn ENOENT');
      },
    });
    expect(note).toMatch(/could not start the plugin dependency install/);
    expect(existsSync(join(dataDir, MARKER))).toBe(false);
  });
});

describe('WRAPPER_SCRIPT (real subprocess)', () => {
  function runWrapper(dataDir: string, spec: object): Promise<number | null> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', WRAPPER_SCRIPT, JSON.stringify(spec), '1234'], { cwd: dataDir, stdio: 'ignore' });
      child.on('error', reject);
      child.on('close', resolve);
    });
  }

  it('records the child exit status in the marker', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'pidb-deps-wrap-'));
    await runWrapper(dataDir, { command: process.execPath, args: ['-e', 'process.exit(3)'] });
    const marker = JSON.parse(readFileSync(join(dataDir, MARKER), 'utf8')) as { startedAt: number; finishedAt: number; exitCode: number };
    expect(marker.startedAt).toBe(1234);
    expect(marker.exitCode).toBe(3);
    expect(typeof marker.finishedAt).toBe('number');
  });

  it('records -1 when the command cannot be spawned', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'pidb-deps-wrap-'));
    await runWrapper(dataDir, { command: join(dataDir, 'no-such-npm'), args: [] });
    const marker = JSON.parse(readFileSync(join(dataDir, MARKER), 'utf8')) as { exitCode: number };
    expect(marker.exitCode).toBe(-1);
  });
});

describe('sessionContext surfaces the ensureDeps note', () => {
  it('prepends a string returned by ensureDeps', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'pidb-deps-ctx-'));
    const context = await sessionContext({ cwd: dataDir, dataDir, store: memoryStore(), ensureDeps: () => 'pidb: installing plugin dependencies…' });
    expect(context.startsWith('pidb: installing plugin dependencies…')).toBe(true);
    expect(context).toContain('Golden rules:');
  });

  it('keeps the note in the fallback status when building the context fails', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'pidb-deps-ctx-'));
    writeFileSync(join(dataDir, 'profiles.json'), '{ not json');
    const context = await sessionContext({ cwd: dataDir, dataDir, store: memoryStore(), ensureDeps: () => 'pidb: installing plugin dependencies…' });
    expect(context.startsWith('pidb: installing plugin dependencies…\npidb: session context unavailable (')).toBe(true);
    expect(context).toContain('Golden rules:');
  });
});
