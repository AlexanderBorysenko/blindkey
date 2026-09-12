import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../../http/context.js';
import { getAdminByUsername, createSession, deleteSession } from '../../repos/admin.js';
import { verifyPassword } from '../../crypto/passwords.js';
import { writeAudit } from '../../repos/audit.js';
import { renderPage } from '../render.js';
import { assertCsrf } from '../csrf.js';
import { clearSessionCookie, setSessionCookie, uiSessionId, SESSION_TTL_MS } from '../session.js';

type LoginBody = { Body: { username?: string; password?: string } };

function isSecure(req: FastifyRequest): boolean {
  return req.protocol === 'https';
}

function loginPage(reply: FastifyReply, status: number, error: string | null): FastifyReply {
  return reply.status(status).type('text/html').send(renderPage('login', { title: 'Log in', nav: false, error }));
}

export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/login', { config: { public: true } }, async (_req, reply) => loginPage(reply, 200, null));

  app.post<LoginBody>(
    '/login',
    { config: { public: true, rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const username = (req.body?.username ?? '').trim();
      const password = req.body?.password ?? '';
      const ua = req.headers['user-agent'] ?? '';
      const admin = username ? getAdminByUsername(ctx.db, username) : null;
      const ok = admin ? await verifyPassword(admin.password_hash, password) : false;
      if (!admin || !ok) {
        writeAudit(ctx.db, {
          actor_type: 'admin',
          actor_id: admin?.id ?? null,
          action: 'auth.login_failed',
          ip: req.ip,
          user_agent: ua,
          meta: { username, via: 'ui' },
        });
        return loginPage(reply, 401, 'Invalid username or password.');
      }
      const id = createSession(ctx.db, admin.id, SESSION_TTL_MS, req.ip, ua);
      writeAudit(ctx.db, { actor_type: 'admin', actor_id: admin.id, action: 'auth.login', ip: req.ip, user_agent: ua, meta: { via: 'ui' } });
      setSessionCookie(reply, id, isSecure(req));
      return reply.redirect('/', 302);
    },
  );

  app.post('/logout', async (req, reply) => {
    assertCsrf(ctx, req);
    const id = uiSessionId(req);
    if (id) deleteSession(ctx.db, id);
    clearSessionCookie(reply);
    return reply.redirect('/login', 302);
  });
}
