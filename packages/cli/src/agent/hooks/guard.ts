// PreToolUse guard (spec §3.1): a pure, heuristic decision function over a single tool-call. Never
// touches the network or the filesystem itself — everything it needs (the plugin data dir, the
// `written.json` paths, the configured server urls, the home dir, the platform) is handed in as
// `GuardContext` by the dispatcher (`index.ts`), so this file is trivially table-testable on any host
// regardless of the actual OS it runs on (a POSIX CI box can still exercise the win32/cmd/PowerShell
// rules by passing `platform: 'win32'` and Windows-shaped paths).
//
// This is defense-in-depth, not a security boundary (spec §6: "the token scope + audit are the hard
// boundary") — every rule here is intentionally biased toward false positives over false negatives
// (a blocked-but-harmless command is an inconvenience; a missed leak is not), balanced against a
// fixed set of things that must never be blocked (ordinary secret-substitution usage like
// `psql "postgres://$PIDB_USER:$PIDB_PASSWORD@db/app"`, `git commit -m "fix pidb login flow"`, an
// `Edit` whose *new_string* happens to say ".env", ...).
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
  /** The plugin's own data dir (spec §2.1/§2.2) — profiles/bindings/written.json/keyring cache. */
  dataDir: string;
  /** Absolute paths written by `pidb secret write|env` this session (`written.json`, spec §2.2). */
  written: string[];
  /** Every configured profile's server url (spec §3.1's "a configured pidb server URL"). */
  serverUrls: string[];
  home: string;
  platform: NodeJS.Platform;
  /**
   * Windows `%APPDATA%` for the current user, when known (production: `env.APPDATA`). Not part of
   * the brief's literal `ctx` shape (`{dataDir, written, serverUrls, home, platform}`), but needed to
   * recognize `%APPDATA%\pidb` (spec §3.1) as a real, resolvable path rather than a bare string —
   * falls back to the conventional `<home>\AppData\Roaming` when omitted, which is exactly what a
   * real Windows session's `$env:APPDATA` resolves to for a default user profile.
   */
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

/** Whitespace-split tokens, with a matching leading/trailing quote stripped from each. */
function tokenize(text: string): string[] {
  return text
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'"))) ? t.slice(1, -1) : t));
}

// ---------------------------------------------------------------------------------------------
// Rule 1: `pidb` together with a disabled agent-mode subcommand (spec §2.3/§3.1).
// ---------------------------------------------------------------------------------------------

const PIDB_LOGIN_TOKEN_RE = /\bpidb(?:\.cmd|\.exe)?\s+(?:login|token)\b/gi;
const PIDB_SECRET_RE = /\bpidb(?:\.cmd|\.exe)?\s+secret\b/gi;
const STATEMENT_STOP_RE = /[;&|]|&&|\|\|/;

/**
 * True when the text immediately before `matchIndex` is empty (the match starts the whole command)
 * or ends with a shell statement operator (`;`, `&`, `|`, and by extension `&&`/`||` since their last
 * character is also `&`/`|`) — i.e. `pidb ...` is actually being *invoked*, not merely quoted inside
 * some other command's argument (a commit message, a string literal, ...).
 */
function isCommandPosition(command: string, matchIndex: number): boolean {
  const trimmed = command.slice(0, matchIndex).replace(/\s+$/, '');
  return trimmed === '' || /[;&|]$/.test(trimmed);
}

/**
 * Rule 1 (spec §3.1): `pidb login`/`pidb token` (anchored to an actual invocation, spec-refined —
 * Fix round 1 Important #4) or `pidb secret get`/`--print` *within a `pidb secret` invocation*
 * (scoped to the text up to the next statement operator, not the whole command). Anchoring on
 * command position is what lets `git commit -m "fix pidb login flow"` (the words "pidb login" appear
 * only inside a quoted string, never as an actual invocation) stay allowed, while
 * `echo hi && pidb login https://x` (a real, if chained, invocation) is still denied.
 */
function mentionsDisabledCommand(command: string): boolean {
  PIDB_LOGIN_TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PIDB_LOGIN_TOKEN_RE.exec(command))) {
    if (isCommandPosition(command, m.index)) return true;
  }
  PIDB_SECRET_RE.lastIndex = 0;
  while ((m = PIDB_SECRET_RE.exec(command))) {
    if (!isCommandPosition(command, m.index)) continue;
    const rest = command.slice(m.index + m[0].length);
    const stopAt = rest.search(STATEMENT_STOP_RE);
    const invocation = stopAt === -1 ? rest : rest.slice(0, stopAt);
    if (/\bget\b/i.test(invocation) || /--print\b/i.test(invocation)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// Rule 2: `pidb secret exec` whose child command prints the environment (spec §3.1, Review Focus 5,
// Fix round 1 Important #2 — scoped to the text after the *first* ` -- `, and narrowed to actual
// environment-*printing* shapes rather than any mention of a `$PIDB_*` reference at all, so normal
// substitution usage like `psql "postgres://$PIDB_USER:$PIDB_PASSWORD@db/app"` stays allowed).
// ---------------------------------------------------------------------------------------------

const PIDB_VAR_REF = /\$\{?PIDB_[A-Za-z0-9_]*\}?|%PIDB_[A-Za-z0-9_]*%|\$env:PIDB_[A-Za-z0-9_]*/i;
const PRINT_VERB_RE = /\b(echo|printf|print|Write-Output|Write-Host|cat|type|Get-Content)\b/i;
const POWERSHELL_INVOKE_RE = /\b(?:powershell(?:\.exe)?|pwsh(?:\.exe)?)\b[^\n]*?(?:-c|-command|-encodedcommand)\s+(['"])([\s\S]*?)\1/i;
const DOTNET_GETENV_RE = /\[Environment\]::GetEnvironmentVariable/i;
const PROC_ENVIRON_RE = /\/proc\/self\/environ/i;
const GET_CHILDITEM_ENV_RE = /\b(Get-ChildItem|gci|dir|ls)\s+env:/i;
const INTERPRETER_INLINE_RE = /\b(?:node\s+-[ep]|python\d*(?:\.\d+)?\s+-c|perl\s+-e|ruby\s+-e|awk)\b/i;
const ENV_ACCESS_IN_CODE_RE = /(process\.env|os\.environ|ENV\[|ENV\{|ENVIRON\[)/;
const ENV_NAME_VALUE_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

function mentionsSecretExec(command: string): boolean {
  return /\bpidb(?:\.exe|\.cmd)?\s+secret\s+exec\b/i.test(command);
}

/** The text after the *first* ` -- ` (the actual invoked child command), or `null` if there is none. */
function childCommandText(command: string): string | null {
  const idx = command.indexOf(' -- ');
  if (idx === -1) return null;
  return command.slice(idx + 4);
}

/** A bare PowerShell expression statement (`-c`/`-Command`'s whole quoted script is just the var ref) auto-prints it. */
function isBarePowerShellVarStatement(text: string): boolean {
  const m = POWERSHELL_INVOKE_RE.exec(text);
  if (!m) return false;
  const script = (m[2] ?? '').trim();
  return /^\$env:PIDB_[A-Za-z0-9_]*$/i.test(script);
}

function hasEnvCommandToken(tokens: string[]): boolean {
  const idx = tokens.findIndex((t) => t.toLowerCase() === 'env');
  if (idx === -1) return false;
  const next = tokens[idx + 1];
  // `env NAME=value cmd` (run a command with one extra env var) never prints anything.
  if (next && ENV_NAME_VALUE_RE.test(next)) return false;
  return true;
}

function hasAdjacentTokens(tokens: string[], a: string, b: string): boolean {
  for (let i = 0; i < tokens.length - 1; i++) {
    if (tokens[i]?.toLowerCase() === a.toLowerCase() && tokens[i + 1]?.toLowerCase() === b.toLowerCase()) return true;
  }
  return false;
}

/** `set` bare, `set | ...` (pipe into a filter), or `set PIDB...` — never `set -e`/`set FOO=bar`/other args. */
function looksLikeBareSetPrint(tokens: string[]): boolean {
  const idx = tokens.findIndex((t) => t.toLowerCase() === 'set');
  if (idx === -1) return false;
  const next = tokens[idx + 1];
  if (next === undefined) return true;
  if (next === '|') return true;
  if (/^pidb/i.test(next)) return true;
  return false;
}

/**
 * Whether `childText` (already scoped to after `pidb secret exec ... -- `) looks like it would print
 * the environment (spec §3.1, refined per Fix round 1 Important #2). Deliberately does *not* treat
 * every `$PIDB_*` mention as risky — only an actual print-like verb, a bare PowerShell expression
 * statement, a known env-dumping command, or interpreter inline code accessing the environment.
 */
function printsEnvironment(childText: string): boolean {
  const text = childText.trim();
  if (!text) return false;
  if (isBarePowerShellVarStatement(text)) return true;
  if (PRINT_VERB_RE.test(text) && PIDB_VAR_REF.test(text)) return true;
  if (DOTNET_GETENV_RE.test(text)) return true;
  if (PROC_ENVIRON_RE.test(text)) return true;
  if (INTERPRETER_INLINE_RE.test(text) && ENV_ACCESS_IN_CODE_RE.test(text)) return true;
  if (GET_CHILDITEM_ENV_RE.test(text)) return true;

  const tokens = tokenize(text);
  if (looksLikeBareSetPrint(tokens)) return true;
  if (hasEnvCommandToken(tokens)) return true;
  if (tokens.some((t) => t.toLowerCase() === 'printenv')) return true;
  if (hasAdjacentTokens(tokens, 'export', '-p')) return true;
  if (hasAdjacentTokens(tokens, 'declare', '-p')) return true;
  if (tokens.some((t) => t.toLowerCase() === 'typeset')) return true;
  if (hasAdjacentTokens(tokens, 'compgen', '-v')) return true;
  return false;
}

// ---------------------------------------------------------------------------------------------
// Rule 3: protected paths (plugin data dir, `~/.config/pidb`, `%APPDATA%\pidb`, `written.json`).
// ---------------------------------------------------------------------------------------------

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

/** Backslashes → forward slashes, lower-cased on win32 — a stable form for comparison. */
function normalizeForCompare(p: string, platform: NodeJS.Platform): string {
  const s = p.replace(/\\/g, '/');
  return platform === 'win32' ? s.toLowerCase() : s;
}

/** `a === b`, or `a` is nested inside `b`, or `b` is nested inside `a` (a proper path-segment boundary either way). */
function pathsOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.startsWith(`${b}/`)) return true;
  if (b.startsWith(`${a}/`)) return true;
  return false;
}

/** Structured containment check for a single resolved path against every protected root/written file. */
function isProtectedPath(resolved: string, ctx: GuardContext): boolean {
  const pm = pathModFor(ctx.platform);
  const target = normalizeForCompare(resolved, ctx.platform);
  for (const root of protectedRoots(ctx)) {
    if (pathsOverlap(target, normalizeForCompare(pm.resolve(root), ctx.platform))) return true;
  }
  for (const w of ctx.written) {
    if (pathsOverlap(target, normalizeForCompare(pm.resolve(w), ctx.platform))) return true;
  }
  return false;
}

/** Expands `~`, `%APPDATA%`/`$env:APPDATA`, `%USERPROFILE%`/`$env:USERPROFILE`, `$HOME`/`${HOME}`, `$XDG_CONFIG_HOME` mentions. */
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

/** Resolves a path-like token relative to `baseDir`, applying the same placeholder expansions. */
function resolveArgPathFrom(raw: string, baseDir: string, ctx: GuardContext): string {
  const pm = pathModFor(ctx.platform);
  const expanded = expandPlaceholders(raw, ctx);
  return pm.isAbsolute(expanded) ? pm.resolve(expanded) : pm.resolve(baseDir, expanded);
}

function resolveArgPath(raw: string, cwd: string, ctx: GuardContext): string {
  return resolveArgPathFrom(raw, cwd, ctx);
}

// Widened per Fix round 1 Minor #6: readers/dumpers/pagers/editors/search tools, archive tools that
// can exfiltrate a whole tree, and the two-token `git add` (staging a protected file for a commit).
const READ_TOOL_WORDS = [
  'cat', 'type', 'get-content', 'less', 'more', 'bat', 'head', 'tail', 'grep', 'rg', 'sed', 'awk',
  'cp', 'mv', 'base64', 'xxd', 'od', 'strings', 'vim', 'vi', 'nano', 'jq', 'source', 'tar', 'zip',
]; // prettier-ignore
const READ_TOOL_RE = new RegExp(`\\b(${READ_TOOL_WORDS.map(escapeRegExp).join('|')})\\b`, 'i');

function mentionsReadTool(command: string): boolean {
  if (READ_TOOL_RE.test(command)) return true;
  const tokens = tokenize(command);
  if (tokens[0] === '.') return true; // POSIX `. file` (source)
  return hasAdjacentTokens(tokens, 'git', 'add');
}

/**
 * Rule 3's Bash-side check (Fix round 1 Important #3): tokenizes the whole command, resolves every
 * non-flag token relative to `cwd` (also handling `./x`/`../x`), and checks each resolved path for
 * *overlap* (equal, nested inside, or an ancestor of) every protected root/written file — a proper
 * path-segment boundary either way, so `/repo/.env.example` is never confused with a written
 * `/repo/.env`, while `grep -r X .` (cwd itself is an ancestor of a written `/repo/.env`) is still
 * caught.
 */
function guardBashProtectedPaths(command: string, cwd: string, ctx: GuardContext): boolean {
  if (!mentionsReadTool(command)) return false;
  const expanded = expandPlaceholders(command, ctx);
  for (const raw of tokenize(expanded)) {
    if (raw.startsWith('-')) continue;
    const resolved = normalizeForCompare(resolveArgPathFrom(raw, cwd, ctx), ctx.platform);
    for (const root of protectedRoots(ctx)) {
      if (pathsOverlap(resolved, normalizeForCompare(pathModFor(ctx.platform).resolve(root), ctx.platform))) return true;
    }
    for (const w of ctx.written) {
      if (pathsOverlap(resolved, normalizeForCompare(pathModFor(ctx.platform).resolve(w), ctx.platform))) return true;
    }
  }
  return false;
}

/** Recursively collects every string leaf value out of an arbitrary (tool_input-shaped) value. */
function collectStringValues(value: unknown, depth = 0): string[] {
  if (depth > 8) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap((v) => collectStringValues(v, depth + 1));
  if (value && typeof value === 'object') return Object.values(value).flatMap((v) => collectStringValues(v, depth + 1));
  return [];
}

// ---------------------------------------------------------------------------------------------
// Rule 4: reading an OS credential store directly.
// ---------------------------------------------------------------------------------------------

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

/** Node/Python inline code (`node -e/-p`, `python -c`) mentioning the `keyring` module by name. */
function mentionsKeyringInInlineCode(command: string): boolean {
  return /\b(node\s+-[ep]|python\d*(?:\.\d+)?\s+-c)\b/i.test(command) && /\bkeyring\b/i.test(command);
}

function readsCredentialStore(command: string): boolean {
  return CREDENTIAL_STORE_PATTERNS.some((re) => re.test(command)) || mentionsKeyringInInlineCode(command);
}

// ---------------------------------------------------------------------------------------------
// Rule 5: direct HTTP against a configured pidb server.
// ---------------------------------------------------------------------------------------------

const NETWORK_TOOL_RE = /\b(curl|wget|Invoke-WebRequest|iwr|irm)\b/i;

/** `localhost`/`127.0.0.1`/`::1` are the same server from a guard's point of view (Fix round 1 Minor #6). */
function hostAliases(hostname: string): string[] {
  const lower = hostname.toLowerCase();
  if (lower === 'localhost' || lower === '127.0.0.1' || lower === '::1') return ['localhost', '127.0.0.1', '::1'];
  return [lower];
}

/** Substring match on `host[:port]`, with or without a scheme — catches a scheme-less mention too. */
function commandMentionsUrl(command: string, url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return command.toLowerCase().includes(url.toLowerCase());
  }
  const portSuffix = parsed.port ? `:${parsed.port}` : '';
  const lowerCmd = command.toLowerCase();
  return hostAliases(parsed.hostname).some((host) => lowerCmd.includes(`${host}${portSuffix}`));
}

function targetsConfiguredServer(command: string, ctx: GuardContext): boolean {
  if (!NETWORK_TOOL_RE.test(command)) return false;
  return ctx.serverUrls.some((url) => commandMentionsUrl(command, url));
}

// ---------------------------------------------------------------------------------------------

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
        'this looks like it would print the environment (env/printenv/set/Get-ChildItem env:/a print verb taking $PIDB_*/.../) inside `pidb secret exec`, which would leak the substituted secret — use the value only inside the invoked program, e.g. `pidb secret exec <target> "<name>" -- npm test`.',
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

// Built-in Claude Code tools only ever get checked on their actual path-designating keys (Fix round 1
// Important #5) — never on free-text content like `Edit`'s `old_string`/`new_string` (which might
// legitimately *say* ".env", e.g. editing a `.gitignore`). Only `mcp__*` tools (arbitrary, unreviewed
// shapes) get the broad recursive string scan.
const PATH_KEYS = ['file_path', 'path', 'notebook_path'];

function guardPathArgs(toolName: string, toolInput: HookToolInput, cwd: string, ctx: GuardContext): GuardDecision {
  const candidates: string[] = [];
  if (toolName.startsWith('mcp__')) {
    candidates.push(...collectStringValues(toolInput));
  } else {
    for (const key of PATH_KEYS) {
      const v = toolInput[key];
      if (typeof v === 'string') candidates.push(v);
    }
    // Glob's `pattern` is resolved against its own `path` (if given), else `cwd` (Fix round 1 Important #5).
    if (toolName === 'Glob' && typeof toolInput.pattern === 'string') {
      const base = typeof toolInput.path === 'string' ? resolveArgPathFrom(toolInput.path, cwd, ctx) : cwd;
      const resolved = resolveArgPathFrom(toolInput.pattern, base, ctx);
      if (isProtectedPath(resolved, ctx)) {
        return deny(
          "this path is inside pidb's protected data (the plugin data dir, its config, or a file `pidb secret write|env` produced) — use the pidb CLI/MCP tools instead of reading it directly.",
        );
      }
    }
  }
  for (const raw of candidates) {
    const resolved = resolveArgPath(raw, cwd, ctx);
    if (isProtectedPath(resolved, ctx)) {
      return deny(
        "this path is inside pidb's protected data (the plugin data dir, its config, or a file `pidb secret write|env` produced) — use the pidb CLI/MCP tools instead of reading it directly.",
      );
    }
  }
  return ALLOW;
}

/**
 * Decides whether to deny a PreToolUse call (spec §3.1). `input.tool_name === 'Bash'` runs the
 * command-text rules (1/2/3-bash/4/5); everything else (Read/Grep/Glob/Edit/Write/NotebookEdit, and
 * any `mcp__*` tool) runs the path-argument check (rule 3).
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
