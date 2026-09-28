// PreToolUse guard (spec §3.1): a pure, heuristic decision function over a single tool-call. Never
// touches the network or the filesystem itself — everything it needs (the plugin data dir, the
// `written.json` paths, the configured server urls, the home dir, the platform) is handed in as
// `GuardContext` by the dispatcher (`index.ts`), so this file is trivially table-testable on any host
// regardless of the actual OS it runs on.
//
// Fix round 2: moved from whole-string regex to a small SEGMENT model — (a) recursively unwrap
// `sh|bash|zsh|dash -c '<script>'`, `powershell|pwsh -c|-Command "<script>"`, `cmd /c <script>`;
// (b) split scripts into segments on newlines/`;`/`&&`/`||`/`|`/`&`/`(`/`)`/`$(...)`/backticks
// (quote-aware, a simple state machine — not a full shell parser); (c) per segment, the "command
// word" is the first token after skipping `env VAR=x`/`sudo`/`npx`/`exec` prefixes and a leading `!`.
// This is what lets rule 1 check only *pidb's own args* (not a quoted commit message, not the child
// command after ` -- `), rule 2 check only the *actual* env-dumping shape (not any `$PIDB_*` mention),
// and rule 3 apply its "directory that contains a protected file" check only to genuinely recursive
// search commands.
//
// This is defense-in-depth, not a security boundary (spec §6) — every rule is intentionally biased
// toward false positives over false negatives, balanced against a fixed set of things that must never
// be blocked (see the test table for the full list of required allows).
import { posix as posixPath, win32 as win32Path } from 'node:path';

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

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// =================================================================================================
// Segment model
// =================================================================================================

/**
 * Quote-aware tokenizer: splits on whitespace outside quotes, but a `'...'`/`"..."` span (however
 * many words it contains) becomes exactly ONE token with the quotes stripped — this is what lets
 * `pidb secret exec acme "get token" -- npm test` see `"get token"` as a single token (never
 * mistakable for the literal word `get`), and lets `sed -i ''` see an explicit empty-string token
 * (never mistakable for "no token here"). Every token also has trailing unquoted `;`/`|`/`&`
 * stripped, per Fix round 2's segment model (defensive — `splitTopLevel` already turns those into
 * segment boundaries, but a caller may tokenize unsegmented text directly, e.g. `mentionsReadTool`).
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let started = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i]!;
    if (ch === "'" || ch === '"') {
      const quote = ch;
      let j = i + 1;
      while (j < n && text[j] !== quote) j++;
      current += text.slice(i + 1, j);
      started = true;
      i = j + 1;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) {
        tokens.push(current);
        current = '';
        started = false;
      }
      i++;
      continue;
    }
    current += ch;
    started = true;
    i++;
  }
  if (started) tokens.push(current);
  return tokens.map((t) => t.replace(/[;|&]+$/, ''));
}

/**
 * Quote-aware top-level split on newlines/`;`/`&`/`|`/`(`/`)`, plus recursing into `$(...)` and
 * `` `...` `` command substitution (their *contents* become additional top-level segments too — this
 * is what lets `echo $(pidb secret get acme DB)` see `pidb secret get acme DB` as its own segment).
 * Not a full shell parser: doesn't distinguish `&&`/`||` from a bare `&`/`|` (both are just boundaries
 * here, which only makes segmentation *finer*, never coarser — never a false negative from that).
 */
function splitTopLevel(text: string): string[] {
  const segments: string[] = [];
  let current = '';
  let i = 0;
  const n = text.length;
  const flush = (): void => {
    const t = current.trim();
    if (t) segments.push(t);
    current = '';
  };
  while (i < n) {
    const ch = text[i]!;
    if (ch === "'" || ch === '"') {
      const quote = ch;
      let j = i + 1;
      while (j < n && text[j] !== quote) j++;
      current += text.slice(i, Math.min(j + 1, n));
      i = j + 1;
      continue;
    }
    if (ch === '`') {
      let j = i + 1;
      while (j < n && text[j] !== '`') j++;
      segments.push(...splitTopLevel(text.slice(i + 1, j)));
      i = j + 1;
      continue;
    }
    if (ch === '$' && text[i + 1] === '(') {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (text[j] === '(') depth++;
        else if (text[j] === ')') depth--;
        j++;
      }
      segments.push(...splitTopLevel(text.slice(i + 2, Math.max(j - 1, i + 2))));
      i = j;
      continue;
    }
    if (ch === '(' || ch === ')' || ch === '\n' || ch === ';' || ch === '&' || ch === '|') {
      flush();
      i++;
      continue;
    }
    current += ch;
    i++;
  }
  flush();
  return segments;
}

const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const SKIP_PREFIX_WORDS = new Set(['sudo', 'npx', 'exec']);

/**
 * The segment's "command word": the first token after skipping a leading `!`, `sudo`/`npx`/`exec`
 * prefixes, and plain `NAME=value` assignments. A leading `env` is special: `env FOO=bar realcmd`
 * skips *through* the assignment(s) to `realcmd` (never printing anything), but a bare `env` (nothing
 * after it, or only assignments with nothing following) resolves to `env` itself — it really is an
 * env-dump either way.
 */
function commandWordInfo(tokens: string[]): { word: string | null; index: number } {
  let i = 0;
  if (tokens[0] === '!') i++;
  while (i < tokens.length && SKIP_PREFIX_WORDS.has((tokens[i] ?? '').toLowerCase())) i++;
  if ((tokens[i] ?? '').toLowerCase() === 'env') {
    let j = i + 1;
    while (j < tokens.length && ENV_ASSIGNMENT_RE.test(tokens[j] ?? '')) j++;
    if (j > i + 1 && j < tokens.length) {
      let k = j;
      while (k < tokens.length && SKIP_PREFIX_WORDS.has((tokens[k] ?? '').toLowerCase())) k++;
      return { word: tokens[k] ?? null, index: k };
    }
    return { word: 'env', index: i };
  }
  while (i < tokens.length && ENV_ASSIGNMENT_RE.test(tokens[i] ?? '')) i++;
  return { word: tokens[i] ?? null, index: i };
}

interface Segment {
  raw: string;
  tokens: string[];
  commandWord: string | null;
  commandIndex: number;
}

function parseSegment(raw: string): Segment {
  const trimmed = raw.trim();
  const tokens = tokenize(trimmed);
  const { word, index } = commandWordInfo(tokens);
  return { raw: trimmed, tokens, commandWord: word, commandIndex: index };
}

const SHELL_C_RE = /^(?:sudo\s+|npx\s+|exec\s+)*(sh|bash|zsh|dash|powershell(?:\.exe)?|pwsh(?:\.exe)?)\b([\s\S]*)$/i;
const CMD_C_RE = /^(?:sudo\s+)?cmd(?:\.exe)?\s+\/c\s+([\s\S]+)$/i;
const SHELL_FLAG_RE = /(?:^|\s)(-c|-command|-encodedcommand)(?=\s|$)/i;

function extractArgText(text: string): string | null {
  let i = 0;
  while (i < text.length && /\s/.test(text[i]!)) i++;
  if (i >= text.length) return null;
  const quote = text[i];
  if (quote === '"' || quote === "'") {
    const end = text.lastIndexOf(quote);
    if (end > i) return text.slice(i + 1, end);
    return text.slice(i + 1);
  }
  const rest = text.slice(i).trim();
  return rest || null;
}

/** `sh|bash|zsh|dash|powershell|pwsh -c|-Command|-EncodedCommand <script>`, or `cmd /c <script>`. */
function tryUnwrapInterpreter(raw: string): string | null {
  const trimmed = raw.trim();
  const m = SHELL_C_RE.exec(trimmed);
  if (m) {
    const fm = SHELL_FLAG_RE.exec(m[2] ?? '');
    if (fm && fm.index !== undefined) return extractArgText((m[2] ?? '').slice(fm.index + fm[0].length));
  }
  const cm = CMD_C_RE.exec(trimmed);
  if (cm) return (cm[1] ?? '').trim() || null;
  return null;
}

/** Every segment in `text`, recursively unwrapping any interpreter invocation found along the way. */
function allSegments(text: string, depth = 0): Segment[] {
  if (depth > 6) return [];
  const out: Segment[] = [];
  for (const raw of splitTopLevel(text)) {
    out.push(parseSegment(raw));
    const inner = tryUnwrapInterpreter(raw);
    if (inner && inner.trim() && inner.trim() !== raw.trim()) out.push(...allSegments(inner, depth + 1));
  }
  return out;
}

function hasAdjacentTokens(tokens: string[], a: string, b: string): boolean {
  for (let i = 0; i < tokens.length - 1; i++) {
    if (tokens[i]?.toLowerCase() === a.toLowerCase() && tokens[i + 1]?.toLowerCase() === b.toLowerCase()) return true;
  }
  return false;
}

// =================================================================================================
// Rule 1: `pidb` + a disabled subcommand — only pidb's OWN args (before its own first ` -- `).
// =================================================================================================

function isPidbCommandWord(word: string | null): boolean {
  const w = (word ?? '').toLowerCase();
  return w === 'pidb' || w === 'pidb.cmd' || w === 'pidb.exe';
}

/**
 * Rule 1 (spec §3.1, Fix round 2 N3): finds every segment (after unwrapping `sh -c`/newlines/`(...)`/
 * `$(...)`) whose command word is `pidb`, takes only the tokens between it and that segment's own
 * first *exact* `--` token (never anything after — that's the invoked child command, not pidb's own
 * args), and checks *that* slice for `login`/`token` as the immediate next word, or `secret ... get`/
 * `secret ... --print`. Operating on tokens (not a whole-text regex) is what lets a multi-word quoted
 * secret name (`"get token"`, `"API token"`) survive as one token that's never mistaken for the bare
 * word `get`/`token`.
 */
function mentionsDisabledCommand(command: string): boolean {
  for (const seg of allSegments(command)) {
    if (!isPidbCommandWord(seg.commandWord)) continue;
    const after = seg.tokens.slice(seg.commandIndex + 1);
    const dashDashIdx = after.findIndex((t) => t === '--');
    const ownArgs = dashDashIdx === -1 ? after : after.slice(0, dashDashIdx);
    const next = (ownArgs[0] ?? '').toLowerCase();
    if (next === 'login' || next === 'token') return true;
    if (next === 'secret') {
      const rest = ownArgs.slice(1);
      if (rest.some((t) => t.toLowerCase() === 'get')) return true;
      if (rest.some((t) => t === '--print')) return true;
    }
  }
  return false;
}

// =================================================================================================
// Rule 2: `pidb secret exec`'s child (after the first ` -- `) printing the environment.
// =================================================================================================

const PIDB_VAR_REF = /\$\{?PIDB_[A-Za-z0-9_]*\}?|%PIDB_[A-Za-z0-9_]*%|\$env:PIDB_[A-Za-z0-9_]*/i;
const PRINT_VERB_WORDS = new Set(['echo', 'printf', 'print', 'write-output', 'write-host', 'echo.', 'cat', 'type']);
const DOTNET_GETENV_RE = /\[Environment\]::GetEnvironmentVariables?\b/i;
const PROC_ENVIRON_RE = /\/proc\/[^/\s]+\/environ\b/i;
const GET_CHILDITEM_ENV_RE = /\b(Get-ChildItem|gci|dir|ls)\s+env:/i;
// Not `\b` before the flag group — a hyphen is a non-word char, so `\b-` can never match right after
// a preceding space (both sides would be non-word, i.e. no boundary transition at all). `\s` instead.
const NODE_LIKE_INLINE_RE = /\b(?:node|deno|bun)\b[^\n]*?\s(?:-pe|-e|-p|--eval|--print)\b/i;
const INTERPRETER_INLINE_RE = new RegExp(
  `${NODE_LIKE_INLINE_RE.source}|\\bpython\\d*(?:\\.\\d+)?\\s+-c\\b|\\bperl\\s+-e\\b|\\bruby\\s+-e\\b|\\bawk\\b`,
  'i',
);
const ENV_ACCESS_IN_CODE_RE = /(process\.env|os\.environ|os\.getenv|environ\[|ENV\[|ENV\{|ENVIRON\[)/;

function mentionsSecretExec(command: string): boolean {
  return /\bpidb(?:\.exe|\.cmd)?\s+secret\s+exec\b/i.test(command);
}

/** The text after the *first* ` -- ` (the actual invoked child command), or `null` if there is none. */
function childCommandText(command: string): string | null {
  const idx = command.indexOf(' -- ');
  if (idx === -1) return null;
  return command.slice(idx + 4);
}

/** `set` bare, `set PIDB...` — a segment boundary already isolates `set | ...` into its own bare `set`. */
function looksLikeBareSetPrint(tokens: string[]): boolean {
  const idx = tokens.findIndex((t) => t.toLowerCase() === 'set');
  if (idx === -1) return false;
  const next = tokens[idx + 1];
  if (next === undefined) return true;
  if (/^pidb/i.test(next)) return true;
  return false;
}

function isEnvDumpCommandWord(seg: Segment): boolean {
  const word = (seg.commandWord ?? '').toLowerCase();
  const next = (seg.tokens[seg.commandIndex + 1] ?? '').toLowerCase();
  if (word === 'env' || word === 'printenv' || word === 'typeset') return true;
  if (word === 'export' && next === '-p') return true;
  if (word === 'declare' && (next === '-p' || next === '-x')) return true;
  if (word === 'compgen' && (next === '-v' || next === '-e')) return true;
  return false;
}

function segmentPrintsEnvironment(seg: Segment): boolean {
  if (/^\$env:PIDB_[A-Za-z0-9_]*$/i.test(seg.raw)) return true; // bare PowerShell expression statement
  if (PRINT_VERB_WORDS.has((seg.commandWord ?? '').toLowerCase()) && PIDB_VAR_REF.test(seg.raw)) return true;
  if (DOTNET_GETENV_RE.test(seg.raw)) return true;
  if (PROC_ENVIRON_RE.test(seg.raw)) return true;
  if (INTERPRETER_INLINE_RE.test(seg.raw) && ENV_ACCESS_IN_CODE_RE.test(seg.raw)) return true;
  if (GET_CHILDITEM_ENV_RE.test(seg.raw)) return true;
  if (looksLikeBareSetPrint(seg.tokens)) return true;
  if (isEnvDumpCommandWord(seg)) return true;
  return false;
}

/** Whether `childText` (already scoped to after `pidb secret exec ... -- `) looks like it would print the environment. */
function printsEnvironment(childText: string): boolean {
  const text = childText.trim();
  if (!text) return false;
  return allSegments(text).some(segmentPrintsEnvironment);
}

// =================================================================================================
// Rule 3: protected paths (plugin data dir, `~/.config/pidb`, `%APPDATA%\pidb`, `written.json`).
// =================================================================================================

function pathModFor(platform: NodeJS.Platform) {
  return platform === 'win32' ? win32Path : posixPath;
}

function appDataOf(ctx: GuardContext): string {
  if (ctx.appData) return ctx.appData;
  const pm = pathModFor(ctx.platform);
  return pm.join(ctx.home, 'AppData', 'Roaming');
}

function protectedRoots(ctx: GuardContext): string[] {
  const pm = pathModFor(ctx.platform);
  return [ctx.dataDir, pm.join(ctx.home, '.config', 'pidb'), pm.join(appDataOf(ctx), 'pidb')];
}

function normalizeForCompare(p: string, platform: NodeJS.Platform): string {
  const s = p.replace(/\\/g, '/');
  return platform === 'win32' ? s.toLowerCase() : s;
}

/** Equal, or nested inside `b` — the default direction, safe for any tool (Fix round 2 N1). */
function overlapNested(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`);
}

/** `overlapNested` plus "`b` is nested inside `a`" (`a` is an ancestor of `b`) — recursive-search only. */
function overlapEither(a: string, b: string): boolean {
  return overlapNested(a, b) || b.startsWith(`${a}/`);
}

type Overlap = (a: string, b: string) => boolean;

function isProtectedPath(resolved: string, ctx: GuardContext, overlap: Overlap): boolean {
  const pm = pathModFor(ctx.platform);
  const target = normalizeForCompare(resolved, ctx.platform);
  for (const root of protectedRoots(ctx)) {
    if (overlap(target, normalizeForCompare(pm.resolve(root), ctx.platform))) return true;
  }
  for (const w of ctx.written) {
    if (overlap(target, normalizeForCompare(pm.resolve(w), ctx.platform))) return true;
  }
  return false;
}

function expandPlaceholders(text: string, ctx: GuardContext): string {
  const pm = pathModFor(ctx.platform);
  const appData = appDataOf(ctx);
  const xdgConfigHome = pm.join(ctx.home, '.config');
  return text
    .replace(/(^|[\s"'([{=:])~(?=[\\/]|$)/g, `$1${ctx.home}`)
    .replace(/%APPDATA%/gi, appData)
    .replace(/\$env:APPDATA/gi, appData)
    .replace(/%USERPROFILE%/gi, ctx.home)
    .replace(/\$env:USERPROFILE/gi, ctx.home)
    .replace(/\$\{HOME\}/g, ctx.home)
    .replace(/\$HOME\b/g, ctx.home)
    .replace(/\$\{XDG_CONFIG_HOME\}/g, xdgConfigHome)
    .replace(/\$XDG_CONFIG_HOME\b/g, xdgConfigHome);
}

function resolveArgPathFrom(raw: string, baseDir: string, ctx: GuardContext): string {
  const pm = pathModFor(ctx.platform);
  const expanded = expandPlaceholders(raw, ctx);
  return pm.isAbsolute(expanded) ? pm.resolve(expanded) : pm.resolve(baseDir, expanded);
}

function resolveArgPath(raw: string, cwd: string, ctx: GuardContext): string {
  return resolveArgPathFrom(raw, cwd, ctx);
}

const READ_TOOL_WORDS = [
  'cat', 'type', 'get-content', 'less', 'more', 'bat', 'head', 'tail', 'grep', 'rg', 'ag', 'ack',
  'sed', 'awk', 'cp', 'mv', 'base64', 'xxd', 'od', 'strings', 'vim', 'vi', 'nano', 'jq', 'source',
  'tar', 'zip',
]; // prettier-ignore
const READ_TOOL_WORDS_SET = new Set(READ_TOOL_WORDS);
const READ_TOOL_RE = new RegExp(`\\b(${READ_TOOL_WORDS.map(escapeRegExp).join('|')})\\b`, 'i');

function mentionsReadTool(command: string): boolean {
  if (READ_TOOL_RE.test(command)) return true;
  const tokens = tokenize(command);
  if (tokens[0] === '.') return true; // POSIX `. file` (source)
  if (hasAdjacentTokens(tokens, 'git', 'add')) return true;
  if (hasAdjacentTokens(tokens, 'git', 'grep')) return true;
  const lower = tokens.map((t) => t.toLowerCase());
  if (lower.includes('find') && (tokens.includes('-exec') || lower.includes('xargs')) && lower.some((t) => READ_TOOL_WORDS_SET.has(t))) {
    return true;
  }
  return false;
}

/** Whether this *segment* is a genuinely recursive content search (Fix round 2 N1's exact list). */
function isRecursiveSearchSegment(tokens: string[]): boolean {
  const lower = tokens.map((t) => t.toLowerCase());
  if (lower.includes('grep') && tokens.some((t) => /^-[a-zA-Z]*[rR][a-zA-Z]*$/.test(t) || t.toLowerCase() === '--recursive')) return true;
  if (lower.some((t) => t === 'rg' || t === 'ag' || t === 'ack')) return true;
  if (hasAdjacentTokens(tokens, 'git', 'grep')) return true;
  if (lower.includes('find') && (tokens.includes('-exec') || lower.includes('xargs')) && lower.some((t) => READ_TOOL_WORDS_SET.has(t))) return true;
  return false;
}

/**
 * `find ... | xargs <read-cmd>` splits `find` and `xargs` into two different *segments* (the pipe is
 * a segment boundary) — neither segment alone contains both words, so `isRecursiveSearchSegment`
 * (which only ever looks within one segment) can't see this shape. Checked once across the whole
 * command instead, and OR'd into every segment's own recursive-ness below.
 */
function commandHasFindPipedToXargsRead(command: string): boolean {
  const tokens = tokenize(command);
  const lower = tokens.map((t) => t.toLowerCase());
  return lower.includes('find') && lower.includes('xargs') && lower.some((t) => READ_TOOL_WORDS_SET.has(t));
}

const EXEMPT_TOKENS = new Set(['.', '..', '', '~']);

/**
 * `cat .env*` — a glob token whose non-wildcard prefix matches a written file's basename in the same
 * (resolved) directory. A plain string-overlap check can't see this (`.env*` isn't textually `.env`),
 * so this checks structurally: split the prefix into a directory part and a basename-prefix part,
 * resolve the directory, and compare against every written file living in that same directory.
 */
function globPrefixMatchesWritten(token: string, effectiveCwd: string, ctx: GuardContext): boolean {
  const wildcardIdx = token.search(/[*?[]/);
  if (wildcardIdx === -1) return false;
  const prefix = token.slice(0, wildcardIdx);
  const pm = pathModFor(ctx.platform);
  const lastSep = Math.max(prefix.lastIndexOf('/'), prefix.lastIndexOf('\\'));
  const dirPart = lastSep === -1 ? '' : prefix.slice(0, lastSep);
  const basePrefix = lastSep === -1 ? prefix : prefix.slice(lastSep + 1);
  if (!basePrefix) return false;
  const resolvedDir = normalizeForCompare(resolveArgPathFrom(dirPart || '.', effectiveCwd, ctx), ctx.platform);
  for (const w of ctx.written) {
    const wResolved = pm.resolve(w);
    const wDir = normalizeForCompare(pm.dirname(wResolved), ctx.platform);
    if (wDir !== resolvedDir) continue;
    const wBase = pm.basename(wResolved);
    if (wBase.toLowerCase().startsWith(basePrefix.toLowerCase())) return true;
  }
  return false;
}

/**
 * Rule 3's Bash-side check (Fix round 2 N1/N4): walks top-level segments (tracking `cd <dir>` so
 * later segments resolve against the right effective cwd), and for each non-`cd` segment resolves
 * every non-flag token relative to that cwd. `.`/`..`/`''`/`~` are skipped entirely *unless* the
 * segment is a genuinely recursive search (rule 3's ancestor-direction is reserved for those, per
 * N1) — in which case the segment's own effective cwd is also checked (covers `grep -r X` with no
 * explicit directory, which implicitly means "search here").
 */
function guardBashProtectedPaths(command: string, cwd: string, ctx: GuardContext): boolean {
  if (!mentionsReadTool(command)) return false;
  const expanded = expandPlaceholders(command, ctx);
  const pm = pathModFor(ctx.platform);
  const findPipedToXargs = commandHasFindPipedToXargsRead(expanded);
  let effectiveCwd = cwd;
  for (const rawSeg of splitTopLevel(expanded)) {
    const tokens = tokenize(rawSeg);
    if ((tokens[0] ?? '').toLowerCase() === 'cd' && tokens[1]) {
      effectiveCwd = resolveArgPathFrom(tokens[1], effectiveCwd, ctx);
      continue;
    }
    const recursive = isRecursiveSearchSegment(tokens) || findPipedToXargs;
    const overlap: Overlap = recursive ? overlapEither : overlapNested;
    const candidates = recursive ? [...tokens, '.'] : tokens;
    for (const raw of candidates) {
      if (raw.startsWith('-')) continue;
      if (!recursive && EXEMPT_TOKENS.has(raw)) continue;
      if (globPrefixMatchesWritten(raw, effectiveCwd, ctx)) return true;
      const resolved = normalizeForCompare(resolveArgPathFrom(raw, effectiveCwd, ctx), ctx.platform);
      for (const root of protectedRoots(ctx)) {
        if (overlap(resolved, normalizeForCompare(pm.resolve(root), ctx.platform))) return true;
      }
      for (const w of ctx.written) {
        if (overlap(resolved, normalizeForCompare(pm.resolve(w), ctx.platform))) return true;
      }
    }
  }
  return false;
}

function collectStringValues(value: unknown, depth = 0): string[] {
  if (depth > 8) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap((v) => collectStringValues(v, depth + 1));
  if (value && typeof value === 'object') return Object.values(value).flatMap((v) => collectStringValues(v, depth + 1));
  return [];
}

/** "Looks like a path" (Fix round 2 N1, for `mcp__*`'s string scan): never a bare `''`/`.`. */
function looksLikePathArg(s: string): boolean {
  if (s === '' || s === '.') return false;
  if (s.includes('/') || s.includes('\\')) return true;
  if (s.startsWith('~')) return true;
  return false;
}

// =================================================================================================
// Rule 4: reading an OS credential store directly.
// =================================================================================================

const CREDENTIAL_STORE_PATTERNS: RegExp[] = [
  /security\s+find-generic-password/i,
  /security\s+find-internet-password/i,
  /security\s+dump-keychain/i,
  /cmdkey\s+\/list/i,
  /Get-StoredCredential/i,
  /secret-tool\s+lookup/i,
  /secret-tool\s+search/i,
  /keyring\s+get/i,
  /@napi-rs\/keyring/i,
];

function mentionsKeyringInInlineCode(command: string): boolean {
  return /\b(node\s+-[ep]|python\d*(?:\.\d+)?\s+-c)\b/i.test(command) && /\bkeyring\b/i.test(command);
}

function readsCredentialStore(command: string): boolean {
  return CREDENTIAL_STORE_PATTERNS.some((re) => re.test(command)) || mentionsKeyringInInlineCode(command);
}

// =================================================================================================
// Rule 5: direct HTTP against a configured pidb server.
// =================================================================================================

const NETWORK_TOOL_RE = /\b(curl|wget|Invoke-WebRequest|iwr|irm)\b/i;

function hostAliases(hostname: string): string[] {
  const lower = hostname.toLowerCase();
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

function targetsConfiguredServer(command: string, ctx: GuardContext): boolean {
  if (!NETWORK_TOOL_RE.test(command)) return false;
  return ctx.serverUrls.some((url) => commandMentionsUrl(command, url));
}

// =================================================================================================

function guardBashCommand(command: string, cwd: string, ctx: GuardContext): GuardDecision {
  if (mentionsDisabledCommand(command)) {
    return deny(
      'pidb login/token/secret get/--print are not available to the Claude agent — ask the user to run this themselves, or use `pidb connect`/`pidb secret exec` instead.',
    );
  }
  if (mentionsSecretExec(command)) {
    const child = childCommandText(command);
    if (child !== null && printsEnvironment(child)) {
      return deny(
        'this looks like it would print the environment inside `pidb secret exec`, which would leak the substituted secret — use the value only inside the invoked program, e.g. `pidb secret exec <target> "<name>" -- npm test`.',
      );
    }
  }
  if (guardBashProtectedPaths(command, cwd, ctx)) {
    return deny(
      "this command reads pidb's protected data (the plugin data dir, its config, or a file `pidb secret write|env` produced) — use the pidb CLI/MCP tools instead of reading it directly.",
    );
  }
  if (readsCredentialStore(command)) {
    return deny('reading the OS credential store directly is not available to the agent — use `pidb connect` (or the MCP tools) instead.');
  }
  if (targetsConfiguredServer(command, ctx)) {
    return deny('direct HTTP calls to the pidb server are not available to the agent — use the pidb MCP tools or CLI instead.');
  }
  return ALLOW;
}

// Built-in tools are checked only on their path-designating keys — never free-text content like
// Edit's old_string/new_string. Grep's `path` uses the ancestor-inclusive direction (N1: Grep is a
// recursive content search); every other built-in stays equal-or-nested-only. `mcp__*` gets every
// path-*looking* string value, at the equal-or-nested direction only.
const PATH_KEYS = ['file_path', 'path', 'notebook_path'];
const PROTECTED_PATH_REASON =
  "this path is inside pidb's protected data (the plugin data dir, its config, or a file `pidb secret write|env` produced) — use the pidb CLI/MCP tools instead of reading it directly.";

function guardPathArgs(toolName: string, toolInput: HookToolInput, cwd: string, ctx: GuardContext): GuardDecision {
  if (toolName.startsWith('mcp__')) {
    for (const raw of collectStringValues(toolInput).filter(looksLikePathArg)) {
      if (isProtectedPath(resolveArgPath(raw, cwd, ctx), ctx, overlapNested)) return deny(PROTECTED_PATH_REASON);
    }
    return ALLOW;
  }
  const overlap: Overlap = toolName === 'Grep' ? overlapEither : overlapNested;
  for (const key of PATH_KEYS) {
    const v = toolInput[key];
    if (typeof v === 'string' && isProtectedPath(resolveArgPath(v, cwd, ctx), ctx, overlap)) return deny(PROTECTED_PATH_REASON);
  }
  if (toolName === 'Glob' && typeof toolInput.pattern === 'string') {
    const base = typeof toolInput.path === 'string' ? resolveArgPathFrom(toolInput.path, cwd, ctx) : cwd;
    if (isProtectedPath(resolveArgPathFrom(toolInput.pattern, base, ctx), ctx, overlapNested)) return deny(PROTECTED_PATH_REASON);
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
