import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BlindkeyClient } from '../src/client.js';
import { runSecretExec } from '../src/commands/exec.js';
import { buildProgram } from '../src/program.js';
import { memoryStore, type TokenStore } from '../src/agent/tokenstore.js';
import { saveProfiles } from '../src/agent/state.js';
import { makeServer, type ServerFixture } from './helpers.js';

let s: ServerFixture;
const client = (scopes: Parameters<ServerFixture['token']>[0]) => new BlindkeyClient({ url: s.url, token: s.token(scopes) });

beforeAll(async () => {
  s = await makeServer();
  s.project('acme');
  s.secret('acme', 'DB', [
    { key: 'host', value: 'db.internal' },
    { key: 'password', value: 'hunter2hunter2' },
  ]);
});
afterAll(async () => {
  await s.close();
});

describe('runSecretExec({ agent: true })', () => {
  it('fetches via the /use endpoint (purpose exec) instead of the reveal endpoint', async () => {
    const before = (s.db.prepare("SELECT COUNT(*) AS c FROM audit_log WHERE action = 'secret.used'").get() as { c: number }).c;
    const code = await runSecretExec(client(['secrets:use']), 'acme', 'DB', [process.execPath, '-e', 'process.exit(0)'], {
      agent: true,
    });
    expect(code).toBe(0);
    const after = (s.db.prepare("SELECT COUNT(*) AS c FROM audit_log WHERE action = 'secret.used'").get() as { c: number }).c;
    expect(after).toBeGreaterThan(before);
  });

  it('a secrets:use-only token cannot use the reveal endpoint (Review Focus 1)', async () => {
    await expect(client(['secrets:use']).json('GET', '/api/v1/projects/acme/secrets/DB/fields')).rejects.toMatchObject({
      status: 403,
    });
  });

  it('injects BLINDKEY_* into the child env exactly like normal mode, and propagates the exit code', async () => {
    const code = await runSecretExec(
      client(['secrets:use']),
      'acme',
      'DB',
      [process.execPath, '-e', 'process.exit(process.env.BLINDKEY_HOST === "db.internal" && process.env.BLINDKEY_PASSWORD ? 9 : 1)'],
      { agent: true },
    );
    expect(code).toBe(9);
  });
});

describe('blindkey secret exec (agent mode, via buildProgram) redacts child output', () => {
  let dataDir: string;
  let repoDir: string;
  let store: TokenStore;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'blindkey-agent-exec-data-'));
    repoDir = mkdtempSync(join(tmpdir(), 'blindkey-agent-exec-repo-'));
    store = memoryStore();
    saveProfiles(dataDir, { default: 'work', profiles: { work: { url: s.url } } });
  });

  async function runAgentExec(script: string): Promise<{ stdout: string; stderr: string }> {
    await store.set('work', s.token(['secrets:use']));
    const program = buildProgram({ agent: true, cwd: repoDir, dataDir, store });
    const originalOut = process.stdout.write.bind(process.stdout);
    const originalErr = process.stderr.write.bind(process.stderr);
    let stdout = '';
    let stderr = '';
    process.stdout.write = ((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown) => {
      stderr += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    try {
      await program.parseAsync(['node', 'blindkey', 'secret', 'exec', 'acme', 'DB', '--', process.execPath, '-e', script]);
    } finally {
      process.stdout.write = originalOut;
      process.stderr.write = originalErr;
    }
    return { stdout, stderr };
  }

  it('redacts the secret value on stdout even when printed verbatim', async () => {
    const { stdout } = await runAgentExec('console.log("value is", process.env.BLINDKEY_PASSWORD)');
    expect(stdout).toContain('value is');
    expect(stdout).toContain('[blindkey:redacted]');
    expect(stdout).not.toContain('hunter2hunter2');
  });

  it('redacts a base64-encoded copy of the value on stderr (Review Focus 4)', async () => {
    const { stderr } = await runAgentExec(
      'const v = process.env.BLINDKEY_PASSWORD; process.stderr.write("b64=" + Buffer.from(v, "utf8").toString("base64") + "\\n")',
    );
    expect(stderr).toContain('b64=');
    expect(stderr).toContain('[blindkey:redacted]');
    expect(stderr).not.toContain('hunter2hunter2');
  });

  it('redacts a value the child writes split across two separate stdout writes (Review Focus 4)', async () => {
    const script = [
      'const v = process.env.BLINDKEY_PASSWORD;',
      'process.stdout.write(v.slice(0, 7));',
      'setTimeout(() => { process.stdout.write(v.slice(7)); }, 20);',
    ].join(' ');
    const { stdout } = await runAgentExec(script);
    expect(stdout).toContain('[blindkey:redacted]');
    expect(stdout).not.toContain('hunter2hunter2');
  });

  it('leaves non-sensitive values (host) readable — only sensitive ones are masked', async () => {
    const { stdout } = await runAgentExec('console.log(process.env.BLINDKEY_HOST, process.env.BLINDKEY_PASSWORD)');
    expect(stdout).toContain('db.internal');
    expect(stdout).toContain('[blindkey:redacted]');
    expect(stdout).not.toContain('hunter2hunter2');
  });

  it('does not touch unrelated output', async () => {
    const { stdout } = await runAgentExec('console.log("hello world, nothing secret here")');
    expect(stdout).toContain('hello world, nothing secret here');
    expect(stdout).not.toContain('[blindkey:redacted]');
  });
});

describe('runSecretExec against a server that does not say which fields are sensitive', () => {
  it('masks every value, as before', async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ name: 'Old', fields: { host: 'old-host.example', password: 'old-password-1' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    const old = new BlindkeyClient({ url: 'http://old.invalid', token: 't' }, fakeFetch);
    const originalOut = process.stdout.write.bind(process.stdout);
    let stdout = '';
    process.stdout.write = ((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await runSecretExec(old, 'acme', 'Old', [process.execPath, '-e', 'console.log(process.env.BLINDKEY_HOST, process.env.BLINDKEY_PASSWORD)'], { agent: true });
    } finally {
      process.stdout.write = originalOut;
    }
    expect(stdout).not.toContain('old-host.example');
    expect(stdout).not.toContain('old-password-1');
  });
});
