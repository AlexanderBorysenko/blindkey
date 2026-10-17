import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { NON_SENSITIVE_KEYS, secretLookingKey } from '@blindkey/shared';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
// @ts-expect-error — plain .mjs build script, no type declarations
import { buildPlugin } from '../../../scripts/build-plugin.mjs';

// Smoke + packaging tests for the committed Claude Code plugin (spec §2.1): the bundles in
// plugin/dist must match the current sources, run standalone under plain `node`, and every manifest
// must parse and point at files that exist.

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const pluginDir = join(repoRoot, 'plugin');
const dist = join(pluginDir, 'dist');
const BUNDLES = ['blindkey.mjs', 'mcp.mjs', 'hook.mjs'];

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function baseEnv(extra: Record<string, string>): Record<string, string> {
  return { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...extra };
}

function run(file: string, args: string[], env: Record<string, string>, stdin = ''): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
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

describe('plugin/dist is up to date with the sources', () => {
  let fresh: string;
  beforeAll(async () => {
    fresh = await buildPlugin(mkdtempSync(join(tmpdir(), 'blindkey-plugin-build-')));
  }, 60_000);

  it.each(BUNDLES)('%s matches a fresh build (run `npm run build:plugin` and commit plugin/dist)', (name) => {
    expect(existsSync(join(dist, name))).toBe(true);
    const committed = readFileSync(join(dist, name), 'utf8');
    const rebuilt = readFileSync(join(fresh, name), 'utf8');
    expect(committed === rebuilt).toBe(true);
  });

  it('builds exactly the three bundles', () => {
    expect(readdirSync(fresh).sort()).toEqual([...BUNDLES].sort());
  });

  it('keeps @napi-rs/keyring external (installed at runtime into the data dir)', () => {
    for (const name of BUNDLES) {
      const text = readFileSync(join(dist, name), 'utf8');
      expect(text).not.toMatch(/keyring\.[a-z0-9-]+\.node/);
    }
  });
});

describe('bundles run standalone', () => {
  it('blindkey.mjs --help lists the agent commands and hides the user-only ones', async () => {
    const r = await run(join(dist, 'blindkey.mjs'), ['--help'], baseEnv({ BLINDKEY_PLUGIN_DATA: mkdtempSync(join(tmpdir(), 'blindkey-pb-')) }));
    expect(r.status).toBe(0);
    for (const cmd of ['connect', 'profile', 'bind', 'unbind', 'status', 'projects', 'docs', 'secrets', 'secret', 'search']) {
      expect(r.stdout).toMatch(new RegExp(`^\\s+${cmd}\\b`, 'm'));
    }
    expect(r.stdout).not.toMatch(/^\s+login\b/m);
    expect(r.stdout).not.toMatch(/^\s+token\b/m);
    expect(r.stderr).toBe('');
  });

  it('blindkey.mjs refuses a user-only command even without BLINDKEY_AGENT', async () => {
    const r = await run(join(dist, 'blindkey.mjs'), ['login', 'http://127.0.0.1:1'], baseEnv({ BLINDKEY_PLUGIN_DATA: mkdtempSync(join(tmpdir(), 'blindkey-pb-')) }));
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/not available to the Claude agent/);
  });

  it('hook.mjs guard prints a deny decision for a disabled command and exits 0', async () => {
    const input = JSON.stringify({ hook_event_name: 'PreToolUse', cwd: tmpdir(), tool_name: 'Bash', tool_input: { command: 'blindkey token list' } });
    const r = await run(join(dist, 'hook.mjs'), ['guard'], baseEnv({ CLAUDE_PLUGIN_DATA: mkdtempSync(join(tmpdir(), 'blindkey-pb-')) }), input);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout) as { hookSpecificOutput: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string } };
    expect(out.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput.permissionDecisionReason.length).toBeGreaterThan(0);
  });

  it('hook.mjs guard allows an ordinary command (no output) and exits 0', async () => {
    const input = JSON.stringify({ hook_event_name: 'PreToolUse', cwd: tmpdir(), tool_name: 'Bash', tool_input: { command: 'npm test' } });
    const r = await run(join(dist, 'hook.mjs'), ['guard'], baseEnv({ CLAUDE_PLUGIN_DATA: mkdtempSync(join(tmpdir(), 'blindkey-pb-')) }), input);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('hook.mjs redact replaces a token in Bash output', async () => {
    const token = `bk_Prefix01_${'a'.repeat(43)}`;
    const input = JSON.stringify({ hook_event_name: 'PostToolUse', cwd: tmpdir(), tool_name: 'Bash', tool_input: { command: 'x' }, tool_response: { stdout: `t=${token}`, stderr: '' } });
    const r = await run(join(dist, 'hook.mjs'), ['redact'], baseEnv({ CLAUDE_PLUGIN_DATA: mkdtempSync(join(tmpdir(), 'blindkey-pb-')) }), input);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('updatedToolOutput');
    expect(r.stdout).not.toContain(token);
  });

  it('hook.mjs session-start injects the golden rules (outside a real plugin root: no npm install)', async () => {
    const input = JSON.stringify({ hook_event_name: 'SessionStart', cwd: tmpdir(), source: 'startup' });
    const dataDir = mkdtempSync(join(tmpdir(), 'blindkey-pb-'));
    const r = await run(
      join(dist, 'hook.mjs'),
      ['session-start'],
      baseEnv({ CLAUDE_PLUGIN_DATA: dataDir, CLAUDE_PLUGIN_ROOT: mkdtempSync(join(tmpdir(), 'blindkey-pb-root-')) }),
      input,
    );
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(out.hookSpecificOutput.additionalContext).toMatch(/no server configured/);
    expect(out.hookSpecificOutput.additionalContext).toMatch(/Golden rules:/);
    expect(existsSync(join(dataDir, 'deps-install.json'))).toBe(false);
  });
});

describe('mcp.mjs over stdio', () => {
  let child: ChildProcessWithoutNullStreams | undefined;
  afterEach(() => {
    child?.kill();
    child = undefined;
  });

  function send(c: ChildProcessWithoutNullStreams, message: unknown): void {
    c.stdin.write(`${JSON.stringify(message)}\n`);
  }

  function waitFor(c: ChildProcessWithoutNullStreams, id: number): Promise<{ result?: unknown; error?: unknown }> {
    return new Promise((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => reject(new Error(`timed out waiting for id ${id}`)), 10_000);
      const onData = (chunk: Buffer): void => {
        buf += chunk.toString('utf8');
        let idx: number;
        while ((idx = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (!line.trim()) continue;
          const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
          if (msg.id === id) {
            clearTimeout(timer);
            c.stdout.off('data', onData);
            resolve(msg);
            return;
          }
        }
      };
      c.stdout.on('data', onData);
    });
  }

  it('answers initialize and tools/list with blindkey_status', async () => {
    child = spawn(process.execPath, [join(dist, 'mcp.mjs')], {
      env: baseEnv({ BLINDKEY_PLUGIN_DATA: mkdtempSync(join(tmpdir(), 'blindkey-pb-mcp-')), BLINDKEY_AGENT: '1' }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    send(child, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'test', version: '0.0.0' } },
    });
    const init = await waitFor(child, 1);
    expect(init.error).toBeUndefined();
    send(child, { jsonrpc: '2.0', method: 'notifications/initialized' });
    send(child, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const list = await waitFor(child, 2);
    expect(list.error).toBeUndefined();
    const names = (list.result as { tools: { name: string }[] }).tools.map((t) => t.name);
    expect(names).toContain('blindkey_status');
  });
});

describe('plugin manifests', () => {
  const sub = (s: string): string => s.replace('${CLAUDE_PLUGIN_ROOT}', pluginDir);

  it('marketplace.json lists the Blindkey plugin at ./plugin', () => {
    const m = readJson(join(repoRoot, '.claude-plugin', 'marketplace.json')) as { name: string; owner: { name: string }; plugins: { name: string; source: string; description: string }[] };
    expect(m.name).toBe('blindkey');
    expect(m.owner.name).toBeTruthy();
    expect(m.plugins).toHaveLength(1);
    expect(m.plugins[0]!.name).toBe('blindkey');
    expect(m.plugins[0]!.description).toBeTruthy();
    expect(existsSync(join(repoRoot, m.plugins[0]!.source, '.claude-plugin', 'plugin.json'))).toBe(true);
  });

  it('plugin.json has name, semver version and description', () => {
    const p = readJson(join(pluginDir, '.claude-plugin', 'plugin.json')) as { name: string; version: string; description: string };
    expect(p.name).toBe('blindkey');
    expect(p.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(p.description).toBeTruthy();
  });

  it('.mcp.json runs dist/mcp.mjs with the data dir passed through', () => {
    const m = readJson(join(pluginDir, '.mcp.json')) as { mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> };
    const s = m.mcpServers.blindkey!;
    expect(s.command).toBe('node');
    expect(s.args).toEqual(['${CLAUDE_PLUGIN_ROOT}/dist/mcp.mjs']);
    expect(existsSync(sub(s.args[0]!))).toBe(true);
    expect(s.env).toEqual({ BLINDKEY_PLUGIN_DATA: '${CLAUDE_PLUGIN_DATA}', BLINDKEY_AGENT: '1' });
  });

  it('hooks.json uses exec form (node + args) for all three hooks, pointing at an existing bundle', () => {
    const h = readJson(join(pluginDir, 'hooks', 'hooks.json')) as {
      hooks: Record<string, { matcher?: string; hooks: { type: string; command: string; args: string[]; timeout: number }[] }[]>;
    };
    const kinds: Record<string, string> = { SessionStart: 'session-start', PreToolUse: 'guard', PostToolUse: 'redact' };
    expect(Object.keys(h.hooks).sort()).toEqual(Object.keys(kinds).sort());
    for (const [event, kind] of Object.entries(kinds)) {
      const entries = h.hooks[event]!;
      expect(entries).toHaveLength(1);
      const cmd = entries[0]!.hooks[0]!;
      expect(cmd.type).toBe('command');
      expect(cmd.command).toBe('node');
      expect(cmd.args).toEqual(['${CLAUDE_PLUGIN_ROOT}/dist/hook.mjs', kind]);
      expect(existsSync(sub(cmd.args[0]!))).toBe(true);
      // Claude Code hook timeouts are in seconds.
      expect(cmd.timeout).toBeGreaterThanOrEqual(5);
      expect(cmd.timeout).toBeLessThanOrEqual(60);
    }
    const pre = new RegExp(`^(?:${h.hooks.PreToolUse![0]!.matcher})$`);
    for (const t of ['Bash', 'Read', 'Grep', 'Glob', 'LS', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'mcp__blindkey__read_document']) expect(pre.test(t)).toBe(true);
    expect(h.hooks.PostToolUse![0]!.matcher).toBe('Bash');
    expect(h.hooks.SessionStart![0]!.matcher).toBeUndefined();
  });

  it('plugin/package.json declares the runtime keyring dependency', () => {
    const p = readJson(join(pluginDir, 'package.json')) as { private: boolean; dependencies: Record<string, string> };
    expect(p.private).toBe(true);
    expect(Object.keys(p.dependencies)).toEqual(['@napi-rs/keyring']);
  });

  it('SKILL.md upsert_secret_meta examples only write fields the server accepts from meta-write (F3)', () => {
    const skill = readFileSync(join(pluginDir, 'skills', 'blindkey', 'SKILL.md'), 'utf8');
    const calls = [...skill.matchAll(/upsert_secret_meta\((.*?)\)`/g)].map((m) => m[1] ?? '');
    const fields = calls.flatMap((c) => [...c.matchAll(/\{key: "([^"]+)"[^}]*?(sensitive: false)?\}/g)].map((m) => ({ key: m[1]!, plain: Boolean(m[2]) })));
    expect(fields.length).toBeGreaterThan(0);
    for (const f of fields) {
      // Default-non-sensitive keys may omit the flag; any other key must say sensitive:false and not look like a credential.
      if (f.plain) expect(secretLookingKey(f.key)).toBe(false);
      else expect(NON_SENSITIVE_KEYS as readonly string[]).toContain(f.key);
    }
    expect(skill).not.toMatch(/key: "account_id", sensitive: false/);
  });

  it('skill and commands have frontmatter', () => {
    const skill = readFileSync(join(pluginDir, 'skills', 'blindkey', 'SKILL.md'), 'utf8');
    expect(skill).toMatch(/^---\nname: blindkey\ndescription: .+\n---\n/);
    for (const c of ['connect', 'server', 'bind', 'status']) {
      const text = readFileSync(join(pluginDir, 'commands', `${c}.md`), 'utf8');
      expect(text).toMatch(/^---\n(?:.*\n)*?description: .+\n(?:.*\n)*?---\n/);
    }
  });
});

describe('bin shims', () => {
  it('bin/blindkey is LF-only, a /bin/sh script, and executable in the git index', () => {
    const text = readFileSync(join(pluginDir, 'bin', 'blindkey'), 'utf8');
    expect(text.startsWith('#!/bin/sh\n')).toBe(true);
    expect(text).not.toContain('\r');
    expect(text).toContain('BLINDKEY_AGENT=1');
    expect(text).toContain('dist/blindkey.mjs');
    const staged = execFileSync('git', ['ls-files', '-s', '--', 'plugin/bin/blindkey'], { cwd: repoRoot, encoding: 'utf8' });
    expect(staged).toMatch(/^100755 /);
  });

  it('bin/blindkey.cmd is CRLF and runs dist\\blindkey.mjs with BLINDKEY_AGENT=1', () => {
    const text = readFileSync(join(pluginDir, 'bin', 'blindkey.cmd'), 'utf8');
    expect(text.split('\n').slice(0, -1).every((l) => l.endsWith('\r'))).toBe(true);
    expect(text).toContain('set BLINDKEY_AGENT=1');
    expect(text).toContain('node "%~dp0..\\dist\\blindkey.mjs" %*');
  });

  it.skipIf(process.platform === 'win32')('bin/blindkey runs the agent CLI', () => {
    const out = execFileSync(join(pluginDir, 'bin', 'blindkey'), ['--help'], {
      env: baseEnv({ BLINDKEY_PLUGIN_DATA: mkdtempSync(join(tmpdir(), 'blindkey-pb-')) }),
      encoding: 'utf8',
    });
    expect(out).toMatch(/^\s+connect\b/m);
  });

  it('.gitattributes pins the shim line endings', () => {
    const attrs = readFileSync(join(repoRoot, '.gitattributes'), 'utf8');
    expect(attrs).toMatch(/^plugin\/bin\/blindkey text eol=lf$/m);
    expect(attrs).toMatch(/^plugin\/bin\/\*\.cmd text eol=crlf$/m);
  });
});
