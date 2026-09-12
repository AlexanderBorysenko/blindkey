import type { FastifyInstance, FastifyRequest } from 'fastify';
import { SCOPES, tokenInputSchema } from '@pidb/shared';
import type { AppContext } from '../../http/context.js';
import { createTokenFor, listTokensFor, revokeTokenFor } from '../../services/admin.js';
import { listProjectsFor } from '../../services/projects.js';
import { adminActor, requireAdmin } from '../session.js';
import { assertCsrf } from '../csrf.js';
import { body, list, pageContext, parseTags, str } from '../forms.js';
import { renderPage } from '../render.js';

const DAY_MS = 86_400_000;

export function registerAdminRoutes(app: FastifyInstance, ctx: AppContext): void {
  const tokensPage = (req: FastifyRequest, extra: Record<string, unknown>) => {
    const principal = requireAdmin(req);
    return renderPage('tokens', {
      ...pageContext(ctx, req, 'Tokens'),
      tokens: listTokensFor(ctx, principal),
      scopes: SCOPES,
      projects: listProjectsFor(ctx, principal),
      created: null,
      error: null,
      ...extra,
    });
  };

  app.get('/tokens', async (req, reply) => reply.type('text/html').send(tokensPage(req, {})));

  app.post('/tokens', async (req, reply) => {
    assertCsrf(ctx, req);
    requireAdmin(req);
    const b = body(req);
    const days = str(b, 'days').trim();
    const projects = parseTags(b.projects);
    const scopes = list(b, 'scopes');
    if (scopes.length === 0) {
      return reply.status(400).type('text/html').send(tokensPage(req, { error: 'at least one scope is required' }));
    }
    const parsed = tokenInputSchema.safeParse({
      name: str(b, 'name'),
      scopes,
      projects: projects.length ? projects : null,
      expires_at: days ? Date.now() + Number(days) * DAY_MS : null,
    });
    if (!parsed.success) {
      const message = parsed.error.issues.map((i) => `${i.path.join('.') || 'form'}: ${i.message}`).join('; ');
      return reply.status(400).type('text/html').send(tokensPage(req, { error: message }));
    }
    const created = createTokenFor(ctx, adminActor(req), parsed.data);
    // The value is rendered exactly once, right here; it is never stored in plaintext.
    return reply.header('cache-control', 'no-store').type('text/html').send(tokensPage(req, { created }));
  });

  app.post<{ Params: { id: string } }>('/tokens/:id/revoke', async (req, reply) => {
    assertCsrf(ctx, req);
    requireAdmin(req);
    revokeTokenFor(ctx, adminActor(req), Number.parseInt(req.params.id, 10));
    return reply.redirect('/tokens', 302);
  });
}
