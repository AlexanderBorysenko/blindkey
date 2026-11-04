import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Scope } from '@blindkey/shared';
import { openDb, type Db } from '../src/db/connection.js';
import type { KeyRing } from '../src/config.js';
import type { AppContext } from '../src/http/context.js';
import { buildApp } from '../src/http/app.js';
import { createToken, type TokenKind } from '../src/repos/tokens.js';
import { createProject, getProjectBySlug, type ProjectRow } from '../src/repos/projects.js';
import { createAdmin, createSession, getAdmin, getUserByUsername, type UserRow } from '../src/repos/admin.js';
import { enableTotp, savePendingTotp } from '../src/repos/twofactor.js';
import { generateTotpSecret, hotp, stepAt } from '../src/auth/totp.js';
import { getWorkspaceBySlug } from '../src/repos/workspaces.js';

export interface Enrolled {
  secret: Buffer;
  /** The code for the current 30 s step plus `offset` (-1, 0 or 1: the verifier's window). A step can be used once. */
  code: (offset?: number) => string;
}

/**
 * Two-factor is mandatory, so every test user that logs in or mints tokens needs it on. This turns it on
 * directly in the database (no recovery codes) and returns the secret for tests that exercise the login code step.
 */
export function enrollTotp(db: Db, ring: KeyRing, userId: number): Enrolled {
  const secret = generateTotpSecret();
  savePendingTotp(db, ring, userId, secret);
  enableTotp(db, userId, 0);
  return { secret, code: (offset = 0) => hotp(secret, stepAt(Date.now()) + offset) };
}

/** A browser session for `username`, opened directly (login is rate limited and needs a code once 2FA is on). Returns the cookie value. */
export function sessionFor(db: Db, username: string, ttlMs = 3_600_000): string {
  return createSession(db, getUserByUsername(db, username)!.id, ttlMs, '127.0.0.1', 'test');
}

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
  /** Turns two-factor on for a user (by id or username); see `enrollTotp`. */
  enroll: (user: number | string) => Enrolled;
  /** Id of the `default` workspace (the only one in a test database). */
  workspaceId: number;
}

export async function makeTestApp(): Promise<TestCtx> {
  const db = openDb(':memory:');
  const ring: KeyRing = { current: 1, keys: new Map([[1, randomBytes(32)]]) };
  const ctx: AppContext = { db, ring, logLevel: 'silent' };
  const workspaceId = getWorkspaceBySlug(db, 'default')!.id;
  const owner = (): UserRow => {
    const existing = getAdmin(db);
    if (existing) return existing;
    const created = createAdmin(db, 'alex', 'hash');
    enrollTotp(db, ring, created.id);
    return created;
  };
  const enroll = (user: number | string): Enrolled => enrollTotp(db, ring, typeof user === 'number' ? user : getUserByUsername(db, user)!.id);
  const app = await buildApp(ctx);
  return {
    app,
    db,
    ring,
    ctx,
    owner,
    enroll,
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
