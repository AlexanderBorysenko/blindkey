import type { AppError } from '../errors.js';
import type { FastifyRequest } from 'fastify';
import type { AppContext } from '../http/context.js';
import { loadNav, type NavData } from '../repos/nav.js';
import { isTotpEnabled } from '../services/twofactor.js';
import { csrfTokenFor } from './csrf.js';
import { flashFor } from './format.js';
import { getUserById } from '../repos/admin.js';
import type { Principal } from '../auth/principal.js';
import { accessFor } from '../auth/access.js';
import type { WorkspaceRow } from '../repos/workspaces.js';
import { uiSessionId } from './session.js';

export function body(req: FastifyRequest): Record<string, unknown> {
  return (req.body ?? {}) as Record<string, unknown>;
}

export function str(b: Record<string, unknown>, key: string, fallback = ''): string {
  const v = b[key];
  return typeof v === 'string' ? v : fallback;
}

export function bool(b: Record<string, unknown>, key: string): boolean {
  const v = b[key];
  return v === 'on' || v === 'true' || v === '1';
}

/** A repeated form field arrives as a string (one value) or an array (several). */
export function list(b: Record<string, unknown>, key: string): string[] {
  const v = b[key];
  if (Array.isArray(v)) return v.map((x) => String(x));
  if (typeof v === 'string') return [v];
  return [];
}

/** Tags are entered as a comma-separated string. */
export function parseTags(raw: unknown): string[] {
  return String(raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export interface PageContext {
  title: string;
  nav: NavData;
  csrf: string;
  path: string;
  activeSlug: string | null;
  flash: string | null;
  totpEnabled: boolean;
  /** The logged-in user (the impersonated one while a super user acts as them); null when anonymous. */
  me: { username: string; isSuper: boolean } | null;
  /** True while a super user is acting as `me`. */
  impersonating: boolean;
  /** On global-item pages: the workspace this request resolved, carried by forms as a hidden `workspace` field. */
  ws: string | null;
  /** The same as a `?workspace=` link suffix ('' when `ws` is null). */
  wsq: string;
  /** Where the sidebar's workspace switcher sends the user back to (a page that still makes sense in another workspace, else `/`). */
  switchNext: string;
}

/** The workspace the sidebar has selected (cookie, or `?workspace=` for this request); null when the user sees none. */
export function activeWorkspace(ctx: AppContext, principal: Principal): WorkspaceRow | null {
  try {
    return accessFor(ctx.db, principal).resolveGlobalWorkspace(null);
  } catch {
    return null;
  }
}

/**
 * The workspace a `/global/` page is rendered for: the resolved active workspace (never the raw cookie, which can be
 * absent or stale), so the hidden `workspace` field and links make a later POST resolve exactly this one.
 */
function globalWorkspace(ctx: AppContext, req: FastifyRequest, path: string): string | null {
  const p = req.principal;
  return path.startsWith('/global/') && p?.kind === 'admin' ? (activeWorkspace(ctx, p)?.slug ?? null) : null;
}

/** `&workspace=<slug>` to append to a redirect that already has a query, for global-item pages; '' otherwise. */
export function wsParam(req: FastifyRequest, global: boolean): string {
  const p = req.principal;
  const ws = global && p?.kind === 'admin' ? p.workspaceHint : null;
  return ws ? `&workspace=${encodeURIComponent(ws)}` : '';
}

/** Item pages belong to one workspace and would 404 in another, so switching from them lands on the projects list. */
function switchNextFor(req: FastifyRequest, path: string): string {
  if (/^\/(p|w)\//.test(path) || /^\/global\/(docs|secrets)\/./.test(path)) return '/';
  const params = new URLSearchParams(req.url.split('?')[1] ?? '');
  params.delete('workspace');
  params.delete('done');
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

function activeSlugFor(path: string): string | null {
  const m = /^\/p\/([^/]+)/.exec(path);
  if (!m?.[1]) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    // Valid-hex-but-invalid-UTF-8 percent escapes (e.g. `%E0%A4`) throw URIError.
    // Such a path can never match a real project slug, so treat it as "no active project".
    return null;
  }
}

export function pageContext(ctx: AppContext, req: FastifyRequest, title: string): PageContext {
  const id = uiSessionId(req);
  const path = req.url.split('?')[0] ?? req.url;
  const query = (req.query ?? {}) as Record<string, unknown>;
  const ws = globalWorkspace(ctx, req, path);
  const principal = req.principal?.kind === 'admin' ? req.principal : null;
  const user = principal ? getUserById(ctx.db, principal.userId) : null;
  return {
    title,
    nav: loadNav(ctx.db, req.principal),
    csrf: id ? csrfTokenFor(ctx, id) : '',
    path,
    activeSlug: activeSlugFor(path),
    flash: flashFor(query.done),
    totpEnabled: req.principal?.kind === 'admin' ? isTotpEnabled(ctx, req.principal.id) : true,
    me: user ? { username: user.username, isSuper: principal?.isSuper === true } : null,
    impersonating: principal !== null && principal.impersonatorId !== null,
    ws,
    wsq: ws ? `?workspace=${encodeURIComponent(ws)}` : '',
    switchNext: switchNextFor(req, path),
  };
}

/** A user-facing message for a 4xx AppError: a ValidationError's issue texts instead of its generic "validation failed". */
export function errorText(err: AppError): string {
  const issues = err.details.issues;
  if (err.code === 'validation' && Array.isArray(issues) && issues.length > 0) {
    return issues
      .map((i: { path?: unknown[]; message?: unknown }) => {
        const path = Array.isArray(i.path) && i.path.length ? `${i.path.join('.')}: ` : '';
        return `${path}${String(i.message ?? 'invalid')}`;
      })
      .join('; ');
  }
  return err.message;
}
