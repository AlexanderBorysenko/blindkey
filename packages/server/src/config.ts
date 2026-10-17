import { readFileSync } from 'node:fs';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface KeyRing {
  current: number;
  keys: Map<number, Buffer>;
}

export interface Config {
  host: string;
  port: number;
  dataDir: string;
  dbPath: string;
  keyRing: KeyRing;
  logLevel: string;
  trustProxy: boolean | string;
}

function parseKey(b64: string, label: string): Buffer {
  const buf = Buffer.from(b64.trim(), 'base64');
  if (buf.length !== 32) throw new ConfigError(`${label} must decode to 32 bytes (got ${buf.length})`);
  return buf;
}

function parseIntStrict(value: string, label: string): number {
  if (!/^\d+$/.test(value)) throw new ConfigError(`${label} must be an integer`);
  return Number.parseInt(value, 10);
}

function parseTrustProxy(value: string | undefined): boolean | string {
  if (!value || !value.trim()) return false;
  const v = value.trim();
  if (v === 'false') return false;
  if (v === 'true') return true;
  return v;
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  readFile: (path: string) => string = (p) => readFileSync(p, 'utf8'),
): Config {
  let raw = env.BLINDKEY_MASTER_KEY;
  if (!raw && env.BLINDKEY_MASTER_KEY_FILE) raw = readFile(env.BLINDKEY_MASTER_KEY_FILE);
  if (!raw || !raw.trim()) throw new ConfigError('BLINDKEY_MASTER_KEY or BLINDKEY_MASTER_KEY_FILE is required');

  const current = parseIntStrict(env.BLINDKEY_MASTER_KEY_VERSION ?? '1', 'BLINDKEY_MASTER_KEY_VERSION');
  if (current < 1) throw new ConfigError('BLINDKEY_MASTER_KEY_VERSION must be >= 1');

  const keys = new Map<number, Buffer>();
  keys.set(current, parseKey(raw, 'BLINDKEY_MASTER_KEY'));

  const previous = (env.BLINDKEY_MASTER_KEY_PREVIOUS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const entry of previous) {
    const idx = entry.indexOf(':');
    if (idx === -1) throw new ConfigError(`BLINDKEY_MASTER_KEY_PREVIOUS entry must be <version>:<base64>`);
    const version = parseIntStrict(entry.slice(0, idx), 'BLINDKEY_MASTER_KEY_PREVIOUS version');
    if (version < 1 || version >= current) {
      throw new ConfigError(`previous key version ${version} must be >= 1 and lower than current (${current})`);
    }
    if (keys.has(version)) {
      throw new ConfigError(`duplicate key version ${version} in BLINDKEY_MASTER_KEY_PREVIOUS`);
    }
    keys.set(version, parseKey(entry.slice(idx + 1), `BLINDKEY_MASTER_KEY_PREVIOUS[${version}]`));
  }

  const port = parseIntStrict(env.BLINDKEY_PORT ?? '8080', 'BLINDKEY_PORT');
  if (port < 1 || port > 65535) throw new ConfigError('BLINDKEY_PORT must be between 1 and 65535');
  const dataDir = env.BLINDKEY_DATA_DIR ?? '/data';

  return {
    host: env.BLINDKEY_HOST ?? '0.0.0.0',
    port,
    dataDir,
    dbPath: env.BLINDKEY_DB_PATH ?? `${dataDir}/blindkey.sqlite`,
    keyRing: { current, keys },
    logLevel: env.BLINDKEY_LOG_LEVEL ?? 'info',
    trustProxy: parseTrustProxy(env.BLINDKEY_TRUST_PROXY),
  };
}
