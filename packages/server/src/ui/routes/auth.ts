import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../../http/context.js';
import { getAdminByUsername, createSession, deleteSession } from '../../repos/admin.js';
import { verifyPassword } from '../../crypto/passwords.js';
import { writeAudit } from '../../repos/audit.js';
import { renderPage } from '../render.js';
import { assertCsrf } from '../csrf.js';
import { body, str } from '../forms.js';
import {
  clearChallengeCookie, clearSessionCookie, setChallengeCookie, setSessionCookie, uiSessionId, SESSION_TTL_MS,
  CHALLENGE_COOKIE,
} from '../session.js';
import {
  claimChallengeAttempt, createChallenge, deleteChallenge, getChallenge, purgeExpiredChallenges,
} from '../../repos/twofactor.js';
import {
  CHALLENGE_TTL_MS, MAX_CHALLENGE_ATTEMPTS, isSecondFactorLocked, isTotpEnabled, verifySecondFactor,
} from '../../services/twofactor.js';

type LoginBody = { Body: { username?: string; password?: string } };

/** The message shown while an admin's second factor is locked (spec §2.4). */
export function factorLockedMessage(until: number, nowTs: number = Date.now()): string {
  const minutes = Math.max(1, Math.ceil((until - nowTs) / 60_000));
  return `Too many wrong codes — try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`;
}

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
      if (isTotpEnabled(ctx, admin.id)) {
        // spec §2: written as soon as the password verifies for a 2FA admin, before the lock and
        // code checks, so the operator can see the password is known even when every code guess fails.
        writeAudit(ctx.db, { actor_type: 'admin', actor_id: admin.id, action: 'auth.password_ok', ip: req.ip, user_agent: ua, meta: { via: 'ui' } });
        const challenge = createChallenge(ctx.db, admin.id, CHALLENGE_TTL_MS, req.ip, ua);
        setChallengeCookie(reply, challenge, isSecure(req));
        return reply.redirect('/login/2fa', 302);
      }
      const id = createSession(ctx.db, admin.id, SESSION_TTL_MS, req.ip, ua);
      writeAudit(ctx.db, { actor_type: 'admin', actor_id: admin.id, action: 'auth.login', ip: req.ip, user_agent: ua, meta: { via: 'ui' } });
      setSessionCookie(reply, id, isSecure(req));
      return reply.redirect('/', 302);
    },
  );

  const challengeFrom = (req: FastifyRequest) => {
    const raw = req.cookies?.[CHALLENGE_COOKIE];
    return typeof raw === 'string' && raw ? getChallenge(ctx.db, raw) : null;
  };
  const codePage = (reply: FastifyReply, status: number, error: string | null) =>
    reply.status(status).type('text/html').send(renderPage('login-2fa', { title: 'Two-factor code', nav: false, error }));

  app.get('/login/2fa', { config: { public: true } }, async (req, reply) => {
    purgeExpiredChallenges(ctx.db);
    if (!challengeFrom(req)) {
      clearChallengeCookie(reply);
      return reply.redirect('/login', 302);
    }
    return codePage(reply, 200, null);
  });

  app.post<{ Body: { code?: string } }>(
    '/login/2fa',
    { config: { public: true, rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const challenge = challengeFrom(req);
      const ua = req.headers['user-agent'] ?? '';
      if (!challenge) {
        clearChallengeCookie(reply);
        return reply.redirect('/login', 302);
      }
      const lockedUntil = isSecondFactorLocked(ctx, challenge.admin_id);
      if (lockedUntil !== null) return codePage(reply, 429, factorLockedMessage(lockedUntil));
      const exhausted = () => {
        deleteChallenge(ctx.db, challenge.id);
        clearChallengeCookie(reply);
        return loginPage(reply, 401, 'Too many attempts — log in again.');
      };
      // Claim the attempt before checking the code, so parallel guesses cannot exceed the cap.
      const attempt = claimChallengeAttempt(ctx.db, challenge.id, MAX_CHALLENGE_ATTEMPTS, Date.now());
      if (attempt === null) return exhausted();
      const used = await verifySecondFactor(ctx, challenge.admin_id, str(body(req), 'code'));
      if (!used) {
        writeAudit(ctx.db, { actor_type: 'admin', actor_id: challenge.admin_id, action: 'auth.totp_failed', ip: req.ip, user_agent: ua, meta: { via: 'ui' } });
        if (attempt >= MAX_CHALLENGE_ATTEMPTS) return exhausted();
        return codePage(reply, 401, 'Invalid code.');
      }
      deleteChallenge(ctx.db, challenge.id);
      clearChallengeCookie(reply);
      if (used === 'recovery') writeAudit(ctx.db, { actor_type: 'admin', actor_id: challenge.admin_id, action: 'auth.recovery_used', ip: req.ip, user_agent: ua, meta: { via: 'ui' } });
      const id = createSession(ctx.db, challenge.admin_id, SESSION_TTL_MS, req.ip, ua);
      writeAudit(ctx.db, { actor_type: 'admin', actor_id: challenge.admin_id, action: 'auth.login', ip: req.ip, user_agent: ua, meta: { via: 'ui', second_factor: used } });
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
