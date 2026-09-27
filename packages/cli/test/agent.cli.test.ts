import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildProgram } from '../src/cli.js';
import { loadBindings, loadProfiles } from '../src/agent/state.js';
import { memoryStore, type TokenStore } from '../src/agent/tokenstore.js';
import { CliError } from '../src/errors.js';

let dataDir: string;
let repoDir: string;
let store: TokenStore;

const env = (): NodeJS.ProcessEnv => ({
  // Present to prove agent mode ignores them (spec §2.3).
  PIDB_URL: 'https://should-be-ignored.example.com',
  PIDB_TOKEN: 'pidb_should_be_ignored',
});

function program(overrides: Partial<{ store: TokenStore; cwd: string }> = {}) {
  return buildProgram({ agent: true, env: env(), cwd: overrides.cwd ?? repoDir, dataDir, store: overrides.store ?? store });
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'pidb-agent-cli-data-'));
  repoDir = mkdtempSync(join(tmpdir(), 'pidb-agent-cli-repo-'));
  store = memoryStore();
});

/** Every command action ends in `emit()`, which writes to real stdout — capture (and mute) it. */
async function run(p: ReturnType<typeof program>, args: string[]): Promise<string> {
  const original = process.stdout.write.bind(process.stdout);
  let captured = '';
  process.stdout.write = ((chunk: unknown) => {
    captured += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    await p.parseAsync(['node', 'pidb', ...args]);
  } finally {
    process.stdout.write = original;
  }
  return captured;
}

async function expectCliError(p: Promise<unknown>): Promise<CliError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(CliError);
    return err as CliError;
  }
  throw new Error('expected the command to throw a CliError');
}

describe('agent mode: profile', () => {
  it('add creates a profile and makes it the default the first time', async () => {
    await run(program(), ['profile', 'add', 'work', 'https://pidb.example.com/']);
    expect(loadProfiles(dataDir)).toEqual({ default: 'work', profiles: { work: { url: 'https://pidb.example.com' } } });
  });

  it('add does not change the default when one is already set', async () => {
    await run(program(), ['profile', 'add', 'work', 'https://work.example.com']);
    await run(program(), ['profile', 'add', 'side', 'https://side.example.com']);
    expect(loadProfiles(dataDir).default).toBe('work');
  });

  it('use switches the default profile', async () => {
    await run(program(), ['profile', 'add', 'work', 'https://work.example.com']);
    await run(program(), ['profile', 'add', 'side', 'https://side.example.com']);
    await run(program(), ['profile', 'use', 'side']);
    expect(loadProfiles(dataDir).default).toBe('side');
  });

  it('use rejects an unknown profile', async () => {
    const err = await expectCliError(program().parseAsync(['node', 'pidb', 'profile', 'use', 'nope']));
    expect(err.exitCode).toBe(4);
    expect(err.message).toMatch(/unknown profile "nope"/);
  });

  it('remove deletes the profile, clears the default if it was the default, and deletes its stored token', async () => {
    await run(program(), ['profile', 'add', 'work', 'https://work.example.com']);
    await store.set('work', 'pidb_work_token');
    await run(program(), ['profile', 'remove', 'work']);
    expect(loadProfiles(dataDir)).toEqual({ default: null, profiles: {} });
    expect(await store.get('work')).toBeNull();
  });

  it('remove rejects an unknown profile', async () => {
    const err = await expectCliError(program().parseAsync(['node', 'pidb', 'profile', 'remove', 'nope']));
    expect(err.exitCode).toBe(4);
  });

  it('list output includes the url but the JSON never includes a token', async () => {
    await run(program(), ['profile', 'add', 'work', 'https://work.example.com']);
    await store.set('work', 'pidb_super_secret_token');
    const captured = await run(program(), ['profile', 'list', '--json']);
    expect(captured).toContain('work.example.com');
    expect(captured).not.toContain('pidb_super_secret_token');
  });
});

describe('agent mode: bind / unbind / status', () => {
  it('bind fails when no profile is configured', async () => {
    const err = await expectCliError(program().parseAsync(['node', 'pidb', 'bind', 'acme']));
    expect(err.exitCode).toBe(3);
    expect(err.message).toMatch(/no server configured/);
  });

  it('bind records the project under the repo key on the default profile', async () => {
    await run(program(), ['profile', 'add', 'work', 'https://work.example.com']);
    await run(program(), ['bind', 'acme']);
    const bindings = loadBindings(dataDir);
    const keys = Object.keys(bindings);
    expect(keys).toHaveLength(1);
    expect(bindings[keys[0]!]).toEqual({ profile: 'work', project: 'acme' });
  });

  it('unbind removes the binding for this repo', async () => {
    await run(program(), ['profile', 'add', 'work', 'https://work.example.com']);
    await run(program(), ['bind', 'acme']);
    await run(program(), ['unbind']);
    expect(loadBindings(dataDir)).toEqual({});
  });

  it('status reports profile, url, bound project and connection state, and never the token', async () => {
    await run(program(), ['profile', 'add', 'work', 'https://work.example.com']);
    await run(program(), ['bind', 'acme']);
    await store.set('work', 'pidb_super_secret_token');

    const captured = await run(program(), ['status']);

    expect(captured).toContain('profile: work');
    expect(captured).toContain('url: https://work.example.com');
    expect(captured).toContain('project: acme');
    expect(captured).toContain('connected: yes');
    expect(captured).not.toContain('pidb_super_secret_token');
  });

  it('status reports "connected: no" and no url/project when nothing is configured', async () => {
    const captured = await run(program(), ['status']);
    expect(captured).toContain('profile: (none)');
    expect(captured).toContain('connected: no');
  });

  it('status --json never includes a token field', async () => {
    await run(program(), ['profile', 'add', 'work', 'https://work.example.com']);
    await store.set('work', 'pidb_super_secret_token');

    const captured = await run(program(), ['status', '--json']);
    const parsed = JSON.parse(captured) as Record<string, unknown>;
    expect(parsed).toEqual({ profile: 'work', url: 'https://work.example.com', project: null, connected: true });
    expect(captured).not.toContain('pidb_super_secret_token');
  });
});

describe('agent mode: disabled commands', () => {
  it('login exits 2 with the spec message', async () => {
    const err = await expectCliError(program().parseAsync(['node', 'pidb', 'login', 'https://x.example.com']));
    expect(err.exitCode).toBe(2);
    expect(err.message).toBe('not available to the Claude agent — ask the user');
  });

  it('secret get exits 2 with the spec message', async () => {
    const err = await expectCliError(program().parseAsync(['node', 'pidb', 'secret', 'get', 'global', 'X', 'k']));
    expect(err.exitCode).toBe(2);
    expect(err.message).toBe('not available to the Claude agent — ask the user');
  });

  it('secret set exits 2 with the spec message', async () => {
    const err = await expectCliError(program().parseAsync(['node', 'pidb', 'secret', 'set', 'global', 'X', 'k']));
    expect(err.exitCode).toBe(2);
  });

  it('token create/list/revoke exit 2 with the spec message', async () => {
    for (const args of [
      ['token', 'create', '--name', 'a', '--scopes', 'projects:read'],
      ['token', 'list'],
      ['token', 'revoke', 'abc'],
    ]) {
      const err = await expectCliError(program().parseAsync(['node', 'pidb', ...args]));
      expect(err.exitCode).toBe(2);
      expect(err.message).toBe('not available to the Claude agent — ask the user');
    }
  });

  it('search is not registered at all in agent mode', async () => {
    await expect(program().parseAsync(['node', 'pidb', 'search', 'anything'])).rejects.toThrow();
  });
});

describe('agent mode: PIDB_URL / PIDB_TOKEN are ignored', () => {
  it('a configured profile wins over PIDB_URL, and the keyring token wins over PIDB_TOKEN', async () => {
    await run(program(), ['profile', 'add', 'work', 'https://work.example.com']);
    await store.set('work', 'pidb_real_token');

    const captured = await run(program(), ['status', '--json']);
    const parsed = JSON.parse(captured) as { url: string };
    expect(parsed.url).toBe('https://work.example.com');
    expect(parsed.url).not.toContain('should-be-ignored');
  });

  it('with no profile configured, resolveAgentConfig errors instead of falling back to PIDB_URL/TOKEN', async () => {
    const err = await expectCliError(program().parseAsync(['node', 'pidb', 'bind', 'acme']));
    expect(err.message).toMatch(/no server configured/);
  });
});

describe('normal mode is unaffected', () => {
  it('does not register agent-only commands (profile/bind/unbind/status)', async () => {
    const normal = buildProgram();
    await expect(normal.parseAsync(['node', 'pidb', 'profile', 'list'])).rejects.toThrow();
  });
});

describe('bind uses the real git top-level when cwd is inside a git repo', () => {
  it('binds the same repo the same way from a subdirectory', async () => {
    execFileSync('git', ['init', '-q'], { cwd: repoDir });
    const subdir = join(repoDir, 'sub');
    mkdirSync(subdir);

    await run(program(), ['profile', 'add', 'work', 'https://work.example.com']);
    await run(program(), ['bind', 'acme']);
    // Bound from the repo root — status must still resolve the same binding from a subdirectory.
    const captured = await run(program({ cwd: subdir }), ['status']);
    expect(captured).toContain('project: acme');
  });
});
