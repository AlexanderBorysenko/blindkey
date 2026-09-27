import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import cookie from '@fastify/cookie';
import { AppError } from '../errors.js';
import type { AppContext } from './context.js';
import { registerAuth } from './auth.js';
import { registerSessionResolver, registerUiGuard } from '../ui/session.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerProjectRoutes } from './routes/projects.js';
import { registerDocumentRoutes } from './routes/documents.js';
import { registerSearchRoutes } from './routes/search.js';
import { registerSecretRoutes } from './routes/secrets.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerMcpRoutes } from './mcp.js';
import { registerUi } from '../ui/index.js';
import { isUiRequest, renderPage } from '../ui/render.js';

export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: ctx.logLevel ?? 'info',
      // Secret material must never reach a log line (spec §12): credentials in
      // headers, and the value-bearing paths of every secrets request body.
      // The MCP JSON-RPC surface carries the same fields nested one level
      // deeper under params.arguments (spec §5).
      redact: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.body.password',
        'req.body.value',
        'req.body.fields',
        'req.body.*.value',
        'req.body.totp',
        'req.body.code',
        'req.body.params.arguments.value',
        'req.body.params.arguments.fields',
        'req.body.params.arguments.password',
        'req.body.params.arguments.totp',
        'req.body.params.arguments.code',
        'body.password',
        'body.value',
        'body.fields',
        'body.totp',
        'body.code',
        'body.params.arguments.value',
        'body.params.arguments.fields',
        'body.params.arguments.password',
        'body.params.arguments.totp',
        'body.params.arguments.code',
      ],
      ...(ctx.loggerStream ? { stream: ctx.loggerStream } : {}),
    },
    trustProxy: ctx.trustProxy ?? false,
    bodyLimit: 4 * 1024 * 1024,
  });

  await app.register(rateLimit, { global: false });
  await app.register(cookie);
  registerSessionResolver(app, ctx);
  registerUiGuard(app);
  registerAuth(app, ctx);
  await registerUi(app, ctx);

  app.setErrorHandler((err, req, reply) => {
    const ui = isUiRequest(req.url);
    if (err instanceof AppError) {
      if (err.status >= 500) {
        req.log.error({ err, code: err.code, ...err.details }, 'request failed');
        return ui
          ? reply.status(err.status).type('text/html').send(renderPage('error', { title: 'Error', code: err.code, message: 'Something went wrong.' }))
          : reply.status(err.status).send({ error: err.code, ...err.details });
      }
      return ui
        ? reply.status(err.status).type('text/html').send(renderPage('error', { title: 'Error', code: err.code, message: err.message }))
        : reply.status(err.status).send({ error: err.code, message: err.message, ...err.details });
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
      return ui
        ? reply.status(e.statusCode).type('text/html').send(renderPage('error', { title: 'Error', code, message: e.message ?? 'bad request' }))
        : reply.status(e.statusCode).send({ error: code, message: e.message ?? 'bad request' });
    }
    req.log.error({ err }, 'unhandled error');
    return ui
      ? reply.status(500).type('text/html').send(renderPage('error', { title: 'Error', code: 'internal', message: 'Something went wrong.' }))
      : reply.status(500).send({ error: 'internal' });
  });
  app.setNotFoundHandler((req, reply) =>
    isUiRequest(req.url)
      ? reply.status(404).type('text/html').send(renderPage('error', { title: 'Not found', code: 'not_found', message: 'That page was not found.' }))
      : reply.status(404).send({ error: 'not_found' }),
  );

  registerHealthRoutes(app, ctx);
  registerProjectRoutes(app, ctx);
  registerDocumentRoutes(app, ctx);
  registerSearchRoutes(app, ctx);
  registerSecretRoutes(app, ctx);
  registerAdminRoutes(app, ctx);
  registerMcpRoutes(app, ctx);
  return app;
}
