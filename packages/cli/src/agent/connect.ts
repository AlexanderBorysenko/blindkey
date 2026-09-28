import { hostname } from 'node:os';
import { AGENT_SCOPES, type Scope } from '@pidb/shared';
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

/** Hard cap on how long `pidb connect` waits for approval, regardless of the server's `expires_in` (spec §2.3). */
const MAX_WAIT_MS = 10 * 60_000;
/** Fallback poll interval (seconds) when the server omits `interval` or sends something unusable. */
const DEFAULT_INTERVAL_S = 5;
/** Backoff added to the poll interval (seconds) on a `429`/`slow_down` response. */
const SLOW_DOWN_BACKOFF_S = 5;
/** Per-request network timeout — a hung connect/poll request must not block the CLI forever. */
const REQUEST_TIMEOUT_MS = 15_000;

async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/** Strips control characters (including ANSI escapes) before anything server-supplied is printed
 * to the terminal — a compromised/misbehaving server must not be able to smuggle escape sequences
 * or spoof extra lines into the CLI's own output. */
function sanitizeForTerminal(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
}

const USER_CODE_RE = /^[A-Z]{4}-[A-Z]{4}$/;

/**
 * Strict allowlist check (fix round 1, Critical 2) before ever opening a browser to a
 * server-supplied url: http(s) only, same origin as the profile's own configured server, path
 * exactly `/connect`, query exactly `?code=<the code we were just given>`, and the code itself
 * matches the server's own generation format. Anything else is refused — the verification line is
 * still printed (sanitized) so the user can decide for themselves whether to open it.
 */
export function isSafeVerificationUrl(rawUrl: string, userCode: string, profileUrl: string): boolean {
  if (!USER_CODE_RE.test(userCode)) return false;
  let target: URL;
  let origin: URL;
  try {
    target = new URL(rawUrl);
    origin = new URL(profileUrl);
  } catch {
    return false;
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return false;
  if (target.origin !== origin.origin) return false;
  if (target.pathname !== '/connect') return false;
  if (target.search !== `?code=${userCode}`) return false;
  return true;
}

function sanitizeInterval(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : NaN;
  if (!Number.isFinite(n) || n < 1) return DEFAULT_INTERVAL_S;
  return Math.floor(n);
}

function sanitizeExpiresIn(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : NaN;
  if (!Number.isFinite(n) || n <= 0) return Math.floor(MAX_WAIT_MS / 1000);
  return n;
}

/**
 * Resolves which profile `pidb connect` targets (spec §2.3): `--profile <name>` selects it (creating
 * it, and requiring `--url`, if it doesn't exist yet; refusing if `--url` is given but disagrees with
 * an existing profile's stored url — use `pidb profile set-url` for that); with no `--profile`, the
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
          `profile "${opts.profile}" is already configured for ${existing.url} — use \`pidb profile set-url ${opts.profile} <url>\` to change it`,
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
    throw new CliError('no server configured — run `pidb profile add <name> <url>`', EXIT_AUTH);
  }
  return profileName;
}

/**
 * `pidb connect` (spec §1.3, §2.3): browser device flow. Starts a request, prints the verification
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

  out.write(`Open ${sanitizeForTerminal(start.verification_url)} and approve code ${sanitizeForTerminal(start.user_code)}\n`);
  if (isSafeVerificationUrl(start.verification_url, start.user_code, url)) {
    openBrowserImpl(start.verification_url, platform);
  } else {
    out.write('warning: the server-provided verification url looks unexpected — not opening a browser automatically\n');
  }

  const expiresInS = sanitizeExpiresIn(start.expires_in);
  const deadline = now() + Math.min(MAX_WAIT_MS, expiresInS * 1000);
  let interval = sanitizeInterval(start.interval);
  let result: PollSuccess | undefined;
  while (now() < deadline) {
    await sleep(interval * 1000);
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
      interval += SLOW_DOWN_BACKOFF_S; // rate limited — slow down, don't give up
      continue;
    }
    const body = await readJson<ErrorBody>(pollRes).catch(() => ({}) as ErrorBody);
    if (body.error === 'slow_down') {
      interval += SLOW_DOWN_BACKOFF_S;
      continue;
    }
    if (pollRes.status === 403) throw new CliError('the connect request was denied', EXIT_AUTH);
    if (pollRes.status === 410) throw new CliError('the connect request expired — run `pidb connect` again', EXIT_AUTH);
    throw new CliError(`connect failed: ${body.error ?? `HTTP ${pollRes.status}`}`, EXIT_AUTH);
  }
  if (!result) {
    throw new CliError('timed out waiting for approval — run `pidb connect` again', EXIT_AUTH);
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
