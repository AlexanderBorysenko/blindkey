import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, statSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configPath, loadConfig, normalizeUrl, saveConfig } from '../src/config.js';
import { CliError } from '../src/errors.js';

let home: string;
const envWith = (extra: Record<string, string> = {}) => ({ PIDB_CONFIG_HOME: home, ...extra }) as NodeJS.ProcessEnv;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'pidb-cfg-'));
});

describe('normalizeUrl', () => {
  it('strips trailing slashes and whitespace', () => {
    expect(normalizeUrl('  https://pidb.example.com/  ')).toBe('https://pidb.example.com');
  });
  it('rejects non-http(s) urls', () => {
    expect(() => normalizeUrl('ftp://x/')).toThrow(/invalid server url|must be http/i);
    expect(() => normalizeUrl('not a url')).toThrow(CliError);
  });
});

describe('loadConfig', () => {
  it('reads the config file', () => {
    writeFileSync(configPath(envWith()), JSON.stringify({ url: 'http://localhost:8080/', token: 'pidb_file' }));
    expect(loadConfig(envWith())).toEqual({ url: 'http://localhost:8080', token: 'pidb_file' });
  });

  it('prefers env vars over the file, per field', () => {
    writeFileSync(configPath(envWith()), JSON.stringify({ url: 'http://file', token: 'pidb_file' }));
    expect(loadConfig(envWith({ PIDB_TOKEN: 'pidb_env' }))).toEqual({ url: 'http://file', token: 'pidb_env' });
    expect(loadConfig(envWith({ PIDB_URL: 'http://env' }))).toEqual({ url: 'http://env', token: 'pidb_file' });
  });

  it('exits 3 when nothing is configured', () => {
    try {
      loadConfig(envWith());
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).exitCode).toBe(3);
      expect((err as CliError).message).toMatch(/pidb login/);
    }
  });

  it('reports a corrupt config file', () => {
    writeFileSync(configPath(envWith()), '{not json');
    expect(() => loadConfig(envWith())).toThrow(/not valid JSON/);
  });
});

describe('saveConfig', () => {
  it('writes config.json with mode 0600 inside a 0700 directory', () => {
    const dir = join(home, 'nested');
    const env = { PIDB_CONFIG_HOME: dir } as NodeJS.ProcessEnv;
    const path = saveConfig({ url: 'https://pidb.example.com', token: 'pidb_abc' }, env);
    expect(path).toBe(join(dir, 'config.json'));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ url: 'https://pidb.example.com', token: 'pidb_abc' });
  });

  it('tightens the mode of a pre-existing world-readable file', () => {
    mkdirSync(join(home, 'd'), { recursive: true });
    const env = { PIDB_CONFIG_HOME: join(home, 'd') } as NodeJS.ProcessEnv;
    writeFileSync(join(home, 'd', 'config.json'), '{}', { mode: 0o644 });
    const path = saveConfig({ url: 'http://x', token: 't' }, env);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('tightens the mode of a pre-existing world-listable directory', () => {
    const dir = join(home, 'existing');
    mkdirSync(dir, { mode: 0o755 });
    chmodSync(dir, 0o755); // Ensure it's 0o755 regardless of umask
    const env = { PIDB_CONFIG_HOME: dir } as NodeJS.ProcessEnv;
    const path = saveConfig({ url: 'https://pidb.example.com', token: 'pidb_abc' }, env);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe('configPath', () => {
  it('falls back to XDG_CONFIG_HOME then HOME', () => {
    expect(configPath({ XDG_CONFIG_HOME: '/xdg' } as NodeJS.ProcessEnv)).toBe('/xdg/pidb/config.json');
    expect(configPath({ HOME: '/home/alex' } as NodeJS.ProcessEnv)).toBe('/home/alex/.config/pidb/config.json');
  });
});
