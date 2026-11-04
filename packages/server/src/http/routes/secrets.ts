import type { FastifyInstance, FastifyRequest } from 'fastify';
import { secretInputSchema, secretPatchSchema, secretUseSchema } from '@blindkey/shared';
import type { AppContext } from '../context.js';
import { actorOf, parseBody, principalOf, workspaceParam } from '../helpers.js';
import { createSecretFor, deleteSecretFor, getSecretFor, listSecretsFor, revealAllFor, revealFieldFor, updateSecretFor, useSecretFor } from '../../services/secrets.js';

const USE_RATE_LIMIT = { max: 120, timeWindow: '1 minute' };

type P = { Params: { slug?: string; name: string; key: string }; Querystring: { workspace?: string } };

export function registerSecretRoutes(app: FastifyInstance, ctx: AppContext): void {
  const prefixes: { base: string; projectOf: (req: FastifyRequest<P>) => string | null; workspaceOf: (req: FastifyRequest<P>) => string | undefined }[] = [
    { base: '/api/v1/secrets', projectOf: () => null, workspaceOf: workspaceParam },
    { base: '/api/v1/projects/:slug/secrets', projectOf: (req) => req.params.slug ?? null, workspaceOf: () => undefined },
  ];

  for (const { base, projectOf, workspaceOf } of prefixes) {
    app.get<P>(base, async (req) => listSecretsFor(ctx, principalOf(req), projectOf(req), workspaceOf(req)));

    app.get<P>(`${base}/:name`, async (req) => getSecretFor(ctx, principalOf(req), projectOf(req), req.params.name, workspaceOf(req)));

    app.get<P>(`${base}/:name/fields`, async (req) => revealAllFor(ctx, actorOf(req), projectOf(req), req.params.name, workspaceOf(req)));

    app.get<P>(`${base}/:name/fields/:key`, async (req, reply) => {
      const value = revealFieldFor(ctx, actorOf(req), projectOf(req), req.params.name, req.params.key, workspaceOf(req));
      if ((req.headers.accept ?? '').includes('text/plain')) return reply.type('text/plain; charset=utf-8').send(value);
      return { key: req.params.key, value };
    });

    app.post<P>(
      `${base}/:name/use`,
      { config: { rateLimit: USE_RATE_LIMIT } },
      async (req) => {
        const input = parseBody(secretUseSchema, req.body);
        return useSecretFor(ctx, actorOf(req), projectOf(req), req.params.name, input.purpose, input.fields, workspaceOf(req));
      },
    );

    app.post<P>(base, async (req, reply) => {
      const input = parseBody(secretInputSchema, req.body);
      return reply.status(201).send(createSecretFor(ctx, actorOf(req), projectOf(req), input, workspaceOf(req)));
    });

    app.patch<P>(`${base}/:name`, async (req) => {
      const patch = parseBody(secretPatchSchema, req.body);
      return updateSecretFor(ctx, actorOf(req), projectOf(req), req.params.name, patch, workspaceOf(req));
    });

    app.delete<P>(`${base}/:name`, async (req, reply) => {
      deleteSecretFor(ctx, actorOf(req), projectOf(req), req.params.name, workspaceOf(req));
      return reply.status(204).send();
    });
  }
}
