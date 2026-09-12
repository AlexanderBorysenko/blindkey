import type { FastifyRequest } from 'fastify';
import type { AppContext } from '../http/context.js';
import { csrfTokenFor } from './csrf.js';
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
  nav: true;
  csrf: string;
}

export function pageContext(ctx: AppContext, req: FastifyRequest, title: string): PageContext {
  const id = uiSessionId(req);
  return { title, nav: true, csrf: id ? csrfTokenFor(ctx, id) : '' };
}
