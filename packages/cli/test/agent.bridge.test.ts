import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createBridge } from '../src/agent/bridge.js';
import { loadBindings, saveBindings, saveProfiles } from '../src/agent/state.js';
import { memoryStore, type TokenStore } from '../src/agent/tokenstore.js';
import { createToken } from '../../server/src/repos/tokens.js';
import { makeServer, type ServerFixture } from './helpers.js';

const UPSTREAM_TOOL_NAMES = [
  'get_project',
  'list_documents',
  'list_projects',
  'list_secrets',
  'read_document',
  'search',
  'secret_request_link',
  'update_project',
  'upsert_secret_meta',
  'write_document',
];
const LOCAL_TOOL_NAMES = ['pidb_status', 'pidb_bind', 'pidb_profiles'];

let s: ServerFixture;
let dataDir: string;
let store: TokenStore;
const cwd = '/repo/acme';

beforeEach(async () => {
  s = await makeServer();
  s.project('acme');
  dataDir = mkdtempSync(join(tmpdir(), 'pidb-agent-bridge-'));
  store = memoryStore();
});
afterEach(async () => {
  await s.close();
});

/** Links a real Client to the bridge Server over the SDK's InMemoryTransport, connects both ends. */
async function connectBridge(cfg: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<Client> {
  const server = createBridge({ cwd: cfg.cwd ?? cwd, env: cfg.env, store, dataDir });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

function connectedProfile(scopes: Parameters<ServerFixture['token']>[0] = ['projects:read', 'docs:read', 'docs:write', 'secrets:meta', 'secrets:use']): void {
  saveProfiles(dataDir, { default: 'work', profiles: { work: { url: s.url } } });
  void store.set('work', s.token(scopes));
}

const textOf = (r: CallToolResult): string => {
  const c = r.content[0];
  return c && c.type === 'text' ? c.text : '';
};

describe('MCP bridge (spec §2.4)', () => {
  it('tools/list merges the upstream server tools with the local pidb_* tools', async () => {
    connectedProfile();
    const client = await connectBridge();
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([...UPSTREAM_TOOL_NAMES, ...LOCAL_TOOL_NAMES].sort());
  });

  it('not connected: tools/list returns only the local tools, nothing upstream', async () => {
    // No profile configured at all.
    const client = await connectBridge();
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([...LOCAL_TOOL_NAMES].sort());
  });

  it('tools/call forwards to the upstream server with the bearer token', async () => {
    connectedProfile();
    const client = await connectBridge();
    const res = await client.callTool({ name: 'list_projects', arguments: {} });
    expect(res.isError).toBeFalsy();
    const projects = JSON.parse(textOf(res as CallToolResult)) as { slug: string }[];
    expect(projects.map((p) => p.slug)).toContain('acme');
  });

  it('not connected: tools/call on an upstream tool returns a tool error with a connect hint', async () => {
    const client = await connectBridge();
    const res = (await client.callTool({ name: 'list_projects', arguments: {} })) as CallToolResult;
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/pidb connect/);
  });

  it('401 token_expired: tools/call returns a tool error with a connect hint, and the token never appears in the output', async () => {
    saveProfiles(dataDir, { default: 'work', profiles: { work: { url: s.url } } });
    const expired = createToken(s.db, {
      name: 'expired-agent',
      scopes: ['projects:read'],
      projectIds: null,
      expiresAt: Date.now() - 1000,
      kind: 'agent',
    }).token;
    await store.set('work', expired);
    const client = await connectBridge();
    const res = (await client.callTool({ name: 'list_projects', arguments: {} })) as CallToolResult;
    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).toMatch(/pidb connect/);
    expect(text).not.toContain(expired);
  });

  it('403 missing_scope from an upstream tool call gets the widen hint appended', async () => {
    // projects:read only — update_project needs projects:write too (spec §1.1).
    connectedProfile(['projects:read']);
    const client = await connectBridge();
    const res = (await client.callTool({ name: 'update_project', arguments: { slug: 'acme', summary: 'nope' } })) as CallToolResult;
    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).toMatch(/missing_scope|projects:write/);
    expect(text).toMatch(/pidb connect.*widen/);
  });

  it('drops the cached upstream client on a 401 so a later call with a refreshed token succeeds', async () => {
    saveProfiles(dataDir, { default: 'work', profiles: { work: { url: s.url } } });
    const expired = createToken(s.db, {
      name: 'expired-agent',
      scopes: ['projects:read'],
      projectIds: null,
      expiresAt: Date.now() - 1000,
      kind: 'agent',
    }).token;
    await store.set('work', expired);
    const client = await connectBridge();
    const first = (await client.callTool({ name: 'list_projects', arguments: {} })) as CallToolResult;
    expect(first.isError).toBe(true);

    // Simulate `pidb connect` having issued a fresh token for the same profile mid-session.
    await store.set('work', s.token(['projects:read']));
    const second = (await client.callTool({ name: 'list_projects', arguments: {} })) as CallToolResult;
    expect(second.isError).toBeFalsy();
  });

  it('pidb_status reports profile/url/project/connected and never the token', async () => {
    connectedProfile();
    saveBindings(dataDir, { [cwd]: { profile: 'work', project: 'acme' } });
    const token = (await store.get('work'))!;
    const client = await connectBridge();
    const res = (await client.callTool({ name: 'pidb_status', arguments: {} })) as CallToolResult;
    expect(res.isError).toBeFalsy();
    const text = textOf(res);
    const status = JSON.parse(text) as { profile: string; url: string; project: string; connected: boolean };
    expect(status).toMatchObject({ profile: 'work', url: s.url, project: 'acme', connected: true });
    expect(text).not.toContain(token);
  });

  it('pidb_status reports not connected when no profile is configured', async () => {
    const client = await connectBridge();
    const res = (await client.callTool({ name: 'pidb_status', arguments: {} })) as CallToolResult;
    const status = JSON.parse(textOf(res)) as { connected: boolean; profile: string | null };
    expect(status.connected).toBe(false);
    expect(status.profile).toBeNull();
  });

  it('pidb_bind uses the same binding logic as the CLI `bind` command and persists to bindings.json', async () => {
    connectedProfile();
    const client = await connectBridge();
    const res = (await client.callTool({ name: 'pidb_bind', arguments: { project: 'acme' } })) as CallToolResult;
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(textOf(res))).toEqual({ profile: 'work', project: 'acme' });
    expect(loadBindings(dataDir)[cwd]).toEqual({ profile: 'work', project: 'acme' });
  });

  it('pidb_bind refuses with a helpful error when no server is configured', async () => {
    const client = await connectBridge();
    const res = (await client.callTool({ name: 'pidb_bind', arguments: { project: 'acme' } })) as CallToolResult;
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/no server configured/);
  });

  it('pidb_profiles lists configured profiles and the default', async () => {
    connectedProfile();
    const client = await connectBridge();
    const res = (await client.callTool({ name: 'pidb_profiles', arguments: {} })) as CallToolResult;
    const body = JSON.parse(textOf(res)) as { default: string; profiles: { name: string; url: string; default: boolean }[] };
    expect(body).toEqual({ default: 'work', profiles: [{ name: 'work', url: s.url, default: true }] });
  });

  it('honours CLAUDE_PROJECT_DIR over the deps cwd for resolving the repo binding', async () => {
    connectedProfile();
    const boundCwd = '/repo/other';
    saveBindings(dataDir, { [boundCwd]: { profile: 'work', project: 'other-project' } });
    // deps.cwd points at an unbound repo; env.CLAUDE_PROJECT_DIR should win.
    const client = await connectBridge({ cwd: '/repo/unbound', env: { CLAUDE_PROJECT_DIR: boundCwd } });
    const res = (await client.callTool({ name: 'pidb_status', arguments: {} })) as CallToolResult;
    const status = JSON.parse(textOf(res)) as { project: string | null };
    expect(status.project).toBe('other-project');
  });
});
