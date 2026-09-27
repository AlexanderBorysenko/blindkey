import { describe, it, expect } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import path from 'node:path';
import { resolveDataDir } from '../src/agent/datadir.js';

describe('resolveDataDir', () => {
  it('uses PIDB_PLUGIN_DATA verbatim when set (hooks/MCP get it from CLAUDE_PLUGIN_DATA)', () => {
    expect(resolveDataDir({ PIDB_PLUGIN_DATA: '/opt/pidb-data' }, '/anything')).toBe('/opt/pidb-data');
  });

  it('derives <plugin>-<marketplace> from a POSIX plugin cache path', () => {
    const selfPath = '/home/ann/.claude/plugins/cache/acme-market/pidb/1.2.3/dist/pidb.mjs';
    expect(resolveDataDir({ HOME: '/home/ann' }, selfPath)).toBe(
      join('/home/ann', '.claude', 'plugins', 'data', 'pidb-acme-market'),
    );
  });

  it('derives <plugin>-<marketplace> from a win32 plugin cache path, regardless of host separators', () => {
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
    expect(resolveDataDir({ HOME: '/home/ann' }, selfPath)).toBe(
      join('/home/ann', '.claude', 'plugins', 'data', 'pidb-acme-market'),
    );
  });

  it('falls back to pidb-pidb when the self path is not inside a plugin cache (dev/tsx)', () => {
    expect(resolveDataDir({ HOME: '/home/ann' }, '/repo/packages/cli/src/agent/cli.ts')).toBe(
      join('/home/ann', '.claude', 'plugins', 'data', 'pidb-pidb'),
    );
  });

  it('falls back to pidb-pidb when the self path is empty', () => {
    expect(resolveDataDir({ HOME: '/home/ann' }, '')).toBe(join('/home/ann', '.claude', 'plugins', 'data', 'pidb-pidb'));
  });

  it('falls back to the real homedir() when HOME is unset', () => {
    expect(resolveDataDir({}, '')).toBe(join(homedir(), '.claude', 'plugins', 'data', 'pidb-pidb'));
  });

  it('a truncated cache path (missing dist segment) does not match', () => {
    const selfPath = '/home/ann/.claude/plugins/cache/acme-market/pidb/1.2.3/pidb.mjs';
    expect(resolveDataDir({ HOME: '/home/ann' }, selfPath)).toBe(
      join('/home/ann', '.claude', 'plugins', 'data', 'pidb-pidb'),
    );
  });
});
