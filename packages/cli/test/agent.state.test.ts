import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import path from 'node:path';
import {
  loadBindings,
  loadProfiles,
  repoKey,
  saveBindings,
  saveProfiles,
  writeJsonAtomic,
  type ProfilesFile,
} from '../src/agent/state.js';
import { CliError } from '../src/errors.js';

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'pidb-agent-state-'));
});

describe('profiles.json', () => {
  it('defaults to an empty profiles file when absent', () => {
    expect(loadProfiles(dataDir)).toEqual({ default: null, profiles: {} });
  });

  it('round-trips through save/load', () => {
    const data: ProfilesFile = { default: 'work', profiles: { work: { url: 'https://pidb.example.com' } } };
    saveProfiles(dataDir, data);
    expect(loadProfiles(dataDir)).toEqual(data);
  });

  it('reports a corrupt file as invalid JSON', () => {
    writeFileSync(join(dataDir, 'profiles.json'), '{not json');
    expect(() => loadProfiles(dataDir)).toThrow(CliError);
    expect(() => loadProfiles(dataDir)).toThrow(/not valid JSON/);
  });
});

describe('bindings.json', () => {
  it('defaults to an empty object when absent', () => {
    expect(loadBindings(dataDir)).toEqual({});
  });

  it('round-trips through save/load', () => {
    const data = { '/repo/acme': { profile: 'work', project: 'acme' } };
    saveBindings(dataDir, data);
    expect(loadBindings(dataDir)).toEqual(data);
  });
});

describe('writeJsonAtomic', () => {
  it('writes via a temp file + rename, leaving no temp file behind and 0600 perms', () => {
    const target = join(dataDir, 'sub', 'thing.json');
    writeJsonAtomic(target, { a: 1 });
    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({ a: 1 });
    const leftovers = readdirSync(join(dataDir, 'sub')).filter((f) => f.includes('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('creates parent directories as needed and overwrites an existing file', () => {
    const target = join(dataDir, 'deep', 'nested', 'thing.json');
    writeJsonAtomic(target, { v: 1 });
    writeJsonAtomic(target, { v: 2 });
    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({ v: 2 });
  });
});

describe('repoKey', () => {
  it('uses the injected gitTopLevel result, resolved and forward-slashed', () => {
    const key = repoKey('/some/cwd', {
      gitTopLevel: () => '/repo/root',
      pathMod: path.posix,
    });
    expect(key).toBe('/repo/root');
  });

  it('falls back to cwd when gitTopLevel returns null (not a repo / git missing)', () => {
    const key = repoKey('/some/cwd', { gitTopLevel: () => null, pathMod: path.posix });
    expect(key).toBe('/some/cwd');
  });

  it('normalizes a win32 path: backslashes to forward slashes, drive letter lower-cased', () => {
    const key = repoKey('C:\\Users\\Ann\\repo', {
      gitTopLevel: () => 'C:\\Users\\Ann\\repo',
      pathMod: path.win32,
    });
    expect(key).toBe('c:/Users/Ann/repo');
  });

  it('is case-insensitive on the drive letter only, not the rest of the path', () => {
    const a = repoKey('x', { gitTopLevel: () => 'D:\\Repo\\Thing', pathMod: path.win32 });
    const b = repoKey('x', { gitTopLevel: () => 'd:\\Repo\\Thing', pathMod: path.win32 });
    expect(a).toBe(b);
    expect(a).toBe('d:/Repo/Thing');
  });
});
