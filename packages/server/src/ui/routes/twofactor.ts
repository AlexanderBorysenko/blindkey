import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../../http/context.js';
import { getAdminById } from '../../repos/admin.js';
import { getTotp } from '../../repos/twofactor.js';
import { verifyPassword } from '../../crypto/passwords.js';
import {
  beginReenrollment, confirmEnrollment, confirmReenrollment, countUnusedRecoveryCodes, isTotpEnabled, pendingEnrollment, reenrollmentSecret,
  isSecondFactorLocked, regenerateRecoveryCodes, startEnrollment, verifySecondFactor,
} from '../../services/twofactor.js';
import { factorLockedMessage } from './auth.js';
import { writeAudit } from '../../repos/audit.js';
import { adminActor, requireAdmin, uiSessionId } from '../session.js';
import { assertCsrf } from '../csrf.js';
import { body, pageContext, str } from '../forms.js';
import { assertNotImpersonating } from '../../services/common.js';
import { isUiRequest, renderPage } from '../render.js';
import { qrDataUri } from '../qr.js';
import { mustChangePassword } from '../../services/password.js';

type View =
  | { state: 'off' }
  | { state: 'setup'; secret: string; qr: string }
  | { state: 'reenroll'; token: string; secret: string; qr: string }
  | { state: 'codes'; codes: string[] }
  | { state: 'on'; enabledAt: number; unused: number };

/** Paths a user without two-factor may still reach: the enrollment pages, logout and assets. */
function allowedWhileEnrolling(path: string): boolean {
  return path === '/settings/2fa' || path === '/settings/2fa/start' || path === '/settings/2fa/confirm' || path === '/logout' || path.startsWith('/assets/');
}

/**
 * Two-factor is mandatory. While the logged-in user has not enabled it, every UI request except the
 * enrollment pages, logout and assets is redirected (GET/HEAD) or refused (anything else). Registered
 * right after the forced password change, which wins when both apply (password first, then 2FA).
 * Skipped while impersonating: an impersonated session cannot change 2FA at all, so gating it would
 * make impersonating a user who has not enrolled pointless.
 */
export function registerTwoFactorGate(app: FastifyInstance, ctx: AppContext): void {
  app.addHook('onRequest', async (req, reply) => {
    const p = req.principal;
    if (!p || p.kind !== 'admin' || p.impersonatorId !== null || !isUiRequest(req.url)) return;
    const path = req.url.split('?')[0] ?? '';
    if (allowedWhileEnrolling(path) || isTotpEnabled(ctx, p.userId) || mustChangePassword(ctx, p.userId)) return;
    if (req.method === 'GET' || req.method === 'HEAD') return reply.redirect('/settings/2fa', 302);
    return reply.status(403).type('text/html').send(
      renderPage('error', { title: 'Error', code: 'totp_setup_required', message: 'Two-factor authentication must be set up first.' }),
    );
  });
}

const spaced = (secret: string): string => secret.replace(/(.{4})(?=.)/g, '$1 ');

export function registerTwoFactorRoutes(app: FastifyInstance, ctx: AppContext): void {
  const adminOf = (req: FastifyRequest) => {
    const principal = requireAdmin(req);
    const admin = getAdminById(ctx.db, principal.id);
    if (!admin) throw new Error('admin not found');
    return admin;
  };

  async function currentView(req: FastifyRequest): Promise<View> {
    const admin = adminOf(req);
    const row = getTotp(ctx.db, admin.id);
    if (row?.enabled_at != null) return { state: 'on', enabledAt: row.enabled_at, unused: countUnusedRecoveryCodes(ctx, admin.id) };
    const pending = pendingEnrollment(ctx, admin.id, admin.username);
    if (!pending) return { state: 'off' };
    return { state: 'setup', secret: spaced(pending.secret), qr: await qrDataUri(pending.uri) };
  }

  // F5d: every settings POST is rate limited (spec §2.3).
  const limited = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

  const page = (req: FastifyRequest, reply: FastifyReply, view: View, error: string | null, status = 200) =>
    reply.status(status).type('text/html').send(renderPage('settings-2fa', { ...pageContext(ctx, req, 'Two-factor'), view, error }));

  app.get('/settings/2fa', async (req, reply) => page(req, reply, await currentView(req), null));

  app.post('/settings/2fa/start', limited, async (req, reply) => {
    assertCsrf(ctx, req);
    startEnrollment(ctx, adminOf(req).id, requireAdmin(req));
    return page(req, reply, await currentView(req), null);
  });

  app.post('/settings/2fa/confirm', limited, async (req, reply) => {
    assertCsrf(ctx, req);
    assertNotImpersonating(requireAdmin(req));
    const codes = await confirmEnrollment(ctx, adminActor(req), str(body(req), 'code'), uiSessionId(req) ?? '');
    if (!codes) return page(req, reply, await currentView(req), 'Invalid code.', 400);
    return page(req, reply, { state: 'codes', codes }, null);
  });

  // Regenerating recovery codes re-authenticates with the password AND a fresh code.
  // Returns null on success, or the error page's message and status.
  async function reauth(req: FastifyRequest, totpOnly = false): Promise<{ status: number; error: string } | null> {
    const admin = adminOf(req);
    const lockedUntil = isSecondFactorLocked(ctx, admin.id);
    if (lockedUntil !== null) return { status: 429, error: factorLockedMessage(lockedUntil) };
    const b = body(req);
    const passwordOk = await verifyPassword(admin.password_hash, str(b, 'password'));
    const factor = passwordOk ? await verifySecondFactor(ctx, admin.id, str(b, 'code'), { totpOnly }) : null;
    if (!passwordOk || !factor) {
      writeAudit(ctx.db, { actor_type: 'admin', actor_id: admin.id, action: 'auth.totp_failed', ip: req.ip, user_agent: req.headers['user-agent'] ?? '', meta: { via: 'settings' } });
      return { status: 400, error: 'Invalid password or code.' };
    }
    // F5: mirrors how the login flows record a recovery-code use.
    if (factor === 'recovery') {
      writeAudit(ctx.db, { actor_type: 'admin', actor_id: admin.id, action: 'auth.recovery_used', ip: req.ip, user_agent: req.headers['user-agent'] ?? '', meta: { via: 'settings' } });
    }
    return null;
  }

  app.post('/settings/2fa/recovery', limited, async (req, reply) => {
    assertCsrf(ctx, req);
    assertNotImpersonating(requireAdmin(req));
    if (!isTotpEnabled(ctx, adminOf(req).id)) return reply.redirect('/settings/2fa', 302);
    const failed = await reauth(req);
    if (failed) return page(req, reply, await currentView(req), failed.error, failed.status);
    return page(req, reply, { state: 'codes', codes: await regenerateRecoveryCodes(ctx, adminActor(req)) }, null);
  });

  async function reenrollView(token: string, secret: string, uri: string): Promise<View> {
    return { state: 'reenroll', token, secret: spaced(secret), qr: await qrDataUri(uri) };
  }

  // Rotates the authenticator secret of an enabled factor. Re-authenticates first; the old secret keeps
  // working until a code from the new one is confirmed.
  app.post('/settings/2fa/reenroll', limited, async (req, reply) => {
    assertCsrf(ctx, req);
    assertNotImpersonating(requireAdmin(req));
    if (!isTotpEnabled(ctx, adminOf(req).id)) return reply.redirect('/settings/2fa', 302);
    // Rotating the secret asks for a current authenticator code: a recovery code (a fallback for a lost device) is not enough.
    const failed = await reauth(req, true);
    if (failed) return page(req, reply, await currentView(req), failed.error, failed.status);
    const next = beginReenrollment(ctx, adminActor(req), adminOf(req).username);
    return page(req, reply, await reenrollView(next.token, next.secret, next.uri), null);
  });

  app.post('/settings/2fa/reenroll/confirm', limited, async (req, reply) => {
    assertCsrf(ctx, req);
    assertNotImpersonating(requireAdmin(req));
    const admin = adminOf(req);
    const b = body(req);
    const token = str(b, 'token');
    const codes = await confirmReenrollment(ctx, adminActor(req), token, str(b, 'code'), uiSessionId(req) ?? '');
    if (!codes) {
      const again = reenrollmentSecret(ctx, admin.id, token, admin.username);
      if (!again) return page(req, reply, await currentView(req), 'That setup expired. Start again.', 400);
      return page(req, reply, await reenrollView(token, again.secret, again.uri), 'Invalid code.', 400);
    }
    return page(req, reply, { state: 'codes', codes }, null);
  });
}
