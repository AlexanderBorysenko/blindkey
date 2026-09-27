import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../http/context.js';
import { changePassword } from '../../services/password.js';
import { adminActor, uiSessionId } from '../session.js';
import { assertCsrf } from '../csrf.js';
import { body, pageContext, str } from '../forms.js';
import { renderPage } from '../render.js';

export function registerPasswordRoutes(app: FastifyInstance, ctx: AppContext): void {
  // F5d: every settings POST is rate limited (spec §2.5).
  const limited = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

  app.get('/settings/password', async (req, reply) =>
    reply.status(200).type('text/html').send(renderPage('settings-password', { ...pageContext(ctx, req, 'Password'), error: null })));

  app.post('/settings/password', limited, async (req, reply) => {
    assertCsrf(ctx, req);
    const b = body(req);
    const result = await changePassword(
      ctx,
      adminActor(req),
      { current: str(b, 'current'), next: str(b, 'next'), confirm: str(b, 'confirm'), code: str(b, 'code') },
      uiSessionId(req) ?? '',
    );
    if (!result.ok) {
      return reply
        .status(result.status)
        .type('text/html')
        .send(renderPage('settings-password', { ...pageContext(ctx, req, 'Password'), error: result.error }));
    }
    return reply.redirect('/settings/password?done=saved', 303);
  });
}
