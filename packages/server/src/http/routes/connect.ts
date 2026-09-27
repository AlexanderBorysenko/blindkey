import type { FastifyInstance, FastifyRequest } from 'fastify';
import { connectPollSchema, connectStartSchema } from '@pidb/shared';
import type { AppContext } from '../context.js';
import { parseBody } from '../helpers.js';
import { pollConnect, startConnect } from '../../services/connect.js';

/**
 * Honors `trustProxy` (set on the Fastify instance in buildApp): `req.protocol`/`req.host` already
 * reflect `X-Forwarded-Proto`/`X-Forwarded-Host` when the server trusts its proxy. `req.host` (not
 * `req.hostname`, which strips the port) is used deliberately: the verification URL must keep the
 * port the admin's browser needs to reach this server on.
 */
function originOf(req: FastifyRequest): string {
  return `${req.protocol}://${req.host}`;
}

export function registerConnectRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post(
    '/api/v1/connect/start',
    { config: { public: true, rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const input = parseBody(connectStartSchema, req.body);
      const result = startConnect(ctx, input, req.ip, req.headers['user-agent'] ?? '', originOf(req));
      return reply.status(201).send(result);
    },
  );

  app.post(
    '/api/v1/connect/poll',
    { config: { public: true, rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req) => {
      const input = parseBody(connectPollSchema, req.body);
      return pollConnect(ctx, input.device_code, req.ip, req.headers['user-agent'] ?? '');
    },
  );
}
