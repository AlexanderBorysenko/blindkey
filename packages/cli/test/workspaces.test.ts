import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiError, BlindkeyClient, parseTarget, scopedPath } from '../src/client.js';
import { CliError } from '../src/errors.js';
import { runDocsList } from '../src/commands/docs.js';
import { runSecretsList } from '../src/commands/secrets.js';
import { runProjectsCreate, runSecretsRequest } from '../src/commands/write.js';
import { runWorkspaces } from '../src/commands/projects.js';
import { buildProgram } from '../src/program.js';
import { repoKey, saveBindings, saveProfiles } from '../src/agent/state.js';
import { memoryStore } from '../src/agent/tokenstore.js';
import { makeServer, runCliAsync, type ServerFixture } from './helpers.js';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

describe('target parsing', () => {
  it('accepts a project slug, global and global@<workspace>', () => {
    expect(parseTarget('acme')).toEqual({ kind: 'project', slug: 'acme' });
    expect(parseTarget('global')).toEqual({ kind: 'global', workspace: null });
    expect(parseTarget('global@second')).toEqual({ kind: 'global', workspace: 'second' });
    expect(parseTarget('global@third')).toEqual({ kind: 'global', workspace: 'third' });
  });

  it.each(['global@', 'global@Bad Slug', 'global@UPPER', 'global@-x', 'global@a@b', 'global@a/b'])('rejects %j', (raw) => {
    expect(() => parseTarget(raw)).toThrow(CliError);
    expect(() => parseTarget(raw)).toThrow(/global@<workspace-slug>/);
  });

  it('builds paths with the workspace query on globals only', () => {
    expect(scopedPath('global', 'secrets')).toBe('/api/v1/secrets');
    expect(scopedPath('global', 'secrets', '', 'second')).toBe('/api/v1/secrets?workspace=second');
    expect(scopedPath('global@second', 'docs', '/deploy', 'ignored')).toBe('/api/v1/docs/deploy?workspace=second');
    expect(scopedPath('global@second', 'secrets', '/DB%20x/use')).toBe('/api/v1/secrets/DB%20x/use?workspace=second');
    expect(scopedPath('acme', 'docs', '/deploy', 'second')).toBe('/api/v1/projects/acme/docs/deploy');
  });
});

describe('workspaces against a server with two workspaces', () => {
  let s: ServerFixture;
  const client = (scopes: Parameters<ServerFixture['token']>[0], projects: string[] | null = null) =>
    new BlindkeyClient({ url: s.url, token: s.token(scopes, projects) });

  beforeAll(async () => {
    s = await makeServer();
    s.workspace('second', 'Second');
    s.project('acme');
    s.project('beta', 'second');
    s.doc(null, 'guidelines-default', '# default', 'default');
    s.doc(null, 'guidelines-second', '# second', 'second');
    s.secret(null, 'Default VPS', [{ key: 'host', value: 'h.example' }], 'default');
    s.secret(null, 'Second VPS', [{ key: 'host', value: 's.example' }], 'second');
  });
  afterAll(async () => {
    await s.close();
  });

  it('`workspaces` lists slug, name and role', async () => {
    const r = await runWorkspaces(client(['projects:read']));
    expect(r.json).toEqual([
      { slug: 'default', name: 'Default', role: 'owner' },
      { slug: 'second', name: 'Second', role: 'owner' },
    ]);
    expect(r.text).toMatch(/^SLUG\s+NAME\s+ROLE$/m);
    expect(r.text).toMatch(/^second\s+Second\s+owner$/m);
  });

  it('global@<ws> lists the globals of that workspace only', async () => {
    const c = client(['docs:read', 'secrets:meta']);
    expect((await runDocsList(c, 'global@second')).text).toContain('guidelines-second');
    expect((await runDocsList(c, 'global@second')).text).not.toContain('guidelines-default');
    expect((await runSecretsList(c, 'global@default')).text).toContain('Default VPS');
    expect((await runSecretsList(c, 'global@default')).text).not.toContain('Second VPS');
  });

  it('a bare global with several visible workspaces surfaces the server 400 with a hint', async () => {
    const err = await runDocsList(client(['docs:read']), 'global').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(400);
    expect((err as ApiError).message).toContain('workspace required');
    expect((err as ApiError).message).toContain('global@<workspace-slug>');
    expect((err as ApiError).message).toContain('blindkey workspaces');
  });

  it('an unknown workspace is a 404, not a hint', async () => {
    const err = await runDocsList(client(['docs:read']), 'global@nope').catch((e: unknown) => e);
    expect((err as ApiError).status).toBe(404);
    expect((err as ApiError).message).not.toContain('global@<workspace-slug>');
  });

  it('projects create --workspace puts the project in that workspace', async () => {
    const c = client(['projects:read', 'projects:create']);
    await expect(runProjectsCreate(c, 'ambiguous', { name: 'A' })).rejects.toMatchObject({ status: 400 });
    await runProjectsCreate(c, 'gamma', { name: 'Gamma', workspace: 'second' });
    const p = await c.json<{ workspace: string }>('GET', '/api/v1/projects/gamma');
    expect(p.workspace).toBe('second');
  });

  it('secrets request for global@<ws> carries the workspace in the link; a project link does not', async () => {
    const c = client(['secrets:meta']);
    const g = await runSecretsRequest(c, 'global@second', 'Second VPS', { key: ['password'] });
    expect((g.json as { url: string }).url).toContain('/global/secrets/Second%20VPS/edit?');
    expect((g.json as { url: string }).url).toContain('workspace=second');
    const p = await runSecretsRequest(c, 'beta', 'New', { key: ['password'] });
    expect((p.json as { url: string }).url).not.toContain('workspace=');
  });

  describe('agent mode: bare global follows the bound project', () => {
    async function runAgent(args: string[], project: string | null): Promise<string> {
      const dataDir = mkdtempSync(join(tmpdir(), 'blindkey-ws-data-'));
      const repoDir = mkdtempSync(join(tmpdir(), 'blindkey-ws-repo-'));
      const store = memoryStore();
      saveProfiles(dataDir, { default: 'work', profiles: { work: { url: s.url } } });
      if (project) saveBindings(dataDir, { [repoKey(repoDir)]: { profile: 'work', project } });
      await store.set('work', s.token(['projects:read', 'docs:read', 'secrets:meta']));
      const program = buildProgram({ agent: true, env: {}, cwd: repoDir, dataDir, store });
      const original = process.stdout.write.bind(process.stdout);
      let out = '';
      process.stdout.write = ((chunk: unknown) => {
        out += String(chunk);
        return true;
      }) as typeof process.stdout.write;
      try {
        await program.parseAsync(['node', 'blindkey', ...args]);
      } finally {
        process.stdout.write = original;
      }
      return out;
    }

    it('uses the workspace of the bound project', async () => {
      const second = await runAgent(['docs', 'list', 'global'], 'beta');
      expect(second).toContain('guidelines-second');
      expect(second).not.toContain('guidelines-default');
      const defaultOut = await runAgent(['secrets', 'list'], 'acme');
      expect(defaultOut).toContain('Default VPS');
      expect(defaultOut).not.toContain('Second VPS');
    });

    it('an explicit global@<ws> wins over the binding', async () => {
      expect(await runAgent(['docs', 'list', 'global@default'], 'beta')).toContain('guidelines-default');
    });

    it('unbound: the server decides and its 400 gets the hint', async () => {
      await expect(runAgent(['docs', 'list', 'global'], null)).rejects.toThrow(/global@<workspace-slug>/);
    });
  });

  describe('spawned CLI', () => {
    const run = (args: string[]) =>
      runCliAsync(
        args,
        {
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? '',
          BLINDKEY_CONFIG_HOME: mkdtempSync(join(tmpdir(), 'blindkey-ws-e2e-')),
          BLINDKEY_URL: s.url,
          BLINDKEY_TOKEN: s.token(['projects:read', 'docs:read', 'secrets:meta']),
        },
        repoRoot,
      );

    it('`blindkey workspaces` prints the table', async () => {
      const r = await run(['workspaces']);
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/default\s+Default\s+owner/);
      expect(r.stdout).toMatch(/second\s+Second\s+owner/);
    });

    it('`blindkey workspaces --json` prints JSON', async () => {
      const r = await run(['workspaces', '--json']);
      expect(JSON.parse(r.stdout)).toHaveLength(2);
    });

    it('rejects a malformed workspace target before any request', async () => {
      const r = await run(['secrets', 'list', 'global@Bad Slug']);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('global@<workspace-slug>');
    });

    it('a bare global prints the workspace hint on the 400', async () => {
      const r = await run(['docs', 'list']);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('workspace required');
      expect(r.stderr).toContain('global@<workspace-slug>');
    });

    it('global@second works end to end', async () => {
      const r = await run(['docs', 'list', 'global@second']);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('guidelines-second');
    });
  });
});
