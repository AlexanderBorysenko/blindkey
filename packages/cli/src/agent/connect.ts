import { hostname } from 'node:os';
import { AGENT_SCOPES, type Scope } from '@pidb/shared';
import { CliError, EXIT_AUTH } from '../errors.js';
import { normalizeUrl } from '../config.js';
import type { CommandResult } from '../output.js';
import { openBrowser } from './browser.js';
import { loadBindings, loadProfiles, repoKey, saveProfiles, type ProfilesFile } from './state.js';
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
  expires_at: number;
}

interface ErrorBody {
  error?: string;
  message?: string;
}

/** Hard cap on how long `pidb connect` waits for approval, regardless of the server's `expires_in` (spec §2.3). */
const MAX_WAIT_MS = 10 * 60_000;

async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

function resolveProfile(opts: ConnectOptions, profiles: ProfilesFile, dataDir: string): string {
  if (opts.profile) {
    if (!profiles.profiles[opts.profile]) {
      if (!opts.url) {
        throw new CliError(`profile "${opts.profile}" does not exist — pass --url to create it`, EXIT_AUTH);
      }
      profiles.profiles[opts.profile] = { url: normalizeUrl(opts.url) };
      if (!profiles.default) profiles.default = opts.profile;
      saveProfiles(dataDir, profiles);
    }
    return opts.profile;
  }
  if (!profiles.default) {
    throw new CliError('no server configured — run `pidb profile add <name> <url>`', EXIT_AUTH);
  }
  return profiles.default;
}

/**
 * `pidb connect` (spec §1.3, §2.3): browser device flow. Starts a request, prints the verification
 * url + user code, best-effort opens the browser, then polls until approved/denied/expired or a
 * ~10 minute timeout, storing the issued token in the OS credential store — the token itself is
 * never printed or included in the returned `CommandResult`.
 */
export async function runConnect(opts: ConnectOptions, deps: ConnectDeps): Promise<CommandResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const platform = deps.platform ?? process.platform;
  const openBrowserImpl = deps.openBrowserImpl ?? openBrowser;
  const now = deps.now ?? Date.now;
  const out = deps.out ?? process.stdout;

  const profiles = loadProfiles(deps.dataDir);
  const profileName = resolveProfile(opts, profiles, deps.dataDir);
  const profile = profiles.profiles[profileName];
  if (!profile) throw new CliError(`profile "${profileName}" does not exist — pass --url to create it`, EXIT_AUTH);
  const url = profile.url;

  const bindings = loadBindings(deps.dataDir);
  const binding = bindings[repoKey(deps.cwd)];
  const boundProject = binding && binding.profile === profileName ? binding.project : null;
  const known = profile.projects ?? [];
  const projects = Array.from(new Set([...(boundProject ? [boundProject] : []), ...known]));

  const name = `claude-${profileName}@${hostname()}`;

  const startRes = await fetchImpl(`${url}/api/v1/connect/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, scopes: AGENT_SCOPES, projects }),
  });
  if (!startRes.ok) {
    const body = await readJson<ErrorBody>(startRes).catch(() => ({}) as ErrorBody);
    throw new CliError(`could not start connect: ${body.error ?? `HTTP ${startRes.status}`}`);
  }
  const start = await readJson<StartResponse>(startRes);

  out.write(`Open ${start.verification_url} and approve code ${start.user_code}\n`);
  openBrowserImpl(start.verification_url, platform);

  const deadline = now() + Math.min(MAX_WAIT_MS, start.expires_in * 1000);
  let result: PollSuccess | undefined;
  while (now() < deadline) {
    await sleep(start.interval * 1000);
    const pollRes = await fetchImpl(`${url}/api/v1/connect/poll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ device_code: start.device_code }),
    });
    if (pollRes.status === 200) {
      result = await readJson<PollSuccess>(pollRes);
      break;
    }
    if (pollRes.status === 428) continue; // authorization_pending — keep polling
    const body = await readJson<ErrorBody>(pollRes).catch(() => ({}) as ErrorBody);
    if (pollRes.status === 403) throw new CliError('the connect request was denied', EXIT_AUTH);
    if (pollRes.status === 410) throw new CliError('the connect request expired — run `pidb connect` again', EXIT_AUTH);
    throw new CliError(`connect failed: ${body.error ?? `HTTP ${pollRes.status}`}`, EXIT_AUTH);
  }
  if (!result) {
    throw new CliError('timed out waiting for approval — run `pidb connect` again', EXIT_AUTH);
  }

  await deps.store.set(profileName, result.token);
  profiles.profiles[profileName] = { url, projects: result.projects, expires_at: result.expires_at };
  saveProfiles(deps.dataDir, profiles);

  return {
    json: { profile: profileName, name: result.name, scopes: result.scopes, projects: result.projects, expires_at: result.expires_at },
    text: [
      `connected as "${result.name}"`,
      `scopes: ${result.scopes.join(', ')}`,
      `projects: ${result.projects.length > 0 ? result.projects.join(', ') : '(none)'}`,
      `expires: ${new Date(result.expires_at).toISOString()}`,
    ].join('\n'),
  };
}
