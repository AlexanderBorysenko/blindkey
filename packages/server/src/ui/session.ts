import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Actor, Principal } from '../auth/principal.js';
import { UnauthorizedError } from '../errors.js';
import type { AppContext } from '../http/context.js';
import { getSession, purgeExpiredSessions } from '../repos/admin.js';
import { isUiRequest } from './render.js';

export const SESSION_COOKIE = 'blindkey_session';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const CHALLENGE_COOKIE = 'blindkey_2fa';
export const CHALLENGE_TTL_S = 300;

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

export function setChallengeCookie(reply: FastifyReply, id: string, secure: boolean): void {
  reply.setCookie(CHALLENGE_COOKIE, id, { path: '/login', httpOnly: true, sameSite: 'lax', secure, maxAge: CHALLENGE_TTL_S });
}

export function clearChallengeCookie(reply: FastifyReply): void {
  reply.clearCookie(CHALLENGE_COOKIE, { path: '/login' });
}

export function requireAdmin(req: FastifyRequest): Principal {
  const p = req.principal;
  if (!p || p.kind !== 'admin') throw new UnauthorizedError();
  return p;
}

export function adminActor(req: FastifyRequest): Actor {
  return { principal: requireAdmin(req), ip: req.ip, userAgent: req.headers['user-agent'] ?? '' };
}

const SAFE_NEXT_RE = /^\/connect(?:[/?]|$)/;
// Printable ASCII only (0x21-0x7e): excludes every control character (0x00-0x20, including
// space), DEL (0x7f), and anything above 0xff — a DEL or non-ASCII byte in the Location header
// otherwise makes Node's http module throw ERR_INVALID_CHAR, turning a bad `next` into a 500.
const PRINTABLE_ASCII_RE = /^[\x21-\x7e]+$/;

/**
 * A `next` redirect target is accepted only when it is a same-origin relative path that starts
 * with `/connect` (spec §1.3: the only flow that needs to survive the login/2FA redirect) and
 * contains nothing but printable ASCII. Anything else — an absolute URL, a protocol-relative
 * `//host/...`, a backslash trick like `/\evil`, a path outside `/connect`, or a control/DEL/
 * non-ASCII character — is rejected outright rather than partially sanitized, so a bad `next` is
 * silently dropped instead of guessed at.
 */
export function safeNext(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2000) return null;
  if (!PRINTABLE_ASCII_RE.test(raw)) return null;
  return SAFE_NEXT_RE.test(raw) ? raw : null;
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
    req.principal = { kind: 'admin', id: session.admin_id, scopes: ['admin'], projectIds: null, agent: false };
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
    if (path === '/login' || path === '/login/2fa' || path.startsWith('/assets/')) return;
    if (req.principal?.kind === 'admin') return;
    // Preserves a safe `next` (spec §1.3: an anonymous GET /connect?code=... survives the login
    // — and, when 2FA is on, the 2FA — round trip and lands back where it started).
    const next = safeNext(req.url);
    return reply.redirect(next ? `/login?next=${encodeURIComponent(next)}` : '/login', 302);
  });
}
