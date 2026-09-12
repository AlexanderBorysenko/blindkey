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
    const all = lines.join('\n');
    expect(all).toContain('incoming request');
    expect(all).not.toContain(SECRET_VALUE);
  });

  it('still redacts the authorization header and the cookie', async () => {
    const { stream, lines } = sink();
    const db = openDb(':memory:');
    const ring: KeyRing = { current: 1, keys: new Map([[1, randomBytes(32)]]) };
    const app: FastifyInstance = await buildApp({ db, ring, logLevel: 'trace', loggerStream: stream });
    // The path must start with /api/ — anything else is a UI path, and the
    // admin-UI guard would redirect it to /login before the handler runs.
    // Fastify's default `req` serializer only emits method/url/host/remoteAddress/
    // remotePort and drops headers entirely, so headers never reach a log line
    // through the normal request log — this probe logs them explicitly through a
    // child logger whose `req` serializer is the identity function, so the root
    // logger's redact config still applies to the object we hand it.
    app.post('/api/v1/__header-probe', { config: { public: true } }, async (req, reply) => {
      req.log.child({}, { serializers: { req: (r: unknown) => r } }).info({ req: { headers: req.headers } }, 'header-probe');
      return reply.send({ ok: true });
    });
    await app.inject({
      method: 'POST',
      url: '/api/v1/__header-probe',
      headers: { authorization: 'Bearer pidb_super-secret-token', cookie: 'pidb_session=abc123' },
    });
    await app.close();
    const all = lines.join('\n');
    expect(all).toContain('header-probe');
    expect(all).toContain('[Redacted]');
    expect(all).not.toContain('pidb_super-secret-token');
    expect(all).not.toContain('abc123');
  });
});
