import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { loadConfig, ConfigError } from '../src/config.js';

const key = () => randomBytes(32).toString('base64');

describe('loadConfig', () => {
  it('throws without a master key', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
  });
  it('rejects a key that is not 32 bytes', () => {
    expect(() => loadConfig({ BLINDKEY_MASTER_KEY: randomBytes(16).toString('base64') })).toThrow(/32 bytes/);
  });
  it('loads key from env with defaults', () => {
    const k = key();
    const c = loadConfig({ BLINDKEY_MASTER_KEY: k });
    expect(c.keyRing.current).toBe(1);
    expect(c.keyRing.keys.get(1)?.toString('base64')).toBe(k);
    expect(c.port).toBe(8080);
    expect(c.host).toBe('0.0.0.0');
    expect(c.dataDir).toBe('/data');
    expect(c.dbPath).toBe('/data/blindkey.sqlite');
  });
  it('loads key from file via injected reader', () => {
    const k = key();
    const c = loadConfig({ BLINDKEY_MASTER_KEY_FILE: '/run/secrets/mk' }, (p) => (p === '/run/secrets/mk' ? k + '\n' : ''));
    expect(c.keyRing.keys.get(1)?.toString('base64')).toBe(k);
  });
  it('parses version and previous keys', () => {
    const k2 = key();
    const k1 = key();
    const c = loadConfig({ BLINDKEY_MASTER_KEY: k2, BLINDKEY_MASTER_KEY_VERSION: '2', BLINDKEY_MASTER_KEY_PREVIOUS: `1:${k1}` });
    expect(c.keyRing.current).toBe(2);
    expect(c.keyRing.keys.get(1)?.toString('base64')).toBe(k1);
    expect(c.keyRing.keys.get(2)?.toString('base64')).toBe(k2);
  });
  it('rejects previous key version >= current', () => {
    expect(() => loadConfig({ BLINDKEY_MASTER_KEY: key(), BLINDKEY_MASTER_KEY_PREVIOUS: `1:${key()}` })).toThrow(ConfigError);
  });
  it('honours BLINDKEY_PORT, BLINDKEY_DATA_DIR, BLINDKEY_DB_PATH', () => {
    const c = loadConfig({ BLINDKEY_MASTER_KEY: key(), BLINDKEY_PORT: '9000', BLINDKEY_DATA_DIR: '/tmp/x', BLINDKEY_DB_PATH: '/tmp/y.sqlite' });
    expect(c.port).toBe(9000);
    expect(c.dataDir).toBe('/tmp/x');
    expect(c.dbPath).toBe('/tmp/y.sqlite');
  });
  it('rejects port 0', () => {
    expect(() => loadConfig({ BLINDKEY_MASTER_KEY: key(), BLINDKEY_PORT: '0' })).toThrow(ConfigError);
  });
  it('rejects duplicate previous key versions', () => {
    expect(() => loadConfig({ BLINDKEY_MASTER_KEY: key(), BLINDKEY_MASTER_KEY_VERSION: '3', BLINDKEY_MASTER_KEY_PREVIOUS: `1:${key()},1:${key()}` })).toThrow(/duplicate/);
  });
  it('defaults trustProxy to false', () => {
    expect(loadConfig({ BLINDKEY_MASTER_KEY: key() }).trustProxy).toBe(false);
  });
  it('parses BLINDKEY_TRUST_PROXY=true as boolean true', () => {
    expect(loadConfig({ BLINDKEY_MASTER_KEY: key(), BLINDKEY_TRUST_PROXY: 'true' }).trustProxy).toBe(true);
  });
  it('parses BLINDKEY_TRUST_PROXY=false as boolean false', () => {
    expect(loadConfig({ BLINDKEY_MASTER_KEY: key(), BLINDKEY_TRUST_PROXY: 'false' }).trustProxy).toBe(false);
  });
  it('parses BLINDKEY_TRUST_PROXY as an IP/CIDR list string', () => {
    expect(loadConfig({ BLINDKEY_MASTER_KEY: key(), BLINDKEY_TRUST_PROXY: '127.0.0.1,10.0.0.0/8' }).trustProxy).toBe('127.0.0.1,10.0.0.0/8');
  });
});
