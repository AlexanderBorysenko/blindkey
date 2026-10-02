import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const mainPath = join(repoRoot, 'packages/cli/src/agent/hooks/main.ts');

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runHookMain(kind: string, stdin: string, env: Record<string, string>): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(join(repoRoot, 'node_modules/.bin/tsx'), [mainPath, kind], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => (stdout += c));
    child.stderr.on('data', (c: string) => (stderr += c));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

/**
 * Real subprocess smoke test of the executable hooks entry (`main.ts`, spec §2.1 `dist/hook.mjs`) —
 * the in-process `agent.hooks.index.test.ts` suite covers `runHook`'s own logic directly; this
 * confirms the actual argv-kind / real-stdin / real-stdout wiring, and that the process always exits
 * 0 no matter what.
 */
describe('hooks main.ts — real subprocess', () => {
  it('guard: allowed command prints nothing to stdout, exits 0', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'blindkey-hooks-main-'));
    const input = JSON.stringify({ hook_event_name: 'PreToolUse', cwd: '/repo', tool_name: 'Bash', tool_input: { command: 'echo hello' } });
    const r = await runHookMain('guard', input, { ...process.env, CLAUDE_PLUGIN_DATA: dataDir } as Record<string, string>);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('guard: denied command prints the PreToolUse deny JSON, exits 0', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'blindkey-hooks-main-'));
    const input = JSON.stringify({ hook_event_name: 'PreToolUse', cwd: '/repo', tool_name: 'Bash', tool_input: { command: 'blindkey login https://x' } });
    const r = await runHookMain('guard', input, { ...process.env, CLAUDE_PLUGIN_DATA: dataDir } as Record<string, string>);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout.trim()) as { hookSpecificOutput: { permissionDecision: string } };
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('session-start: prints additionalContext including the golden rules, exits 0', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'blindkey-hooks-main-'));
    const input = JSON.stringify({ hook_event_name: 'SessionStart', cwd: '/repo' });
    const r = await runHookMain('session-start', input, { ...process.env, CLAUDE_PLUGIN_DATA: dataDir } as Record<string, string>);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout.trim()) as { hookSpecificOutput: { additionalContext: string } };
    expect(parsed.hookSpecificOutput.additionalContext).toContain('Golden rules:');
  });

  it('an unknown kind exits 0 with an empty stdout and a stderr note', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'blindkey-hooks-main-'));
    const r = await runHookMain('bogus-kind', '{}', { ...process.env, CLAUDE_PLUGIN_DATA: dataDir } as Record<string, string>);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/unknown or missing kind/);
  });

  it('redact: a >1 MB result piped through the real process arrives complete and valid JSON', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'blindkey-hooks-main-'));
    const stdout = `PASSWORD=hunter2\n${'lorem ipsum dolor\n'.repeat(70_000)}END-MARKER`;
    const input = JSON.stringify({ hook_event_name: 'PostToolUse', cwd: '/repo', tool_name: 'Bash', tool_input: { command: 'x' }, tool_response: { stdout } });
    const r = await runHookMain('redact', input, { ...process.env, CLAUDE_PLUGIN_DATA: dataDir } as Record<string, string>);
    expect(r.status).toBe(0);
    expect(r.stdout.length).toBeGreaterThan(1_000_000);
    const parsed = JSON.parse(r.stdout) as { hookSpecificOutput: { updatedToolOutput: { stdout: string } } };
    const out = parsed.hookSpecificOutput.updatedToolOutput.stdout;
    expect(out.startsWith('PASSWORD=[blindkey:redacted]\n')).toBe(true);
    expect(out.endsWith('END-MARKER')).toBe(true);
  });

  it('malformed stdin still exits 0 (never crashes the process)', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'blindkey-hooks-main-'));
    const r = await runHookMain('redact', 'not json', { ...process.env, CLAUDE_PLUGIN_DATA: dataDir } as Record<string, string>);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });
});
