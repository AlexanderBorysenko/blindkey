import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../errors.js';
import type { AppContext } from '../http/context.js';
import { uiSessionId } from './session.js';

/**
 * The CSRF token is an HMAC of the session id under the current master key:
 * no extra table, and it dies with the session.
 */
export function csrfTokenFor(ctx: AppContext, sessionId: string): string {
  const key = ctx.ring.keys.get(ctx.ring.current);
  if (!key) throw new AppError(500, 'internal', 'master key unavailable');
  return createHmac('sha256', key).update(`csrf:${sessionId}`).digest('hex');
}

export function assertCsrf(ctx: AppContext, req: FastifyRequest): void {
  const sessionId = uiSessionId(req);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const supplied = typeof body.csrf === 'string' ? body.csrf : '';
  if (!sessionId || !supplied) throw new AppError(403, 'csrf', 'invalid or missing CSRF token');
  const expected = csrfTokenFor(ctx, sessionId);
  const a = Buffer.from(supplied, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new AppError(403, 'csrf', 'invalid or missing CSRF token');
}
