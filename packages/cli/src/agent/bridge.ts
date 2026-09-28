// Stdio MCP bridge (spec §2.4): the plugin's `.mcp.json` launches `dist/mcp.mjs` (`bridge-main.ts`,
// which is the only thing that constructs a real `StdioServerTransport` around what's built here).
// This module is side-effect-free and fully testable in-process — `createBridge` returns a plain
// low-level `Server` that a test can connect to with the SDK's `InMemoryTransport` and a real `Client`.
//
// Proxies the pidb server's own `/mcp` tools (spec §1.5) over Streamable HTTP with the agent token
// from the OS credential store, and adds three local tools (`pidb_status`, `pidb_bind`,
// `pidb_profiles`) that never leave this process. Profile/token are resolved fresh on every call
// (spec: "profile or binding may change mid-session") — only the upstream MCP `Client` (keyed by
// `url`+`token`) is cached, and dropped on an authentication/authorization failure so the next call
// reconnects rather than reusing a session tied to a token that's since been rotated or widened.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { CliError } from '../errors.js';
import { resolveAgentConfig, type AgentConfig } from './context.js';
import { resolveDataDir } from './datadir.js';
import { loadBindings, loadProfiles, performBind, repoKey } from './state.js';
import type { TokenStore } from './tokenstore.js';

export interface BridgeDeps {
  /** Claude Code's project dir (its cwd when it launches the MCP server) — overridden by `env.CLAUDE_PROJECT_DIR` when set. */
  cwd: string;
  env?: NodeJS.ProcessEnv;
  store: TokenStore;
  /** Overrides the derived plugin data dir (tests; production derives it via `resolveDataDir`, which itself honours `PIDB_PLUGIN_DATA`). */
  dataDir?: string;
}

const CONNECT_HINT = 'not connected — run `pidb connect`';
const WIDEN_HINT = 'the token lacks access — run `pidb connect` to widen';

const LOCAL_TOOLS: Tool[] = [
  {
    name: 'pidb_status',
    description:
      "Show the pidb agent's own connection status: bound profile + server url, bound project, whether a token is stored, " +
      'and its approved projects/expiry if known. Never returns the token itself.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'pidb_bind',
    description:
      "Bind this repo (Claude Code's project dir) to a pidb project slug, on a chosen or default profile — the exact same " +
      'binding logic as the `pidb bind` CLI command.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'project slug to bind this repo to' },
        profile: { type: 'string', description: "profile to bind (default: the repo's current binding, else the default profile)" },
      },
      required: ['project'],
    },
  },
  {
    name: 'pidb_profiles',
    description: 'List configured pidb server profiles and which one (if any) is the default.',
    inputSchema: { type: 'object', properties: {} },
  },
];
const LOCAL_TOOL_NAMES = new Set(LOCAL_TOOLS.map((t) => t.name));

function textResult(text: string, isError = false): CallToolResult {
  return { content: [{ type: 'text', text }], isError };
}

/** Strips the current token value out of anything the bridge is about to emit (belt-and-braces — the
 * upstream server never echoes a token back, but a transport-level error can embed arbitrary response
 * text and must never be trusted to be token-free). */
function sanitize(token: string, text: string): string {
  return token.length > 0 ? text.split(token).join('[redacted]') : text;
}

/** True when an upstream tool's own error text names a missing/insufficient scope (spec §2.4 "403 →
 * widen hint") — this never arrives as an HTTP-level 403 from `/mcp` (every scope check happens
 * *inside* a tool handler, which turns an `AppError(403, ...)` into an ordinary `isError: true` tool
 * result, not a rejected request), so it has to be detected from the returned result's own text. */
function isScopeError(result: CallToolResult): boolean {
  if (result.isError !== true) return false;
  const first = result.content[0];
  const text = first && first.type === 'text' ? first.text : '';
  return /^(missing_scope|forbidden):/.test(text);
}

function withWidenHint(result: CallToolResult): CallToolResult {
  return {
    ...result,
    content: result.content.map((c) => (c.type === 'text' ? { ...c, text: `${c.text} — ${WIDEN_HINT}` } : c)),
  };
}

export function createBridge(deps: BridgeDeps): Server {
  const env = deps.env ?? process.env;
  // Claude Code launches the bridge with cwd = the project dir already; CLAUDE_PROJECT_DIR is
  // honoured too, and preferred, per spec §2.4.
  const cwd = env.CLAUDE_PROJECT_DIR || deps.cwd;
  const store = deps.store;
  const dataDir = deps.dataDir ?? resolveDataDir(env);

  const upstream = new Map<string, Client>();
  const clientKey = (url: string, token: string): string => `${url}\u0000${token}`;

  async function getUpstreamClient(url: string, token: string): Promise<Client> {
    const key = clientKey(url, token);
    const existing = upstream.get(key);
    if (existing) return existing;
    const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
    const client = new Client({ name: 'pidb-bridge', version: '0.1.0' });
    await client.connect(transport);
    upstream.set(key, client);
    return client;
  }

  /** Drops a cached client so the next call reconnects from scratch — used after an auth failure,
   * since the cached client's session is tied to a token that just proved invalid/insufficient. */
  function dropUpstreamClient(url: string, token: string): void {
    const key = clientKey(url, token);
    const client = upstream.get(key);
    if (!client) return;
    upstream.delete(key);
    void client.close().catch(() => {});
  }

  /** Resolves the effective profile/token for the *current* call — never cached across calls, since
   * the bound profile or its token can change mid-session (spec §2.4). Returns null for "not
   * connected"/"no server configured" instead of throwing, so callers can degrade gracefully. */
  async function resolveConfig(): Promise<AgentConfig | null> {
    try {
      return await resolveAgentConfig({ cwd, env, store, dataDir });
    } catch {
      return null;
    }
  }

  function statusCodeOf(err: unknown): number | undefined {
    return err instanceof StreamableHTTPError ? err.code : undefined;
  }

  async function callUpstreamTool(cfg: AgentConfig, name: string, args: Record<string, unknown> | undefined): Promise<CallToolResult> {
    try {
      const client = await getUpstreamClient(cfg.url, cfg.token);
      const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
      return isScopeError(result) ? withWidenHint(result) : result;
    } catch (err) {
      const status = statusCodeOf(err);
      if (status === 401 || status === 403) dropUpstreamClient(cfg.url, cfg.token);
      const hint = status === 401 ? CONNECT_HINT : status === 403 ? WIDEN_HINT : undefined;
      const message = sanitize(cfg.token, err instanceof Error ? err.message : String(err));
      return textResult(hint ? `${message} — ${hint}` : message, true);
    }
  }

  async function handleStatus(): Promise<CallToolResult> {
    const profiles = loadProfiles(dataDir);
    const bindings = loadBindings(dataDir);
    const binding = bindings[repoKey(cwd)];
    const profileName = binding?.profile ?? profiles.default;
    const profile = profileName ? profiles.profiles[profileName] : undefined;
    const token = profileName ? await store.get(profileName) : null;
    return textResult(
      JSON.stringify(
        {
          profile: profileName ?? null,
          url: profile?.url ?? null,
          project: binding?.project ?? null,
          connected: token !== null,
          projects: profile?.projects ?? null,
          expires_at: profile?.expires_at ?? null,
        },
        null,
        2,
      ),
    );
  }

  function handleBind(rawArgs: Record<string, unknown> | undefined): CallToolResult {
    const project = typeof rawArgs?.project === 'string' ? rawArgs.project : undefined;
    if (!project) return textResult('pidb_bind requires a "project" argument', true);
    const profile = typeof rawArgs?.profile === 'string' ? rawArgs.profile : undefined;
    try {
      const result = performBind(dataDir, cwd, project, profile);
      return textResult(JSON.stringify(result));
    } catch (err) {
      return textResult(err instanceof CliError ? err.message : 'bind failed', true);
    }
  }

  function handleProfiles(): CallToolResult {
    const profiles = loadProfiles(dataDir);
    const list = Object.entries(profiles.profiles).map(([name, p]) => ({ name, url: p.url, default: name === profiles.default }));
    return textResult(JSON.stringify({ default: profiles.default, profiles: list }, null, 2));
  }

  const server = new Server({ name: 'pidb-bridge', version: '0.1.0' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const cfg = await resolveConfig();
    let upstreamTools: Tool[] = [];
    if (cfg) {
      try {
        const client = await getUpstreamClient(cfg.url, cfg.token);
        upstreamTools = (await client.listTools()).tools;
      } catch (err) {
        const status = statusCodeOf(err);
        if (status === 401 || status === 403) dropUpstreamClient(cfg.url, cfg.token);
        // Degrade to local tools only — tools/list has no per-call error channel.
      }
    }
    return { tools: [...upstreamTools, ...LOCAL_TOOLS] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    if (LOCAL_TOOL_NAMES.has(name)) {
      if (name === 'pidb_status') return handleStatus();
      if (name === 'pidb_bind') return handleBind(args);
      return handleProfiles();
    }
    const cfg = await resolveConfig();
    if (!cfg) return textResult(CONNECT_HINT, true);
    return callUpstreamTool(cfg, name, args);
  });

  return server;
}
