import type { FastifyInstance, FastifyRequest } from 'fastify';
import { SCOPES, tokenInputSchema } from '@pidb/shared';
import type { AppContext } from '../../http/context.js';
import { createTokenFor, listAuditFor, listPendingAgentTokensFor, listTokensFor, renameTokenFor, revokeTokenFor, updateTokenProjectsFor } from '../../services/admin.js';
import { AppError } from '../../errors.js';
import { listProjectsFor } from '../../services/projects.js';
import { adminActor, requireAdmin } from '../session.js';
import { assertCsrf } from '../csrf.js';
import { body, bool, errorText, list, pageContext, parseTags, str } from '../forms.js';
import { renderPage } from '../render.js';
import { DAY_MS } from '../../repos/tokens.js';

export function registerAdminRoutes(app: FastifyInstance, ctx: AppContext): void {
  const tokensPage = (req: FastifyRequest, extra: Record<string, unknown>) => {
    const principal = requireAdmin(req);
    return renderPage('tokens', {
      ...pageContext(ctx, req, 'Tokens'),
      tokens: listTokensFor(ctx, principal),
      pending: listPendingAgentTokensFor(ctx, principal),
      scopes: SCOPES,
      projects: listProjectsFor(ctx, principal),
      created: null,
      error: null,
      listError: null,
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
    // Three cases: the "never expires" checkbox forces null; a whole number of days (greater
    // than zero) becomes an explicit expiry — Date.now() + n * DAY_MS stays a valid positive
    // epoch-ms for a negative or zero n, so tokenInputSchema's z.number().int().positive()
    // cannot catch an already-expired or dead-on-arrival token on its own, so that is rejected
    // here, before the arithmetic; and empty/absent leaves expires_at omitted, so the service
    // applies its default lifetime (90 days).
    const never = bool(b, 'never');
    let expiresAt: number | null | undefined;
    if (never) {
      expiresAt = null;
    } else if (days) {
      const n = Number(days);
      if (!Number.isInteger(n) || n <= 0) {
        return reply.status(400).type('text/html').send(tokensPage(req, { error: 'Expiry must be a whole number of days greater than zero.' }));
      }
      expiresAt = Date.now() + n * DAY_MS;
    } else {
      expiresAt = undefined; // service default (90 days)
    }
    const parsed = tokenInputSchema.safeParse({
      name: str(b, 'name'),
      scopes,
      projects: projects.length ? projects : null,
      ...(expiresAt === undefined ? {} : { expires_at: expiresAt }),
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
    return reply.redirect('/tokens?done=revoked', 302);
  });

  app.post<{ Params: { id: string } }>('/tokens/:id/projects', async (req, reply) => {
    assertCsrf(ctx, req);
    requireAdmin(req);
    const b = body(req);
    const projects = bool(b, 'all') ? null : list(b, 'projects');
    try {
      updateTokenProjectsFor(ctx, adminActor(req), Number.parseInt(req.params.id, 10), projects);
    } catch (err) {
      if (err instanceof AppError && err.status < 500) {
        return reply.status(err.status).type('text/html').send(tokensPage(req, { listError: errorText(err) }));
      }
      throw err;
    }
    return reply.redirect('/tokens?done=saved', 302);
  });

  app.post<{ Params: { id: string } }>('/tokens/:id/label', async (req, reply) => {
    assertCsrf(ctx, req);
    requireAdmin(req);
    try {
      renameTokenFor(ctx, adminActor(req), Number.parseInt(req.params.id, 10), str(body(req), 'label'));
    } catch (err) {
      if (err instanceof AppError && err.status < 500) {
        return reply.status(err.status).type('text/html').send(tokensPage(req, { listError: errorText(err) }));
      }
      throw err;
    }
    return reply.redirect('/tokens?done=saved', 302);
  });

  type AuditQs = { Querystring: { limit?: string; before?: string; action?: string; actor?: string } };

  app.get<AuditQs>('/audit', async (req, reply) => {
    const principal = requireAdmin(req);
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit ?? '50', 10) || 50, 1), 200);
    const before = req.query.before ? Number.parseInt(req.query.before, 10) : undefined;
    // A junk cursor (NaN) or a non-positive one both degrade to "no cursor" rather than
    // producing a confusing page: audit ids are positive, so `id < 0` would just come back empty.
    const validBefore = before !== undefined && Number.isFinite(before) && before > 0 ? before : undefined;
    const action = req.query.action ?? '';
    const actor = req.query.actor ?? '';
    const rows = listAuditFor(ctx, principal, {
      limit,
      before: validBefore,
      action: action || undefined,
      actorType: actor || undefined,
    });
    const last = rows.at(-1);
    const query = new URLSearchParams();
    if (limit !== 50) query.set('limit', String(limit));
    if (action) query.set('action', action);
    if (actor) query.set('actor', actor);
    const olderQuery = new URLSearchParams(query);
    if (last) olderQuery.set('before', String(last.id));
    return reply.type('text/html').send(
      renderPage('audit', {
        ...pageContext(ctx, req, 'Audit log'),
        rows,
        limit,
        action,
        actor,
        olderHref: rows.length === limit && last ? `/audit?${olderQuery.toString()}` : null,
        resetHref: `/audit?${query.toString()}`,
      }),
    );
  });
}
