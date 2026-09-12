import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { principalOf } from '../helpers.js';
import { searchFor } from '../../services/search.js';

export function registerSearchRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get<{ Querystring: { q?: string } }>('/api/v1/search', async (req) => searchFor(ctx, principalOf(req), req.query.q ?? ''));
}
