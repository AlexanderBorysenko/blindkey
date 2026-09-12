import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { Scope } from '@pidb/shared';
import { openDb, type Db } from '../../server/src/db/connection.js';
import { buildApp } from '../../server/src/http/app.js';
import type { KeyRing } from '../../server/src/config.js';
import { createToken } from '../../server/src/repos/tokens.js';
import { createProject, getProjectBySlug } from '../../server/src/repos/projects.js';
import { createSecret } from '../../server/src/repos/secrets.js';
import { upsertDocument } from '../../server/src/repos/documents.js';
import { createAdmin } from '../../server/src/repos/admin.js';
import { hashPassword } from '../../server/src/crypto/passwords.js';

export interface ServerFixture {
  url: string;
  db: Db;
  ring: KeyRing;
  token: (scopes: Scope[], projects?: string[] | null) => string;
  project: (slug: string) => void;
  secret: (project: string | null, name: string, fields: { key: string; value: string; sensitive?: boolean }[]) => void;
  doc: (project: string | null, slug: string, body_md: string) => void;
  admin: (username: string, password: string) => Promise<void>;
  close: () => Promise<void>;
}

export async function makeServer(): Promise<ServerFixture> {
  const db = openDb(':memory:');
  const ring: KeyRing = { current: 1, keys: new Map([[1, randomBytes(32)]]) };
  const app = await buildApp({ db, ring, logLevel: 'silent' });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address() as AddressInfo;
  const idOf = (slug: string | null) => (slug === null ? null : getProjectBySlug(db, slug)!.id);
  return {
    url: `http://127.0.0.1:${port}`,
    db,
    ring,
    token: (scopes, projects = null) =>
      createToken(db, {
        name: 'test',
        scopes,
        projectIds: projects === null ? null : projects.map((s) => getProjectBySlug(db, s)!.id),
        expiresAt: null,
      }).token,
    project: (slug) => {
      createProject(db, { slug, name: slug.toUpperCase(), status: 'active', tags: [], summary: '' });
    },
    secret: (project, name, fields) => {
      createSecret(db, ring, { projectId: idOf(project), name, description: '', tags: [], fields });
    },
    doc: (project, slug, body_md) => {
      upsertDocument(db, { projectId: idOf(project), slug, title: slug, category: 'notes', body_md });
    },
    admin: async (username, password) => {
      createAdmin(db, username, await hashPassword(password));
    },
    close: async () => {
      await app.close();
    },
  };
}

export interface CliRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Run the CLI in a child process and await it. Never use spawnSync here: the
 * fixture server runs in this process, and a synchronous wait would block the
 * event loop that has to answer the child's HTTP request.
 */
export function runCliAsync(args: string[], env: Record<string, string>, repoRoot: string): Promise<CliRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(join(repoRoot, 'node_modules/.bin/tsx'), [join(repoRoot, 'packages/cli/src/cli.ts'), ...args], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => (stdout += c));
    child.stderr.on('data', (c: string) => (stderr += c));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}
