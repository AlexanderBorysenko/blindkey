import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import QRCode from 'qrcode';
import type { AppContext } from '../../http/context.js';
import { getAdminById } from '../../repos/admin.js';
import { getTotp } from '../../repos/twofactor.js';
import { verifyPassword } from '../../crypto/passwords.js';
import {
  confirmEnrollment, countUnusedRecoveryCodes, disableTwoFactor, isTotpEnabled, pendingEnrollment,
  regenerateRecoveryCodes, startEnrollment, verifySecondFactor,
} from '../../services/twofactor.js';
import { writeAudit } from '../../repos/audit.js';
import { adminActor, requireAdmin } from '../session.js';
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

  const page = (req: FastifyRequest, reply: FastifyReply, view: View, error: string | null, status = 200) =>
    reply.status(status).type('text/html').send(renderPage('settings-2fa', { ...pageContext(ctx, req, 'Two-factor'), view, error }));

  app.get('/settings/2fa', async (req, reply) => page(req, reply, await currentView(req), null));

  app.post('/settings/2fa/start', async (req, reply) => {
    assertCsrf(ctx, req);
    startEnrollment(ctx, adminOf(req).id);
    return page(req, reply, await currentView(req), null);
  });

  app.post('/settings/2fa/confirm', async (req, reply) => {
    assertCsrf(ctx, req);
    const codes = await confirmEnrollment(ctx, adminActor(req), str(body(req), 'code'));
    if (!codes) return page(req, reply, await currentView(req), 'Invalid code.', 400);
    return page(req, reply, { state: 'codes', codes }, null);
  });

  // Both destructive actions re-authenticate with the password AND a fresh code.
  async function reauth(req: FastifyRequest): Promise<boolean> {
    const admin = adminOf(req);
    const b = body(req);
    const passwordOk = await verifyPassword(admin.password_hash, str(b, 'password'));
    const factor = passwordOk ? await verifySecondFactor(ctx, admin.id, str(b, 'code')) : null;
    if (!passwordOk || !factor) {
      writeAudit(ctx.db, { actor_type: 'admin', actor_id: admin.id, action: 'auth.totp_failed', ip: req.ip, user_agent: req.headers['user-agent'] ?? '', meta: { via: 'settings' } });
      return false;
    }
    return true;
  }

  app.post('/settings/2fa/recovery', async (req, reply) => {
    assertCsrf(ctx, req);
    if (!isTotpEnabled(ctx, adminOf(req).id)) return reply.redirect('/settings/2fa', 302);
    if (!(await reauth(req))) return page(req, reply, await currentView(req), 'Invalid password or code.', 400);
    return page(req, reply, { state: 'codes', codes: await regenerateRecoveryCodes(ctx, adminActor(req)) }, null);
  });

  app.post('/settings/2fa/disable', async (req, reply) => {
    assertCsrf(ctx, req);
    if (!isTotpEnabled(ctx, adminOf(req).id)) return reply.redirect('/settings/2fa', 302);
    if (!(await reauth(req))) return page(req, reply, await currentView(req), 'Invalid password or code.', 400);
    disableTwoFactor(ctx, adminActor(req));
    return reply.redirect('/settings/2fa?done=saved', 302);
  });
}
