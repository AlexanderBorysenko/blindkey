import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../../http/context.js';
import { AppError, NotFoundError } from '../../errors.js';
import { deleteSession, getUserById } from '../../repos/admin.js';
import { mustChangePassword } from '../../services/password.js';
import { isTotpEnabled } from '../../services/twofactor.js';
import { isTwoFactorByAdmin } from '../../repos/twofactor.js';
import { qrDataUri } from '../qr.js';
import {
  confirmUserSetupFor, createUserFor, deleteUserFor, listUsersFor, resetUserPasswordFor, resetUserTwoFactorFor, setUserDisabledFor, setUserSuperFor,
  startImpersonation, stopImpersonation, userSetupFor,
} from '../../services/users.js';
import { adminActor, clearSessionCookie, requireAdmin, setSessionCookie, uiSessionId } from '../session.js';
import { assertCsrf } from '../csrf.js';
import { body, bool, errorText, pageContext, str } from '../forms.js';
import { isUiRequest, renderPage } from '../render.js';

/** A password for the "generate" option: 24 URL-safe characters (144 bits), shown once and never stored in plaintext. */
export function generatePassword(): string {
  return randomBytes(18).toString('base64url');
}

/** Paths a user who must change their password may still reach. */
function allowedWhileForced(path: string): boolean {
  return path === '/settings/password' || path === '/logout' || path.startsWith('/assets/');
}

/**
 * While the logged-in user has a temporary password (new account or reset), every UI request except
 * the password form, logout and assets is redirected (GET/HEAD) or refused (anything else) until
 * they pick a new one. A super user acting as someone else is not blocked by the target's flag:
 * the impersonated session cannot change passwords at all, and blocking it would make impersonating
 * a user with a temporary password pointless.
 */
export function registerForcedPasswordChange(app: FastifyInstance, ctx: AppContext): void {
  app.addHook('onRequest', async (req, reply) => {
    const p = req.principal;
    if (!p || p.kind !== 'admin' || p.impersonatorId !== null || !isUiRequest(req.url)) return;
    const path = req.url.split('?')[0] ?? '';
    if (allowedWhileForced(path) || !mustChangePassword(ctx, p.userId)) return;
    if (req.method === 'GET' || req.method === 'HEAD') return reply.redirect('/settings/password', 302);
    return reply.status(403).type('text/html').send(
      renderPage('error', { title: 'Error', code: 'password_change_required', message: 'You must change your password first.' }),
    );
  });
}

export function registerUserRoutes(app: FastifyInstance, ctx: AppContext): void {
  const limited = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };

  /** Other users get a plain 404 for everything under /admin/users. */
  const superOnly = (req: FastifyRequest) => {
    const principal = requireAdmin(req);
    if (!principal.isSuper) throw new NotFoundError('not found');
    return principal;
  };

  const usersPage = (req: FastifyRequest, extra: Record<string, unknown>) => {
    const principal = superOnly(req);
    return renderPage('users', {
      ...pageContext(ctx, req, 'Users'),
      users: listUsersFor(ctx, principal).map((u) => {
        const twofactor = isTotpEnabled(ctx, u.id);
        return { ...u, twofactor, setup_pending: !twofactor && isTwoFactorByAdmin(ctx.db, u.id) };
      }),
      selfId: principal.userId,
      created: null,
      error: null,
      confirmDelete: null,
      ...extra,
    });
  };

  /** Runs a service action; a 4xx guard error is shown on the page instead of becoming an error screen. */
  async function act(req: FastifyRequest, reply: FastifyReply, run: () => void | Promise<void>, extra: () => Record<string, unknown> = () => ({}), redirectTo = '/admin/users?done=saved') {
    assertCsrf(ctx, req);
    superOnly(req);
    try {
      await run();
    } catch (err) {
      if (err instanceof AppError && err.status < 500) {
        return reply.status(err.status).type('text/html').send(usersPage(req, { error: errorText(err) }));
      }
      throw err;
    }
    const shown = extra();
    if (Object.keys(shown).length > 0) return reply.header('cache-control', 'no-store').type('text/html').send(usersPage(req, shown));
    return reply.redirect(redirectTo, 303);
  }

  const idOf = (req: FastifyRequest<{ Params: { id: string } }>) => Number.parseInt(req.params.id, 10);

  app.get('/admin/users', async (req, reply) => reply.type('text/html').send(usersPage(req, {})));

  /** Step 2 of creating a user (and of a 2FA reset): the QR for the super user to have scanned, and the code field. */
  async function setupPage(req: FastifyRequest, reply: FastifyReply, id: number, tempPassword: string | null, error: string | null, status = 200) {
    const setup = userSetupFor(ctx, superOnly(req), id);
    if (!setup) throw new NotFoundError('no two-factor setup in progress for this user');
    return reply.status(status).header('cache-control', 'no-store').type('text/html').send(renderPage('users-setup-2fa', {
      ...pageContext(ctx, req, 'Users'),
      setup: { id, username: setup.username },
      qr: await qrDataUri(setup.uri),
      secretText: setup.secret.replace(/(.{4})(?=.)/g, '$1 '),
      tempPassword,
      error,
    }));
  }

  // Step 1: the account exists with a pending 2FA enrollment and cannot log in; step 2 confirms it.
  app.post('/admin/users', limited, async (req, reply) => {
    assertCsrf(ctx, req);
    superOnly(req);
    const b = body(req);
    const username = str(b, 'username');
    const generate = bool(b, 'generate');
    const password = generate ? generatePassword() : str(b, 'password');
    let id: number;
    try {
      id = (await createUserFor(ctx, adminActor(req), { username, password })).id;
    } catch (err) {
      if (err instanceof AppError && err.status < 500) {
        return reply.status(err.status).type('text/html').send(usersPage(req, { error: errorText(err) }));
      }
      throw err;
    }
    return setupPage(req, reply, id, generate ? password : null, null);
  });

  app.get<{ Params: { id: string } }>('/admin/users/:id/setup-2fa', async (req, reply) => setupPage(req, reply, idOf(req), null, null));

  app.post<{ Params: { id: string } }>('/admin/users/:id/setup-2fa', limited, async (req, reply) => {
    assertCsrf(ctx, req);
    superOnly(req);
    const b = body(req);
    const id = idOf(req);
    // Only displayed again on the result page (never stored): a tampered value can only mislead the super user's own screen.
    const tempPassword = str(b, 'temp_password') || null;
    let codes: string[] | null;
    try {
      codes = await confirmUserSetupFor(ctx, adminActor(req), id, str(b, 'code'));
    } catch (err) {
      if (err instanceof AppError && err.status < 500) {
        return reply.status(err.status).type('text/html').send(usersPage(req, { error: errorText(err) }));
      }
      throw err;
    }
    if (!codes) return setupPage(req, reply, id, tempPassword, 'Invalid code.', 400);
    return reply.header('cache-control', 'no-store').type('text/html').send(renderPage('users-2fa-done', {
      ...pageContext(ctx, req, 'Users'),
      username: getUserById(ctx.db, id)?.username ?? '',
      tempPassword,
      codes,
    }));
  });

  type IdReq = FastifyRequest<{ Params: { id: string } }>;

  app.post<{ Params: { id: string } }>('/admin/users/:id/disable', limited, async (req, reply) =>
    act(req, reply, () => setUserDisabledFor(ctx, adminActor(req), idOf(req), true)));
  app.post<{ Params: { id: string } }>('/admin/users/:id/enable', limited, async (req, reply) =>
    act(req, reply, () => setUserDisabledFor(ctx, adminActor(req), idOf(req), false)));
  app.post<{ Params: { id: string } }>('/admin/users/:id/promote', limited, async (req, reply) =>
    act(req, reply, () => setUserSuperFor(ctx, adminActor(req), idOf(req), true)));
  app.post<{ Params: { id: string } }>('/admin/users/:id/demote', limited, async (req, reply) =>
    act(req, reply, () => setUserSuperFor(ctx, adminActor(req), idOf(req), false)));
  app.post<{ Params: { id: string } }>('/admin/users/:id/reset-2fa', limited, async (req, reply) =>
    act(req, reply, () => resetUserTwoFactorFor(ctx, adminActor(req), idOf(req)), () => ({}), `/admin/users/${idOf(req)}/setup-2fa`));

  app.post<{ Params: { id: string } }>('/admin/users/:id/reset-password', limited, async (req: IdReq, reply) => {
    const b = body(req);
    const generate = bool(b, 'generate');
    const password = generate ? generatePassword() : str(b, 'password');
    return act(req, reply, () => resetUserPasswordFor(ctx, adminActor(req), idOf(req), password, bool(b, 'revoke_tokens')), () => ({
      created: { username: getUserById(ctx.db, idOf(req))?.username ?? '', password: generate ? password : null, reset: true },
    }));
  });

  // Deleting takes two posts: the first (no `confirmed`) only renders the confirmation page.
  app.post<{ Params: { id: string } }>('/admin/users/:id/delete', limited, async (req: IdReq, reply) => {
    assertCsrf(ctx, req);
    superOnly(req);
    if (!bool(body(req), 'confirmed')) {
      const target = getUserById(ctx.db, idOf(req));
      if (!target) throw new NotFoundError('user not found');
      return reply.type('text/html').send(usersPage(req, { confirmDelete: { id: target.id, username: target.username } }));
    }
    return act(req, reply, () => deleteUserFor(ctx, adminActor(req), idOf(req)));
  });

  app.post<{ Params: { id: string } }>('/admin/users/:id/impersonate', limited, async (req: IdReq, reply) => {
    assertCsrf(ctx, req);
    superOnly(req);
    let session: string;
    try {
      session = startImpersonation(ctx, adminActor(req), idOf(req), uiSessionId(req) ?? undefined);
    } catch (err) {
      if (err instanceof AppError && err.status < 500) {
        return reply.status(err.status).type('text/html').send(usersPage(req, { error: errorText(err) }));
      }
      throw err;
    }
    setSessionCookie(reply, session, req.protocol === 'https');
    return reply.redirect('/', 303);
  });

  app.post('/impersonate/stop', async (req, reply) => {
    assertCsrf(ctx, req);
    const sessionId = uiSessionId(req) ?? '';
    try {
      const back = stopImpersonation(ctx, adminActor(req), sessionId);
      setSessionCookie(reply, back, req.protocol === 'https');
      return reply.redirect('/admin/users', 303);
    } catch (err) {
      // The real user can no longer come back (demoted or disabled): end the session outright.
      if (err instanceof NotFoundError && req.principal?.kind === 'admin' && req.principal.impersonatorId !== null) {
        deleteSession(ctx.db, sessionId);
        clearSessionCookie(reply);
        return reply.redirect('/login', 303);
      }
      throw err;
    }
  });
}
