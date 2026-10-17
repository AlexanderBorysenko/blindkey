import { hostname } from 'node:os';
import { AGENT_SCOPES, type Scope } from '@blindkey/shared';
import { CliError, EXIT_AUTH, EXIT_REFUSED } from '../errors.js';
import { normalizeUrl } from '../config.js';
import type { CommandResult } from '../output.js';
import { openBrowser } from './browser.js';
import { loadBindings, loadProfiles, repoKey, saveProfiles, type BindingsFile, type ProfilesFile } from './state.js';
import type { TokenStore } from './tokenstore.js';

export interface ConnectOptions {
  profile?: string;
  url?: string;
}

export interface ConnectDeps {
  cwd: string;
  store: TokenStore;
  dataDir: string;
  fetchImpl?: typeof fetch;
  /** Sleeps for `ms` milliseconds between polls; injectable so tests never really wait. */
  sleep?: (ms: number) => Promise<void>;
  platform?: NodeJS.Platform;
  openBrowserImpl?: typeof openBrowser;
  /** Injectable clock, paired with `sleep`, so the "give up after ~10 minutes" bound is testable. */
  now?: () => number;
  out?: Pick<NodeJS.WritableStream, 'write'>;
}

interface StartResponse {
  device_code: string;
  user_code: string;
  verification_url: string;
  expires_in: number;
  interval: number;
}

interface PollSuccess {
  token: string;
  id: number;
  name: string;
  scopes: Scope[];
  projects: string[];
  expires_at: number | null;
}

interface ErrorBody {
  error?: string;
  message?: string;
}

/** Hard cap on how long `blindkey connect` waits for approval, regardless of the server's `expires_in` (spec §2.3). */
const MAX_WAIT_MS = 10 * 60_000;
/** Fallback poll interval (seconds) when the server omits `interval` or sends something unusable. */
const DEFAULT_INTERVAL_S = 5;
/** Hard cap on the poll interval (seconds), fix round 2 — a malicious/broken `interval` (or one grown
 * by repeated `slow_down` backoff) must never make a single `sleep()` absurdly long. */
const MAX_INTERVAL_S = 60;
/** Backoff added to the poll interval (seconds) on a `429`/`slow_down` response. */
const SLOW_DOWN_BACKOFF_S = 5;
/** Per-request network timeout — a hung connect/poll request must not block the CLI forever. */
const REQUEST_TIMEOUT_MS = 15_000;

async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/** Strips control characters (including ANSI escapes) and bidi-override/isolate/mark characters
 * (fix round 2, Minor 4 — `U+202A`-`U+202E`, `U+2066`-`U+2069`, `U+200E`/`U+200F` can reorder how
 * surrounding text *displays* without changing its content, another way a hostile server could spoof
 * what the terminal shows) before anything server-supplied is printed to the terminal. */
function sanitizeForTerminal(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, '');
}

const USER_CODE_RE = /^[A-Z]{4}-[A-Z]{4}$/;

/**
 * The browser url `blindkey connect` opens and prints (spec §2.3, F6): built locally as
 * `<profile url>/connect?code=<user_code>` — the server's own `verification_url` is never trusted
 * (not printed, not opened), so a hostile or misconfigured server can't point the user's browser
 * elsewhere. `user_code` must match the server's generation format (`XXXX-XXXX`, uppercase letters)
 * first — anything else could smuggle extra query/path characters into the url — and the profile url
 * must be http(s). Returns the canonical href, or `null` when either check fails.
 */
export function buildVerificationUrl(profileUrl: string, userCode: string): string | null {
  if (!USER_CODE_RE.test(userCode)) return null;
  let target: URL;
  try {
    target = new URL(`${profileUrl}/connect?code=${userCode}`);
  } catch {
    return null;
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return null;
  if (target.username !== '' || target.password !== '') return null;
  return target.href;
}

function sanitizeInterval(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : NaN;
  if (!Number.isFinite(n) || n < 1) return DEFAULT_INTERVAL_S;
  return Math.min(MAX_INTERVAL_S, Math.floor(n));
}

function sanitizeExpiresIn(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : NaN;
  if (!Number.isFinite(n) || n <= 0) return Math.floor(MAX_WAIT_MS / 1000);
  return n;
}

/**
 * Resolves which profile `blindkey connect` targets (spec §2.3): `--profile <name>` selects it (creating
 * it, and requiring `--url`, if it doesn't exist yet; refusing if `--url` is given but disagrees with
 * an existing profile's stored url — use `blindkey profile set-url` for that); with no `--profile`, the
 * repo's currently bound profile wins over the default profile, and a bare `--url` with no
 * `--profile` is refused (there is no name to store it under). All of these are configuration
 * refusals (`EXIT_REFUSED`), distinct from "no server configured at all" (`EXIT_AUTH`, matching
 * `resolveAgentConfig`/`bind` elsewhere in the CLI).
 */
function resolveProfile(opts: ConnectOptions, profiles: ProfilesFile, bindings: BindingsFile, cwd: string, dataDir: string): string {
  if (opts.profile) {
    const existing = profiles.profiles[opts.profile];
    if (existing) {
      if (opts.url && normalizeUrl(opts.url) !== existing.url) {
        throw new CliError(
          `profile "${opts.profile}" is already configured for ${existing.url} — use \`blindkey profile set-url ${opts.profile} <url>\` to change it`,
          EXIT_REFUSED,
        );
      }
      return opts.profile;
    }
    if (!opts.url) {
      throw new CliError(`profile "${opts.profile}" does not exist — pass --url to create it`, EXIT_REFUSED);
    }
    profiles.profiles[opts.profile] = { url: normalizeUrl(opts.url) };
    if (!profiles.default) profiles.default = opts.profile;
    saveProfiles(dataDir, profiles);
    return opts.profile;
  }
  if (opts.url) {
    throw new CliError('--url requires --profile <name>', EXIT_REFUSED);
  }
  const bound = bindings[repoKey(cwd)]?.profile;
  const profileName = bound && profiles.profiles[bound] ? bound : profiles.default;
  if (!profileName) {
    throw new CliError('no server configured — run `blindkey profile add <name> <url>`', EXIT_AUTH);
  }
  return profileName;
}

/**
 * `blindkey connect` (spec §1.3, §2.3): browser device flow. Starts a request, prints the verification
 * url + user code, best-effort opens the browser (only once the url passes strict validation), then
 * polls until approved/denied/expired or a ~10 minute timeout, storing the issued token in the OS
 * credential store — the token itself is never printed or included in the returned `CommandResult`.
 */
export async function runConnect(opts: ConnectOptions, deps: ConnectDeps): Promise<CommandResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const platform = deps.platform ?? process.platform;
  const openBrowserImpl = deps.openBrowserImpl ?? openBrowser;
  const now = deps.now ?? Date.now;
  const out = deps.out ?? process.stdout;

  const profiles = loadProfiles(deps.dataDir);
  const bindings = loadBindings(deps.dataDir);
  const profileName = resolveProfile(opts, profiles, bindings, deps.cwd, deps.dataDir);
  const profile = profiles.profiles[profileName];
  if (!profile) throw new CliError(`profile "${profileName}" does not exist — pass --url to create it`, EXIT_REFUSED);
  const url = profile.url;

  const binding = bindings[repoKey(deps.cwd)];
  const boundProject = binding && binding.profile === profileName ? binding.project : null;
  const known = profile.projects ?? [];
  const projects = Array.from(new Set([...(boundProject ? [boundProject] : []), ...known]));

  const name = `claude-${profileName}@${hostname()}`;

  const startRes = await fetchImpl(`${url}/api/v1/connect/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, scopes: AGENT_SCOPES, projects }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!startRes.ok) {
    const body = await readJson<ErrorBody>(startRes).catch(() => ({}) as ErrorBody);
    throw new CliError(`could not start connect: ${body.error ?? `HTTP ${startRes.status}`}`);
  }
  const start = await readJson<StartResponse>(startRes);
  if (typeof start.user_code !== 'string') {
    throw new CliError('server returned a malformed connect response (non-string user_code)');
  }

  // Built locally from the profile url — the server's `verification_url` is ignored (F6).
  const verificationUrl = buildVerificationUrl(url, start.user_code);
  if (verificationUrl) {
    out.write(`Open ${verificationUrl} and approve code ${start.user_code}\n`);
    openBrowserImpl(verificationUrl, platform);
  } else {
    out.write(`Open ${sanitizeForTerminal(`${url}/connect`)} and approve code ${sanitizeForTerminal(start.user_code)}\n`);
    out.write('warning: the server returned an unexpected code format — not opening a browser automatically\n');
  }

  const expiresInS = sanitizeExpiresIn(start.expires_in);
  const deadline = now() + Math.min(MAX_WAIT_MS, expiresInS * 1000);
  let interval = sanitizeInterval(start.interval);
  let result: PollSuccess | undefined;
  while (now() < deadline) {
    // Never sleep past the deadline (fix round 2, Important 2 follow-up): a capped-but-still-large
    // interval (or one grown by repeated backoff below) must not make the final wait overshoot the
    // point where this loop would otherwise have already given up.
    await sleep(Math.min(interval * 1000, deadline - now()));
    const pollRes = await fetchImpl(`${url}/api/v1/connect/poll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ device_code: start.device_code }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (pollRes.status === 200) {
      result = await readJson<PollSuccess>(pollRes);
      break;
    }
    if (pollRes.status === 428) continue; // authorization_pending — keep polling
    if (pollRes.status === 429) {
      interval = Math.min(MAX_INTERVAL_S, interval + SLOW_DOWN_BACKOFF_S); // rate limited — slow down, don't give up
      continue;
    }
    const body = await readJson<ErrorBody>(pollRes).catch(() => ({}) as ErrorBody);
    if (body.error === 'slow_down') {
      interval = Math.min(MAX_INTERVAL_S, interval + SLOW_DOWN_BACKOFF_S);
      continue;
    }
    if (pollRes.status === 403) throw new CliError('the connect request was denied', EXIT_AUTH);
    if (pollRes.status === 410) throw new CliError('the connect request expired — run `blindkey connect` again', EXIT_AUTH);
    throw new CliError(`connect failed: ${body.error ?? `HTTP ${pollRes.status}`}`, EXIT_AUTH);
  }
  if (!result) {
    throw new CliError('timed out waiting for approval — run `blindkey connect` again', EXIT_AUTH);
  }

  await deps.store.set(profileName, result.token);
  // Reload profiles.json right before writing back (fix round 1): polling can take minutes, during
  // which another process could have changed unrelated profiles — read-modify-write against a copy
  // loaded at the very start of this function would silently clobber those changes.
  const freshProfiles = loadProfiles(deps.dataDir);
  freshProfiles.profiles[profileName] = { url, projects: result.projects, expires_at: result.expires_at };
  saveProfiles(deps.dataDir, freshProfiles);

  return {
    json: { profile: profileName, name: result.name, scopes: result.scopes, projects: result.projects, expires_at: result.expires_at },
    text: [
      `connected as "${result.name}"`,
      `scopes: ${result.scopes.join(', ')}`,
      `projects: ${result.projects.length > 0 ? result.projects.join(', ') : '(none)'}`,
      `expires: ${result.expires_at === null ? 'never' : new Date(result.expires_at).toISOString()}`,
    ].join('\n'),
  };
}
