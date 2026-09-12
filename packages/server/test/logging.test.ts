import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import { openDb } from '../src/db/connection.js';
import { buildApp } from '../src/http/app.js';
import type { KeyRing } from '../src/config.js';
import type { FastifyInstance } from 'fastify';
import { makeTestApp, type TestCtx } from './helpers.js';

const SECRET_VALUE = 'hunter2-do-not-log-me';

/** Collects every line the logger writes. */
function sink(): { stream: Writable; lines: string[] } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(String(chunk));
      cb();
    },
  });
  return { stream, lines };
}

describe('logging', () => {
  let t: TestCtx;
  beforeAll(async () => {
    t = await makeTestApp();
  });
  afterAll(async () => {
    await t.app.close();
  });

  it('redacts a secret-bearing request body when something logs it', async () => {
    const { stream, lines } = sink();
    const db = openDb(':memory:');
    const ring: KeyRing = { current: 1, keys: new Map([[1, randomBytes(32)]]) };
    const app: FastifyInstance = await buildApp({ db, ring, logLevel: 'trace', loggerStream: stream });
    // The path must start with /api/ — anything else is a UI path, and the
    // admin-UI guard would redirect it to /login before the handler runs.
    app.post('/api/v1/__log-probe', { config: { public: true } }, async (req, reply) => {
      req.log.info({ body: req.body }, 'probe');
      return reply.send({ ok: true });
    });
    await app.inject({
      method: 'POST',
      url: '/api/v1/__log-probe',
      payload: { name: 'DB', password: SECRET_VALUE, value: SECRET_VALUE, fields: [{ key: 'password', value: SECRET_VALUE }] },
    });
    await app.close();
    const all = lines.join('\n');
    expect(all).toContain('probe');
    expect(all).not.toContain(SECRET_VALUE);
    expect(all).toContain('[Redacted]');
  });

  it('logs nothing containing a value for a real secrets request', async () => {
    const { stream, lines } = sink();
    const db = openDb(':memory:');
    const ring: KeyRing = { current: 1, keys: new Map([[1, randomBytes(32)]]) };
    const app: FastifyInstance = await buildApp({ db, ring, logLevel: 'trace', loggerStream: stream });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/secrets', // the global (project-less) secrets collection
      payload: { name: 'Cloudflare', fields: [{ key: 'api_key', value: SECRET_VALUE }] },
    });
    expect(res.statusCode).toBe(401); // no token: the route is never reached
    await app.close();
    expect(lines.join('\n')).not.toContain(SECRET_VALUE);
  });

  it('still redacts the authorization header and the cookie', async () => {
    const { stream, lines } = sink();
    const db = openDb(':memory:');
    const ring: KeyRing = { current: 1, keys: new Map([[1, randomBytes(32)]]) };
    const app: FastifyInstance = await buildApp({ db, ring, logLevel: 'trace', loggerStream: stream });
    await app.inject({
      method: 'GET',
      url: '/api/v1/projects',
      headers: { authorization: 'Bearer pidb_super-secret-token', cookie: 'pidb_session=abc123' },
    });
    await app.close();
    const all = lines.join('\n');
    expect(all).not.toContain('pidb_super-secret-token');
    expect(all).not.toContain('abc123');
  });
});
