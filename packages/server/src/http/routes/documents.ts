import type { FastifyInstance, FastifyRequest } from 'fastify';
import { documentInputSchema } from '@pidb/shared';
import type { AppContext } from '../context.js';
import { actorOf, parseBody, principalOf } from '../helpers.js';
import { deleteDocumentFor, listDocumentsFor, readDocumentFor, writeDocumentFor } from '../../services/documents.js';

type DocParams = { Params: { slug?: string; doc: string }; Querystring: { resolve?: string } };

export function registerDocumentRoutes(app: FastifyInstance, ctx: AppContext): void {
  const prefixes: { base: string; projectOf: (req: FastifyRequest<DocParams>) => string | null }[] = [
    { base: '/api/v1/docs', projectOf: () => null },
    { base: '/api/v1/projects/:slug/docs', projectOf: (req) => req.params.slug ?? null },
  ];

  for (const { base, projectOf } of prefixes) {
    app.get<DocParams>(base, async (req) => listDocumentsFor(ctx, principalOf(req), projectOf(req)));

    app.get<DocParams>(`${base}/:doc`, async (req) =>
      readDocumentFor(ctx, principalOf(req), projectOf(req), req.params.doc, req.query.resolve === 'meta'),
    );

    app.put<DocParams>(`${base}/:doc`, async (req, reply) => {
      const input = parseBody(documentInputSchema, req.body);
      const { doc, created } = writeDocumentFor(ctx, actorOf(req), projectOf(req), req.params.doc, input);
      return reply.status(created ? 201 : 200).send(doc);
    });

    app.delete<DocParams>(`${base}/:doc`, async (req, reply) => {
      deleteDocumentFor(ctx, actorOf(req), projectOf(req), req.params.doc);
      return reply.status(204).send();
    });
  }
}
