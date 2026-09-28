// PreToolUse guard (spec §3.1): a pure, heuristic decision function over a single tool-call. Never
// touches the network or the filesystem itself — everything it needs (the plugin data dir, the
// `written.json` paths, the configured server urls, the home dir, the platform) is handed in as
// `GuardContext` by the dispatcher (`index.ts`), so this file is trivially table-testable on any host
// regardless of the actual OS it runs on.
//
// Fix round 4 — SEGMENT model throughout (see `shell.ts`): a Bash command is expanded into segments
// by recursively unwrapping `sh|bash|zsh|dash|ksh -<flags with c> '<script>'`, `powershell|pwsh -c`,
// `cmd /c|/k`, and `pidb secret exec ... -- <child>`, splitting on newlines/`;`/`&&`/`||`/`|`/`&`/
// `(`/`)` and command substitutions (also inside double quotes). Every segment carries its effective
// cwd (`cd` tracking) and whether it runs inside a `pidb secret exec` child. Each rule then looks at
// segments' resolved command words (basename, prefixes such as `env`/`sudo`/`time`/`npx` skipped)
// instead of raw text. Path matching lives in `paths.ts`.
//
// This is defense-in-depth, not a security boundary (spec §6) — rules are biased toward catching
// accidental leaks, balanced against a fixed set of everyday dev commands that must never be blocked
// (see `agent.hooks.guard.probe.test.ts`'s `fp` table).
import { commandWordOf, splitSegments, tokenizeSpans, unwrapInterpreter, type Token } from './shell.js';
import {
  globHitsProtected,
  globToRegExp,
  hasWildcard,
  isProtectedPath,
  normalizeForCompare,
  overlapEither,
  overlapNested,
  pathModFor,
  protectedRoots,
  resolveArgPath,
  writtenFiles,
  type Overlap,
} from './paths.js';

export { tokenize } from './shell.js';

export interface HookToolInput {
  [key: string]: unknown;
}

export interface HookInput {
  hook_event_name: string;
  session_id?: string;
  cwd: string;
  tool_name?: string;
  tool_input?: HookToolInput;
  tool_response?: unknown;
}

export interface GuardContext {
  dataDir: string;
  written: string[];
  serverUrls: string[];
  home: string;
  platform: NodeJS.Platform;
  /** Windows `%APPDATA%` (production: `env.APPDATA`); falls back to `<home>\AppData\Roaming`. */
  appData?: string;
}

export type GuardDecision = { deny: false } | { deny: true; reason: string };

const ALLOW: GuardDecision = { deny: false };

function deny(reason: string): GuardDecision {
  return { deny: true, reason };
}

// =================================================================================================
// Segment expansion
// =================================================================================================

interface Segment {
  raw: string;
  spans: Token[];
  tokens: string[];
  /** Resolved command word (lower-cased basename), or null. */
  word: string | null;
  /** Index of the command word's token. */
  index: number;
  /** Effective working directory (after preceding `cd`s in the same script). */
  cwd: string;
  /** Whether this segment runs inside (or after) a `pidb secret exec ... --` child. */
  inExec: boolean;
  /** The sibling segments of the same script (for `find ... | xargs cat`). */
  group: Segment[];
}

const MAX_DEPTH = 8;
const CD_WORDS = new Set(['cd', 'pushd', 'chdir', 'set-location', 'sl']);

function isPidbWord(word: string | null): boolean {
  return word === 'pidb';
}

/** pidb's own args (between the command word and its first exact `--`) and the child text after it. */
function pidbArgs(seg: Segment): { own: string[]; childStart: number | null; hasDashDash: boolean } {
  const after = seg.tokens.slice(seg.index + 1);
  const dd = after.indexOf('--');
  if (dd === -1) return { own: after, childStart: null, hasDashDash: false };
  const childTok = seg.spans[seg.index + 1 + dd + 1];
  return { own: after.slice(0, dd), childStart: childTok ? childTok.start : null, hasDashDash: true };
}

function isSecretExec(seg: Segment): boolean {
  if (!isPidbWord(seg.word)) return false;
  const own = pidbArgs(seg).own.map((t) => t.toLowerCase());
  const s = own.indexOf('secret');
  return s !== -1 && own[s + 1] === 'exec';
}

function expandSegments(text: string, cwd: string, ctx: GuardContext, inExec = false, depth = 0, out: Segment[] = []): Segment[] {
  let effectiveCwd = cwd;
  let execSeen = inExec;
  const group: Segment[] = [];
  for (const raw of splitSegments(text)) {
    const spans = tokenizeSpans(raw);
    const tokens = spans.map((s) => s.value);
    const cw = commandWordOf(tokens);
    const seg: Segment = { raw, spans, tokens, word: cw.word, index: cw.index, cwd: effectiveCwd, inExec: execSeen, group };
    out.push(seg);
    group.push(seg);
    const target = tokens[cw.index + 1];
    if (cw.word && CD_WORDS.has(cw.word) && target && target !== '-') effectiveCwd = resolveArgPath(target, effectiveCwd, ctx);
    if (depth >= MAX_DEPTH) continue;
    const script = unwrapInterpreter(raw, spans, cw);
    if (script && script.trim() && script.trim() !== raw) expandSegments(script, seg.cwd, ctx, seg.inExec, depth + 1, out);
    if (isSecretExec(seg)) {
      // Everything after the exec in the same script is treated as the child too (a trailing `; env`
      // or a newline after `--` is almost certainly meant for it) — biased toward catching leaks.
      execSeen = true;
      const { childStart } = pidbArgs(seg);
      if (childStart !== null) expandSegments(raw.slice(childStart), seg.cwd, ctx, true, depth + 1, out);
    }
  }
  return out;
}

// =================================================================================================
// Rule 1: `pidb` + a disabled subcommand — only pidb's OWN args (before its own first ` -- `).
// =================================================================================================

/**
 * Any segment — top-level, chained, substituted (`$(...)`/backticks, also inside double quotes),
 * unwrapped from `sh -c`/`cmd /c`, or itself an exec child — whose command word is `pidb` (by
 * basename, after `npx`/`npm exec`/`pnpm`/`time`/... prefixes) with `login`/`token` as its first
 * arg, or `secret` followed by an exact `get`/`--print` token.
 */
function runsDisabledPidbCommand(segments: Segment[]): boolean {
  return segments.some((seg) => {
    if (!isPidbWord(seg.word)) return false;
    const own = pidbArgs(seg).own;
    const next = (own[0] ?? '').toLowerCase();
    if (next === 'login' || next === 'token') return true;
    if (next !== 'secret') return false;
    return own.slice(1).some((t) => t.toLowerCase() === 'get' || t === '--print');
  });
}

// =================================================================================================
// Rule 2: `pidb secret exec`'s child printing the environment.
// =================================================================================================

const PIDB_VAR_REF = /\$\{?PIDB_[A-Za-z0-9_]*\}?|%PIDB_[A-Za-z0-9_]*%|\$\{?env:PIDB_[A-Za-z0-9_]*\}?/i;
const PRINT_WORDS = new Set([
  'echo', 'printf', 'print', 'write-output', 'write', 'write-host', 'write-information', 'write-error',
  'write-warning', 'write-verbose', 'out-host', 'out-default', 'echo.', 'cat', 'type', 'tee', 'say',
]); // prettier-ignore
const ENV_PROVIDER_WORDS = new Set([
  'get-item', 'gi', 'get-childitem', 'gci', 'dir', 'ls', 'get-content', 'gc', 'cat', 'type',
  'get-itemproperty', 'gp', 'get-itempropertyvalue', 'gpv',
]); // prettier-ignore
const DOTNET_GETENV_RE = /\[(System\.)?Environment\]::GetEnvironmentVariables?\b/i;
const PROC_ENVIRON_RE = /\/proc\/[^/\s]+\/environ\b/i;
const ENV_ACCESS_IN_CODE_RE =
  /process\.env|Deno\.env|Bun\.env|os\.environ|os\.getenv|getenv\(|\bENV\[|\bENV\{|\$ENV\{|%ENV\b|\bENV\.|ENVIRON\b|System\.getenv/;
const WHOLE_ENV_IN_CODE_RE =
  /process\.env(?![.[\w])|Deno\.env\.toObject|os\.environ(?![[.\w])|os\.environ\.(items|keys|values|copy)|%ENV\b|\bENV\.(to_h|to_a|each|inspect|keys)|\bENVIRON\b(?!\[)|getenv\(\s*\)/;
/** A print-like call whose own statement (up to `;`/newline) goes on to access the environment. */
const PRINTS_ENV_IN_CODE_RE =
  /(console\.\w+|\bprint(ln|f)?\b|\bputs\b|\bpp\b|\bp[ (]|\bsay\b|\becho\b|std(out|err)\.write|\$stdout|\bSTDOUT\b|\bwarn\b|\bdie\b|\bdump\b|\balert\b)[^;\n]*?(process\.env|Deno\.env|Bun\.env|os\.environ|os\.getenv|getenv\(|\bENV\b|\$ENV\{|%ENV\b|ENVIRON\b|System\.getenv)/;

interface InlineCode {
  code: string;
  printFlag: boolean;
}

/** The inline program of `node -e`/`python -c`/`ruby -e`/`perl -ne`/`deno eval`/`php -r`/`awk '...'`, if any. */
function inlineCodeOf(seg: Segment): InlineCode | null {
  const w = seg.word ?? '';
  const args = seg.tokens.slice(seg.index + 1);
  let flagRe: RegExp | null = null;
  let printRe: RegExp | null = null;
  if (w === 'node' || w === 'bun' || w === 'nodejs') {
    flagRe = /^(-e|-p|-pe|-ep|--eval|--print)$/;
    printRe = /^(-p|-pe|-ep|--print)$/;
  } else if (/^(python[\d.]*|py|pypy[\d.]*)$/.test(w)) flagRe = /^-[a-zA-Z]*c$/;
  else if (w === 'ruby') flagRe = /^-[a-zA-Z]*e$/;
  else if (w === 'perl') {
    flagRe = /^-[a-zA-Z]*[eE]$/;
    printRe = /^-[a-zA-Z]*p[a-zA-Z]*$/;
  } else if (w === 'php') flagRe = /^-r$/;
  else if (w === 'deno') {
    const i = args.findIndex((t) => t === 'eval');
    if (i === -1) return null;
    const code = args.slice(i + 1).find((t) => !t.startsWith('-'));
    return code === undefined ? null : { code, printFlag: args.some((t) => t === '-p' || t === '--print') };
  } else if (/^(awk|gawk|mawk|nawk)$/.test(w)) {
    for (let k = 0; k < args.length; k++) {
      const t = args[k]!;
      if (t === '-f') return null;
      if (t === '-v' || t === '-F') {
        k++;
        continue;
      }
      if (t.startsWith('-')) continue;
      return { code: t, printFlag: false };
    }
    return null;
  }
  if (!flagRe) return null;
  for (let k = 0; k < args.length; k++) {
    const t = args[k]!;
    const eq = /^(--eval|--print)=(.*)$/s.exec(t);
    if (eq) return { code: eq[2]!, printFlag: eq[1] === '--print' };
    if (flagRe.test(t) && args[k + 1] !== undefined) {
      return { code: args[k + 1]!, printFlag: args.some((a) => printRe?.test(a) ?? false) };
    }
  }
  return null;
}

function segmentPrintsEnvironment(seg: Segment): boolean {
  const word = seg.word ?? '';
  const args = seg.tokens.slice(seg.index + 1);
  if (/^\$\{?env:pidb_[a-z0-9_]*\}?$/i.test(word)) return true; // bare PowerShell expression statement
  if (word === 'env' || word === 'printenv' || word === 'typeset') return true;
  if (word === 'export' && (args.length === 0 || args[0] === '-p')) return true;
  if (word === 'declare' && args.every((a) => a.startsWith('-'))) return true;
  if (word === 'compgen' && args.some((a) => a === '-v' || a === '-e')) return true;
  if (word === 'set' && (args.length === 0 || /^pidb/i.test(args[0]!))) return true;
  if (PRINT_WORDS.has(word) && PIDB_VAR_REF.test(seg.raw)) return true;
  if (ENV_PROVIDER_WORDS.has(word) && args.some((a) => /^env:/i.test(a))) return true;
  if (DOTNET_GETENV_RE.test(seg.raw) || PROC_ENVIRON_RE.test(seg.raw)) return true;
  const inline = inlineCodeOf(seg);
  if (inline && ENV_ACCESS_IN_CODE_RE.test(inline.code)) {
    if (inline.printFlag || PRINTS_ENV_IN_CODE_RE.test(inline.code) || WHOLE_ENV_IN_CODE_RE.test(inline.code)) return true;
  }
  return false;
}

// =================================================================================================
// Rule 3: protected paths (plugin data dir, `~/.config/pidb`, `%APPDATA%\pidb`, `written.json`).
// =================================================================================================

const READ_WORDS = new Set([
  'cat', 'type', 'get-content', 'gc', 'less', 'more', 'bat', 'batcat', 'head', 'tail', 'sed', 'awk',
  'gawk', 'cp', 'mv', 'copy', 'copy-item', 'cpi', 'move-item', 'xcopy', 'robocopy', 'base64', 'xxd',
  'od', 'hexdump', 'strings', 'vim', 'vi', 'nvim', 'nano', 'emacs', 'jq', 'yq', 'source', '.', 'tar',
  'zip', '7z', 'gzip', 'bzip2', 'xz', 'diff', 'cmp', 'sort', 'nl', 'tac', 'uniq', 'cut', 'paste',
  'rev', 'fold', 'column', 'iconv', 'openssl', 'scp', 'rsync', 'import-csv', 'curl', 'http', 'https',
  'node', 'nodejs', 'bun', 'deno', 'ruby', 'perl', 'php',
  // grep family (pattern-aware below)
  'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'select-string', 'sls', 'findstr',
]); // prettier-ignore
const GREP_FAMILY = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'findstr']);
const ALWAYS_RECURSIVE = new Set(['rg', 'ag', 'ack']);
const GIT_READ_SUBCOMMANDS = new Set(['add', 'diff', 'show', 'blame', 'cat-file', 'hash-object', 'apply', 'grep']);
/** Flags taking a separate argument, per search tool (so the argument isn't mistaken for a path). */
const SEARCH_ARG_FLAGS: Record<string, Set<string>> = {
  grep: new Set(['-e', '-f', '-m', '-A', '-B', '-C', '-d', '-D', '--regexp', '--file', '--max-count', '--after-context', '--before-context', '--context', '--include', '--exclude', '--exclude-dir', '--label']),
  rg: new Set(['-e', '-f', '-g', '-t', '-T', '-m', '-A', '-B', '-C', '-j', '-M', '-r', '-E', '-d', '--glob', '--iglob', '--type', '--type-not', '--regexp', '--file', '--max-count', '--replace', '--encoding', '--max-columns', '--context', '--after-context', '--before-context', '--threads', '--sort', '--sortr', '--max-depth', '--type-add', '--ignore-file', '--pre', '--pre-glob', '--color', '--colors', '--max-filesize', '--path-separator']),
  ag: new Set(['-G', '-m', '-A', '-B', '-C', '--ignore', '--ignore-dir', '--file-search-regex']),
  git: new Set(['-e', '-f', '-m', '-A', '-B', '-C', '--max-depth', '--threads', '-O']),
}; // prettier-ignore
SEARCH_ARG_FLAGS.egrep = SEARCH_ARG_FLAGS.grep!;
SEARCH_ARG_FLAGS.fgrep = SEARCH_ARG_FLAGS.grep!;
SEARCH_ARG_FLAGS.ack = SEARCH_ARG_FLAGS.ag!;
const EXEMPT_TOKENS = new Set(['.', '..', '', '~', '-', '/dev/null', 'nul']);

interface Operands {
  /** Positional (non-flag) arguments, redirections removed. */
  positional: string[];
  /** Files read through `<file` input redirection. */
  inputs: string[];
  /** Values of flags taking a separate argument (e.g. `rg -g '*.ts'`). */
  flagValues: Map<string, string[]>;
  /** Whether a `-e`/`-f`/`--regexp`/`--file`-style flag supplied the pattern. */
  patternViaFlag: boolean;
}

/** Splits a segment's args into positionals/inputs, dropping flags and output redirections. */
function operandsOf(args: string[], argFlags: Set<string>, windowsSlashFlags: boolean): Operands {
  const out: Operands = { positional: [], inputs: [], flagValues: new Map(), patternViaFlag: false };
  let afterDashDash = false;
  for (let k = 0; k < args.length; k++) {
    let t = args[k]!;
    if (/^\d*<<-?$|^\d*<<</.test(t) || t.startsWith('<(')) {
      if (/^\d*<<-?$|^<<<$/.test(t)) k++;
      continue;
    }
    if (/^\d*<<\S/.test(t)) continue; // heredoc delimiter glued on
    const inRedir = /^\d*<(.*)$/s.exec(t);
    if (inRedir) {
      const target = inRedir[1] ? inRedir[1] : args[++k];
      if (target !== undefined) out.inputs.push(target);
      continue;
    }
    const outRedir = /^(\d*|&)>>?(.*)$/s.exec(t);
    if (outRedir) {
      if (!outRedir[2]) k++;
      continue;
    }
    const glued = t.search(/\d*>/);
    if (glued > 0) t = t.slice(0, glued); // `.env>out.txt`
    if (!afterDashDash && t === '--') {
      afterDashDash = true;
      continue;
    }
    if (!afterDashDash && t.length > 1 && (t.startsWith('-') || (windowsSlashFlags && /^\/[a-zA-Z]{1,2}(:.*)?$/.test(t)))) {
      if (/^(-e|-f|--regexp|--file)(=|$)|^-e.|^\/[cg]:/i.test(t)) out.patternViaFlag = true;
      if (argFlags.has(t) && args[k + 1] !== undefined) {
        const list = out.flagValues.get(t) ?? [];
        list.push(args[++k]!);
        out.flagValues.set(t, list);
      } else {
        const eq = /^(--[\w-]+)=(.*)$/s.exec(t);
        if (eq) out.flagValues.set(eq[1]!, [...(out.flagValues.get(eq[1]!) ?? []), eq[2]!]);
      }
      continue;
    }
    out.positional.push(t);
  }
  return out;
}

/** Whether a protected file under `root` survives the search's glob/type filters (true when unfiltered). */
function filtersAdmitProtected(root: string, globs: string[], types: string[], ctx: GuardContext): boolean {
  return admittedProtected(root, globs, types, ctx).length > 0;
}

/**
 * The protected roots / written files under (or around) `root` that survive the search's glob/type
 * filters — everything overlapping `root` when unfiltered. Used to name the offending file in the
 * Grep tool's deny message (Task 9).
 */
function admittedProtected(root: string, globs: string[], types: string[], ctx: GuardContext): string[] {
  const pm = pathModFor(ctx.platform);
  const rootN = normalizeForCompare(root, ctx.platform);
  // A protected directory's contents are unknown — never considered filtered out.
  const roots = protectedRoots(ctx).filter((r) => overlapEither(rootN, normalizeForCompare(r, ctx.platform)));
  const files = writtenFiles(ctx).filter((w) => overlapEither(rootN, normalizeForCompare(w, ctx.platform)));
  if (roots.length > 0 || (globs.length === 0 && types.length === 0)) return [...roots, ...files];
  const positive = globs.filter((g) => !g.startsWith('!'));
  const negative = globs.filter((g) => g.startsWith('!')).map((g) => g.slice(1));
  return files.filter((file) => {
    const fileN = normalizeForCompare(file, ctx.platform);
    const base = pm.basename(file);
    const rel = fileN.startsWith(`${rootN.replace(/\/$/, '')}/`) ? fileN.slice(rootN.replace(/\/$/, '').length + 1) : base;
    const matches = (g: string): boolean => globToRegExp(g.includes('/') ? g.replace(/^\.\//, '') : g, ctx.platform).test(g.includes('/') ? rel : base);
    if (negative.some(matches)) return false;
    if (positive.length > 0 && !positive.some(matches)) return false;
    if (types.length > 0) {
      const ext = (base.includes('.') ? base.slice(base.lastIndexOf('.') + 1) : base).toLowerCase();
      if (!types.some((t) => ['all', 'env', 'dotenv', 'config', ext].includes(t.toLowerCase()))) return false;
    }
    return true;
  });
}

function pathHitsProtected(raw: string, cwd: string, ctx: GuardContext, recursive: boolean): boolean {
  if (hasWildcard(raw)) return globHitsProtected(raw, cwd, ctx, recursive);
  if (!recursive && EXEMPT_TOKENS.has(raw.toLowerCase())) return false;
  const overlap: Overlap = recursive ? overlapEither : overlapNested;
  return isProtectedPath(resolveArgPath(raw, cwd, ctx), ctx, overlap);
}

/** Quoted string literals inside inline interpreter code that name a protected/written file. */
function inlineCodeNamesProtected(code: string, cwd: string, ctx: GuardContext): boolean {
  const pm = pathModFor(ctx.platform);
  const basenames = new Set(writtenFiles(ctx).map((w) => normalizeForCompare(pm.basename(w), ctx.platform)));
  for (const m of code.matchAll(/(['"`])([^'"`\n]{1,260})\1/g)) {
    const lit = m[2]!.trim();
    if (!lit || /\s/.test(lit)) continue;
    if (pathHitsProtected(lit, cwd, ctx, false)) return true;
    const base = lit.split(/[\\/]/).pop() ?? '';
    if (basenames.has(normalizeForCompare(base, ctx.platform))) return true;
  }
  return false;
}

/** `find <paths> ... -exec <read> {}` or `find <paths> | xargs <read>` — returns the searched paths. */
function findReadRoots(seg: Segment): string[] | null {
  if (seg.word !== 'find') return null;
  const args = seg.tokens.slice(seg.index + 1);
  const execIdx = args.findIndex((t) => ['-exec', '-execdir', '-ok', '-okdir'].includes(t));
  let reads = execIdx !== -1 && READ_WORDS.has(commandWordOf(args.slice(execIdx + 1)).word ?? '');
  if (!reads) {
    reads = seg.group.some((s) => {
      if (s.word !== 'xargs') return false;
      const xa = s.tokens.slice(s.index + 1);
      let k = 0;
      while (k < xa.length && xa[k]!.startsWith('-')) k += /^-[IaLndPsE]$/.test(xa[k]!) ? 2 : 1;
      return READ_WORDS.has(commandWordOf(xa.slice(k)).word ?? '');
    });
  }
  if (!reads) return null;
  const roots: string[] = [];
  for (const t of args) {
    if (t.startsWith('-') || t === '(' || t === '!' || t === '\\(') break;
    roots.push(t);
  }
  return roots.length > 0 ? roots : ['.'];
}

/** cp/mv-style commands whose last operand is the destination. */
const COPY_WORDS = new Set(['cp', 'mv', 'copy', 'copy-item', 'cpi', 'move-item', 'xcopy', 'scp', 'rsync']);

/** `'read'` = reads protected data; `'overwrite'` = only its copy destination is a protected/written file. */
type ProtectedAccess = 'read' | 'overwrite' | false;

function segmentReadsProtected(seg: Segment, ctx: GuardContext): ProtectedAccess {
  const word = seg.word ?? '';
  const winFlags = ctx.platform === 'win32' && word === 'findstr';
  let args = seg.tokens.slice(seg.index + 1);
  let searchWord = word === 'git' ? '' : word;
  let recursive = false;
  let checkAll = READ_WORDS.has(word);
  if (word === 'git') {
    let k = 0;
    while (k < args.length && args[k]!.startsWith('-')) k += ['-C', '-c', '--git-dir', '--work-tree'].includes(args[k]!) ? 2 : 1;
    const sub = (args[k] ?? '').toLowerCase();
    args = args.slice(k + 1);
    checkAll = GIT_READ_SUBCOMMANDS.has(sub);
    if (sub === 'grep') {
      searchWord = 'git';
      recursive = true;
    }
  }
  const argFlags = SEARCH_ARG_FLAGS[searchWord] ?? new Set<string>();
  const ops = operandsOf(args, argFlags, winFlags);
  // `<file` input redirection reads the file whatever the command is.
  if (ops.inputs.some((p) => pathHitsProtected(p, seg.cwd, ctx, false))) return 'read';

  const findRoots = findReadRoots(seg);
  if (findRoots) return findRoots.some((p) => pathHitsProtected(p, seg.cwd, ctx, true)) ? 'read' : false;

  const inline = inlineCodeOf(seg);
  if (inline && inlineCodeNamesProtected(inline.code, seg.cwd, ctx)) return 'read';

  if (!checkAll) return false;
  let paths = ops.positional.map((p) => (/^(curl|https?)$/.test(word) ? p.replace(/^@/, '') : p));
  if (GREP_FAMILY.has(searchWord) || searchWord === 'git') {
    if (word !== 'git') {
      recursive =
        ALWAYS_RECURSIVE.has(word) ||
        args.some((a) => /^-[a-zA-Z]*[rR][a-zA-Z]*$/.test(a) || a === '--recursive' || a === '--dereference-recursive' || /^--directories=recurse$|^-d\s*recurse$/.test(a)) ||
        (word === 'findstr' && args.some((a) => /^\/s$/i.test(a)));
    }
    if (!ops.patternViaFlag && !(word === 'rg' && args.includes('--files'))) paths = paths.slice(1);
    if (recursive && paths.length === 0) paths = ['.'];
  }
  if (!recursive) {
    if (COPY_WORDS.has(word) && paths.length >= 2) {
      // Sources are read; the last operand is only written to (Task 9: a distinct deny reason).
      if (paths.slice(0, -1).some((p) => pathHitsProtected(p, seg.cwd, ctx, false))) return 'read';
      return pathHitsProtected(paths[paths.length - 1]!, seg.cwd, ctx, false) ? 'overwrite' : false;
    }
    return paths.some((p) => pathHitsProtected(p, seg.cwd, ctx, false)) ? 'read' : false;
  }
  const globs = [...(ops.flagValues.get('-g') ?? []), ...(ops.flagValues.get('--glob') ?? []), ...(ops.flagValues.get('--iglob') ?? []), ...(ops.flagValues.get('--include') ?? [])];
  const types = [...(ops.flagValues.get('-t') ?? []), ...(ops.flagValues.get('--type') ?? [])];
  const hit = paths.some((p) => {
    if (!pathHitsProtected(p, seg.cwd, ctx, true)) return false;
    if (hasWildcard(p)) return true;
    const resolved = resolveArgPath(p, seg.cwd, ctx);
    // The path itself is (inside) a protected target — filters don't matter.
    if (isProtectedPath(resolved, ctx, overlapNested)) return true;
    return filtersAdmitProtected(resolved, globs, types, ctx);
  });
  return hit ? 'read' : false;
}

// =================================================================================================
// Rule 4: reading an OS credential store directly.
// =================================================================================================

const CREDENTIAL_STORE_PATTERNS: RegExp[] = [
  /security\s+find-generic-password/i,
  /security\s+find-internet-password/i,
  /security\s+dump-keychain/i,
  /cmdkey(\.exe)?\s+\/list/i,
  /Get-StoredCredential/i,
  /secret-tool\s+lookup/i,
  /secret-tool\s+search/i,
  /keyring\s+get/i,
  /@napi-rs\/keyring/i,
];

function readsCredentialStore(command: string, segments: Segment[]): boolean {
  const texts = [command, ...segments.map((s) => s.raw)];
  if (texts.some((t) => CREDENTIAL_STORE_PATTERNS.some((re) => re.test(t)))) return true;
  return segments.some((s) => {
    const inline = inlineCodeOf(s);
    return inline !== null && /\bkeyring\b/i.test(inline.code);
  });
}

// =================================================================================================
// Rule 5: direct HTTP against a configured pidb server.
// =================================================================================================

const NETWORK_WORDS = new Set([
  'curl', 'wget', 'wget2', 'invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm', 'http', 'https',
  'xh', 'xhs', 'httpie', 'aria2c', 'lwp-request', 'fetch',
]); // prettier-ignore

function hostAliases(hostname: string): string[] {
  const lower = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (lower === 'localhost' || lower === '127.0.0.1' || lower === '::1') return ['localhost', '127.0.0.1', '::1'];
  return [lower];
}

/** Substring match on `host[:port]` or `[host]:port` (IPv6 URL bracket form), with or without a scheme. */
function commandMentionsUrl(command: string, url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return command.toLowerCase().includes(url.toLowerCase());
  }
  const portSuffix = parsed.port ? `:${parsed.port}` : '';
  const lowerCmd = command.toLowerCase();
  return hostAliases(parsed.hostname).some((host) => lowerCmd.includes(`${host}${portSuffix}`) || lowerCmd.includes(`[${host}]${portSuffix}`));
}

function targetsConfiguredServer(command: string, segments: Segment[], ctx: GuardContext): boolean {
  if (!segments.some((s) => NETWORK_WORDS.has(s.word ?? ''))) return false;
  return ctx.serverUrls.some((url) => commandMentionsUrl(command, url));
}

// =================================================================================================

/**
 * Escaping agent mode (spec §2.3): a user-installed `pidb` runs in agent mode because Claude Code sets
 * `CLAUDECODE=1`; `PIDB_ALLOW_USER_MODE=1` is the *user's* opt-out, and clearing/overriding
 * `CLAUDECODE` would defeat it too — neither is for the agent.
 */
const AGENT_MODE_ESCAPE_RE = /\bPIDB_ALLOW_USER_MODE\b|\bCLAUDECODE\s*=|(?:\s-u\s*|--unset[=\s]\s*|\bunset\s+(?:-v\s+)?)CLAUDECODE\b|env:CLAUDECODE\b/i;

function guardBashCommand(command: string, cwd: string, ctx: GuardContext): GuardDecision {
  if (AGENT_MODE_ESCAPE_RE.test(command)) {
    return deny('switching pidb out of agent mode (PIDB_ALLOW_USER_MODE / CLAUDECODE) is for the user only — ask the user to run this themselves.');
  }
  const segments = expandSegments(command, cwd, ctx);
  if (runsDisabledPidbCommand(segments)) {
    return deny(
      'pidb login/token/secret get/--print are not available to the Claude agent — ask the user to run this themselves, or use `pidb connect`/`pidb secret exec` instead.',
    );
  }
  if (segments.some((s) => s.inExec && segmentPrintsEnvironment(s))) {
    return deny(
      'this looks like it would print the environment inside `pidb secret exec`, which would leak the substituted secret — use the value only inside the invoked program, e.g. `pidb secret exec <target> "<name>" -- npm test`.',
    );
  }
  const access = segments.map((s) => segmentReadsProtected(s, ctx));
  if (!access.includes('read') && access.includes('overwrite')) {
    return deny(
      'this would overwrite a pidb-written secret file (produced by `pidb secret write|env`) — regenerate it with `pidb secret write|env --out <file>` instead, or write to a different path.',
    );
  }
  if (access.includes('read')) {
    return deny(
      "this command reads pidb's protected data (the plugin data dir, its config, or a file `pidb secret write|env` produced) — use the pidb CLI/MCP tools instead of reading it directly.",
    );
  }
  if (readsCredentialStore(command, segments)) {
    return deny('reading the OS credential store directly is not available to the agent — use `pidb connect` (or the MCP tools) instead.');
  }
  if (targetsConfiguredServer(command, segments, ctx)) {
    return deny('direct HTTP calls to the pidb server are not available to the agent — use the pidb MCP tools or CLI instead.');
  }
  return ALLOW;
}

// =================================================================================================
// Structured tool inputs (Read/Grep/Glob/Edit/Write/NotebookEdit/LS, `mcp__*`).
// =================================================================================================

const PATH_KEYS = ['file_path', 'path', 'notebook_path'];
const PROTECTED_PATH_REASON =
  "this path is inside pidb's protected data (the plugin data dir, its config, or a file `pidb secret write|env` produced) — use the pidb CLI/MCP tools instead of reading it directly.";

function collectStrings(value: unknown, depth = 0): string[] {
  if (depth > 8) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap((v) => collectStrings(v, depth + 1));
  if (value && typeof value === 'object') return Object.values(value).flatMap((v) => collectStrings(v, depth + 1));
  return [];
}

/** A whitespace-free string (≤260 chars) that could name a path; never `''`/`.` (Fix round 4). */
function couldBePath(s: string): boolean {
  return s !== '' && s !== '.' && s.length <= 260 && !/\s/.test(s);
}

/** Every whitespace-free string value, resolved against cwd, at the equal-or-nested direction. */
function guardMcp(toolInput: HookToolInput, cwd: string, ctx: GuardContext): GuardDecision {
  for (const raw of collectStrings(toolInput)) {
    if (!couldBePath(raw)) continue;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) continue; // a URL, not a path
    if (isProtectedPath(resolveArgPath(raw, cwd, ctx), ctx, overlapNested)) return deny(PROTECTED_PATH_REASON);
  }
  return ALLOW;
}

function guardGrepTool(toolInput: HookToolInput, cwd: string, ctx: GuardContext): GuardDecision {
  const root = typeof toolInput.path === 'string' && toolInput.path !== '' ? resolveArgPath(toolInput.path, cwd, ctx) : cwd;
  if (isProtectedPath(root, ctx, overlapNested)) return deny(PROTECTED_PATH_REASON);
  if (!isProtectedPath(root, ctx, overlapEither)) return ALLOW;
  const globs = typeof toolInput.glob === 'string' && toolInput.glob ? toolInput.glob.split(/[\s,]+/).filter(Boolean) : [];
  const types = typeof toolInput.type === 'string' && toolInput.type ? [toolInput.type] : [];
  const hits = admittedProtected(root, globs, types, ctx);
  if (hits.length === 0) return ALLOW;
  return deny(
    `this search would reach a file \`pidb secret write|env\` produced (${hits.slice(0, 5).join(', ')}) — ` +
      'pass a `path` that does not contain it, or a `glob`/`type` that excludes it (e.g. `glob: "*.ts"`), and never read that file.',
  );
}

function guardPathArgs(toolName: string, toolInput: HookToolInput, cwd: string, ctx: GuardContext): GuardDecision {
  if (toolName.startsWith('mcp__')) return guardMcp(toolInput, cwd, ctx);
  if (toolName === 'Grep') return guardGrepTool(toolInput, cwd, ctx);
  for (const key of PATH_KEYS) {
    const v = toolInput[key];
    if (typeof v === 'string' && v !== '' && isProtectedPath(resolveArgPath(v, cwd, ctx), ctx, overlapNested)) return deny(PROTECTED_PATH_REASON);
  }
  if (toolName === 'Glob' && typeof toolInput.pattern === 'string') {
    const base = typeof toolInput.path === 'string' ? resolveArgPath(toolInput.path, cwd, ctx) : cwd;
    if (isProtectedPath(resolveArgPath(toolInput.pattern, base, ctx), ctx, overlapNested)) return deny(PROTECTED_PATH_REASON);
  }
  return ALLOW;
}

/**
 * Decides whether to deny a PreToolUse call (spec §3.1). `input.tool_name === 'Bash'` runs the
 * command-text rules (1/2/3-bash/4/5); everything else (Read/Grep/Glob/Edit/Write/NotebookEdit/`LS`,
 * and any `mcp__*` tool) runs the path-argument check (rule 3).
 */
export function guardDecision(input: HookInput, ctx: GuardContext): GuardDecision {
  const toolName = input.tool_name ?? '';
  const toolInput: HookToolInput = input.tool_input ?? {};
  if (toolName === 'Bash') {
    const command = typeof toolInput.command === 'string' ? toolInput.command : '';
    return guardBashCommand(command, input.cwd, ctx);
  }
  return guardPathArgs(toolName, toolInput, input.cwd, ctx);
}
