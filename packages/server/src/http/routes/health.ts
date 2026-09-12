import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { principalOf } from '../helpers.js';
import { listProjects } from '../../repos/projects.js';

export function registerHealthRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/health', { config: { public: true } }, async () => ({ ok: true }));

  app.get('/api/v1/me', async (req) => {
    const p = principalOf(req);
    return {
      kind: p.kind,
      scopes: p.scopes,
      projects: p.projectIds === null ? null : listProjects(ctx.db, p.projectIds).map((x) => x.slug),
    };
  });
}
