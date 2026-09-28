import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { openDb } from '../src/db/connection.js';
import { buildApp } from '../src/http/app.js';

async function appWith(trustProxy: boolean) {
  const db = openDb(':memory:');
  return buildApp({ db, ring: { current: 1, keys: new Map([[1, randomBytes(32)]]) }, logLevel: 'silent', trustProxy });
}

describe('HSTS', () => {
  it('is sent on HTTPS responses behind a trusted proxy', async () => {
    const app = await appWith(true);
    const res = await app.inject({ method: 'GET', url: '/health', headers: { 'x-forwarded-proto': 'https' } });
    expect(res.headers['strict-transport-security']).toBe('max-age=31536000');
  });

  it('is not sent over plain HTTP, nor when the proxy is not trusted', async () => {
    const trusted = await appWith(true);
    expect((await trusted.inject({ method: 'GET', url: '/health' })).headers['strict-transport-security']).toBeUndefined();
    const untrusted = await appWith(false);
    const res = await untrusted.inject({ method: 'GET', url: '/health', headers: { 'x-forwarded-proto': 'https' } });
    expect(res.headers['strict-transport-security']).toBeUndefined();
  });
});
