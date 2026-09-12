import type { FastifyInstance } from 'fastify';
import { projectInputSchema, projectPatchSchema } from '@pidb/shared';
import type { AppContext } from '../context.js';
import { actorOf, parseBody, principalOf } from '../helpers.js';
import { createProjectFor, deleteProjectFor, getProjectDetailFor, listProjectsFor, updateProjectFor } from '../../services/projects.js';

type SlugParams = { Params: { slug: string } };

export function registerProjectRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/v1/projects', async (req) => listProjectsFor(ctx, principalOf(req)));

  app.get<SlugParams>('/api/v1/projects/:slug', async (req) => getProjectDetailFor(ctx, principalOf(req), req.params.slug));

  app.post('/api/v1/projects', async (req, reply) => {
    const input = parseBody(projectInputSchema, req.body);
    return reply.status(201).send(createProjectFor(ctx, actorOf(req), input));
  });

  app.patch<SlugParams>('/api/v1/projects/:slug', async (req) => {
    const patch = parseBody(projectPatchSchema, req.body);
    return updateProjectFor(ctx, actorOf(req), req.params.slug, patch);
  });

  app.delete<SlugParams>('/api/v1/projects/:slug', async (req, reply) => {
    deleteProjectFor(ctx, actorOf(req), req.params.slug);
    return reply.status(204).send();
  });
}
