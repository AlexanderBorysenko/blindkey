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
  trustProxy: boolean | number | string;
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

function parseTrustProxy(value: string | undefined): boolean | number | string {
  if (!value || !value.trim()) return false;
  const v = value.trim();
  if (v === 'false') return false;
  if (v === 'true') return true;
  if (/^\d+$/.test(v)) return Number.parseInt(v, 10);
  return v;
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  readFile: (path: string) => string = (p) => readFileSync(p, 'utf8'),
): Config {
  let raw = env.PIDB_MASTER_KEY;
  if (!raw && env.PIDB_MASTER_KEY_FILE) raw = readFile(env.PIDB_MASTER_KEY_FILE);
  if (!raw || !raw.trim()) throw new ConfigError('PIDB_MASTER_KEY or PIDB_MASTER_KEY_FILE is required');

  const current = parseIntStrict(env.PIDB_MASTER_KEY_VERSION ?? '1', 'PIDB_MASTER_KEY_VERSION');
  if (current < 1) throw new ConfigError('PIDB_MASTER_KEY_VERSION must be >= 1');

  const keys = new Map<number, Buffer>();
  keys.set(current, parseKey(raw, 'PIDB_MASTER_KEY'));

  const previous = (env.PIDB_MASTER_KEY_PREVIOUS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const entry of previous) {
    const idx = entry.indexOf(':');
    if (idx === -1) throw new ConfigError(`PIDB_MASTER_KEY_PREVIOUS entry must be <version>:<base64>`);
    const version = parseIntStrict(entry.slice(0, idx), 'PIDB_MASTER_KEY_PREVIOUS version');
    if (version < 1 || version >= current) {
      throw new ConfigError(`previous key version ${version} must be >= 1 and lower than current (${current})`);
    }
    if (keys.has(version)) {
      throw new ConfigError(`duplicate key version ${version} in PIDB_MASTER_KEY_PREVIOUS`);
    }
    keys.set(version, parseKey(entry.slice(idx + 1), `PIDB_MASTER_KEY_PREVIOUS[${version}]`));
  }

  const port = parseIntStrict(env.PIDB_PORT ?? '8080', 'PIDB_PORT');
  if (port < 1 || port > 65535) throw new ConfigError('PIDB_PORT must be between 1 and 65535');
  const dataDir = env.PIDB_DATA_DIR ?? '/data';

  return {
    host: env.PIDB_HOST ?? '0.0.0.0',
    port,
    dataDir,
    dbPath: env.PIDB_DB_PATH ?? `${dataDir}/pidb.sqlite`,
    keyRing: { current, keys },
    logLevel: env.PIDB_LOG_LEVEL ?? 'info',
    trustProxy: parseTrustProxy(env.PIDB_TRUST_PROXY),
  };
}
