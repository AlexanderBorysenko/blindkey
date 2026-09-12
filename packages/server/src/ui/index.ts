import type { FastifyInstance } from 'fastify';
import formbody from '@fastify/formbody';
import fastifyStatic from '@fastify/static';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type { AppContext } from '../http/context.js';
import { PUBLIC_DIR } from './render.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerDocumentRoutes } from './routes/documents.js';
import { registerProjectRoutes } from './routes/projects.js';
import { registerSecretRoutes } from './routes/secrets.js';

const require = createRequire(import.meta.url);

/** Pico and htmx ship inside their packages; serve them from node_modules, never a CDN. */
function assetRoots(): string[] {
  return [
    PUBLIC_DIR,
    dirname(require.resolve('@picocss/pico/css/pico.min.css')),
    dirname(require.resolve('htmx.org/dist/htmx.min.js')),
  ];
}

export async function registerUi(app: FastifyInstance, ctx: AppContext): Promise<void> {
  await app.register(formbody);
  await app.register(fastifyStatic, {
    root: assetRoots(),
    prefix: '/assets/',
    decorateReply: false,
    cacheControl: true,
    maxAge: '1h',
    // Static assets carry no secrets and must load before a session exists.
    // @fastify/static@10 invokes setHeaders with the Fastify reply, not the
    // raw node response, so the header is set via reply.header(), not res.setHeader().
    setHeaders: (reply) => reply.header('x-content-type-options', 'nosniff'),
  });

  registerAuthRoutes(app, ctx);
  registerProjectRoutes(app, ctx);
  registerDocumentRoutes(app, ctx);
  registerSecretRoutes(app, ctx);
}
