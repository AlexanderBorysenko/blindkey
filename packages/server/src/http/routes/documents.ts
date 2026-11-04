import type { FastifyInstance, FastifyRequest } from 'fastify';
import { documentInputSchema } from '@blindkey/shared';
import type { AppContext } from '../context.js';
import { actorOf, parseBody, principalOf, workspaceParam } from '../helpers.js';
import { deleteDocumentFor, listDocumentsFor, readDocumentFor, writeDocumentFor } from '../../services/documents.js';

type DocParams = { Params: { slug?: string; doc: string }; Querystring: { resolve?: string; workspace?: string } };

export function registerDocumentRoutes(app: FastifyInstance, ctx: AppContext): void {
  const prefixes: { base: string; projectOf: (req: FastifyRequest<DocParams>) => string | null; workspaceOf: (req: FastifyRequest<DocParams>) => string | undefined }[] = [
    { base: '/api/v1/docs', projectOf: () => null, workspaceOf: workspaceParam },
    { base: '/api/v1/projects/:slug/docs', projectOf: (req) => req.params.slug ?? null, workspaceOf: () => undefined },
  ];

  for (const { base, projectOf, workspaceOf } of prefixes) {
    app.get<DocParams>(base, async (req) => listDocumentsFor(ctx, principalOf(req), projectOf(req), workspaceOf(req)));

    app.get<DocParams>(`${base}/:doc`, async (req) =>
      readDocumentFor(ctx, principalOf(req), projectOf(req), req.params.doc, req.query.resolve === 'meta', workspaceOf(req)),
    );

    app.put<DocParams>(`${base}/:doc`, async (req, reply) => {
      const input = parseBody(documentInputSchema, req.body);
      const { doc, created } = writeDocumentFor(ctx, actorOf(req), projectOf(req), req.params.doc, input, workspaceOf(req));
      return reply.status(created ? 201 : 200).send(doc);
    });

    app.delete<DocParams>(`${base}/:doc`, async (req, reply) => {
      deleteDocumentFor(ctx, actorOf(req), projectOf(req), req.params.doc, workspaceOf(req));
      return reply.status(204).send();
    });
  }
}
