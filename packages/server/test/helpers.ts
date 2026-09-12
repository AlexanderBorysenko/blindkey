import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Scope } from '@pidb/shared';
import { openDb, type Db } from '../src/db/connection.js';
import type { KeyRing } from '../src/config.js';
import type { AppContext } from '../src/http/context.js';
import { buildApp } from '../src/http/app.js';
import { createToken } from '../src/repos/tokens.js';
import { createProject, getProjectBySlug, type ProjectRow } from '../src/repos/projects.js';

export interface TestCtx {
  app: FastifyInstance;
  db: Db;
  ring: KeyRing;
  ctx: AppContext;
  token: (scopes: Scope[], projects?: string[] | null) => string;
  project: (slug: string) => ProjectRow;
}

export async function makeTestApp(): Promise<TestCtx> {
  const db = openDb(':memory:');
  const ring: KeyRing = { current: 1, keys: new Map([[1, randomBytes(32)]]) };
  const ctx: AppContext = { db, ring, logLevel: 'silent' };
  const app = await buildApp(ctx);
  return {
    app,
    db,
    ring,
    ctx,
    token: (scopes, projects = null) => {
      const ids = projects === null ? null : projects.map((s) => getProjectBySlug(db, s)!.id);
      return createToken(db, { name: 'test', scopes, projectIds: ids, expiresAt: null }).token;
    },
    project: (slug) => createProject(db, { slug, name: slug.toUpperCase(), status: 'active', tags: [], summary: '' }),
  };
}

export const auth = (token: string) => ({ authorization: `Bearer ${token}` });
