import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { AppError } from '../errors.js';
import type { AppContext } from './context.js';
import { registerAuth } from './auth.js';
import { registerHealthRoutes } from './routes/health.js';

export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: ctx.logLevel ?? 'info', redact: ['req.headers.authorization', 'req.headers.cookie'] },
    trustProxy: ctx.trustProxy ?? false,
  });

  await app.register(rateLimit, { global: false });
  registerAuth(app, ctx);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.status).send({ error: err.code, message: err.message, ...err.details });
    }
    const e = err as { statusCode?: number; message?: string };
    if (e.statusCode && e.statusCode < 500) {
      return reply.status(e.statusCode).send({ error: 'bad_request', message: e.message ?? 'bad request' });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({ error: 'internal' });
  });
  app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: 'not_found' }));

  registerHealthRoutes(app, ctx);
  return app;
}
