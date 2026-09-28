import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

/**
 * Real subprocess smoke test of the executable bridge entry (`bridge-main.ts`, spec §2.1
 * `dist/mcp.mjs`) over actual stdio framing (newline-delimited JSON-RPC) — the in-process
 * `agent.bridge.test.ts` suite covers `createBridge`'s own logic via the SDK's `InMemoryTransport`,
 * but never spawns the real entry or exercises `StdioServerTransport`'s line-based read buffer.
 *
 * No profile is configured (`PIDB_PLUGIN_DATA` points at a fresh, empty data dir), so
 * `resolveAgentConfig` fails fast on "no server configured" before ever touching a token store —
 * this is what makes the test runnable without a real OS keychain (`keyringStore` only loads
 * `@napi-rs/keyring` lazily, on a `get`/`set`/`delete` call that never happens here).
 */
let child: ChildProcessWithoutNullStreams | undefined;

afterEach(() => {
  child?.kill();
  child = undefined;
});

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number;
  result?: unknown;
  error?: unknown;
}

function send(c: ChildProcessWithoutNullStreams, message: unknown): void {
  c.stdin.write(`${JSON.stringify(message)}\n`);
}

/** Reads newline-delimited JSON-RPC messages from stdout until one with the given id arrives. */
function waitForResponse(c: ChildProcessWithoutNullStreams, id: number, timeoutMs = 10_000): Promise<JsonRpcResponse> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`timed out waiting for response id ${id}`)), timeoutMs);
    const onData = (chunk: Buffer): void => {
      buf += chunk.toString('utf8');
      let idx: number;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line) as JsonRpcResponse;
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

describe('MCP bridge executable entry (packages/cli/src/agent/bridge-main.ts), real stdio', () => {
  it('answers initialize and tools/list with the static upstream tools + local pidb_* tools when not connected (F2)', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'pidb-agent-bridge-main-'));
    child = spawn(join(repoRoot, 'node_modules/.bin/tsx'), [join(repoRoot, 'packages/cli/src/agent/bridge-main.ts')], {
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', PIDB_PLUGIN_DATA: dataDir },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c: string) => (stderr += c));

    send(child, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'test', version: '0.0.0' } },
    });
    const initRes = await waitForResponse(child, 1);
    expect(initRes.error).toBeUndefined();
    expect((initRes.result as { serverInfo?: { name?: string } }).serverInfo?.name).toBe('pidb-bridge');

    send(child, { jsonrpc: '2.0', method: 'notifications/initialized' });
    send(child, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const listRes = await waitForResponse(child, 2);
    expect(listRes.error).toBeUndefined();
    const names = (listRes.result as { tools: { name: string }[] }).tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'get_project',
        'list_documents',
        'list_projects',
        'list_secrets',
        'pidb_bind',
        'pidb_profiles',
        'pidb_status',
        'read_document',
        'search',
        'secret_request_link',
        'update_project',
        'upsert_secret_meta',
        'write_document',
      ].sort(),
    );
    expect(stderr).toBe('');
  });
});
