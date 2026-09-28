import { describe, it, expect } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import path from 'node:path';
import { resolveDataDir } from '../src/agent/datadir.js';

describe('resolveDataDir', () => {
  it('uses PIDB_PLUGIN_DATA verbatim when set (hooks/MCP get it from CLAUDE_PLUGIN_DATA)', () => {
    expect(resolveDataDir({ PIDB_PLUGIN_DATA: '/opt/pidb-data' }, '/anything')).toBe('/opt/pidb-data');
  });

  it('derives the data dir from the self path itself (POSIX), not from $HOME', () => {
    const selfPath = '/home/ann/.claude/plugins/cache/acme-market/pidb/1.2.3/dist/pidb.mjs';
    // HOME deliberately points somewhere else: the self path is the source of truth, not $HOME.
    expect(resolveDataDir({ HOME: '/completely/different/home' }, selfPath)).toBe(
      '/home/ann/.claude/plugins/data/pidb-acme-market',
    );
  });

  it('derives the data dir from a win32 self path, preserving its own prefix verbatim', () => {
    const selfPath = path.win32.join(
      'C:\\Users\\Ann\\.claude',
      'plugins',
      'cache',
      'acme-market',
      'pidb',
      '1.2.3',
      'dist',
      'pidb.mjs',
    );
    expect(resolveDataDir({ HOME: '/home/ann' }, selfPath)).toBe('C:\\Users\\Ann\\.claude\\plugins\\data\\pidb-acme-market');
  });

  it('falls back to $HOME/.claude/plugins/data/pidb-pidb when the self path is not inside a plugin cache (dev/tsx)', () => {
    expect(resolveDataDir({ HOME: '/home/ann' }, '/repo/packages/cli/src/agent/cli.ts')).toBe(
      join('/home/ann', '.claude', 'plugins', 'data', 'pidb-pidb'),
    );
  });

  it('falls back to pidb-pidb when the self path is empty', () => {
    expect(resolveDataDir({ HOME: '/home/ann' }, '')).toBe(join('/home/ann', '.claude', 'plugins', 'data', 'pidb-pidb'));
  });

  it('falls back to the real homedir() when HOME is unset and the self path is not a cache path', () => {
    expect(resolveDataDir({}, '')).toBe(join(homedir(), '.claude', 'plugins', 'data', 'pidb-pidb'));
  });

  it('a truncated cache path (missing dist segment) does not match and falls back to $HOME', () => {
    const selfPath = '/home/ann/.claude/plugins/cache/acme-market/pidb/1.2.3/pidb.mjs';
    expect(resolveDataDir({ HOME: '/home/ann' }, selfPath)).toBe(
      join('/home/ann', '.claude', 'plugins', 'data', 'pidb-pidb'),
    );
  });
});
