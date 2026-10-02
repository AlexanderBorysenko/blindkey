import { describe, it, expect, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UPSTREAM_TOOL_DESCRIPTORS } from '../src/agent/upstream-tools.js';
import { makeServer, type ServerFixture } from './helpers.js';

let s: ServerFixture | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});

/**
 * Drift guard (spec §2.4, F2): the bridge's static descriptors must equal what a live blindkey server's
 * `/mcp` lists — name, description and JSON inputSchema — so an edit to packages/server/src/http/mcp.ts
 * that isn't mirrored into packages/cli/src/agent/upstream-tools.ts fails the suite.
 */
describe('static upstream tool descriptors', () => {
  it('match a live server tools/list exactly (same names, order, descriptions, input schemas)', async () => {
    s = await makeServer();
    const client = new Client({ name: 'drift-test', version: '0.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${s.url}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${s.token(['projects:read'])}` } },
      }),
    );
    const live = (await client.listTools()).tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
    await client.close();
    expect(UPSTREAM_TOOL_DESCRIPTORS).toEqual(live);
  });
});
