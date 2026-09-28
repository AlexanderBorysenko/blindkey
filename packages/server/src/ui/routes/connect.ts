import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from '../../http/context.js';
import { AppError } from '../../errors.js';
import { errorText } from '../forms.js';
import { approveConnect, denyConnect, viewConnectRequest } from '../../services/connect.js';
import { adminActor, requireAdmin } from '../session.js';
import { assertCsrf } from '../csrf.js';
import { body, list, pageContext, str } from '../forms.js';
import { renderPage } from '../render.js';

// spec §1.3: POST /connect/approve and /connect/deny are rate limited 10/min, same as other UI POSTs.
const limited = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

interface Selection {
  scopes: string[];
  projects: string[];
  expiresDays: string;
}

export function registerConnectRoutes(app: FastifyInstance, ctx: AppContext): void {
  const page = (req: FastifyRequest, code: string, error: string | null, status = 200, selected?: Selection) => {
    requireAdmin(req);
    const view = viewConnectRequest(ctx, code);
    // On a validation error the form is re-rendered with what the approver actually ticked
    // (Review: don't silently reset their selection back to the original request's checkboxes).
    const fallback: Selection | undefined =
      view.state === 'form' ? { scopes: view.row.scopes, projects: view.row.projects, expiresDays: String(view.row.expires_days) } : undefined;
    return {
      status,
      html: renderPage('connect', { ...pageContext(ctx, req, 'Connect'), ...view, code, error, selected: selected ?? fallback }),
    };
  };

  app.get<{ Querystring: { code?: string } }>('/connect', async (req, reply) => {
    const { status, html } = page(req, req.query.code ?? '', null);
    return reply.status(status).type('text/html').send(html);
  });

  app.post('/connect/approve', limited, async (req, reply) => {
    assertCsrf(ctx, req);
    const actor = adminActor(req);
    const b = body(req);
    const code = str(b, 'code');
    const scopes = list(b, 'scopes');
    const projects = list(b, 'projects');
    const expiresDays = str(b, 'expires_days');
    try {
      approveConnect(ctx, actor, code, scopes, projects, expiresDays);
    } catch (err) {
      if (err instanceof AppError && err.status < 500) {
        const { status, html } = page(req, code, errorText(err), err.status, { scopes, projects, expiresDays });
        return reply.status(status).type('text/html').send(html);
      }
      throw err;
    }
    return reply.redirect('/tokens?done=approved', 302);
  });

  app.post('/connect/deny', limited, async (req, reply) => {
    assertCsrf(ctx, req);
    const actor = adminActor(req);
    const b = body(req);
    const code = str(b, 'code');
    try {
      denyConnect(ctx, actor, code);
    } catch (err) {
      if (err instanceof AppError && err.status < 500) {
        const { status, html } = page(req, code, err.message, err.status);
        return reply.status(status).type('text/html').send(html);
      }
      throw err;
    }
    return reply.redirect('/tokens?done=denied', 302);
  });
}
