import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHook } from '../src/agent/hooks/index.js';
import { recordWritten, saveProfiles } from '../src/agent/state.js';
import { memoryStore } from '../src/agent/tokenstore.js';

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'pidb-agent-hooks-dispatcher-'));
});

function hookJson(overrides: Record<string, unknown>): string {
  return JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's1', cwd: '/repo', ...overrides });
}

describe('runHook — guard', () => {
  it('prints nothing and exits 0 for an allowed command', async () => {
    const result = await runHook('guard', hookJson({ tool_name: 'Bash', tool_input: { command: 'echo hello' } }), { CLAUDE_PLUGIN_DATA: dataDir });
    expect(result).toEqual({ stdout: '', exitCode: 0 });
  });

  it('prints the documented PreToolUse deny JSON for a denied command', async () => {
    const result = await runHook('guard', hookJson({ tool_name: 'Bash', tool_input: { command: 'pidb login https://x' } }), {
      CLAUDE_PLUGIN_DATA: dataDir,
    });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      hookSpecificOutput: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string };
    };
    expect(parsed.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(parsed.hookSpecificOutput.permissionDecisionReason.length).toBeGreaterThan(0);
  });

  it('reads written.json and protects a file recorded there', async () => {
    recordWritten(dataDir, '/repo/.pidb/db.env');
    const result = await runHook('guard', hookJson({ tool_name: 'Bash', tool_input: { command: 'cat /repo/.pidb/db.env' } }), {
      CLAUDE_PLUGIN_DATA: dataDir,
    });
    const parsed = JSON.parse(result.stdout) as { hookSpecificOutput: { permissionDecision: string } };
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('reads profiles.json for the curl-target rule', async () => {
    saveProfiles(dataDir, { default: 'work', profiles: { work: { url: 'https://pidb.example.com' } } });
    const result = await runHook('guard', hookJson({ tool_name: 'Bash', tool_input: { command: 'curl https://pidb.example.com/api/v1/projects' } }), {
      CLAUDE_PLUGIN_DATA: dataDir,
    });
    const parsed = JSON.parse(result.stdout) as { hookSpecificOutput: { permissionDecision: string } };
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('falls back to resolveDataDir when CLAUDE_PLUGIN_DATA is unset (no crash)', async () => {
    const result = await runHook('guard', hookJson({ tool_name: 'Bash', tool_input: { command: 'echo hello' } }), { HOME: dataDir });
    expect(result).toEqual({ stdout: '', exitCode: 0 });
  });

  it('never throws on malformed stdin — allows and notes it on stderr', async () => {
    const result = await runHook('guard', 'not json', { CLAUDE_PLUGIN_DATA: dataDir });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/pidb hook \(guard\)/);
  });

  it('never throws on empty stdin — allows and notes it on stderr', async () => {
    const result = await runHook('guard', '', { CLAUDE_PLUGIN_DATA: dataDir });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBeTruthy();
  });
});

describe('runHook — redact', () => {
  it('prints nothing when the tool_response has nothing to redact', async () => {
    const result = await runHook(
      'redact',
      JSON.stringify({ hook_event_name: 'PostToolUse', cwd: '/repo', tool_name: 'Bash', tool_response: { stdout: 'ok', stderr: '' } }),
      { CLAUDE_PLUGIN_DATA: dataDir },
    );
    expect(result).toEqual({ stdout: '', exitCode: 0 });
  });

  it('prints the documented PostToolUse updatedOutput JSON when something was redacted', async () => {
    const token = `pidb_${'a'.repeat(24)}`;
    const result = await runHook(
      'redact',
      JSON.stringify({ hook_event_name: 'PostToolUse', cwd: '/repo', tool_name: 'Bash', tool_response: { stdout: `token: ${token}`, stderr: '' } }),
      { CLAUDE_PLUGIN_DATA: dataDir },
    );
    const parsed = JSON.parse(result.stdout) as { hookSpecificOutput: { hookEventName: string; updatedOutput: { stdout: string; stderr: string } } };
    expect(parsed.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    expect(parsed.hookSpecificOutput.updatedOutput.stdout).toContain('[pidb:redacted]');
    expect(parsed.hookSpecificOutput.updatedOutput.stdout).not.toContain(token);
  });

  it('handles a plain-string tool_response', async () => {
    const token = `pidb_${'b'.repeat(24)}`;
    const result = await runHook('redact', JSON.stringify({ hook_event_name: 'PostToolUse', cwd: '/repo', tool_response: `x=${token}` }), {
      CLAUDE_PLUGIN_DATA: dataDir,
    });
    const parsed = JSON.parse(result.stdout) as { hookSpecificOutput: { updatedOutput: string } };
    expect(parsed.hookSpecificOutput.updatedOutput).toBe('x=[pidb:redacted]');
  });

  it('never throws on malformed stdin — no redaction and a stderr note', async () => {
    const result = await runHook('redact', '{not valid json', { CLAUDE_PLUGIN_DATA: dataDir });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/pidb hook \(redact\)/);
  });
});

describe('runHook — session-start', () => {
  it('prints the documented SessionStart additionalContext JSON', async () => {
    const result = await runHook('session-start', JSON.stringify({ hook_event_name: 'SessionStart', cwd: '/repo' }), { CLAUDE_PLUGIN_DATA: dataDir });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    expect(parsed.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('no server configured');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('Golden rules:');
  });

  it('uses the injected store/fetchImpl deps instead of a real keyring', async () => {
    saveProfiles(dataDir, { default: 'work', profiles: { work: { url: 'https://pidb.example.com' } } });
    const store = memoryStore({ work: 'a-token' });
    const result = await runHook('session-start', JSON.stringify({ hook_event_name: 'SessionStart', cwd: '/repo' }), { CLAUDE_PLUGIN_DATA: dataDir }, {
      store,
      fetchImpl: async () => {
        throw new Error('unreachable');
      },
    });
    const parsed = JSON.parse(result.stdout) as { hookSpecificOutput: { additionalContext: string } };
    expect(parsed.hookSpecificOutput.additionalContext).toContain('Connected.');
  });

  it('still injects a one-line-status additionalContext (with golden rules) on malformed stdin', async () => {
    const result = await runHook('session-start', 'not json at all', { CLAUDE_PLUGIN_DATA: dataDir });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { hookSpecificOutput: { additionalContext: string } };
    expect(parsed.hookSpecificOutput.additionalContext).toContain('Golden rules:');
  });
});

describe('runHook — CLAUDE_PLUGIN_DATA vs resolveDataDir precedence', () => {
  it('prefers CLAUDE_PLUGIN_DATA over a derivable plugin-cache self path', async () => {
    const other = mkdtempSync(join(tmpdir(), 'pidb-agent-hooks-other-'));
    saveProfiles(other, { default: 'other-profile', profiles: { 'other-profile': { url: 'https://other.example.com' } } });
    saveProfiles(dataDir, { default: 'work', profiles: { work: { url: 'https://pidb.example.com' } } });
    // Inject a store explicitly here (rather than falling through to the real `keyringStore`) — this
    // test is only about data-dir precedence, not the OS credential store, which the "no profile"
    // cases above never touch since `resolveAgentConfig`-style resolution short-circuits before it.
    const result = await runHook('session-start', JSON.stringify({ hook_event_name: 'SessionStart', cwd: '/repo' }), { CLAUDE_PLUGIN_DATA: dataDir }, {
      store: memoryStore(),
    });
    const parsed = JSON.parse(result.stdout) as { hookSpecificOutput: { additionalContext: string } };
    expect(parsed.hookSpecificOutput.additionalContext).toContain('work');
    expect(parsed.hookSpecificOutput.additionalContext).not.toContain('other-profile');
  });
});
