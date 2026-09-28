import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureDeps, npmSpawnSpec, pluginRootFrom, type SpawnFn } from '../src/agent/deps.js';
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
  it('does nothing when the keyring module is already installed', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'pidb-deps-'));
    mkdirSync(join(dataDir, 'node_modules', '@napi-rs', 'keyring'), { recursive: true });
    writeFileSync(join(dataDir, 'node_modules', '@napi-rs', 'keyring', 'package.json'), '{}');
    const calls: Call[] = [];
    expect(ensureDeps({ dataDir, pluginRoot: fakePluginRoot(), spawnImpl: recordingSpawn(calls) })).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('does nothing outside an installed plugin (dev: no plugin.json next to package.json)', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'pidb-deps-'));
    const calls: Call[] = [];
    expect(ensureDeps({ dataDir, pluginRoot: mkdtempSync(join(tmpdir(), 'nope-')), spawnImpl: recordingSpawn(calls) })).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('copies package.json and starts a detached npm install in the data dir, then reports it', () => {
    const base = mkdtempSync(join(tmpdir(), 'pidb-deps-'));
    const dataDir = join(base, 'data', 'pidb-pidb'); // not created yet
    const root = fakePluginRoot();
    const calls: Call[] = [];
    const note = ensureDeps({ dataDir, pluginRoot: root, platform: 'darwin', env: {}, spawnImpl: recordingSpawn(calls), now: () => 1000 });
    expect(note).toMatch(/installing plugin dependencies/);
    expect(readFileSync(join(dataDir, 'package.json'), 'utf8')).toBe(readFileSync(join(root, 'package.json'), 'utf8'));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe('npm');
    expect(calls[0]!.args).toEqual(['install', '--omit=dev', '--no-audit', '--no-fund']);
    expect(calls[0]!.opts.cwd).toBe(dataDir);
    expect(calls[0]!.opts.detached).toBe(true);
    expect(calls[0]!.opts.shell).toBeUndefined();
    expect(existsSync(join(dataDir, 'deps-install.json'))).toBe(true);
  });

  it('does not start a second install while one is recent; retries after it goes stale', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'pidb-deps-'));
    const root = fakePluginRoot();
    const calls: Call[] = [];
    const spawnImpl = recordingSpawn(calls);
    ensureDeps({ dataDir, pluginRoot: root, env: {}, spawnImpl, now: () => 1_000 });
    const again = ensureDeps({ dataDir, pluginRoot: root, env: {}, spawnImpl, now: () => 61_000 });
    expect(again).toMatch(/still installing/);
    expect(calls).toHaveLength(1);
    ensureDeps({ dataDir, pluginRoot: root, env: {}, spawnImpl, now: () => 1_000 + 11 * 60_000 });
    expect(calls).toHaveLength(2);
  });

  it('reports (never throws) when npm cannot be started', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'pidb-deps-'));
    const note = ensureDeps({
      dataDir,
      pluginRoot: fakePluginRoot(),
      env: {},
      spawnImpl: () => {
        throw new Error('spawn npm ENOENT');
      },
    });
    expect(note).toMatch(/could not start npm/);
  });
});

describe('sessionContext surfaces the ensureDeps note', () => {
  it('prepends a string returned by ensureDeps', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'pidb-deps-ctx-'));
    const context = await sessionContext({ cwd: dataDir, dataDir, store: memoryStore(), ensureDeps: () => 'pidb: installing plugin dependencies…' });
    expect(context.startsWith('pidb: installing plugin dependencies…')).toBe(true);
    expect(context).toContain('Golden rules:');
  });
});
