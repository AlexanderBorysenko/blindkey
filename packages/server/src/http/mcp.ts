import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { DOC_CATEGORIES, PROJECT_STATUSES, projectInputSchema, secretRequestPath, secretInputSchema, secretKeySchema, secretNameSchema, secretPatchSchema, slugSchema, tagsSchema, type Scope } from '@pidb/shared';
import type { AppContext } from './context.js';
import { actorOf, originOf, parseBody } from './helpers.js';
import { hasScope, type Actor, type Principal } from '../auth/principal.js';
import { AppError } from '../errors.js';
import { createProjectFor, getProjectDetailFor, listProjectsFor, updateProjectFor } from '../services/projects.js';
import { listDocumentsFor, readDocumentFor, writeDocumentFor } from '../services/documents.js';
import { createSecretFor, listSecretsFor, updateSecretFor } from '../services/secrets.js';
import { loadProjectFor } from '../services/common.js';
import { getSecretMeta } from '../repos/secrets.js';
import { searchFor } from '../services/search.js';

const INSTRUCTIONS = `pidb stores project documentation and named secrets.
Secret VALUES are never returned through MCP: only names, descriptions, tags and field keys (with a "sensitive" flag).
Values are consumed ONLY via the pidb CLI — never any other way:
  pidb secret exec <project|global> "<name>" -- <command>   # fields injected as PIDB_<KEY> env vars
  pidb secret write <project|global> "<name>" <field> --out <path> --mode 600
  pidb secret env <project|global> "<name>" --out .env
Documents reference secrets with {{secret:Name}}, {{secret:global/Name}} or {{secret:<project-slug>/Name}}. Never paste secret values into documents.
create_project creates a project (needs projects:create); it is added to your own token's projects at once.
update_project changes name/status/tags/summary (needs projects:write). upsert_secret_meta creates or patches a
secret's non-sensitive fields (needs secrets:meta-write); a field may be declared sensitive:false unless its key
looks like a credential — anything sensitive is refused. To get a sensitive value
in front of the user, call secret_request_link for a prefilled admin-UI link (it points at the new-secret form for a
name that doesn't exist yet, or the existing secret's edit page otherwise), hand it to them, then call list_secrets
to confirm once they've submitted it.`;

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
    'create_project',
    {
      description:
        'Create a project. Requires projects:create. The new project is added to this token\'s projects immediately, ' +
        'so you can write its documents and secrets straight away.',
      inputSchema: {
        slug: slugSchema,
        name: z.string().min(1).max(200),
        status: z.enum(PROJECT_STATUSES).optional(),
        tags: tagsSchema.optional(),
        summary: z.string().max(5000).optional(),
      },
    },
    async ({ slug, name, status, tags, summary }) =>
      run(() => createProjectFor(ctx, actor, parseBody(projectInputSchema, { slug, name, status, tags, summary }))),
  );

  server.registerTool(
    'upsert_secret_meta',
    {
      description:
        'Create a secret (project omitted for global) or patch an existing one\'s description/tags/fields, by name. ' +
        'Requires secrets:meta-write. Fields may only be non-sensitive both before and after: keys that are non-sensitive ' +
        'by default (host, port, url, username, database, public_key), or any other key passed with sensitive:false ' +
        'unless it looks like a credential (pass, secret, token, key, salt, auth, private, ...). Creating or touching a ' +
        'sensitive field is refused with a 403; use secret_request_link instead so the user types the value in.',
      inputSchema: {
        project: slugSchema.optional(),
        name: secretNameSchema,
        description: z.string().max(5000).optional(),
        tags: tagsSchema.optional(),
        fields: z
          .array(z.object({ key: secretKeySchema, value: z.string().max(1_000_000), sensitive: z.literal(false).optional() }))
          .max(200)
          .optional(),
      },
    },
    async ({ project, name, description, tags, fields }) =>
      run(() => {
        const projectRow = project ? loadProjectFor(ctx, p, project) : null;
        const existing = getSecretMeta(ctx.db, ctx.ring, projectRow?.id ?? null, name);
        const fieldInputs = (fields ?? []).map((f) => ({ key: f.key, value: f.value, ...(f.sensitive === false ? { sensitive: false } : {}) }));
        if (!existing) {
          // Validated the same way the UI's create form is (min 1 field, unique keys, size caps):
          // a duplicate key or an empty field list comes back as a validation error, not "internal error".
          const input = parseBody(secretInputSchema, { name, description: description ?? '', tags: tags ?? [], fields: fieldInputs });
          return createSecretFor(ctx, actor, project ?? null, input);
        }
        const patch = parseBody(secretPatchSchema, {
          ...(description !== undefined ? { description } : {}),
          ...(tags !== undefined ? { tags } : {}),
          ...(fieldInputs.length ? { fields: fieldInputs } : {}),
        });
        return updateSecretFor(ctx, actor, project ?? null, name, patch);
      }),
  );

  server.registerTool(
    'secret_request_link',
    {
      description:
        'Build a prefilled admin-UI link for creating or updating a secret\'s values: give this link to the user; they ' +
        'type the values; then call list_secrets to confirm. Points at the new-secret form for a name that does not ' +
        'exist yet, or at that existing secret\'s edit page otherwise (existing fields are left alone; only keys not ' +
        'already on the secret get an empty row to fill in). sensitive:false is honoured only for keys that are ' +
        'non-sensitive by default (host, port, url, username, database, public_key); any other key stays sensitive. ' +
        'Works with any secrets scope. Never returns or asks for a value.',
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
        const projectRow = project ? loadProjectFor(ctx, p, project) : null;
        const existing = getSecretMeta(ctx.db, ctx.ring, projectRow?.id ?? null, name);
        return { url: `${origin}${secretRequestPath({ project: project ?? null, name, exists: Boolean(existing), description, tags, keys })}` };
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
