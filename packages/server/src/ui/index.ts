import type { FastifyInstance } from 'fastify';
import formbody from '@fastify/formbody';
import fastifyStatic from '@fastify/static';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { AppContext } from '../http/context.js';
import { PUBLIC_DIR, isUiRequest } from './render.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerConnectRoutes } from './routes/connect.js';
import { registerDocumentRoutes } from './routes/documents.js';
import { registerPasswordRoutes } from './routes/password.js';
import { registerProjectRoutes } from './routes/projects.js';
import { registerSecretRoutes } from './routes/secrets.js';
import { registerTwoFactorRoutes } from './routes/twofactor.js';

const require = createRequire(import.meta.url);

/** htmx and the Plex fonts ship inside their packages; serve them from node_modules, never a CDN. */
function assetRoots(): string[] {
  return [PUBLIC_DIR, dirname(require.resolve('htmx.org/dist/htmx.min.js'))];
}

export async function registerUi(app: FastifyInstance, ctx: AppContext): Promise<void> {
  // The UI serves its own scripts and styles only; htmx and the Plex fonts come from /assets.
  // No inline scripts, handlers or style attributes are ever rendered: all client behaviour
  // lives in the delegated, CSP-safe /assets/app.js (see src/ui/public/app.js).
  const CSP = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "object-src 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join('; ');

  app.addHook('onSend', async (req, reply, payload) => {
    if (!isUiRequest(req.url)) return payload;
    reply.header('content-security-policy', CSP);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'same-origin');
    reply.header('x-frame-options', 'DENY');
    // Every UI page can show session-specific or sensitive content, so none of them may sit
    // in a shared cache; only the static assets under /assets/ (fonts, CSS, htmx, app.js) are
    // safe to cache and keep their own cache-control set by @fastify/static above.
    const path = req.url.split('?')[0] ?? '';
    if (!path.startsWith('/assets/')) reply.header('cache-control', 'no-store');
    return payload;
  });

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

  // @fontsource/ibm-plex-sans and @fontsource/ibm-plex-mono both ship a files/ directory
  // with overlapping file names, so they cannot share one static root with PUBLIC_DIR.
  await app.register(fastifyStatic, {
    root: join(dirname(require.resolve('@fontsource/ibm-plex-sans/package.json')), 'files'),
    prefix: '/assets/fonts/plex-sans/',
    decorateReply: false,
    cacheControl: true,
    maxAge: '1h',
    setHeaders: (reply) => reply.header('x-content-type-options', 'nosniff'),
  });
  await app.register(fastifyStatic, {
    root: join(dirname(require.resolve('@fontsource/ibm-plex-mono/package.json')), 'files'),
    prefix: '/assets/fonts/plex-mono/',
    decorateReply: false,
    cacheControl: true,
    maxAge: '1h',
    setHeaders: (reply) => reply.header('x-content-type-options', 'nosniff'),
  });

  registerAuthRoutes(app, ctx);
  registerConnectRoutes(app, ctx);
  registerProjectRoutes(app, ctx);
  registerDocumentRoutes(app, ctx);
  registerSecretRoutes(app, ctx);
  registerAdminRoutes(app, ctx);
  registerTwoFactorRoutes(app, ctx);
  registerPasswordRoutes(app, ctx);
}
