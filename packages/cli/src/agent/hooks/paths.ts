// Path/glob matching for the PreToolUse guard's rule 3 (Fix round 4): resolving a raw argument against
// an effective cwd (with `~`/`$HOME`/`%APPDATA%`/`$PWD`/`$(pwd)` expansion), the two overlap
// directions, and wildcard tokens matched as globs against the protected/written paths.
import { posix as posixPath, win32 as win32Path } from 'node:path';

export interface PathContext {
  dataDir: string;
  written: string[];
  home: string;
  platform: NodeJS.Platform;
  appData?: string;
}

export function pathModFor(platform: NodeJS.Platform) {
  return platform === 'win32' ? win32Path : posixPath;
}

export function appDataOf(ctx: PathContext): string {
  if (ctx.appData) return ctx.appData;
  return pathModFor(ctx.platform).join(ctx.home, 'AppData', 'Roaming');
}

/** The plugin data dir, `~/.config/pidb`, `%APPDATA%\pidb` (resolved). */
export function protectedRoots(ctx: PathContext): string[] {
  const pm = pathModFor(ctx.platform);
  return [ctx.dataDir, pm.join(ctx.home, '.config', 'pidb'), pm.join(appDataOf(ctx), 'pidb')].map((p) => pm.resolve(p));
}

export function writtenFiles(ctx: PathContext): string[] {
  const pm = pathModFor(ctx.platform);
  return ctx.written.map((w) => pm.resolve(w));
}

/** Forward slashes; case-folded on win32 (NTFS is case-insensitive). */
export function normalizeForCompare(p: string, platform: NodeJS.Platform): string {
  const s = p.replace(/\\/g, '/');
  return platform === 'win32' ? s.toLowerCase() : s;
}

function withTrailingSlash(p: string): string {
  return p.endsWith('/') ? p : `${p}/`;
}

/** `a` equals `b` or is nested inside it — safe for any tool. */
export function overlapNested(a: string, b: string): boolean {
  return a === b || a.startsWith(withTrailingSlash(b));
}

/** `overlapNested`, or `a` is an ancestor of `b` (a recursive search of `a` reaches `b`). Handles `/` and `C:/`. */
export function overlapEither(a: string, b: string): boolean {
  return overlapNested(a, b) || b.startsWith(withTrailingSlash(a));
}

export type Overlap = (a: string, b: string) => boolean;

/** Every protected root and written file, normalized for comparison. */
export function protectedTargets(ctx: PathContext): string[] {
  return [...protectedRoots(ctx), ...writtenFiles(ctx)].map((p) => normalizeForCompare(p, ctx.platform));
}

export function isProtectedPath(resolved: string, ctx: PathContext, overlap: Overlap): boolean {
  const target = normalizeForCompare(resolved, ctx.platform);
  return protectedTargets(ctx).some((p) => overlap(target, p));
}

/** Expands `~`, `$HOME`, `%APPDATA%`, `$env:APPDATA`, `%USERPROFILE%`, `$XDG_CONFIG_HOME`, and cwd references. */
export function expandPlaceholders(text: string, ctx: PathContext, cwd?: string): string {
  const pm = pathModFor(ctx.platform);
  const appData = appDataOf(ctx);
  const xdgConfigHome = pm.join(ctx.home, '.config');
  let out = text
    .replace(/(^|[\s"'([{=:])~(?=[\\/]|$)/g, `$1${ctx.home}`)
    .replace(/%APPDATA%/gi, appData)
    .replace(/\$\{?env:APPDATA\}?/gi, appData)
    .replace(/%USERPROFILE%/gi, ctx.home)
    .replace(/\$\{?env:(USERPROFILE|HOME)\}?/gi, ctx.home)
    .replace(/\$\{HOME\}/g, ctx.home)
    .replace(/\$HOME\b/g, ctx.home)
    .replace(/\$\{XDG_CONFIG_HOME\}/g, xdgConfigHome)
    .replace(/\$XDG_CONFIG_HOME\b/g, xdgConfigHome);
  if (cwd !== undefined) {
    out = out
      .replace(/\$\(\s*(pwd|Get-Location|gl)\s*\)/gi, cwd)
      .replace(/`\s*pwd\s*`/g, cwd)
      .replace(/\$\{PWD\}/gi, cwd)
      .replace(/\$PWD\b/gi, cwd)
      .replace(/%CD%/gi, cwd);
  }
  return out;
}

export function resolveArgPath(raw: string, baseDir: string, ctx: PathContext): string {
  const pm = pathModFor(ctx.platform);
  const expanded = expandPlaceholders(raw, ctx, baseDir);
  return pm.isAbsolute(expanded) ? pm.resolve(expanded) : pm.resolve(baseDir, expanded);
}

export function hasWildcard(token: string): boolean {
  return /[*?[]/.test(token);
}

/**
 * Glob → RegExp over a normalized (forward-slash) path. `*`/`?` never cross a `/` but DO match a
 * leading dot (zsh `GLOB_DOTS`/PowerShell semantics — biased toward catching `*.env` against `.env`);
 * `**` crosses directories; `[...]` is a character class.
 */
export function globToRegExp(glob: string, platform: NodeJS.Platform): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else re += '[^/]*';
    } else if (ch === '?') re += '[^/]';
    else if (ch === '[') {
      const close = glob.indexOf(']', i + 1);
      if (close === -1) re += '\\[';
      else {
        re += `[${glob.slice(i + 1, close).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`;
        i = close;
      }
    } else re += ch.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, platform === 'win32' ? 'i' : '');
}

/**
 * Whether a wildcard token (resolved against `baseDir`) could name a protected/written path: the glob
 * matches a target itself, or its static directory prefix lies inside a protected root
 * (`~/.config/pidb/*`). For a recursive search the glob may also match one of a target's ancestor
 * directories (`grep -r X *` reaches `config/db.env` through `config`).
 */
export function globHitsProtected(token: string, baseDir: string, ctx: PathContext, recursive: boolean): boolean {
  const resolvedGlob = normalizeForCompare(resolveArgPath(token, baseDir, ctx), ctx.platform);
  const re = globToRegExp(resolvedGlob, ctx.platform);
  const targets = protectedTargets(ctx);
  for (const t of targets) {
    if (re.test(t)) return true;
    if (!recursive) continue;
    for (let cut = t.lastIndexOf('/'); cut > 0; cut = t.lastIndexOf('/', cut - 1)) {
      if (re.test(t.slice(0, cut))) return true;
    }
  }
  const wildcardIdx = resolvedGlob.search(/[*?[]/);
  const staticDir = resolvedGlob.slice(0, resolvedGlob.lastIndexOf('/', wildcardIdx) + 1).replace(/\/$/, '') || '/';
  return protectedRoots(ctx).some((r) => overlapNested(staticDir, normalizeForCompare(r, ctx.platform)));
}
