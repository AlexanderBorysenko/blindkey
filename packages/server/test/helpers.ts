import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Scope } from '@blindkey/shared';
import { openDb, type Db } from '../src/db/connection.js';
import type { KeyRing } from '../src/config.js';
import type { AppContext } from '../src/http/context.js';
import { buildApp } from '../src/http/app.js';
import { createToken, type TokenKind } from '../src/repos/tokens.js';
import { createProject, getProjectBySlug, type ProjectRow } from '../src/repos/projects.js';
import { createAdmin, getAdmin, type UserRow } from '../src/repos/admin.js';
import { getWorkspaceBySlug } from '../src/repos/workspaces.js';

export interface TestCtx {
  app: FastifyInstance;
  db: Db;
  ring: KeyRing;
  ctx: AppContext;
  token: (scopes: Scope[], projects?: string[] | null, kind?: TokenKind) => string;
  project: (slug: string) => ProjectRow;
  /** Id of an existing project by slug. */
  project_id: (slug: string) => number;
  /** The first (super) user, created on first use; owner of the `default` workspace. */
  owner: () => UserRow;
  /** Id of the `default` workspace (the only one in a test database). */
  workspaceId: number;
}

export async function makeTestApp(): Promise<TestCtx> {
  const db = openDb(':memory:');
  const ring: KeyRing = { current: 1, keys: new Map([[1, randomBytes(32)]]) };
  const ctx: AppContext = { db, ring, logLevel: 'silent' };
  const workspaceId = getWorkspaceBySlug(db, 'default')!.id;
  const owner = (): UserRow => getAdmin(db) ?? createAdmin(db, 'alex', 'hash');
  const app = await buildApp(ctx);
  return {
    app,
    db,
    ring,
    ctx,
    owner,
    workspaceId,
    project_id: (slug) => getProjectBySlug(db, slug)!.id,
    token: (scopes, projects = null, kind = 'user') => {
      const ids = projects === null ? null : projects.map((s) => getProjectBySlug(db, s)!.id);
      return createToken(db, { userId: owner().id, name: 'test', scopes, projectIds: ids, expiresAt: null, kind }).token;
    },
    project: (slug) => createProject(db, { slug, name: slug.toUpperCase(), status: 'active', tags: [], summary: '' }, workspaceId),
  };
}

export const auth = (token: string) => ({ authorization: `Bearer ${token}` });

/** Id of the seeded `default` workspace (every fresh database has it). */
export const homeId = (db: Db): number => getWorkspaceBySlug(db, 'default')!.id;
