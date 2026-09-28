import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import nodePath from 'node:path';
import { CliError } from '../errors.js';

export interface Profile {
  url: string;
  /** Projects the current (or most recently issued) token for this profile was approved for, per
   * the connect poll response (spec §2.3) — used to widen a later `pidb connect`'s request. */
  projects?: string[];
  /** Expiry of the current token for this profile, from the connect poll response. */
  expires_at?: number | null;
}

export interface ProfilesFile {
  default: string | null;
  profiles: Record<string, Profile>;
}

export interface Binding {
  profile: string;
  project: string;
}

/** Keyed by `repoKey(cwd)` (spec §2.2). */
export type BindingsFile = Record<string, Binding>;

function readJsonFile<T>(path: string, fallback: T): T {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw new CliError(`cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new CliError(`${path} is not valid JSON`);
  }
}

/**
 * Atomic write: write to a sibling temp file, then rename over the target.
 * A crash or concurrent read mid-write never observes a partial file —
 * `rename` is atomic on the same filesystem on both POSIX and Windows.
 */
export function writeJsonAtomic(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

function profilesPath(dataDir: string): string {
  return join(dataDir, 'profiles.json');
}

function bindingsPath(dataDir: string): string {
  return join(dataDir, 'bindings.json');
}

export function loadProfiles(dataDir: string): ProfilesFile {
  return readJsonFile(profilesPath(dataDir), { default: null, profiles: {} });
}

export function saveProfiles(dataDir: string, data: ProfilesFile): void {
  writeJsonAtomic(profilesPath(dataDir), data);
}

export function loadBindings(dataDir: string): BindingsFile {
  return readJsonFile(bindingsPath(dataDir), {});
}

export function saveBindings(dataDir: string, data: BindingsFile): void {
  writeJsonAtomic(bindingsPath(dataDir), data);
}

/** `written.json` (spec §2.2): absolute paths produced by `pidb secret write|env` in agent mode. */
export interface WrittenFile {
  paths: string[];
}

function writtenPath(dataDir: string): string {
  return join(dataDir, 'written.json');
}

export function loadWritten(dataDir: string): WrittenFile {
  return readJsonFile(writtenPath(dataDir), { paths: [] });
}

/** Appends `absPath` to `written.json`, deduped, atomic (a no-op write if it's already recorded). */
export function recordWritten(dataDir: string, absPath: string): void {
  const data = loadWritten(dataDir);
  if (data.paths.includes(absPath)) return;
  data.paths.push(absPath);
  writeJsonAtomic(writtenPath(dataDir), data);
}

/** Resolves symlinks in `p` (an existing path); returns `p` itself, unresolved, when that fails. */
function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Realpath-resolves `p` as far as the filesystem allows: walks up to the nearest existing ancestor
 * (the target itself usually doesn't exist yet — we're about to create it), resolves *that*
 * (following any symlinked directories along the way), and re-appends the non-existent tail
 * unresolved. This is what lets `isPathInside` catch a symlinked directory planted inside the data
 * dir that actually points somewhere else on disk — a plain textual `resolve()` would be fooled by
 * it, since `resolve()` never touches the filesystem.
 */
function realCandidatePath(p: string): string {
  let current = resolve(p);
  const tail: string[] = [];
  while (true) {
    try {
      const real = realpathSync(current);
      return tail.length > 0 ? join(real, ...tail) : real;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return join(current, ...tail); // unexpected — don't throw from a safety check
      const parent = dirname(current);
      if (parent === current) return join(current, ...tail); // reached the filesystem root
      tail.unshift(basename(current));
      current = parent;
    }
  }
}

/**
 * True when `candidate` is `dir` itself or nested inside it. Both sides are realpath-resolved (fix
 * round 1, Minor 7) so a symlink cannot be used to make a path that's textually inside `dir` actually
 * land somewhere else, or vice versa. `rel === '..'`/`rel.startsWith('..' + sep)` is the precise
 * "escaped upward" check — testing `rel.startsWith('..')` alone would misfire on a legitimately
 * nested entry whose name happens to start with two dots (e.g. `dir/..hidden`).
 */
export function isPathInside(dir: string, candidate: string): boolean {
  const base = safeRealpath(resolve(dir));
  const target = realCandidatePath(candidate);
  if (base === target) return true;
  const rel = relative(base, target);
  if (rel === '..' || rel.startsWith(`..${sep}`)) return false;
  if (isAbsolute(rel)) return false; // e.g. a different drive letter on win32 — relative() can't express it
  return true;
}

export interface RepoKeyOptions {
  /** Returns the git top-level for `cwd`, or null when not a repo / git is missing. Overridable for tests. */
  gitTopLevel?: (cwd: string) => string | null;
  /** Path module used to resolve the key; overridable to exercise win32 normalization from any host. */
  pathMod?: Pick<typeof nodePath, 'resolve'>;
}

function defaultGitTopLevel(cwd: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Key for `bindings.json`: the repo's git top-level (falling back to `cwd`
 * when it isn't a repo, or git isn't installed), normalized per spec §2.2 —
 * `path.resolve`, forward slashes, lower-cased drive letter on Windows.
 */
export function repoKey(cwd: string, opts: RepoKeyOptions = {}): string {
  const pathMod = opts.pathMod ?? nodePath;
  const top = (opts.gitTopLevel ?? defaultGitTopLevel)(cwd) ?? cwd;
  const resolved = pathMod.resolve(top).replace(/\\/g, '/');
  return resolved.replace(/^([A-Za-z]):/, (_m, drive: string) => `${drive.toLowerCase()}:`);
}
