import { createRequire } from 'node:module';
import { join } from 'node:path';
import { CliError } from '../errors.js';

export interface TokenStore {
  get(profile: string): Promise<string | null>;
  set(profile: string, token: string): Promise<void>;
  delete(profile: string): Promise<void>;
}

/** Keyring entry service (spec §2.2): service `blindkey`, account `profile:<name>`. */
const SERVICE = 'blindkey';
const account = (profile: string): string => `profile:${profile}`;

interface KeyringEntry {
  setPassword(password: string): void;
  getPassword(): string | null;
  deletePassword(): boolean;
}

interface KeyringModule {
  Entry: new (service: string, account: string) => KeyringEntry;
}

export type KeyringLoader = () => KeyringModule;

/**
 * Loads `@napi-rs/keyring` the way the shipped plugin bundle needs to: first
 * relative to the plugin data dir (where `npm install` puts the runtime
 * dependency on first run, per spec §2.1), then falling back to normal
 * module resolution (dev / monorepo, where it's an optionalDependency of
 * `@blindkey/cli` itself).
 */
function defaultLoader(dataDir: string): KeyringLoader {
  return () => {
    try {
      return createRequire(join(dataDir, 'package.json'))('@napi-rs/keyring') as KeyringModule;
    } catch {
      return createRequire(import.meta.url)('@napi-rs/keyring') as KeyringModule;
    }
  };
}

/** In-memory token store for tests — never touches the real OS keychain. */
export function memoryStore(initial: Record<string, string> = {}): TokenStore {
  const map = new Map(Object.entries(initial));
  return {
    async get(profile) {
      return map.get(profile) ?? null;
    },
    async set(profile, token) {
      map.set(profile, token);
    },
    async delete(profile) {
      map.delete(profile);
    },
  };
}

/** OS credential store (spec §2.2) — never a file fallback. */
export function keyringStore(dataDir: string, loader: KeyringLoader = defaultLoader(dataDir)): TokenStore {
  let mod: KeyringModule | undefined;
  function load(): KeyringModule {
    if (!mod) {
      try {
        mod = loader();
      } catch {
        throw new CliError('no OS credential store available — run a Claude Code session so the plugin installs its dependencies');
      }
    }
    return mod;
  }
  return {
    async get(profile) {
      const { Entry } = load();
      return new Entry(SERVICE, account(profile)).getPassword();
    },
    async set(profile, token) {
      const { Entry } = load();
      new Entry(SERVICE, account(profile)).setPassword(token);
    },
    async delete(profile) {
      const { Entry } = load();
      new Entry(SERVICE, account(profile)).deletePassword();
    },
  };
}
