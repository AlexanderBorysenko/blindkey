import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import QRCode from 'qrcode';
import type { AppContext } from '../../http/context.js';
import { getAdminById } from '../../repos/admin.js';
import { getTotp } from '../../repos/twofactor.js';
import { verifyPassword } from '../../crypto/passwords.js';
import {
  confirmEnrollment, countUnusedRecoveryCodes, disableTwoFactor, isTotpEnabled, pendingEnrollment,
  isSecondFactorLocked, regenerateRecoveryCodes, startEnrollment, verifySecondFactor,
} from '../../services/twofactor.js';
import { factorLockedMessage } from './auth.js';
import { writeAudit } from '../../repos/audit.js';
import { adminActor, requireAdmin, uiSessionId } from '../session.js';
import { assertCsrf } from '../csrf.js';
import { body, pageContext, str } from '../forms.js';
import { renderPage } from '../render.js';

type View =
  | { state: 'off' }
  | { state: 'setup'; secret: string; qr: string }
  | { state: 'codes'; codes: string[] }
  | { state: 'on'; enabledAt: number; unused: number };

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
    const svg = await QRCode.toString(pending.uri, { type: 'svg', margin: 1 });
    return { state: 'setup', secret: pending.secret.replace(/(.{4})(?=.)/g, '$1 '), qr: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}` };
  }

  // F5d: every settings POST is rate limited (spec §2.3).
  const limited = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

  const page = (req: FastifyRequest, reply: FastifyReply, view: View, error: string | null, status = 200) =>
    reply.status(status).type('text/html').send(renderPage('settings-2fa', { ...pageContext(ctx, req, 'Two-factor'), view, error }));

  app.get('/settings/2fa', async (req, reply) => page(req, reply, await currentView(req), null));

  app.post('/settings/2fa/start', limited, async (req, reply) => {
    assertCsrf(ctx, req);
    startEnrollment(ctx, adminOf(req).id);
    return page(req, reply, await currentView(req), null);
  });

  app.post('/settings/2fa/confirm', limited, async (req, reply) => {
    assertCsrf(ctx, req);
    const codes = await confirmEnrollment(ctx, adminActor(req), str(body(req), 'code'), uiSessionId(req) ?? '');
    if (!codes) return page(req, reply, await currentView(req), 'Invalid code.', 400);
    return page(req, reply, { state: 'codes', codes }, null);
  });

  // Both destructive actions re-authenticate with the password AND a fresh code.
  // Returns null on success, or the error page's message and status.
  async function reauth(req: FastifyRequest): Promise<{ status: number; error: string } | null> {
    const admin = adminOf(req);
    const lockedUntil = isSecondFactorLocked(ctx, admin.id);
    if (lockedUntil !== null) return { status: 429, error: factorLockedMessage(lockedUntil) };
    const b = body(req);
    const passwordOk = await verifyPassword(admin.password_hash, str(b, 'password'));
    const factor = passwordOk ? await verifySecondFactor(ctx, admin.id, str(b, 'code')) : null;
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
    if (!isTotpEnabled(ctx, adminOf(req).id)) return reply.redirect('/settings/2fa', 302);
    const failed = await reauth(req);
    if (failed) return page(req, reply, await currentView(req), failed.error, failed.status);
    return page(req, reply, { state: 'codes', codes: await regenerateRecoveryCodes(ctx, adminActor(req)) }, null);
  });

  app.post('/settings/2fa/disable', limited, async (req, reply) => {
    assertCsrf(ctx, req);
    if (!isTotpEnabled(ctx, adminOf(req).id)) return reply.redirect('/settings/2fa', 302);
    const failed = await reauth(req);
    if (failed) return page(req, reply, await currentView(req), failed.error, failed.status);
    disableTwoFactor(ctx, adminActor(req));
    return reply.redirect('/settings/2fa?done=saved', 302);
  });
}
