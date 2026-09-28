// stdin/stdout JSON dispatcher for the plugin's three Claude Code hooks (spec §3.1–§3.3). Pure
// decision logic lives in `guard.ts`/`redact.ts`/`session-start.ts`; this file only wires that logic
// to the documented hook I/O shapes and guarantees the one hard rule that matters more than any
// individual behavior: **this must never throw, never block, and never exit non-zero** — an internal
// bug here should degrade to "allow"/"no redaction"/"a one-line status", not break Claude Code's tool
// loop. `runHook` is side-effect-free enough to unit-test directly (no real stdin/stdout/process.exit);
// `main.ts` is the actual executable entry that Task 9 bundles into `dist/hook.mjs`.
import { homedir } from 'node:os';
import { resolveDataDir } from '../datadir.js';
import { loadProfiles, loadWritten } from '../state.js';
import { keyringStore, type TokenStore } from '../tokenstore.js';
import { guardDecision, type GuardContext, type HookInput, type HookToolInput } from './guard.js';
import { redactToolResponse } from './redact.js';
import { fallbackContext, sessionContext, type SessionStartDeps } from './session-start.js';

export type { GuardContext, GuardDecision, HookInput, HookToolInput } from './guard.js';
export { guardDecision } from './guard.js';
export { redactOutput, redactToolResponse } from './redact.js';
export { fallbackContext, sessionContext, type SessionStartDeps } from './session-start.js';

export type HookKind = 'guard' | 'redact' | 'session-start';

export interface RunHookResult {
  /** Written verbatim to the hook's stdout (empty string ⇒ write nothing, per the documented contract). */
  stdout: string;
  /** Always 0 — a hook must never fail Claude Code's tool loop (spec §3.1–§3.3, task-8 brief). */
  exitCode: number;
  /** A one-line diagnostic for stderr, only ever present when something unexpected happened internally. */
  stderr?: string;
}

export interface RunHookDeps {
  /** Overrides `process.platform` (tests: exercise win32 rules from a POSIX host). */
  platform?: NodeJS.Platform;
  /** Overrides `session-start`'s upstream fetch (tests; also the server-down/timeout paths). */
  fetchImpl?: typeof fetch;
  /** Overrides the token store `session-start` reads from (tests: `memoryStore()`; production: the real keyring). */
  store?: TokenStore;
  /** Overrides `session-start`'s project-detail fetch timeout (tests only — production keeps the spec's ≤4s default). */
  timeoutMs?: number;
  /** Task 9's hook point (spec §2.1/§3.3 "Ensures deps") — see `session-start.ts`'s `SessionStartDeps.ensureDeps`. */
  ensureDeps?: SessionStartDeps['ensureDeps'];
}

function parseHookInput(stdinText: string): HookInput {
  const trimmed = stdinText.trim();
  if (!trimmed) throw new Error('empty stdin (expected a JSON hook payload)');
  const parsed: unknown = JSON.parse(trimmed);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('hook input is not a JSON object');
  }
  const obj = parsed as Record<string, unknown>;
  return {
    hook_event_name: typeof obj.hook_event_name === 'string' ? obj.hook_event_name : '',
    session_id: typeof obj.session_id === 'string' ? obj.session_id : undefined,
    cwd: typeof obj.cwd === 'string' ? obj.cwd : process.cwd(),
    tool_name: typeof obj.tool_name === 'string' ? obj.tool_name : undefined,
    tool_input: obj.tool_input && typeof obj.tool_input === 'object' && !Array.isArray(obj.tool_input) ? (obj.tool_input as HookToolInput) : {},
    tool_response: obj.tool_response,
  };
}

function collectServerUrls(dataDir: string): string[] {
  try {
    return Object.values(loadProfiles(dataDir).profiles).map((p) => p.url);
  } catch {
    return [];
  }
}

/**
 * `written.json` being corrupt must degrade *only* that one signal, not fail the whole guard open
 * (Fix round 1 Minor #9) — a naive `loadWritten(dataDir).paths` call left uncaught here would bubble
 * all the way out to `runHook`'s outer catch, which for `kind: 'guard'` means "allow", silently
 * dropping rules 1/2/4/5 too. Treats a load failure as an empty written-paths list plus a stderr note.
 */
function loadWrittenPathsSafe(dataDir: string): { paths: string[]; note?: string } {
  try {
    return { paths: loadWritten(dataDir).paths };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { paths: [], note: `pidb hook (guard): written.json unreadable (${message}) — treating as empty` };
  }
}

function guardOutput(reason: string): string {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  });
}

// `updatedToolOutput`, not `updatedOutput` (Fix round 1 Critical #1) — the field Claude Code 2.1.281
// actually recognizes for a PostToolUse hookSpecificOutput; `updatedOutput` doesn't exist in the
// binary and is silently ignored. See spec §3.2.
function redactHookOutput(updatedToolOutput: unknown): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput } });
}

function sessionStartOutput(additionalContext: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext } });
}

async function dispatch(kind: HookKind, stdinText: string, env: NodeJS.ProcessEnv, deps: RunHookDeps): Promise<RunHookResult> {
  const dataDir = env.CLAUDE_PLUGIN_DATA ?? resolveDataDir(env);

  if (kind === 'session-start') {
    // Even a stdin we can't parse still gets a real session-start attempt (falling back to
    // `process.cwd()`), because `sessionContext` on its own is almost always able to produce a
    // useful one-line status (spec: "on any failure injects a one-line status") — losing that just
    // because the JSON envelope itself was malformed would be a worse outcome than a best-effort cwd.
    let cwd = process.cwd();
    try {
      cwd = parseHookInput(stdinText).cwd;
    } catch {
      // fall through with process.cwd()
    }
    const store = deps.store ?? keyringStore(dataDir);
    const context = await sessionContext({
      cwd,
      dataDir,
      store,
      fetchImpl: deps.fetchImpl,
      timeoutMs: deps.timeoutMs,
      ensureDeps: deps.ensureDeps,
    });
    return { stdout: sessionStartOutput(context), exitCode: 0 };
  }

  const input = parseHookInput(stdinText);

  if (kind === 'guard') {
    const written = loadWrittenPathsSafe(dataDir);
    const ctx: GuardContext = {
      dataDir,
      written: written.paths,
      serverUrls: collectServerUrls(dataDir),
      home: env.HOME ?? homedir(),
      platform: deps.platform ?? process.platform,
      // Fix round 1 Minor #8: production reads the real `%APPDATA%` from the environment rather than
      // always falling back to the `<home>\AppData\Roaming` convention `guard.ts` uses when unset.
      appData: env.APPDATA,
    };
    const decision = guardDecision(input, ctx);
    const stdout = decision.deny ? guardOutput(decision.reason) : '';
    return { stdout, exitCode: 0, stderr: written.note };
  }

  // redact
  const { changed, value } = redactToolResponse(input.tool_response);
  return changed ? { stdout: redactHookOutput(value), exitCode: 0 } : { stdout: '', exitCode: 0 };
}

/**
 * Runs one hook invocation end to end: parses `stdinText` as the documented hook JSON, decides, and
 * returns the exact stdout the hook must print (empty string ⇒ print nothing) — always with
 * `exitCode: 0`. Never throws: any internal error is caught here and turned into the safest possible
 * fallback for `kind` (guard → allow, redact → no `updatedToolOutput`, session-start → a one-line status
 * built the same way `sessionContext` builds its own failure status), with a diagnostic on `stderr`
 * for guard/redact (session-start's fallback already explains itself in the injected context, so no
 * separate stderr note is needed there).
 */
export async function runHook(kind: HookKind, stdinText: string, env: NodeJS.ProcessEnv = process.env, deps: RunHookDeps = {}): Promise<RunHookResult> {
  try {
    return await dispatch(kind, stdinText, env, deps);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (kind === 'session-start') {
      return { stdout: sessionStartOutput(fallbackContext(message)), exitCode: 0, stderr: `pidb hook (session-start): ${message}` };
    }
    return { stdout: '', exitCode: 0, stderr: `pidb hook (${kind}): ${message} — allowing by default` };
  }
}
