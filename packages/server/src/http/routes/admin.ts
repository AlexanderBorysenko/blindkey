import type { FastifyInstance } from 'fastify';
import { authTokenRequestSchema, tokenInputSchema } from '@pidb/shared';
import type { AppContext } from '../context.js';
import { actorOf, parseBody, principalOf } from '../helpers.js';
import { UnauthorizedError, ValidationError } from '../../errors.js';
import { createTokenFor, exchangePassword, listAuditFor, listTokensFor, revokeTokenFor } from '../../services/admin.js';

type AuditQs = { Querystring: { limit?: string; before?: string; action?: string; actor?: string } };

function optInt(v: string | undefined, name: string): number | undefined {
  if (v === undefined) return undefined;
  if (!/^\d+$/.test(v)) throw new ValidationError([{ path: [name], message: 'must be an integer' }]);
  return Number.parseInt(v, 10);
}

export function registerAdminRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/v1/tokens', async (req) => listTokensFor(ctx, principalOf(req)));

  app.post('/api/v1/tokens', async (req, reply) => {
    const input = parseBody(tokenInputSchema, req.body);
    return reply.status(201).send(createTokenFor(ctx, actorOf(req), input));
  });

  app.delete<{ Params: { id: string } }>('/api/v1/tokens/:id', async (req, reply) => {
    const id = optInt(req.params.id, 'id') ?? -1;
    revokeTokenFor(ctx, actorOf(req), id);
    return reply.status(204).send();
  });

  app.get<AuditQs>('/api/v1/audit', async (req) =>
    listAuditFor(ctx, principalOf(req), {
      limit: optInt(req.query.limit, 'limit'),
      before: optInt(req.query.before, 'before'),
      action: req.query.action,
      actorType: req.query.actor,
    }),
  );

  app.post(
    '/api/v1/auth/token',
    { config: { public: true, rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const input = parseBody(authTokenRequestSchema, req.body);
      const result = await exchangePassword(ctx, input, req.ip, req.headers['user-agent'] ?? '');
      if (!result) throw new UnauthorizedError('invalid credentials');
      return reply.status(201).send(result);
    },
  );
}
