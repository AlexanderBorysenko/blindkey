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
