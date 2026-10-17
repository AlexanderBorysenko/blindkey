import { describe, it, expect, beforeAll } from 'vitest';
import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

// Regression test for the critical bundling bug: esbuild bundling `agent/cli.ts` as its own entry
// point (spec §2.1 `dist/blindkey.mjs`) must NOT also pull in `cli.ts`'s top-level
// `if (isEntryPoint()) void main()` — that would run the *normal* program a second time in the same
// process (reading BLINDKEY_URL/BLINDKEY_TOKEN/~/.config/blindkey, and running every command twice), because a
// bundle shares one `import.meta.url` across every module it contains. `program.ts` (imported by
// both entries) has no top-level side effects, and `agent/cli.ts` never imports `cli.ts`, so bundling
// `agent/cli.ts` alone must not run the normal entry's self-exec block at all.

const cliDir = fileURLToPath(new URL('..', import.meta.url));
let bundlePath: string;

beforeAll(async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'blindkey-agent-bundle-'));
  bundlePath = join(outDir, 'blindkey-agent.mjs');
  await build({
    entryPoints: [join(cliDir, 'src/agent/cli.ts')],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    // Native module, installed at runtime into the plugin data dir (spec §2.1) — never bundled.
    external: ['@napi-rs/keyring'],
    logLevel: 'silent',
  });
}, 30_000);

function run(args: string[], env: Record<string, string>): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bundlePath, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
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

describe('bundled agent entry (esbuild, matching the real plugin build)', () => {
  it('(a) `token list` with BLINDKEY_URL/BLINDKEY_TOKEN set and no BLINDKEY_AGENT: only the refusal, exit 2, no network attempt', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'blindkey-agent-bundle-data-'));
    const r = await run(['token', 'list'], {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      BLINDKEY_PLUGIN_DATA: dataDir,
      // Present to prove the normal program never runs (it would try to reach this and fail
      // differently, or succeed and print token data) — agent mode always ignores these anyway.
      BLINDKEY_URL: 'http://127.0.0.1:1',
      BLINDKEY_TOKEN: 'bk_should_be_ignored',
    });
    expect(r.status).toBe(2);
    const occurrences = r.stderr.split('not available to the Claude agent — ask the user').length - 1;
    expect(occurrences).toBe(1);
    expect(r.stdout).toBe('');
    // No sign the normal program's client ever ran (it would surface a connection error to 127.0.0.1:1).
    expect(r.stderr).not.toMatch(/ECONNREFUSED|cannot reach/);
  });

  it('(b) `unbind` prints its result exactly once (no double execution from the bundle)', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'blindkey-agent-bundle-data-'));
    const r = await run(['unbind'], {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      BLINDKEY_PLUGIN_DATA: dataDir,
    });
    expect(r.status).toBe(0);
    const occurrences = r.stdout.split('this repo was not bound').length - 1;
    expect(occurrences).toBe(1);
  });
});
