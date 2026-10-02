import { CliError, EXIT_AUTH } from '../errors.js';
import { resolveDataDir } from './datadir.js';
import { loadBindings, loadProfiles, repoKey } from './state.js';
import type { TokenStore } from './tokenstore.js';

export interface AgentConfig {
  profile: string;
  url: string;
  token: string;
  project: string | null;
}

export interface ResolveAgentConfigInput {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  store: TokenStore;
  /** Overrides the derived plugin data dir (tests; production derives it via `resolveDataDir`). */
  dataDir?: string;
}

/**
 * Resolves the effective server + token for agent-mode commands (spec §2.3):
 * the bound profile for `cwd`'s repo if one exists, else the default
 * profile; the token always comes from the OS credential store. `BLINDKEY_URL`/
 * `BLINDKEY_TOKEN` are never consulted here — agent mode ignores them entirely.
 */
export async function resolveAgentConfig(input: ResolveAgentConfigInput): Promise<AgentConfig> {
  const env = input.env ?? process.env;
  const dataDir = input.dataDir ?? resolveDataDir(env);
  const profiles = loadProfiles(dataDir);
  const bindings = loadBindings(dataDir);
  const binding = bindings[repoKey(input.cwd)];
  const profileName = binding?.profile ?? profiles.default;
  const profile = profileName ? profiles.profiles[profileName] : undefined;
  if (!profileName || !profile) {
    throw new CliError('no server configured — run `blindkey profile add <name> <url>`', EXIT_AUTH);
  }
  const token = await input.store.get(profileName);
  if (!token) {
    throw new CliError('not connected — run `blindkey connect`', EXIT_AUTH);
  }
  return { profile: profileName, url: profile.url, token, project: binding?.project ?? null };
}
