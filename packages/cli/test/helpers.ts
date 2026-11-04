import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { Scope } from '@blindkey/shared';
import { openDb, type Db } from '../../server/src/db/connection.js';
import { buildApp } from '../../server/src/http/app.js';
import type { KeyRing } from '../../server/src/config.js';
import { createToken } from '../../server/src/repos/tokens.js';
import { createProject, getProjectBySlug } from '../../server/src/repos/projects.js';
import { createSecret } from '../../server/src/repos/secrets.js';
import { upsertDocument } from '../../server/src/repos/documents.js';
import { createAdmin, getAdmin, setAdminPasswordHash } from '../../server/src/repos/admin.js';
import { addOwner, createWorkspace, getWorkspaceBySlug } from '../../server/src/repos/workspaces.js';
import { hashPassword } from '../../server/src/crypto/passwords.js';
import { enrollTotp, type Enrolled } from '../../server/test/helpers.js';

export interface ServerFixture {
  url: string;
  db: Db;
  ring: KeyRing;
  token: (scopes: Scope[], projects?: string[] | null) => string;
  /** Adds a workspace (the fixture owner owns it). Pass its slug as the trailing `workspace` argument below. */
  workspace: (slug: string, name: string) => void;
  /** `workspace` defaults to `default`; it only matters for projects and for globals (project = null). */
  project: (slug: string, workspace?: string) => void;
  secret: (project: string | null, name: string, fields: { key: string; value: string; sensitive?: boolean }[], workspace?: string) => void;
  doc: (project: string | null, slug: string, body_md: string, workspace?: string) => void;
  admin: (username: string, password: string) => Promise<void>;
  /** Id of the owner user (created on demand): tokens and approvals act as them. */
  userId: () => number;
  /** The owner's second factor (two-factor is mandatory, so the owner is always enrolled). */
  totp: () => Enrolled;
  /**
   * A valid login code for the owner. Resets the replay guard (`last_used_step`) first so a test file can log in
   * many times within one 30 s step; replay protection itself is covered by the server tests.
   */
  loginCode: () => string;
  close: () => Promise<void>;
}

export async function makeServer(): Promise<ServerFixture> {
  const db = openDb(':memory:');
  const ring: KeyRing = { current: 1, keys: new Map([[1, randomBytes(32)]]) };
  const app = await buildApp({ db, ring, logLevel: 'silent' });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address() as AddressInfo;
  const workspaceId = getWorkspaceBySlug(db, 'default')!.id;
  let enrolled: Enrolled | null = null;
  const owner = () => {
    const existing = getAdmin(db);
    if (existing) return existing;
    const created = createAdmin(db, 'fixture-owner', 'hash');
    enrolled = enrollTotp(db, ring, created.id);
    return created;
  };
  const wsId = (slug: string | undefined) => (slug === undefined ? workspaceId : getWorkspaceBySlug(db, slug)!.id);
  const workspaceOf = (slug: string) => getProjectBySlug(db, slug)!.workspace_id;
  const idOf = (slug: string | null) => (slug === null ? null : getProjectBySlug(db, slug)!.id);
  return {
    url: `http://127.0.0.1:${port}`,
    db,
    ring,
    token: (scopes, projects = null) =>
      createToken(db, {
        userId: owner().id,
        name: 'test',
        scopes,
        projectIds: projects === null ? null : projects.map((s) => getProjectBySlug(db, s)!.id),
        expiresAt: null,
      }).token,
    workspace: (slug, name) => {
      addOwner(db, createWorkspace(db, { slug, name }).id, owner().id);
    },
    project: (slug, workspace) => {
      createProject(db, { slug, name: slug.toUpperCase(), status: 'active', tags: [], summary: '' }, wsId(workspace));
    },
    secret: (project, name, fields, workspace) => {
      createSecret(db, ring, { projectId: idOf(project), workspaceId: project === null ? wsId(workspace) : workspaceOf(project), name, description: '', tags: [], fields });
    },
    doc: (project, slug, body_md, workspace) => {
      upsertDocument(db, { projectId: idOf(project), workspaceId: project === null ? wsId(workspace) : workspaceOf(project), slug, title: slug, category: 'notes', body_md });
    },
    admin: async (username, password) => {
      const hash = await hashPassword(password);
      const existing = getAdmin(db);
      if (!existing) {
        enrolled = enrollTotp(db, ring, createAdmin(db, username, hash).id);
        return;
      }
      // A token fixture already created the owner: it becomes this admin (its tokens stay valid).
      db.prepare(`UPDATE admin SET username = ? WHERE id = ?`).run(username, existing.id);
      setAdminPasswordHash(db, existing.id, hash);
    },
    userId: () => owner().id,
    totp: () => {
      owner();
      return enrolled!;
    },
    loginCode: () => {
      const id = owner().id;
      db.prepare(`UPDATE admin_totp SET last_used_step = 0 WHERE admin_id = ?`).run(id);
      return enrolled!.code();
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
 *
 * `stdinInput`, when given, is written to the child's stdin and the stream is
 * then ended (simulating `printf '...' | blindkey ...`) instead of leaving stdin
 * unset (`ignore`), which is what non-interactive prompts (login) read from.
 */
export function runCliAsync(args: string[], env: Record<string, string>, repoRoot: string, stdinInput?: string): Promise<CliRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(join(repoRoot, 'node_modules/.bin/tsx'), [join(repoRoot, 'packages/cli/src/cli.ts'), ...args], {
      env,
      stdio: [stdinInput === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => (stdout += c));
    child.stderr.on('data', (c: string) => (stderr += c));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    if (stdinInput !== undefined) child.stdin!.end(stdinInput);
  });
}

export interface CliRunOrTimeout extends CliRun {
  /** True if the child was still running at `timeoutMs` and had to be killed. */
  timedOut: boolean;
}

/**
 * Like runCliAsync, but writes `stdinInput` to the child's stdin WITHOUT
 * ending the stream — as if the caller's own end of the pipe stays open (a
 * `spawn` with the default `stdio: 'pipe'`, `docker exec -i`, a CI harness) —
 * and races the child's exit against `timeoutMs`. A CLI command that finishes
 * its own work must exit on its own even though the pipe is still open; if it
 * doesn't, the child is killed and `timedOut` is true instead of hanging the
 * test suite.
 */
export function runCliKeepStdinOpen(
  args: string[],
  env: Record<string, string>,
  repoRoot: string,
  stdinInput: string,
  timeoutMs = 5000,
): Promise<CliRunOrTimeout> {
  return new Promise((resolve, reject) => {
    const child = spawn(join(repoRoot, 'node_modules/.bin/tsx'), [join(repoRoot, 'packages/cli/src/cli.ts'), ...args], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => (stdout += c));
    child.stderr.on('data', (c: string) => (stderr += c));
    child.on('error', reject);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve({ status: null, stdout, stderr, timedOut: true });
    }, timeoutMs);
    child.on('close', (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status, stdout, stderr, timedOut: false });
    });
    // Deliberately no .end(): the pipe stays open, as it would for a real
    // caller that hasn't (or won't) close its end.
    child.stdin!.write(stdinInput);
  });
}

/**
 * Run the CLI with stdin redirected from a file (or `/dev/null`), like
 * `blindkey login <url> < answers.txt` or a cron/CI job with no controlling
 * terminal. This exercises `process.stdin` as an `fs.ReadStream` — a
 * different runtime shape than the pipe `net.Socket` `runCliAsync` and
 * `runCliKeepStdinOpen` exercise, and the one on which `stdin.ref`/`.unref`
 * don't exist at runtime despite the type declaring them unconditionally.
 */
export function runCliWithFileStdin(args: string[], env: Record<string, string>, repoRoot: string, stdinFilePath: string): Promise<CliRun> {
  return new Promise((resolve, reject) => {
    const fd = openSync(stdinFilePath, 'r');
    const child = spawn(join(repoRoot, 'node_modules/.bin/tsx'), [join(repoRoot, 'packages/cli/src/cli.ts'), ...args], {
      env,
      stdio: [fd, 'pipe', 'pipe'],
    });
    closeSync(fd); // the child has its own duplicated fd; ours is no longer needed
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
