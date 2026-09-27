import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
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
  it('is always in agent mode: `login` exits 2 with the spec message, even without PIDB_AGENT set', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'pidb-agent-entry-'));
    const r = await runEntry(
      'packages/cli/src/agent/cli.ts',
      ['login', 'https://x.example.com'],
      { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', PIDB_PLUGIN_DATA: dataDir },
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('not available to the Claude agent — ask the user');
  });
});

describe('normal entry (packages/cli/src/cli.ts) with PIDB_AGENT=1', () => {
  it('also enters agent mode: `login` exits 2 with the spec message', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'pidb-agent-entry-'));
    const r = await runEntry(
      'packages/cli/src/cli.ts',
      ['login', 'https://x.example.com'],
      { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', PIDB_PLUGIN_DATA: dataDir, PIDB_AGENT: '1' },
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('not available to the Claude agent — ask the user');
  });

  it('without PIDB_AGENT, normal mode is unaffected: `login` fails on the network, not with the agent-refused message', async () => {
    const configHome = mkdtempSync(join(tmpdir(), 'pidb-normal-entry-'));
    const r = await runEntry(
      'packages/cli/src/cli.ts',
      ['login', 'http://127.0.0.1:1'],
      { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', PIDB_CONFIG_HOME: configHome },
    );
    expect(r.stderr).not.toContain('not available to the Claude agent');
  });
});
