import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

/** Never calls a disabled action's client(), so no real OS keychain access happens here. */
function runEntry(entry: string, args: string[], env: Record<string, string>): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(join(repoRoot, 'node_modules/.bin/tsx'), [join(repoRoot, entry), ...args], {
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

describe('agent entry (packages/cli/src/agent/cli.ts)', () => {
  it('is always in agent mode: `login` exits 2 with the spec message, even without BLINDKEY_AGENT set', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'blindkey-agent-entry-'));
    const r = await runEntry(
      'packages/cli/src/agent/cli.ts',
      ['login', 'https://x.example.com'],
      { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', BLINDKEY_PLUGIN_DATA: dataDir },
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('not available to the Claude agent — ask the user');
  });
});

describe('normal entry (packages/cli/src/cli.ts) with BLINDKEY_AGENT=1', () => {
  it('also enters agent mode: `login` exits 2 with the spec message', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'blindkey-agent-entry-'));
    const r = await runEntry(
      'packages/cli/src/cli.ts',
      ['login', 'https://x.example.com'],
      { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', BLINDKEY_PLUGIN_DATA: dataDir, BLINDKEY_AGENT: '1' },
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('not available to the Claude agent — ask the user');
  });

  it('without BLINDKEY_AGENT, normal mode is unaffected: `login` fails on the network, not with the agent-refused message', async () => {
    const configHome = mkdtempSync(join(tmpdir(), 'blindkey-normal-entry-'));
    const r = await runEntry(
      'packages/cli/src/cli.ts',
      ['login', 'http://127.0.0.1:1'],
      { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', BLINDKEY_CONFIG_HOME: configHome },
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr).not.toContain('not available to the Claude agent');
  });
});

describe('normal entry (packages/cli/src/cli.ts) under Claude Code (CLAUDECODE=1) — PATH shadowing, spec §2.3', () => {
  it('enters agent mode without BLINDKEY_AGENT: `login` exits 2 with the spec message', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'blindkey-claudecode-'));
    const r = await runEntry(
      'packages/cli/src/cli.ts',
      ['login', 'https://x.example.com'],
      { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', BLINDKEY_PLUGIN_DATA: dataDir, CLAUDECODE: '1' },
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('not available to the Claude agent — ask the user');
  });

  it('uses the agent config (plugin data dir under CLAUDE_CONFIG_DIR), ignoring BLINDKEY_URL/BLINDKEY_TOKEN', async () => {
    const claudeDir = mkdtempSync(join(tmpdir(), 'blindkey-claudecfg-'));
    const r = await runEntry('packages/cli/src/cli.ts', ['profile', 'list'], {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      CLAUDE_CONFIG_DIR: claudeDir,
      CLAUDECODE: '1',
      BLINDKEY_URL: 'http://127.0.0.1:1',
      BLINDKEY_TOKEN: 'bk_should_not_be_used',
    });
    // `profile` exists only in agent mode; in normal mode commander would reject it as unknown.
    expect(r.stderr).not.toContain('unknown command');
    expect(r.status).toBe(0);
    const add = await runEntry('packages/cli/src/cli.ts', ['profile', 'add', 'home', 'https://blindkey.example.com'], {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      CLAUDE_CONFIG_DIR: claudeDir,
      CLAUDECODE: '1',
    });
    expect(add.status).toBe(0);
    expect(existsSync(join(claudeDir, 'plugins', 'data', 'blindkey-blindkey', 'profiles.json'))).toBe(true);
  });

  it('BLINDKEY_ALLOW_USER_MODE=1 opts out: normal mode (`login` fails on the network, not refused)', async () => {
    const configHome = mkdtempSync(join(tmpdir(), 'blindkey-usermode-'));
    const r = await runEntry(
      'packages/cli/src/cli.ts',
      ['login', 'http://127.0.0.1:1'],
      { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', BLINDKEY_CONFIG_HOME: configHome, CLAUDECODE: '1', BLINDKEY_ALLOW_USER_MODE: '1' },
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr).not.toContain('not available to the Claude agent');
  });

  it('BLINDKEY_AGENT=1 still wins over BLINDKEY_ALLOW_USER_MODE=1 (the plugin shim is always agent mode)', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'blindkey-claudecode-'));
    const r = await runEntry(
      'packages/cli/src/cli.ts',
      ['login', 'https://x.example.com'],
      { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', BLINDKEY_PLUGIN_DATA: dataDir, BLINDKEY_AGENT: '1', CLAUDECODE: '1', BLINDKEY_ALLOW_USER_MODE: '1' },
    );
    expect(r.status).toBe(2);
  });
});

describe("main()'s handling of commander's own errors (exitOverride regression)", () => {
  it('`--help` exits 0 with empty stderr (commander already printed the help to stdout)', async () => {
    const r = await runEntry('packages/cli/src/cli.ts', ['--help'], {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toContain('Usage: blindkey');
  });

  it("a missing-argument error prints commander's own line exactly once, not doubled or re-wrapped", async () => {
    const configHome = mkdtempSync(join(tmpdir(), 'blindkey-missing-arg-'));
    const r = await runEntry('packages/cli/src/cli.ts', ['login'], {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      BLINDKEY_CONFIG_HOME: configHome,
    });
    expect(r.status).not.toBe(0);
    const occurrences = r.stderr.split("missing required argument 'url'").length - 1;
    expect(occurrences).toBe(1);
    expect(r.stderr).not.toContain('error: error:');
  });
});

describe('agent mode: bare `blindkey token` (no subcommand) refuses instead of showing group help', () => {
  it('exits 2 with the spec message and does not leak subcommand names/options', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'blindkey-bare-token-'));
    const r = await runEntry('packages/cli/src/agent/cli.ts', ['token'], {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      BLINDKEY_PLUGIN_DATA: dataDir,
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('not available to the Claude agent — ask the user');
    expect(r.stdout).not.toContain('create');
    expect(r.stdout).not.toContain('revoke');
  });
});
