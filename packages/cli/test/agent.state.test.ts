import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import path from 'node:path';
import {
  isPathInside,
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
  dataDir = mkdtempSync(join(tmpdir(), 'blindkey-agent-state-'));
});

describe('profiles.json', () => {
  it('defaults to an empty profiles file when absent', () => {
    expect(loadProfiles(dataDir)).toEqual({ default: null, profiles: {} });
  });

  it('round-trips through save/load', () => {
    const data: ProfilesFile = { default: 'work', profiles: { work: { url: 'https://blindkey.example.com' } } };
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
  it('writes via a temp file + rename, leaving no temp file behind', () => {
    const target = join(dataDir, 'sub', 'thing.json');
    writeJsonAtomic(target, { a: 1 });
    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({ a: 1 });
    const leftovers = readdirSync(join(dataDir, 'sub')).filter((f) => f.includes('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('writes the file 0600 (POSIX file-mode bits are not meaningful on Windows)', () => {
    const target = join(dataDir, 'perms.json');
    writeJsonAtomic(target, { a: 1 });
    expect(statSync(target).mode & 0o777).toBe(0o600);
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

describe('isPathInside (fix round 1, Minor 7)', () => {
  it('the dir itself is inside itself', () => {
    expect(isPathInside(dataDir, dataDir)).toBe(true);
  });

  it('a direct child is inside', () => {
    expect(isPathInside(dataDir, join(dataDir, 'secret.txt'))).toBe(true);
  });

  it('a nested descendant is inside', () => {
    expect(isPathInside(dataDir, join(dataDir, 'a', 'b', 'secret.txt'))).toBe(true);
  });

  it('a sibling directory is not inside', () => {
    expect(isPathInside(dataDir, `${dataDir}-sibling/secret.txt`)).toBe(false);
  });

  it('a genuine parent-traversal escape is not inside', () => {
    expect(isPathInside(dataDir, join(dataDir, '..', 'outside.txt'))).toBe(false);
  });

  it('a relative --out of "../<data dir name>/x" that resolves back inside is inside', () => {
    const out = join(dataDir, '..', path.basename(dataDir), 'secret.txt');
    expect(isPathInside(dataDir, out)).toBe(true);
  });

  it('a legitimately nested entry whose name merely starts with ".." is inside, not an escape', () => {
    // Regression: an earlier check (`rel.startsWith('..')`) misfired on this — a subpath like
    // "..hidden" isn't the traversal token "..", it's just a filename that happens to start with it.
    expect(isPathInside(dataDir, join(dataDir, '..hidden', 'secret.txt'))).toBe(true);
  });

  it.skipIf(process.platform === 'win32')(
    'a symlinked directory inside the data dir that actually points outside it is not inside (realpath escape)',
    () => {
      const outsideDir = mkdtempSync(join(tmpdir(), 'blindkey-agent-state-outside-'));
      const linkPath = join(dataDir, 'looks-safe');
      symlinkSync(outsideDir, linkPath, 'dir');
      expect(isPathInside(dataDir, join(linkPath, 'secret.txt'))).toBe(false);
    },
  );

  it.skipIf(process.platform === 'win32')('a symlinked data dir itself is still matched via realpath', () => {
    const realDir = mkdtempSync(join(tmpdir(), 'blindkey-agent-state-real-'));
    const linkedDataDir = join(tmpdir(), `blindkey-agent-state-link-${process.pid}-${Date.now()}`);
    symlinkSync(realDir, linkedDataDir, 'dir');
    expect(isPathInside(linkedDataDir, join(realDir, 'secret.txt'))).toBe(true);
  });

  it.skipIf(process.platform === 'win32')(
    'fix round 2, Minor 3: a data dir that does not exist yet, reached through a symlinked ancestor, still matches its own descendants',
    () => {
      const realBase = mkdtempSync(join(tmpdir(), 'blindkey-agent-state-realbase-'));
      const symlinkedBase = join(tmpdir(), `blindkey-agent-state-symlinkbase-${process.pid}-${Date.now()}`);
      symlinkSync(realBase, symlinkedBase, 'dir');
      // Neither the data dir itself nor the candidate file exist yet — only `symlinkedBase` (a
      // symlink to `realBase`) does.
      const notYetCreatedDataDir = join(symlinkedBase, 'plugin-data');
      const out = join(notYetCreatedDataDir, 'secret.txt');
      expect(isPathInside(notYetCreatedDataDir, out)).toBe(true);
      // A path that only looks related textually (same symlinked prefix, different subdirectory)
      // is still correctly rejected.
      const sibling = join(symlinkedBase, 'other-dir', 'secret.txt');
      expect(isPathInside(notYetCreatedDataDir, sibling)).toBe(false);
    },
  );
});
