import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Actor, Principal } from '../auth/principal.js';
import { UnauthorizedError } from '../errors.js';
import type { AppContext } from '../http/context.js';
import { getSession, purgeExpiredSessions } from '../repos/admin.js';
import { isUiRequest } from './render.js';

export const SESSION_COOKIE = 'pidb_session';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function uiSessionId(req: FastifyRequest): string | null {
  const raw = req.cookies?.[SESSION_COOKIE];
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

export function setSessionCookie(reply: FastifyReply, id: string, secure: boolean): void {
  reply.setCookie(SESSION_COOKIE, id, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure,
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

export function requireAdmin(req: FastifyRequest): Principal {
  const p = req.principal;
  if (!p || p.kind !== 'admin') throw new UnauthorizedError();
  return p;
}

export function adminActor(req: FastifyRequest): Actor {
  return { principal: requireAdmin(req), ip: req.ip, userAgent: req.headers['user-agent'] ?? '' };
}

/**
 * Resolves the session cookie into the same Principal the API uses, BEFORE the
 * bearer-token hook runs — that hook returns early when req.principal is set.
 */
export function registerSessionResolver(app: FastifyInstance, ctx: AppContext): void {
  let lastPurge = 0;
  app.addHook('onRequest', async (req) => {
    if (!isUiRequest(req.url)) return;
    const id = uiSessionId(req);
    if (!id) return;
    const nowTs = Date.now();
    if (nowTs - lastPurge > 60_000) {
      lastPurge = nowTs;
      purgeExpiredSessions(ctx.db);
    }
    const session = getSession(ctx.db, id);
    if (!session) return;
    req.principal = { kind: 'admin', id: session.admin_id, scopes: ['admin'], projectIds: null };
  });
}

/**
 * Anonymous UI page requests are sent to the login form instead of getting a
 * 401 JSON error. Registered as an onRequest hook in buildApp, between the
 * session resolver and registerAuth — onRequest hooks run before preHandler
 * hooks, and registerAuth's onRequest hook throws UnauthorizedError for every
 * non-public route, so this guard must run first to turn that into a redirect.
 */
export function registerUiGuard(app: FastifyInstance): void {
  app.addHook('onRequest', async (req, reply) => {
    if (!isUiRequest(req.url)) return;
    const path = req.url.split('?')[0] ?? '';
    if (path === '/login' || path.startsWith('/assets/')) return;
    if (req.principal?.kind === 'admin') return;
    return reply.redirect('/login', 302);
  });
}
