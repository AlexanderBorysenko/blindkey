import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildProgram } from '../src/program.js';
import { loadBindings, loadProfiles } from '../src/agent/state.js';
import { memoryStore, type TokenStore } from '../src/agent/tokenstore.js';
import { CliError } from '../src/errors.js';

let dataDir: string;
let repoDir: string;
let store: TokenStore;

const env = (): NodeJS.ProcessEnv => ({
  // Present to prove agent mode ignores them (spec §2.3).
  BLINDKEY_URL: 'https://should-be-ignored.example.com',
  BLINDKEY_TOKEN: 'bk_should_be_ignored',
});

function program(overrides: Partial<{ store: TokenStore; cwd: string }> = {}) {
  return buildProgram({ agent: true, env: env(), cwd: overrides.cwd ?? repoDir, dataDir, store: overrides.store ?? store });
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'blindkey-agent-cli-data-'));
  repoDir = mkdtempSync(join(tmpdir(), 'blindkey-agent-cli-repo-'));
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
    await p.parseAsync(['node', 'blindkey', ...args]);
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
    await run(program(), ['profile', 'add', 'work', 'https://blindkey.example.com/']);
    expect(loadProfiles(dataDir)).toEqual({ default: 'work', profiles: { work: { url: 'https://blindkey.example.com' } } });
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
    const err = await expectCliError(program().parseAsync(['node', 'blindkey', 'profile', 'use', 'nope']));
    expect(err.exitCode).toBe(4);
    expect(err.message).toMatch(/unknown profile "nope"/);
  });

  it('remove deletes the profile, clears the default if it was the default, and deletes its stored token', async () => {
    await run(program(), ['profile', 'add', 'work', 'https://work.example.com']);
    await store.set('work', 'bk_work_token');
    await run(program(), ['profile', 'remove', 'work']);
    expect(loadProfiles(dataDir)).toEqual({ default: null, profiles: {} });
    expect(await store.get('work')).toBeNull();
  });

  it('remove rejects an unknown profile', async () => {
    const err = await expectCliError(program().parseAsync(['node', 'blindkey', 'profile', 'remove', 'nope']));
    expect(err.exitCode).toBe(4);
  });

  it('list output includes the url but the JSON never includes a token', async () => {
    await run(program(), ['profile', 'add', 'work', 'https://work.example.com']);
    await store.set('work', 'bk_super_secret_token');
    const captured = await run(program(), ['profile', 'list', '--json']);
    expect(captured).toContain('work.example.com');
    expect(captured).not.toContain('bk_super_secret_token');
  });

  it('add refuses an existing profile name rather than silently overwriting its url', async () => {
    await run(program(), ['profile', 'add', 'work', 'https://work.example.com']);
    const err = await expectCliError(program().parseAsync(['node', 'blindkey', 'profile', 'add', 'work', 'https://other.example.com']));
    expect(err.exitCode).toBe(2);
    expect(err.message).toBe('profile work exists — use `blindkey profile set-url work <url>`');
    // Untouched: the refused add did not change the stored url.
    expect(loadProfiles(dataDir).profiles.work).toEqual({ url: 'https://work.example.com' });
  });

  it('set-url changes the url and clears the stored token', async () => {
    await run(program(), ['profile', 'add', 'work', 'https://work.example.com']);
    await store.set('work', 'bk_old_token');
    const captured = await run(program(), ['profile', 'set-url', 'work', 'https://work2.example.com/']);
    expect(loadProfiles(dataDir).profiles.work).toEqual({ url: 'https://work2.example.com' });
    expect(await store.get('work')).toBeNull();
    expect(captured).toContain('token cleared — run `blindkey connect --profile work`');
  });

  it('set-url rejects an unknown profile', async () => {
    const err = await expectCliError(program().parseAsync(['node', 'blindkey', 'profile', 'set-url', 'nope', 'https://x.example.com']));
    expect(err.exitCode).toBe(4);
  });

  it('set-url deletes the token before saving the new url (crash-safety: never a new url with a stale token)', async () => {
    await run(program(), ['profile', 'add', 'work', 'https://work.example.com']);
    await store.set('work', 'bk_old_token');
    let urlOnDiskWhenTokenWasDeleted: string | undefined;
    const spyingStore: TokenStore = {
      get: (p) => store.get(p),
      set: (p, t) => store.set(p, t),
      delete: async (p) => {
        urlOnDiskWhenTokenWasDeleted = loadProfiles(dataDir).profiles[p]?.url;
        await store.delete(p);
      },
    };
    await run(program({ store: spyingStore }), ['profile', 'set-url', 'work', 'https://work2.example.com']);
    expect(urlOnDiskWhenTokenWasDeleted).toBe('https://work.example.com');
  });
});

describe('agent mode: bind / unbind / status', () => {
  it('bind fails when no profile is configured', async () => {
    const err = await expectCliError(program().parseAsync(['node', 'blindkey', 'bind', 'acme']));
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
    await store.set('work', 'bk_super_secret_token');

    const captured = await run(program(), ['status']);

    expect(captured).toContain('profile: work');
    expect(captured).toContain('url: https://work.example.com');
    expect(captured).toContain('project: acme');
    expect(captured).toContain('connected: yes');
    expect(captured).not.toContain('bk_super_secret_token');
  });

  it('status reports "connected: no" and no url/project when nothing is configured', async () => {
    const captured = await run(program(), ['status']);
    expect(captured).toContain('profile: (none)');
    expect(captured).toContain('connected: no');
  });

  it('status --json never includes a token field', async () => {
    await run(program(), ['profile', 'add', 'work', 'https://work.example.com']);
    await store.set('work', 'bk_super_secret_token');

    const captured = await run(program(), ['status', '--json']);
    const parsed = JSON.parse(captured) as Record<string, unknown>;
    expect(parsed).toEqual({ profile: 'work', url: 'https://work.example.com', project: null, connected: true });
    expect(captured).not.toContain('bk_super_secret_token');
  });
});

describe('agent mode: disabled commands', () => {
  it('login exits 2 with the spec message', async () => {
    const err = await expectCliError(program().parseAsync(['node', 'blindkey', 'login', 'https://x.example.com']));
    expect(err.exitCode).toBe(2);
    expect(err.message).toBe('not available to the Claude agent — ask the user');
  });

  it('login with no <url> still exits 2 with the agent message, not commander\'s "missing required argument"', async () => {
    const err = await expectCliError(program().parseAsync(['node', 'blindkey', 'login']));
    expect(err.exitCode).toBe(2);
    expect(err.message).toBe('not available to the Claude agent — ask the user');
  });

  it('secret get exits 2 with the spec message', async () => {
    const err = await expectCliError(program().parseAsync(['node', 'blindkey', 'secret', 'get', 'global', 'X', 'k']));
    expect(err.exitCode).toBe(2);
    expect(err.message).toBe('not available to the Claude agent — ask the user');
  });

  it('secret get with no arguments at all still exits 2 with the agent message', async () => {
    const err = await expectCliError(program().parseAsync(['node', 'blindkey', 'secret', 'get']));
    expect(err.exitCode).toBe(2);
    expect(err.message).toBe('not available to the Claude agent — ask the user');
  });

  it('secret set exits 2 with the spec message', async () => {
    const err = await expectCliError(program().parseAsync(['node', 'blindkey', 'secret', 'set', 'global', 'X', 'k']));
    expect(err.exitCode).toBe(2);
  });

  it('token create/list/revoke exit 2 with the spec message', async () => {
    for (const args of [
      ['token', 'create', '--name', 'a', '--scopes', 'projects:read'],
      ['token', 'list'],
      ['token', 'revoke', 'abc'],
    ]) {
      const err = await expectCliError(program().parseAsync(['node', 'blindkey', ...args]));
      expect(err.exitCode).toBe(2);
      expect(err.message).toBe('not available to the Claude agent — ask the user');
    }
  });

  it('token create with no options at all still exits 2 with the agent message, not a missing-option error', async () => {
    const err = await expectCliError(program().parseAsync(['node', 'blindkey', 'token', 'create']));
    expect(err.exitCode).toBe(2);
    expect(err.message).toBe('not available to the Claude agent — ask the user');
  });

  it('bare `token` (no subcommand) refuses instead of showing the group\'s help', async () => {
    const err = await expectCliError(program().parseAsync(['node', 'blindkey', 'token']));
    expect(err.exitCode).toBe(2);
    expect(err.message).toBe('not available to the Claude agent — ask the user');
  });

  it('login, secret get, secret set and the whole token group are hidden from agent-mode help', () => {
    const help = program().helpInformation();
    expect(help).not.toMatch(/\blogin\b/);
    expect(help).not.toMatch(/\btoken\b/);
    const secretHelp = program().commands.find((c) => c.name() === 'secret')!.helpInformation();
    expect(secretHelp).not.toMatch(/\bget\b/);
    expect(secretHelp).not.toMatch(/\bset\b/);
    expect(secretHelp).toMatch(/\bwrite\b/); // still visible: not disabled
  });

  it('search remains visible in agent-mode help (spec ruling: available, read-only)', () => {
    expect(program().helpInformation()).toMatch(/\bsearch\b/);
  });
});

describe('agent mode: search is available (spec ruling)', () => {
  it('is registered — fails on config resolution (no profile configured), not on an unknown command', async () => {
    const err = await expectCliError(program().parseAsync(['node', 'blindkey', 'search', 'anything']));
    expect(err.exitCode).toBe(3);
    expect(err.message).toMatch(/no server configured/);
  });
});

describe('agent mode: BLINDKEY_URL / BLINDKEY_TOKEN are ignored', () => {
  it('a configured profile wins over BLINDKEY_URL, and the keyring token wins over BLINDKEY_TOKEN', async () => {
    await run(program(), ['profile', 'add', 'work', 'https://work.example.com']);
    await store.set('work', 'bk_real_token');

    const captured = await run(program(), ['status', '--json']);
    const parsed = JSON.parse(captured) as { url: string };
    expect(parsed.url).toBe('https://work.example.com');
    expect(parsed.url).not.toContain('should-be-ignored');
  });

  it('with no profile configured, resolveAgentConfig errors instead of falling back to BLINDKEY_URL/TOKEN', async () => {
    const err = await expectCliError(program().parseAsync(['node', 'blindkey', 'bind', 'acme']));
    expect(err.message).toMatch(/no server configured/);
  });
});

describe('normal mode is unaffected', () => {
  it('does not register agent-only commands (profile/bind/unbind/status)', async () => {
    const normal = buildProgram();
    await expect(normal.parseAsync(['node', 'blindkey', 'profile', 'list'])).rejects.toThrow();
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
