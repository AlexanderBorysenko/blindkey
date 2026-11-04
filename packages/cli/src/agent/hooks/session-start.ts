// SessionStart context injection (spec §3.3). Builds the `additionalContext` string a fresh Claude
// Code session gets: which profile/server is configured, whether it's connected, which project this
// repo is bound to (and that project's summary/docs/secrets from the server), and the spec §3.4
// golden rules — always, verbatim, and never truncated away (see `finalize` below).
import { ApiError, BlindkeyClient } from '../../client.js';
import { loadBindings, loadProfiles, repoKey } from '../state.js';
import type { TokenStore } from '../tokenstore.js';

export interface SessionStartDeps {
  cwd: string;
  dataDir: string;
  store: TokenStore;
  /** Overridable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Project-detail fetch timeout in ms (spec: "≤ 4s"). Defaults to 4000. */
  timeoutMs?: number;
  /**
   * Task 9's hook point: ensure the plugin's runtime deps (e.g. `@napi-rs/keyring`) are installed
   * into the data dir before building context (spec §2.1/§3.3 "Ensures deps"). Not implemented here
   * — the implementation is `agent/deps.ts` (`ensureDeps`), supplied by `main.ts`. A returned string
   * is a one-line status ("installing plugin dependencies…") shown first in the context. Errors are
   * swallowed: a failed dep-install must never block session context from being injected.
   */
  ensureDeps?: () => void | string | undefined | Promise<void | string | undefined>;
}

const MAX_CONTEXT_CHARS = 4096;
const MAX_LIST_ITEMS = 20;

const GOLDEN_RULES = [
  'Never ask the user to paste a secret or token into chat; never print, echo, log, cat or base64 a secret.',
  'Use values only via `blindkey secret exec <target> "<name>" -- <cmd>` (env BLINDKEY_<KEY>; target = project slug, `global` or `global@<workspace>`), or `blindkey secret write|env --out <file>` for tools that need files; never read those files back.',
  'Missing secret → call `secret_request_link` and give the user the link; wait; verify with `list_secrets`.',
  'Keep project docs current with `write_document` (architecture, runbooks, decisions — the project "memory"); shared infrastructure memory (servers, conventions) lives in global docs — read/write them with `project` omitted (plus `workspace` when several are visible — `list_workspaces`); update project summary/tags with `update_project`; non-secret facts go into non-sensitive fields via `upsert_secret_meta` (host, port, url, username, database, public_key, or any non-credential key with `sensitive: false`); credentials → `secret_request_link`; a new project → `create_project`.',
  '401/expired → run `blindkey connect` (the user approves in the browser); 403 on a project → `blindkey connect` to widen.',
  'Never use curl against the Blindkey server; use MCP tools / the CLI.',
] as const;

const GOLDEN_RULES_BLOCK = ['', 'Golden rules:', ...GOLDEN_RULES.map((r, i) => `${i + 1}. ${r}`)].join('\n');

interface RemoteDocSummary {
  slug: string;
  title: string;
}
interface RemoteSecretField {
  key: string;
  sensitive: boolean;
}
interface RemoteSecretSummary {
  name: string;
  fields: RemoteSecretField[];
}
interface RemoteWorkspace {
  slug: string;
  name: string;
  role: string;
}
interface RemoteProjectDetail {
  slug: string;
  workspace?: string;
  summary: string;
  tags: string[];
  documents: RemoteDocSummary[];
  secrets: RemoteSecretSummary[];
}

function bulletedList(items: string[], max: number): string[] {
  if (items.length <= max) return items.map((i) => `- ${i}`);
  const shown = items.slice(0, max).map((i) => `- ${i}`);
  shown.push(`… ${items.length - max} more`);
  return shown;
}

/**
 * A 401/403/404 status is reported as such (each gets its own hint, spec §2.5); `'down'` = couldn't
 * reach/parse the server in time (or any other failure).
 */
async function fetchProjectDetail(
  url: string,
  token: string,
  project: string,
  deps: SessionStartDeps,
  deadline: number,
): Promise<RemoteProjectDetail | 401 | 403 | 404 | 'down'> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  try {
    const client = new BlindkeyClient({ url, token }, fetchImpl);
    return await withDeadline(client.json<RemoteProjectDetail>('GET', `/api/v1/projects/${encodeURIComponent(project)}`), deadline);
  } catch (err) {
    if (err instanceof ApiError && (err.status === 401 || err.status === 403 || err.status === 404)) return err.status;
    return 'down';
  }
}

interface GlobalListing {
  docs: RemoteDocSummary[];
  secrets: RemoteSecretSummary[];
}

/** Global docs + secrets (shared across projects); a list that can't be fetched in time (or lacks scope) is empty. */
async function fetchGlobals(
  url: string,
  token: string,
  workspace: string | null,
  deps: SessionStartDeps,
  deadline: number,
): Promise<GlobalListing> {
  const client = new BlindkeyClient({ url, token }, deps.fetchImpl ?? fetch);
  // Each list on its own: a token without secrets:meta still gets the global documents.
  const list = async <T>(path: string): Promise<T[]> => {
    try {
      const v = await withDeadline(client.json<T[]>('GET', path), deadline);
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  };
  const qs = workspace ? `?workspace=${encodeURIComponent(workspace)}` : '';
  const [docs, secrets] = await Promise.all([
    list<RemoteDocSummary>(`/api/v1/docs${qs}`),
    list<RemoteSecretSummary>(`/api/v1/secrets${qs}`),
  ]);
  return { docs, secrets };
}

function secretLine(s: RemoteSecretSummary): string {
  return `${s.name} (${s.fields.map((f) => (f.sensitive ? `${f.key}*` : f.key)).join(', ') || 'no fields'})`;
}

/** Visible workspaces; empty when the token lacks projects:read or the server doesn't answer in time. */
async function fetchWorkspaces(url: string, token: string, deps: SessionStartDeps, deadline: number): Promise<RemoteWorkspace[]> {
  try {
    const client = new BlindkeyClient({ url, token }, deps.fetchImpl ?? fetch);
    const v = await withDeadline(client.json<RemoteWorkspace[]>('GET', '/api/v1/workspaces'), deadline);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function globalLines(g: GlobalListing, workspace: RemoteWorkspace | string | null): string[] {
  if (g.docs.length === 0 && g.secrets.length === 0) return [];
  const label =
    workspace === null
      ? ''
      : typeof workspace === 'string'
        ? ` of workspace "${workspace}"`
        : ` of workspace "${workspace.name}" (${workspace.slug})`;
  const slug = workspace === null ? null : typeof workspace === 'string' ? workspace : workspace.slug;
  const lines = [
    '',
    `Global (shared across all projects${label} — servers, conventions; use tools with \`project\` omitted${slug ? ` (workspace "${slug}")` : ''}):`,
  ];
  if (g.docs.length > 0) lines.push('Global documents:', ...bulletedList(g.docs.map((d) => `${d.slug} — ${d.title}`), MAX_LIST_ITEMS));
  if (g.secrets.length > 0) lines.push('Global secrets:', ...bulletedList(g.secrets.map(secretLine), MAX_LIST_ITEMS));
  return lines;
}

function workspaceChoiceLines(workspaces: RemoteWorkspace[]): string[] {
  return [
    '',
    'Several workspaces, each with its own global docs and secrets — pick one: pass `workspace: "<slug>"` to the MCP tools (`list_workspaces`) or use the target `global@<slug>` in the CLI:',
    ...bulletedList(workspaces.map((w) => `${w.slug} — ${w.name} (${w.role})`), MAX_LIST_ITEMS),
  ];
}

/** Rejects once `deadline` (an absolute `Date.now()`-scale timestamp) passes, whatever's left of it. */
function withDeadline<T>(p: Promise<T>, deadline: number): Promise<T> {
  const ms = Math.max(deadline - Date.now(), 0);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/**
 * `deadline` is a single shared budget (Fix round 1 Minor #10): `ensureDeps`, `store.get`, and the
 * project-detail fetch all draw down the *same* remaining time rather than each getting their own
 * fresh `timeoutMs` — a slow/hanging keychain (`store.get`) or a slow dep-install must not let the
 * total time this hook can block Claude Code exceed the documented "≤ 4s" budget.
 */
async function buildBody(deps: SessionStartDeps, deadline: number): Promise<string[]> {
  const profiles = loadProfiles(deps.dataDir);
  const bindings = loadBindings(deps.dataDir);
  const binding = bindings[repoKey(deps.cwd)];
  const profileName = binding?.profile ?? profiles.default;
  const profile = profileName ? profiles.profiles[profileName] : undefined;

  if (!profileName || !profile) {
    return [
      'blindkey: no server configured for this agent.',
      'Ask the user to run `/blindkey:server <name> <url>` and then `/blindkey:connect` (or `blindkey profile add <name> <url>` / `blindkey connect` directly).',
    ];
  }

  const lines = [`blindkey: profile "${profileName}" — ${profile.url}`];

  const token = await withDeadline(Promise.resolve(deps.store.get(profileName)), deadline);
  if (!token) {
    lines.push('Not connected — run `blindkey connect` (browser approval), or ask the user to run `/blindkey:connect`.');
    return lines;
  }
  lines.push('Connected.');

  // Globals live in a workspace: the bound project's, else the only visible one; with several visible
  // workspaces and no binding we list them instead of guessing.
  const workspaces = fetchWorkspaces(profile.url, token, deps, deadline);
  const section = await projectSection(profile.url, token, binding?.project, deps, deadline);
  lines.push(...section.lines);
  const all = await workspaces;
  if (Date.now() >= deadline) return lines; // budget spent: no more fetches
  const bound = section.workspace === null ? undefined : all.find((w) => w.slug === section.workspace);
  if (section.workspace !== null) {
    const g = await fetchGlobals(profile.url, token, section.workspace, deps, deadline);
    lines.push(...globalLines(g, bound ?? section.workspace));
  } else if (all.length > 1) {
    lines.push(...workspaceChoiceLines(all));
  } else {
    const only = all[0];
    const g = await fetchGlobals(profile.url, token, only?.slug ?? null, deps, deadline);
    lines.push(...globalLines(g, only ?? null));
  }
  return lines;
}

interface ProjectSection {
  lines: string[];
  /** Workspace slug of the bound project, when it could be read. */
  workspace: string | null;
}

async function projectSection(
  url: string,
  token: string,
  project: string | undefined,
  deps: SessionStartDeps,
  deadline: number,
): Promise<ProjectSection> {
  const lines: string[] = [];
  const none = (): ProjectSection => ({ lines, workspace: null });
  if (!project) {
    lines.push('This repo is not bound to a Blindkey project — call `blindkey_bind` or ask the user which project this is.');
    return none();
  }
  lines.push(`Bound project: ${project}`);

  const detail = await fetchProjectDetail(url, token, project, deps, deadline);
  if (detail === 'down') {
    lines.push(`blindkey server (${url}) is unreachable right now — project details unavailable this session.`);
    return none();
  }
  if (detail === 401) {
    lines.push('blindkey: token expired or revoked — run `blindkey connect`.');
    return none();
  }
  if (detail === 403) {
    lines.push(`blindkey: the token lacks access to project "${project}" — run \`blindkey connect\` to widen.`);
    return none();
  }
  if (detail === 404) {
    // The server answers 404 both for a missing slug and for one this token wasn't approved for.
    lines.push(
      `Project "${project}" not found or not approved for this token — run \`blindkey connect\` to approve it, or \`blindkey bind\` another.`,
    );
    return none();
  }

  if (detail.workspace) lines.push(`Workspace: ${detail.workspace}`);
  if (detail.summary) lines.push(`Summary: ${detail.summary}`);
  if (detail.tags.length > 0) lines.push(`Tags: ${detail.tags.join(', ')}`);

  if (detail.documents.length > 0) {
    lines.push('Documents:', ...bulletedList(detail.documents.map((d) => `${d.slug} — ${d.title}`), MAX_LIST_ITEMS));
  } else {
    lines.push('Documents: none yet.');
  }

  if (detail.secrets.length > 0) {
    lines.push(
      'Secrets:',
      ...bulletedList(
        detail.secrets.map(secretLine),
        MAX_LIST_ITEMS,
      ),
    );
  } else {
    lines.push('Secrets: none yet.');
  }

  return { lines, workspace: detail.workspace ?? null };
}

/**
 * Reserves space for the (fixed-size) golden-rules block and truncates the *variable* body — never
 * the golden rules themselves — to fit within the spec's ~4 KB budget. `body`'s own internal lists
 * are already capped by `bulletedList`; this is the final, always-correct safety net.
 */
function finalize(bodyLines: string[]): string {
  const budget = Math.max(MAX_CONTEXT_CHARS - GOLDEN_RULES_BLOCK.length - 1, 0);
  let body = bodyLines.join('\n');
  if (body.length > budget) {
    body = budget > 0 ? `${body.slice(0, Math.max(budget - 1, 0))}…` : '';
  }
  return `${body}\n${GOLDEN_RULES_BLOCK}`;
}

/**
 * Builds a one-line-status `additionalContext` (still including the full golden-rules block) for
 * when something failed before — or independently of — `sessionContext`'s own internal try/catch
 * (e.g. the dispatcher's `keyringStore(dataDir)` construction). Exported so `index.ts`'s outermost
 * safety net can produce the exact same shape rather than a hand-rolled, possibly-incomplete one.
 */
export function fallbackContext(message: string, notes: readonly string[] = []): string {
  return finalize([...notes, `blindkey: session context unavailable (${message}).`]);
}

/**
 * Builds the SessionStart `additionalContext` string (spec §3.3). Never throws — any failure
 * (malformed state files, a server that's down, an unexpected error resolving the token store) is
 * caught and turned into a one-line status instead, so a broken environment still surfaces something
 * useful rather than blocking session start (or, if the dispatcher's own try/catch is what actually
 * saves the day, this is redundant with it — belt and braces for a hook that must never crash).
 */
export async function sessionContext(deps: SessionStartDeps): Promise<string> {
  // Fix round 2 N5: restore the hard ≤4s cap — a caller-supplied `timeoutMs` can shrink the budget
  // but never grow it past the spec's own ceiling.
  const deadline = Date.now() + Math.min(deps.timeoutMs ?? 4000, 4000);
  const notes: string[] = [];
  if (deps.ensureDeps) {
    try {
      const note = await withDeadline(Promise.resolve(deps.ensureDeps()), deadline);
      if (typeof note === 'string' && note) notes.push(note);
    } catch {
      // npm install into the data dir (agent/deps.ts) — never let it block session context, and
      // never let it eat into the budget the rest of this function still needs.
    }
  }
  try {
    return finalize([...notes, ...(await buildBody(deps, deadline))]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fallbackContext(message, notes);
  }
}
