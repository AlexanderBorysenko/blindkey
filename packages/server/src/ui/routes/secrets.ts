import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../http/context.js';
import { getSecretFor, listSecretsFor, revealFieldFor } from '../../services/secrets.js';
import { adminActor, requireAdmin } from '../session.js';
import { assertCsrf } from '../csrf.js';
import { body, pageContext, str } from '../forms.js';
import { renderPage, renderPartial } from '../render.js';
import { scopeOf } from './documents.js';

type SecretParams = { Params: { slug?: string; name: string } };

export function registerSecretRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/global/secrets', async (req, reply) => {
    const principal = requireAdmin(req);
    return reply.type('text/html').send(
      renderPage('secrets', {
        ...pageContext(ctx, req, 'Global secrets'),
        prefix: '/global',
        secrets: listSecretsFor(ctx, principal, null),
      }),
    );
  });

  for (const base of ['/p/:slug/secrets', '/global/secrets']) {
    app.get<SecretParams>(`${base}/:name`, async (req, reply) => {
      const principal = requireAdmin(req);
      const scope = scopeOf(req.params);
      const secret = getSecretFor(ctx, principal, scope.projectSlug, req.params.name);
      return reply.type('text/html').send(
        renderPage('secret', {
          ...pageContext(ctx, req, secret.name),
          prefix: scope.prefix,
          scopeLabel: scope.projectSlug ?? 'global',
          secret,
        }),
      );
    });

    app.post<SecretParams>(`${base}/:name/reveal`, async (req, reply) => {
      assertCsrf(ctx, req);
      requireAdmin(req);
      const scope = scopeOf(req.params);
      const key = str(body(req), 'key');
      // One field per request: revealFieldFor writes the audit row for a sensitive read.
      const value = revealFieldFor(ctx, adminActor(req), scope.projectSlug, req.params.name, key);
      return reply
        .header('cache-control', 'no-store')
        .type('text/html')
        .send(renderPartial('revealed', { key, value }));
    });
  }
}
