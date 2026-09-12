import type { FastifyInstance, FastifyRequest } from 'fastify';
import { secretInputSchema, secretPatchSchema } from '@pidb/shared';
import type { AppContext } from '../context.js';
import { actorOf, parseBody, principalOf } from '../helpers.js';
import { createSecretFor, deleteSecretFor, getSecretFor, listSecretsFor, revealAllFor, revealFieldFor, updateSecretFor } from '../../services/secrets.js';

type P = { Params: { slug?: string; name: string; key: string } };

export function registerSecretRoutes(app: FastifyInstance, ctx: AppContext): void {
  const prefixes: { base: string; projectOf: (req: FastifyRequest<P>) => string | null }[] = [
    { base: '/api/v1/secrets', projectOf: () => null },
    { base: '/api/v1/projects/:slug/secrets', projectOf: (req) => req.params.slug ?? null },
  ];

  for (const { base, projectOf } of prefixes) {
    app.get<P>(base, async (req) => listSecretsFor(ctx, principalOf(req), projectOf(req)));

    app.get<P>(`${base}/:name`, async (req) => getSecretFor(ctx, principalOf(req), projectOf(req), req.params.name));

    app.get<P>(`${base}/:name/fields`, async (req) => revealAllFor(ctx, actorOf(req), projectOf(req), req.params.name));

    app.get<P>(`${base}/:name/fields/:key`, async (req, reply) => {
      const value = revealFieldFor(ctx, actorOf(req), projectOf(req), req.params.name, req.params.key);
      if ((req.headers.accept ?? '').includes('text/plain')) return reply.type('text/plain; charset=utf-8').send(value);
      return { key: req.params.key, value };
    });

    app.post<P>(base, async (req, reply) => {
      const input = parseBody(secretInputSchema, req.body);
      return reply.status(201).send(createSecretFor(ctx, actorOf(req), projectOf(req), input));
    });

    app.patch<P>(`${base}/:name`, async (req) => {
      const patch = parseBody(secretPatchSchema, req.body);
      return updateSecretFor(ctx, actorOf(req), projectOf(req), req.params.name, patch);
    });

    app.delete<P>(`${base}/:name`, async (req, reply) => {
      deleteSecretFor(ctx, actorOf(req), projectOf(req), req.params.name);
      return reply.status(204).send();
    });
  }
}
