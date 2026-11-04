import type { Scope } from '@blindkey/shared';
import { makeTestApp, auth, type TestCtx } from './helpers.js';
import type { Actor } from '../src/auth/principal.js';
import { createUser, type UserRow } from '../src/repos/admin.js';
import { createToken, type TokenKind } from '../src/repos/tokens.js';
import { upsertGrant } from '../src/repos/grants.js';
import { createSecret } from '../src/repos/secrets.js';
import { getDocument, upsertDocument } from '../src/repos/documents.js';

export interface Shared extends TestCtx {
  bob: UserRow;
  carol: UserRow;
  dave: UserRow;
  erin: UserRow;
  /** A token acting as `user`. */
  as: (user: UserRow, scopes?: Scope[], projects?: string[] | null, kind?: TokenKind) => string;
  /** Request as a user with a full-scope (`admin`) token unless `token` is given. */
  call: (user: UserRow, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown, token?: string) => Promise<{ status: number; json: unknown; body: string }>;
}

const fields = (host: string, secret: string, key = 'password') => [
  { key: 'host', value: host },
  { key, value: secret },
];

/**
 * One workspace (`default`) owned by the first user, with projects alpha/beta/gamma, a global secret and
 * document, and four more users: bob (grant `*` on alpha), carol (grant `cli` on the single secret
 * beta/DB), dave (grant `docs.read` on the single document gamma/gdoc), erin (no grants at all).
 */
export async function makeShared(): Promise<Shared> {
  const t = await makeTestApp();
  t.owner();
  // Two-factor is mandatory, so every fixture user has it on.
  const mk = (name: string): UserRow => {
    const user = createUser(t.db, { username: name, passwordHash: 'h' });
    t.enroll(user.id);
    return user;
  };
  const alpha = t.project('alpha');
  const beta = t.project('beta');
  const gamma = t.project('gamma');
  const ws = t.workspaceId;
  const secret = (projectId: number | null, name: string, f: { key: string; value: string }[]) =>
    createSecret(t.db, t.ring, { projectId, workspaceId: ws, name, description: `${name} desc`, tags: [], fields: f });
  const doc = (projectId: number | null, slug: string, body: string) =>
    upsertDocument(t.db, { projectId, workspaceId: ws, slug, title: slug, category: 'notes', body_md: body });
  secret(alpha.id, 'ADB', fields('10.0.0.1', 'alpha-pw'));
  doc(alpha.id, 'notes', 'alpha notes');
  const db = secret(beta.id, 'DB', fields('db.example', 'beta-pw'));
  secret(beta.id, 'OTHER', fields('other.example', 'other-pw'));
  doc(beta.id, 'bdoc', 'beta doc');
  doc(gamma.id, 'gdoc', 'gamma doc');
  doc(gamma.id, 'gother', 'gamma other');
  secret(gamma.id, 'GS', fields('gs.example', 'gs-pw'));
  secret(null, 'GLOBAL_S', fields('g.example', 'glob-pw', 'token'));
  doc(null, 'ghandbook', 'global handbook');

  const bob = mk('bob');
  const carol = mk('carol');
  const dave = mk('dave');
  const erin = mk('erin');
  upsertGrant(t.db, { userId: bob.id, targetType: 'project', targetId: alpha.id, perms: '*' });
  upsertGrant(t.db, { userId: carol.id, targetType: 'secret', targetId: db.id, perms: ['cli'] });
  upsertGrant(t.db, { userId: dave.id, targetType: 'document', targetId: getDocument(t.db, gamma.id, 'gdoc')!.id, perms: ['docs.read'] });

  const as: Shared['as'] = (user, scopes = ['admin'], projects = null, kind = 'user') =>
    createToken(t.db, {
      userId: user.id,
      name: `t-${user.username}`,
      scopes,
      projectIds: projects === null ? null : projects.map((s) => t.project_id(s)),
      expiresAt: null,
      kind,
    }).token;
  const call: Shared['call'] = async (user, method, url, payload, token) => {
    const res = await t.app.inject({ method, url, headers: auth(token ?? as(user)), ...(payload === undefined ? {} : { payload: payload as object }) });
    let json: unknown = null;
    try {
      json = res.json();
    } catch {
      json = null;
    }
    return { status: res.statusCode, json, body: res.body };
  };
  return Object.assign(t, { bob, carol, dave, erin, as, call }) as unknown as Shared;
}

/** The JSON body of a response typed for the test at hand. */
export const jsonAs = <T>(r: { json: unknown }): T => r.json as T;

/** A session-style actor for a user (full scopes), for calling services directly. */
export function actorOf(user: UserRow, scopes: Scope[] = ['admin']): Actor {
  return {
    principal: { kind: 'admin', id: user.id, userId: user.id, isSuper: user.is_super, impersonatorId: null, scopes, projectIds: null, agent: false },
    ip: '127.0.0.1',
    userAgent: 'test',
  };
}
