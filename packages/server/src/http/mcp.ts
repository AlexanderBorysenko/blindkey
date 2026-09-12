import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { DOC_CATEGORIES, slugSchema } from '@pidb/shared';
import type { AppContext } from './context.js';
import { actorOf } from './helpers.js';
import type { Actor } from '../auth/principal.js';
import { AppError } from '../errors.js';
import { getProjectDetailFor, listProjectsFor } from '../services/projects.js';
import { listDocumentsFor, readDocumentFor, writeDocumentFor } from '../services/documents.js';
import { listSecretsFor } from '../services/secrets.js';
import { searchFor } from '../services/search.js';

const INSTRUCTIONS = `pidb stores project documentation and named secrets.
Secret VALUES are never returned through MCP: only names, descriptions, tags and field keys (with a "sensitive" flag).
To use a secret value without loading it into context, run the pidb CLI:
  pidb secret exec <project|global> "<name>" -- <command>   # fields injected as PIDB_<KEY> env vars
  pidb secret write <project|global> "<name>" <field> --out <path> --mode 600
  pidb secret env <project|global> "<name>" --out .env
Documents reference secrets with {{secret:Name}}, {{secret:global/Name}} or {{secret:<project-slug>/Name}}. Never paste secret values into documents.`;

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

function ok(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}

function fail(err: unknown): ToolResult {
  const text = err instanceof AppError ? `${err.code}: ${err.message} ${JSON.stringify(err.details)}` : 'internal error';
  return { content: [{ type: 'text', text }], isError: true };
}

function run(fn: () => unknown): ToolResult {
  try {
    return ok(fn());
  } catch (err) {
    return fail(err);
  }
}

export function buildMcpServer(ctx: AppContext, actor: Actor): McpServer {
  const server = new McpServer({ name: 'pidb', version: '0.1.0' }, { instructions: INSTRUCTIONS });
  const p = actor.principal;

  server.registerTool(
    'list_projects',
    { description: 'List projects visible to this token (slug, name, status, tags, summary).', inputSchema: {} },
    async () => run(() => listProjectsFor(ctx, p)),
  );

  server.registerTool(
    'get_project',
    { description: 'Get a project with its document index and secret metadata (no sensitive values).', inputSchema: { slug: slugSchema } },
    async ({ slug }) => run(() => getProjectDetailFor(ctx, p, slug)),
  );

  server.registerTool(
    'list_documents',
    { description: 'List documents of a project (or global documents when project is omitted).', inputSchema: { project: slugSchema.optional() } },
    async ({ project }) => run(() => listDocumentsFor(ctx, p, project ?? null)),
  );

  server.registerTool(
    'read_document',
    {
      description: 'Read a Markdown document. Omit project for global documents (e.g. "guidelines"). Includes resolved secret refs (keys only).',
      inputSchema: { project: slugSchema.optional(), slug: slugSchema },
    },
    async ({ project, slug }) => run(() => readDocumentFor(ctx, p, project ?? null, slug, true)),
  );

  server.registerTool(
    'write_document',
    {
      description: 'Create or update a Markdown document. Rejected if it looks like it contains secret values or references unknown secrets; pass force=true to override.',
      inputSchema: {
        project: slugSchema.optional(),
        slug: slugSchema,
        title: z.string().min(1).max(300),
        category: z.enum(DOC_CATEGORIES),
        body_md: z.string().max(2_000_000),
        force: z.boolean().optional(),
      },
    },
    async ({ project, slug, title, category, body_md, force }) =>
      run(() => writeDocumentFor(ctx, actor, project ?? null, slug, { title, category, body_md, force: force ?? false })),
  );

  server.registerTool(
    'search',
    { description: 'Search project names, document text and secret names. Never searches secret values.', inputSchema: { query: z.string().min(1) } },
    async ({ query }) => run(() => searchFor(ctx, p, query)),
  );

  server.registerTool(
    'list_secrets',
    {
      description: 'List secret metadata for a project (or global when project omitted): name, description, tags, field keys and non-sensitive values.',
      inputSchema: { project: slugSchema.optional() },
    },
    async ({ project }) => run(() => listSecretsFor(ctx, p, project ?? null)),
  );

  return server;
}

export function registerMcpRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/mcp', async (req, reply) => {
    const actor = actorOf(req);
    const server = buildMcpServer(ctx, actor);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.hijack();
    reply.raw.on('close', () => {
      void transport.close().catch(() => {});
      void server.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req.raw, reply.raw, req.body);
    } catch (err) {
      req.log.error({ err }, 'mcp request failed');
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'content-type': 'application/json' });
        reply.raw.end(JSON.stringify({ error: 'internal' }));
      } else {
        reply.raw.destroy();
      }
    }
  });

  app.get('/mcp', async (_req, reply) => reply.status(405).send({ error: 'method_not_allowed' }));
  app.delete('/mcp', async (_req, reply) => reply.status(405).send({ error: 'method_not_allowed' }));
}
