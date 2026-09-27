import type { FastifyInstance } from 'fastify';
import { AppError, UnauthorizedError } from '../errors.js';
import type { Principal } from '../auth/principal.js';
import { lookupTokenByValue, touchToken } from '../repos/tokens.js';
import { writeAudit } from '../repos/audit.js';
import { parseTokenPrefix } from '../crypto/tokens.js';
import type { AppContext } from './context.js';

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null;
  }
  interface FastifyContextConfig {
    public?: boolean;
  }
}

export class FailureLimiter {
  private hits = new Map<string, number[]>();
  constructor(
    private readonly max = 20,
    private readonly windowMs = 60_000,
  ) {}
  private prune(ip: string, ts: number): number[] {
    const list = (this.hits.get(ip) ?? []).filter((t) => ts - t < this.windowMs);
    if (list.length === 0) this.hits.delete(ip);
    else this.hits.set(ip, list);
    return list;
  }
  record(ip: string, ts = Date.now()): void {
    const list = this.prune(ip, ts);
    list.push(ts);
    this.hits.set(ip, list);
  }
  isBlocked(ip: string, ts = Date.now()): boolean {
    return this.prune(ip, ts).length >= this.max;
  }
  get size(): number {
    return this.hits.size;
  }
}

/**
 * Throttles `auth.token_expired` audit rows to at most one per token per hour (spec §2): a
 * hammered expired token would otherwise fill the audit log with one row per request. Keyed by
 * token id, entries older than the window are swept once the map grows past 1000 so a flood of
 * distinct dead tokens cannot grow it forever. `ts` is an explicit parameter (default `Date.now()`)
 * so this is unit-testable without sleeping.
 */
export class ExpiredTokenThrottle {
  private lastWritten = new Map<number, number>();
  constructor(private readonly windowMs = 60 * 60_000) {}
  private prune(ts: number): void {
    if (this.lastWritten.size <= 1000) return;
    for (const [id, last] of this.lastWritten) {
      if (ts - last >= this.windowMs) this.lastWritten.delete(id);
    }
  }
  /** Returns true (and records `ts`) the first time this token id is seen in the window; false otherwise. */
  shouldAudit(tokenId: number, ts: number = Date.now()): boolean {
    this.prune(ts);
    const last = this.lastWritten.get(tokenId);
    if (last !== undefined && ts - last < this.windowMs) return false;
    this.lastWritten.set(tokenId, ts);
    return true;
  }
  get size(): number {
    return this.lastWritten.size;
  }
}

const BEARER_RE = /^Bearer\s+(\S+)$/i;

export function registerAuth(app: FastifyInstance, ctx: AppContext): void {
  const limiter = new FailureLimiter();
  const expiredTokenThrottle = new ExpiredTokenThrottle();
  app.decorateRequest('principal', null);
  app.addHook('onRequest', async (req) => {
    // Static UI assets (fonts, htmx, app.css) carry no data and load before a session exists.
    if (req.url.startsWith('/assets/')) return;
    if (req.routeOptions.config.public) return;
    if (req.principal) return; // set by an earlier resolver (e.g. admin session, Plan 3)
    const ip = req.ip;
    if (limiter.isBlocked(ip)) throw new AppError(429, 'rate_limited', 'too many failed authentication attempts');
    const m = BEARER_RE.exec(req.headers.authorization ?? '');
    const token = m?.[1];
    if (!token) throw new UnauthorizedError();
    const found = lookupTokenByValue(ctx.db, token);
    if (found.state === 'expired') {
      // Only a holder of the token value can see this distinction; it does not feed the failure limiter.
      if (expiredTokenThrottle.shouldAudit(found.row.id)) {
        writeAudit(ctx.db, {
          actor_type: 'token',
          actor_id: found.row.id,
          action: 'auth.token_expired',
          ip,
          user_agent: req.headers['user-agent'] ?? '',
          meta: { prefix: found.row.prefix },
        });
      }
      throw new AppError(401, 'token_expired', 'token expired');
    }
    if (found.state === 'none') {
      limiter.record(ip);
      writeAudit(ctx.db, {
        actor_type: 'token',
        actor_id: null,
        action: 'auth.token_failed',
        ip,
        user_agent: req.headers['user-agent'] ?? '',
        meta: { prefix: parseTokenPrefix(token) },
      });
      throw new UnauthorizedError();
    }
    const row = found.row;
    touchToken(ctx.db, row.id);
    req.principal = { kind: 'token', id: row.id, scopes: row.scopes, projectIds: row.project_ids, agent: row.kind === 'agent' };
  });
}
