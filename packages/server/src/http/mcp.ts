import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { DOC_CATEGORIES, PROJECT_STATUSES, secretKeySchema, secretNameSchema, slugSchema, tagsSchema, type Scope } from '@pidb/shared';
import type { AppContext } from './context.js';
import { actorOf, originOf } from './helpers.js';
import { hasScope, type Actor, type Principal } from '../auth/principal.js';
import { AppError } from '../errors.js';
import { getProjectDetailFor, listProjectsFor, updateProjectFor } from '../services/projects.js';
import { listDocumentsFor, readDocumentFor, writeDocumentFor } from '../services/documents.js';
import { createSecretFor, listSecretsFor, updateSecretFor } from '../services/secrets.js';
import { loadProjectFor } from '../services/common.js';
import { getSecretMeta } from '../repos/secrets.js';
import { searchFor } from '../services/search.js';

const INSTRUCTIONS = `pidb stores project documentation and named secrets.
Secret VALUES are never returned through MCP: only names, descriptions, tags and field keys (with a "sensitive" flag).
To use a secret value without loading it into context, run the pidb CLI:
  pidb secret exec <project|global> "<name>" -- <command>   # fields injected as PIDB_<KEY> env vars
  pidb secret write <project|global> "<name>" <field> --out <path> --mode 600
  pidb secret env <project|global> "<name>" --out .env
Documents reference secrets with {{secret:Name}}, {{secret:global/Name}} or {{secret:<project-slug>/Name}}. Never paste secret values into documents.
update_project changes name/status/tags/summary (needs projects:write). upsert_secret_meta creates or patches a
secret's non-sensitive fields (needs secrets:meta-write) — anything sensitive is refused. To get a sensitive value
in front of the user, call secret_request_link for a prefilled admin-UI link, hand it to them, then call
list_secrets to confirm once they've submitted it.`;

/** Any scope that touches secrets at all — the minimum bar for `secret_request_link` (spec §1.5: "any secrets scope"). */
const SECRETS_SCOPES: Scope[] = ['secrets:meta', 'secrets:meta-write', 'secrets:reveal', 'secrets:use', 'secrets:write'];

function assertAnySecretsScope(principal: Principal): void {
  if (!SECRETS_SCOPES.some((s) => hasScope(principal, s))) {
    throw new AppError(403, 'missing_scope', 'requires any secrets scope', { scopes: SECRETS_SCOPES });
  }
}

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

export function buildMcpServer(ctx: AppContext, actor: Actor, origin: string): McpServer {
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

  server.registerTool(
    'update_project',
    {
      description: 'Update a project\'s name, status, tags or summary (never its slug). Requires projects:write.',
      inputSchema: {
        slug: slugSchema,
        name: z.string().min(1).max(200).optional(),
        status: z.enum(PROJECT_STATUSES).optional(),
        tags: tagsSchema.optional(),
        summary: z.string().max(5000).optional(),
      },
    },
    async ({ slug, name, status, tags, summary }) => run(() => updateProjectFor(ctx, actor, slug, { name, status, tags, summary })),
  );

  server.registerTool(
    'upsert_secret_meta',
    {
      description:
        'Create a secret (project omitted for global) or patch an existing one\'s description/tags/fields, by name. ' +
        'Requires secrets:meta-write. Fields may only be keys that are non-sensitive both before and after (e.g. host, ' +
        'port, url, username, database, public_key) — creating or touching a sensitive field is refused with a 403; use ' +
        'secret_request_link instead so the user types the value in.',
      inputSchema: {
        project: slugSchema.optional(),
        name: secretNameSchema,
        description: z.string().max(5000).optional(),
        tags: tagsSchema.optional(),
        fields: z.array(z.object({ key: secretKeySchema, value: z.string().max(1_000_000) })).max(200).optional(),
      },
    },
    async ({ project, name, description, tags, fields }) =>
      run(() => {
        const projectRow = project ? loadProjectFor(ctx, p, project) : null;
        const existing = getSecretMeta(ctx.db, ctx.ring, projectRow?.id ?? null, name);
        const fieldInputs = (fields ?? []).map((f) => ({ key: f.key, value: f.value }));
        if (!existing) {
          return createSecretFor(ctx, actor, project ?? null, { name, description: description ?? '', tags: tags ?? [], fields: fieldInputs });
        }
        return updateSecretFor(ctx, actor, project ?? null, name, {
          ...(description !== undefined ? { description } : {}),
          ...(tags !== undefined ? { tags } : {}),
          ...(fieldInputs.length ? { fields: fieldInputs } : {}),
        });
      }),
  );

  server.registerTool(
    'secret_request_link',
    {
      description:
        'Build a prefilled admin-UI link for creating or updating a secret\'s values: give this link to the user; they ' +
        'type the values; then call list_secrets to confirm. Works with any secrets scope. Never returns or asks for a value.',
      inputSchema: {
        project: slugSchema.optional(),
        name: secretNameSchema,
        description: z.string().max(5000).optional(),
        tags: tagsSchema.optional(),
        keys: z
          .array(z.object({ key: secretKeySchema, sensitive: z.boolean() }))
          .min(1)
          .max(200),
      },
    },
    async ({ project, name, description, tags, keys }) =>
      run(() => {
        assertAnySecretsScope(p);
        if (project) loadProjectFor(ctx, p, project);
        const prefix = project ? `/p/${encodeURIComponent(project)}` : '/global';
        const qs = new URLSearchParams();
        qs.set('name', name);
        if (description) qs.set('description', description);
        if (tags && tags.length > 0) qs.set('tags', tags.join(','));
        qs.set('keys', keys.map((k) => (k.sensitive ? k.key : `${k.key}!`)).join(','));
        return { url: `${origin}${prefix}/secrets/new?${qs.toString()}` };
      }),
  );

  return server;
}

export function registerMcpRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/mcp', async (req, reply) => {
    const actor = actorOf(req);
    const server = buildMcpServer(ctx, actor, originOf(req));
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
