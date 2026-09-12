import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { CliError, EXIT_AUTH } from './errors.js';

export interface CliConfig {
  url: string;
  token: string;
}

/**
 * PIDB_CONFIG_HOME is the config directory itself (used by tests and by anyone
 * keeping several profiles); XDG_CONFIG_HOME and HOME get the `pidb` suffix.
 */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PIDB_CONFIG_HOME) return env.PIDB_CONFIG_HOME;
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, 'pidb');
  return join(env.HOME ?? homedir(), '.config', 'pidb');
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), 'config.json');
}

export function normalizeUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new CliError(`invalid server url "${url}"`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new CliError(`invalid server url "${url}" — must be http:// or https://`);
  }
  return trimmed;
}

function readConfigFile(env: NodeJS.ProcessEnv): Partial<CliConfig> {
  const path = configPath(env);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CliError(`config file ${path} is not valid JSON`);
  }
  if (typeof parsed !== 'object' || parsed === null) throw new CliError(`config file ${path} is not valid JSON`);
  const o = parsed as Record<string, unknown>;
  const out: Partial<CliConfig> = {};
  if (typeof o.url === 'string') out.url = o.url;
  if (typeof o.token === 'string') out.token = o.token;
  return out;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CliConfig {
  const file = readConfigFile(env);
  const url = env.PIDB_URL ?? file.url;
  const token = env.PIDB_TOKEN ?? file.token;
  if (!url || !token) {
    throw new CliError('not configured — run `pidb login <url>`, or set PIDB_URL and PIDB_TOKEN', EXIT_AUTH);
  }
  return { url: normalizeUrl(url), token };
}

export function saveConfig(config: CliConfig, env: NodeJS.ProcessEnv = process.env): string {
  const path = configPath(env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700); // mkdirSync's mode is ignored when the directory already exists
  writeFileSync(path, `${JSON.stringify({ url: config.url, token: config.token }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600); // writeFileSync's mode is ignored when the file already exists
  return path;
}
