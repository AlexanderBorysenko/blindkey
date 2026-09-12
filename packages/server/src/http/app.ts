import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { AppError } from '../errors.js';
import type { AppContext } from './context.js';
import { registerAuth } from './auth.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerProjectRoutes } from './routes/projects.js';
import { registerDocumentRoutes } from './routes/documents.js';
import { registerSearchRoutes } from './routes/search.js';
import { registerSecretRoutes } from './routes/secrets.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerMcpRoutes } from './mcp.js';

export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: ctx.logLevel ?? 'info', redact: ['req.headers.authorization', 'req.headers.cookie'] },
    trustProxy: ctx.trustProxy ?? false,
    bodyLimit: 4 * 1024 * 1024,
  });

  await app.register(rateLimit, { global: false });
  registerAuth(app, ctx);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      if (err.status >= 500) {
        req.log.error({ err, code: err.code, ...err.details }, 'request failed');
        return reply.status(err.status).send({ error: err.code, ...err.details });
      }
      return reply.status(err.status).send({ error: err.code, message: err.message, ...err.details });
    }
    const e = err as { statusCode?: number; message?: string };
    if (e.statusCode && e.statusCode < 500) {
      const code =
        e.statusCode === 429
          ? 'rate_limited'
          : e.statusCode === 413
            ? 'payload_too_large'
            : e.statusCode === 415
              ? 'unsupported_media_type'
              : 'bad_request';
      return reply.status(e.statusCode).send({ error: code, message: e.message ?? 'bad request' });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({ error: 'internal' });
  });
  app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: 'not_found' }));

  registerHealthRoutes(app, ctx);
  registerProjectRoutes(app, ctx);
  registerDocumentRoutes(app, ctx);
  registerSearchRoutes(app, ctx);
  registerSecretRoutes(app, ctx);
  registerAdminRoutes(app, ctx);
  registerMcpRoutes(app, ctx);
  return app;
}
