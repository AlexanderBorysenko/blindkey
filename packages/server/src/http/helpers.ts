import type { FastifyRequest } from 'fastify';
import type { ZodType } from 'zod';
import type { Actor, Principal } from '../auth/principal.js';
import { UnauthorizedError, ValidationError } from '../errors.js';

export function principalOf(req: FastifyRequest): Principal {
  if (!req.principal) throw new UnauthorizedError();
  return req.principal;
}

export function actorOf(req: FastifyRequest): Actor {
  return { principal: principalOf(req), ip: req.ip, userAgent: req.headers['user-agent'] ?? '' };
}

export function parseBody<T>(schema: ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value ?? {});
  if (!r.success) throw new ValidationError(r.error.issues);
  return r.data;
}

/**
 * Honors `trustProxy` (set on the Fastify instance in buildApp): `req.protocol`/`req.host` already
 * reflect `X-Forwarded-Proto`/`X-Forwarded-Host` when the server trusts its proxy. `req.host` (not
 * `req.hostname`, which strips the port) is used deliberately: callers that build an absolute URL
 * from this origin (the connect verification URL, the MCP `secret_request_link` tool) need the
 * port the admin's browser has to reach this server on.
 */
export function originOf(req: FastifyRequest): string {
  return `${req.protocol}://${req.host}`;
}
