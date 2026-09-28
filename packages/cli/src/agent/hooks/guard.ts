// PreToolUse guard (spec §3.1): a pure, heuristic decision function over a single tool-call. Never
// touches the network or the filesystem itself — everything it needs (the plugin data dir, the
// `written.json` paths, the configured server urls, the home dir, the platform) is handed in as
// `GuardContext` by the dispatcher (`index.ts`), so this file is trivially table-testable on any host
// regardless of the actual OS it runs on (a POSIX CI box can still exercise the win32/cmd/PowerShell
// rules by passing `platform: 'win32'` and Windows-shaped paths).
//
// This is defense-in-depth, not a security boundary (spec §6: "the token scope + audit are the hard
// boundary") — every rule here is intentionally biased toward false positives over false negatives
// (a blocked-but-harmless command is an inconvenience; a missed leak is not), and the brief's three
// "allowed look-alikes" (`pidb secret exec acme DB -- npm test`, `cat README.md`, `echo hello`) are
// the one hard constraint on how aggressive that bias is allowed to be.
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
   * Windows `%APPDATA%` for the current user, when known. Not part of the brief's literal `ctx`
   * shape (`{dataDir, written, serverUrls, home, platform}`), but needed to recognize
   * `%APPDATA%\pidb` (spec §3.1) as a real, resolvable path rather than a bare string — falls back to
   * the conventional `<home>\AppData\Roaming` when omitted, which is exactly what a real Windows
   * session's `$env:APPDATA` resolves to for a default user profile.
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

// ---------------------------------------------------------------------------------------------
// Rule 1: `pidb` together with a disabled agent-mode subcommand (spec §2.3/§3.1).
// ---------------------------------------------------------------------------------------------

function mentionsDisabledCommand(command: string): boolean {
  if (!/\bpidb\b/i.test(command)) return false;
  return /secret\s+get\b/i.test(command) || /--print\b/i.test(command) || /\blogin\b/i.test(command) || /\btoken\b/i.test(command);
}

// ---------------------------------------------------------------------------------------------
// Rule 2: `pidb secret exec` whose child command prints the environment (spec §3.1, Review Focus 5).
// ---------------------------------------------------------------------------------------------

const PIDB_VAR_REF = /\$\{?PIDB_[A-Za-z0-9_]*\}?|%PIDB_[A-Za-z0-9_]*%|\$env:PIDB_[A-Za-z0-9_]*/i;

function mentionsSecretExec(command: string): boolean {
  return /\bpidb(\.exe|\.cmd)?\s+secret\s+exec\b/i.test(command);
}

/**
 * Whether `command` (the *whole* raw Bash command, not just whatever comes after
 * `pidb secret exec ... --`) looks like it would print the environment. Deliberately checks the
 * whole string rather than trying to isolate the child command by splitting on shell separators
 * (`;`, `&&`, `|`, ...) — a naive split breaks on a `;`/`|` that's actually *inside* a quoted argument
 * (e.g. `python -c "import os; print(os.environ)"`), which would silently separate a pattern from the
 * evidence that completes it. Operating on the whole string can only make this rule *more* eager to
 * deny (never less), which matches the "prefer false positives over leaks" guidance.
 */
function printsEnvironment(command: string): boolean {
  const cmd = command.trim();
  if (!cmd) return false;
  // A literal `$PIDB_*`/`${PIDB_*}`/`%PIDB_*%`/`$env:PIDB_*` reference anywhere is inherently risky
  // — it doesn't need to be wrapped in an explicit `echo`/`printf` to leak (e.g. a bare PowerShell
  // expression statement `$env:PIDB_PASSWORD` writes its value to the pipeline/host on its own).
  if (PIDB_VAR_REF.test(cmd)) return true;
  // `set` with no further arguments dumps every shell var — "bare" here means "set" is its own
  // whitespace/quote-delimited token at the very end of the command (`cmd /c set`, `-- set`, a lone
  // `set`, `true; set`), not a `set -e`/`set FOO=bar`/word-ending-in-"set" (e.g. "npm run reset").
  if (/(^|[\s"'])set(['"]?)$/i.test(cmd)) return true;
  if (/\bprintenv\b/i.test(cmd)) return true;
  // `env` (bare, or as a flag like `--env`) is always suspicious per spec; `env NAME=value cmd` (the
  // "run a command with one extra env var" idiom) is excluded since it never prints anything.
  if (/\benv\b/i.test(cmd) && !/\benv\s+[A-Za-z_][A-Za-z0-9_]*=/.test(cmd)) return true;
  if (/\bexport\s+-p\b/i.test(cmd)) return true;
  if (/\b(Get-ChildItem|gci|dir|ls)\s+env:/i.test(cmd)) return true;
  if (/\b(node\s+-e|python\s+-c)\b/i.test(cmd) && /(process\.env|os\.environ)/.test(cmd)) return true;
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

/** Backslashes → forward slashes, lower-cased on win32 — a stable form for both substring and exact comparison. */
function normalizeForCompare(p: string, platform: NodeJS.Platform): string {
  const s = p.replace(/\\/g, '/');
  return platform === 'win32' ? s.toLowerCase() : s;
}

/** Structured containment check for a single resolved path against every protected root/written file. */
function isProtectedPath(resolved: string, ctx: GuardContext): boolean {
  const pm = pathModFor(ctx.platform);
  const target = normalizeForCompare(resolved, ctx.platform);
  for (const root of protectedRoots(ctx)) {
    const normRoot = normalizeForCompare(pm.resolve(root), ctx.platform);
    if (target === normRoot || target.startsWith(`${normRoot}/`)) return true;
  }
  for (const w of ctx.written) {
    if (target === normalizeForCompare(pm.resolve(w), ctx.platform)) return true;
  }
  return false;
}

/** Expands `~`, `%APPDATA%`, `$env:APPDATA`, `$HOME`/`${HOME}` mentions using ctx's home/appData. */
function expandPlaceholders(text: string, ctx: GuardContext): string {
  const appData = appDataOf(ctx);
  return text
    .replace(/(^|[\s"'([{=:])~(?=[\\/]|$)/g, `$1${ctx.home}`)
    .replace(/%APPDATA%/gi, appData)
    .replace(/\$env:APPDATA/gi, appData)
    .replace(/\$\{HOME\}/g, ctx.home)
    .replace(/\$HOME\b/g, ctx.home);
}

/** Resolves a single tool-input path value relative to `cwd`, applying the same expansions. */
function resolveArgPath(raw: string, cwd: string, ctx: GuardContext): string {
  const pm = pathModFor(ctx.platform);
  const expanded = expandPlaceholders(raw, ctx);
  return pm.isAbsolute(expanded) ? pm.resolve(expanded) : pm.resolve(cwd, expanded);
}

const READ_TOOL_NAMES = ['cat', 'type', 'get-content', 'less', 'head', 'tail', 'grep', 'sed', 'awk', 'cp', 'base64', 'xxd', 'od', 'strings'];
const READ_TOOL_RE = new RegExp(`\\b(${READ_TOOL_NAMES.map(escapeRegExp).join('|')})\\b`, 'i');

function mentionsReadTool(command: string): boolean {
  return READ_TOOL_RE.test(command);
}

/** Whole-command substring check (spec: "Bash commands mentioning them") after placeholder expansion. */
function mentionsProtectedPathText(command: string, ctx: GuardContext): boolean {
  const pm = pathModFor(ctx.platform);
  const haystack = normalizeForCompare(expandPlaceholders(command, ctx), ctx.platform);
  for (const root of protectedRoots(ctx)) {
    if (haystack.includes(normalizeForCompare(pm.resolve(root), ctx.platform))) return true;
  }
  for (const w of ctx.written) {
    if (haystack.includes(normalizeForCompare(pm.resolve(w), ctx.platform))) return true;
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
  /cmdkey\s+\/list/i,
  /Get-StoredCredential/i,
  /secret-tool\s+lookup/i,
  /keyring\s+get/i,
];

function readsCredentialStore(command: string): boolean {
  return CREDENTIAL_STORE_PATTERNS.some((re) => re.test(command));
}

// ---------------------------------------------------------------------------------------------
// Rule 5: direct HTTP against a configured pidb server.
// ---------------------------------------------------------------------------------------------

const NETWORK_TOOL_RE = /\b(curl|wget|Invoke-WebRequest|iwr|irm)\b/i;

function commandMentionsUrl(command: string, url: string): boolean {
  try {
    const origin = new URL(url).origin;
    return new RegExp(escapeRegExp(origin), 'i').test(command);
  } catch {
    return command.toLowerCase().includes(url.toLowerCase());
  }
}

function targetsConfiguredServer(command: string, ctx: GuardContext): boolean {
  if (!NETWORK_TOOL_RE.test(command)) return false;
  return ctx.serverUrls.some((url) => commandMentionsUrl(command, url));
}

// ---------------------------------------------------------------------------------------------

function guardBashCommand(command: string, ctx: GuardContext): GuardDecision {
  if (mentionsDisabledCommand(command)) {
    return deny(
      'pidb login/token/secret get/--print are not available to the Claude agent — ask the user to run this themselves, or use `pidb connect`/`pidb secret exec` instead.',
    );
  }
  if (mentionsSecretExec(command) && printsEnvironment(command)) {
    return deny(
      'this looks like it would print the environment (env/printenv/set/Get-ChildItem env:/$PIDB_*/%PIDB_%/...) inside `pidb secret exec`, which would leak the substituted secret — use the value only inside the invoked program, e.g. `pidb secret exec <target> "<name>" -- npm test`.',
    );
  }
  if (mentionsReadTool(command) && mentionsProtectedPathText(command, ctx)) {
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

function guardPathArgs(toolInput: HookToolInput, cwd: string, ctx: GuardContext): GuardDecision {
  for (const raw of collectStringValues(toolInput)) {
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
 * command-text rules (1/2/3-bash/4/5); everything else (Read/Grep/Glob/Edit/Write, and any
 * `mcp__*` tool) runs the generic path-argument check (rule 3) over every string value found
 * anywhere in `tool_input`.
 */
export function guardDecision(input: HookInput, ctx: GuardContext): GuardDecision {
  const toolInput: HookToolInput = input.tool_input ?? {};
  if (input.tool_name === 'Bash') {
    const command = typeof toolInput.command === 'string' ? toolInput.command : '';
    return guardBashCommand(command, ctx);
  }
  return guardPathArgs(toolInput, input.cwd, ctx);
}
