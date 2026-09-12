# Projects Info DB — Plan 1: Core Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `pidb` server core: shared validation/lint/ref library, SQLite schema, envelope crypto, repositories, scoped-token REST API, MCP endpoint, and the `pidb-server` ops CLI — fully tested with vitest.

**Architecture:** npm-workspaces monorepo with `@pidb/shared` (pure functions: zod schemas, secret-reference parser, secret-value lint) and `@pidb/server` (Fastify 5 + better-sqlite3). Server is layered: `config` → `db` (SQL migrations) → `crypto` (AES-256-GCM envelope, tokens, argon2) → `repos` (one module per table group, plain functions taking `db`) → `auth` (principal + scope guards) → `http` (routes, error handler, MCP endpoint) → `cli` (init/start/rotate-key/backup). Plan 2 (CLI client) and Plan 3 (admin UI + Docker) build on this.

**Tech Stack:** Node 22, TypeScript 5.9 (ESM, NodeNext), Fastify 5, better-sqlite3 13 (FTS5), argon2 0.45, zod 4, @modelcontextprotocol/sdk 1.30, commander 15, pino, vitest 3.

**Spec:** `docs/superpowers/specs/2026-09-12-projects-info-db-design.md`

## Global Constraints

- Node `>=22`, ESM only (`"type": "module"`), TypeScript `strict: true`, `module`/`moduleResolution` = `NodeNext`. Relative imports inside packages must use `.js` extensions.
- Secret values are **never** logged, never returned by list/meta endpoints when `is_sensitive = 1`, never searchable, never exposed through MCP.
- Every read of a sensitive field value writes an `audit_log` row with `action = 'secret.reveal'` and `field_key`.
- Unknown project OR project outside the token's `project_ids` → HTTP 404 `{ "error": "not_found" }`. Missing scope → 403 `{ "error": "missing_scope", "scope": "<scope>" }`. Bad/missing token → 401 `{ "error": "unauthorized" }`.
- Scopes (exact strings): `projects:read`, `docs:read`, `docs:write`, `secrets:meta`, `secrets:reveal`, `secrets:write`, `admin`. `admin` implies all.
- Token format: `pidb_<8 base64url chars>_<43 base64url chars>`; stored as sha256 hex; compared with `timingSafeEqual`.
- Master key: 32 bytes base64 from `PIDB_MASTER_KEY` or file at `PIDB_MASTER_KEY_FILE`; server refuses to start without it.
- AES-256-GCM everywhere; blob layout `nonce(12) ‖ tag(16) ‖ ciphertext`. DEK wrap AAD = `"secret-dek"`; field AAD = `"<secret_id>:<field_key>"`.
- Non-sensitive default keys (exact): `host`, `port`, `url`, `username`, `database`, `public_key`. Everything else defaults to sensitive.
- Secret reference syntax: `{{secret:Name}}`, `{{secret:global/Name}}`, `{{secret:<project-slug>/Name}}`. Secret names must not contain `/`.
- Document categories (exact): `context`, `architecture`, `deploy`, `conventions`, `client`, `notes`, `guidelines`. Project statuses: `active`, `paused`, `archived`.
- Commit after every task with a Conventional Commits message ending in `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Run tests with `npx vitest run <path>` from the repo root. Never mark a step done without the test output showing PASS.

## File Structure

```
package.json                      workspaces root, scripts: build/test/typecheck
tsconfig.base.json                shared compiler options
vitest.config.ts                  alias @pidb/shared → packages/shared/src/index.ts
packages/shared/
  package.json  tsconfig.json
  src/index.ts                    re-exports
  src/schemas.ts                  zod schemas + constants (scopes, categories, statuses)
  src/refs.ts                     parseSecretRefs()
  src/lint.ts                     lintForSecrets()
  test/schemas.test.ts  test/refs.test.ts  test/lint.test.ts
packages/server/
  package.json  tsconfig.json
  src/config.ts                   loadConfig(env) → Config (master keys, paths, port)
  src/db/migrations.ts            MIGRATIONS[] + runMigrations(db)
  src/db/connection.ts            openDb(path) → Database (pragmas + migrate)
  src/crypto/envelope.ts          seal/open, DEK wrap/unwrap, field encrypt/decrypt
  src/crypto/tokens.ts            generateToken/hashToken/parseTokenPrefix/hashesEqual
  src/crypto/passwords.ts         hashPassword/verifyPassword (argon2id)
  src/errors.ts                   AppError + subclasses
  src/repos/projects.ts           project CRUD
  src/repos/documents.ts          document CRUD + FTS search
  src/repos/secrets.ts            secret CRUD, reveal, rewrap
  src/repos/tokens.ts             token create/find/revoke
  src/repos/audit.ts              writeAudit/listAudit
  src/repos/admin.ts              admin + sessions
  src/auth/principal.ts           Principal, hasScope, canAccessProject
  src/http/context.ts             AppContext type
  src/http/app.ts                 buildApp(ctx) — plugins, hooks, routes, error handler
  src/http/auth.ts                bearer resolution hook + failure rate limit
  src/http/helpers.ts             requireScope, loadProject, clientIp, audit helper
  src/http/routes/health.ts
  src/http/routes/projects.ts
  src/http/routes/documents.ts
  src/http/routes/secrets.ts
  src/http/routes/search.ts
  src/http/routes/admin.ts        tokens, audit, POST /auth/token
  src/http/mcp.ts                 MCP Streamable HTTP endpoint
  src/seed/guidelines.ts          seeded global guidelines document (string)
  src/ops.ts                      runInit/runRotateKey/runBackup (testable)
  src/cli.ts                      pidb-server bin (commander)
  test/helpers.ts                 makeTestContext(), makeToken()
  test/*.test.ts                  one file per module
```

---

### Task 1: Monorepo scaffold + shared package skeleton

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `vitest.config.ts`, `.gitignore` (exists; extend), `.npmrc`
- Create: `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/src/index.ts`, `packages/shared/src/schemas.ts` (constants only for now)
- Create: `packages/server/package.json`, `packages/server/tsconfig.json`, `packages/server/src/index.ts`
- Test: `packages/shared/test/smoke.test.ts`

**Interfaces:**
- Produces: workspace names `@pidb/shared`, `@pidb/server`; root scripts `npm test`, `npm run build`, `npm run typecheck`; vitest alias so server tests import `@pidb/shared` from source.

- [ ] **Step 1: Root files**

`package.json`:
```json
{
  "name": "pidb-monorepo",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "workspaces": ["packages/*"],
  "scripts": {
    "build": "npm run build -w @pidb/shared && npm run build -w @pidb/server",
    "typecheck": "npm run build -w @pidb/shared && tsc -p packages/server/tsconfig.json --noEmit",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "tsx": "^4.23.0",
    "typescript": "^5.9.3",
    "vitest": "^3.2.0"
  }
}
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "sourceMap": true,
    "noUncheckedIndexedAccess": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@pidb/shared': fileURLToPath(new URL('./packages/shared/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    testTimeout: 20000,
  },
});
```

`.npmrc`:
```
save-exact=false
fund=false
audit=false
```

Append to `.gitignore`:
```
*.sqlite-wal
*.sqlite-shm
coverage/
```

- [ ] **Step 2: Shared package**

`packages/shared/package.json`:
```json
{
  "name": "@pidb/shared",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "files": ["dist"],
  "scripts": { "build": "tsc -p tsconfig.json" },
  "dependencies": { "zod": "^4.0.0" }
}
```

`packages/shared/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src"]
}
```

`packages/shared/src/schemas.ts` (constants only in this task; schemas come in Task 2):
```ts
export const SCOPES = [
  'projects:read',
  'docs:read',
  'docs:write',
  'secrets:meta',
  'secrets:reveal',
  'secrets:write',
  'admin',
] as const;
export type Scope = (typeof SCOPES)[number];

export const PROJECT_STATUSES = ['active', 'paused', 'archived'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const DOC_CATEGORIES = [
  'context',
  'architecture',
  'deploy',
  'conventions',
  'client',
  'notes',
  'guidelines',
] as const;
export type DocCategory = (typeof DOC_CATEGORIES)[number];

export const NON_SENSITIVE_KEYS = ['host', 'port', 'url', 'username', 'database', 'public_key'] as const;

export function defaultSensitive(key: string): boolean {
  return !(NON_SENSITIVE_KEYS as readonly string[]).includes(key);
}
```

`packages/shared/src/index.ts`:
```ts
export * from './schemas.js';
```

- [ ] **Step 3: Server package skeleton**

`packages/server/package.json`:
```json
{
  "name": "@pidb/server",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "bin": { "pidb-server": "./dist/cli.js" },
  "files": ["dist"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "dev": "tsx src/cli.ts start"
  },
  "dependencies": {
    "@fastify/rate-limit": "^11.0.0",
    "@modelcontextprotocol/sdk": "^1.30.0",
    "@pidb/shared": "0.1.0",
    "argon2": "^0.45.0",
    "better-sqlite3": "^13.0.0",
    "commander": "^15.0.0",
    "fastify": "^5.0.0",
    "pino": "^10.0.0",
    "zod": "^4.0.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0",
    "pino-pretty": "^13.0.0"
  }
}
```

`packages/server/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist", "types": ["node"] },
  "include": ["src"]
}
```

`packages/server/src/index.ts`:
```ts
export {};
```

- [ ] **Step 4: Write smoke test**

`packages/shared/test/smoke.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { SCOPES, defaultSensitive } from '../src/index.js';

describe('shared smoke', () => {
  it('exports scopes', () => {
    expect(SCOPES).toContain('secrets:reveal');
    expect(SCOPES).toHaveLength(7);
  });
  it('defaultSensitive treats host as non-sensitive and password as sensitive', () => {
    expect(defaultSensitive('host')).toBe(false);
    expect(defaultSensitive('password')).toBe(true);
  });
});
```

- [ ] **Step 5: Install and run**

Run: `npm install` (from repo root), then `npx vitest run packages/shared`
Expected: 2 tests PASS. Then `npm run build` → exit 0, `packages/shared/dist/index.js` exists.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: scaffold monorepo with shared and server packages

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Shared zod schemas

**Files:**
- Modify: `packages/shared/src/schemas.ts`
- Test: `packages/shared/test/schemas.test.ts`

**Interfaces:**
- Produces: `slugSchema`, `projectInputSchema`, `projectPatchSchema`, `secretNameSchema`, `secretFieldInputSchema`, `secretInputSchema`, `secretPatchSchema`, `documentInputSchema`, `tokenInputSchema`, `authTokenRequestSchema`, `scopeSchema`, and inferred types `ProjectInput`, `ProjectPatch`, `SecretInput`, `SecretPatch`, `SecretFieldInput`, `DocumentInput`, `TokenInput`, `AuthTokenRequest`.

- [ ] **Step 1: Write failing tests**

`packages/shared/test/schemas.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import {
  slugSchema,
  projectInputSchema,
  secretInputSchema,
  secretPatchSchema,
  documentInputSchema,
  tokenInputSchema,
} from '../src/index.js';

describe('slugSchema', () => {
  it('accepts lowercase slugs', () => {
    expect(slugSchema.safeParse('critter-hero').success).toBe(true);
  });
  it('rejects uppercase, spaces, leading dash', () => {
    for (const bad of ['Critter', 'a b', '-abc', 'abc-', '']) {
      expect(slugSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe('projectInputSchema', () => {
  it('applies defaults', () => {
    const r = projectInputSchema.parse({ slug: 'x', name: 'X' });
    expect(r.status).toBe('active');
    expect(r.tags).toEqual([]);
    expect(r.summary).toBe('');
  });
  it('rejects unknown keys and bad status', () => {
    expect(projectInputSchema.safeParse({ slug: 'x', name: 'X', extra: 1 }).success).toBe(false);
    expect(projectInputSchema.safeParse({ slug: 'x', name: 'X', status: 'dead' }).success).toBe(false);
  });
});

describe('secretInputSchema', () => {
  it('accepts flat string fields', () => {
    const r = secretInputSchema.parse({
      name: 'Staging server',
      fields: [{ key: 'host', value: '1.2.3.4' }, { key: 'password', value: 'p' }],
    });
    expect(r.fields).toHaveLength(2);
    expect(r.description).toBe('');
  });
  it('rejects non-string values, nested objects, duplicate keys, slash in name', () => {
    expect(secretInputSchema.safeParse({ name: 'a', fields: [{ key: 'port', value: 22 }] }).success).toBe(false);
    expect(secretInputSchema.safeParse({ name: 'a', fields: [{ key: 'x', value: { a: 1 } }] }).success).toBe(false);
    expect(
      secretInputSchema.safeParse({ name: 'a', fields: [{ key: 'x', value: '1' }, { key: 'x', value: '2' }] }).success,
    ).toBe(false);
    expect(secretInputSchema.safeParse({ name: 'a/b', fields: [{ key: 'x', value: '1' }] }).success).toBe(false);
  });
  it('rejects empty fields array and bad keys', () => {
    expect(secretInputSchema.safeParse({ name: 'a', fields: [] }).success).toBe(false);
    expect(secretInputSchema.safeParse({ name: 'a', fields: [{ key: 'bad key', value: '1' }] }).success).toBe(false);
  });
});

describe('secretPatchSchema', () => {
  it('accepts partial updates with removeFields', () => {
    const r = secretPatchSchema.parse({ description: 'd', removeFields: ['old'] });
    expect(r.removeFields).toEqual(['old']);
    expect(r.fields).toBeUndefined();
  });
});

describe('documentInputSchema', () => {
  it('defaults force=false and validates category', () => {
    const r = documentInputSchema.parse({ title: 'T', category: 'context', body_md: '# hi' });
    expect(r.force).toBe(false);
    expect(documentInputSchema.safeParse({ title: 'T', category: 'blog', body_md: '' }).success).toBe(false);
  });
});

describe('tokenInputSchema', () => {
  it('requires at least one valid scope; projects default null', () => {
    const r = tokenInputSchema.parse({ name: 'cc', scopes: ['docs:read'] });
    expect(r.projects).toBeNull();
    expect(r.expires_at).toBeNull();
    expect(tokenInputSchema.safeParse({ name: 'cc', scopes: [] }).success).toBe(false);
    expect(tokenInputSchema.safeParse({ name: 'cc', scopes: ['root'] }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/shared/test/schemas.test.ts`
Expected: FAIL — `slugSchema` etc. not exported.

- [ ] **Step 3: Implement schemas**

Append to `packages/shared/src/schemas.ts`:
```ts
import { z } from 'zod';

export const scopeSchema = z.enum(SCOPES);

export const slugSchema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/, 'slug must be lowercase letters, digits and dashes');

export const tagsSchema = z.array(z.string().min(1).max(50)).max(50);

export const projectInputSchema = z.strictObject({
  slug: slugSchema,
  name: z.string().min(1).max(200),
  status: z.enum(PROJECT_STATUSES).default('active'),
  tags: tagsSchema.default([]),
  summary: z.string().max(5000).default(''),
});
export type ProjectInput = z.infer<typeof projectInputSchema>;

export const projectPatchSchema = z.strictObject({
  slug: slugSchema.optional(),
  name: z.string().min(1).max(200).optional(),
  status: z.enum(PROJECT_STATUSES).optional(),
  tags: tagsSchema.optional(),
  summary: z.string().max(5000).optional(),
});
export type ProjectPatch = z.infer<typeof projectPatchSchema>;

export const secretNameSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((n) => !n.includes('/'), 'secret name must not contain "/"');

export const secretKeySchema = z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/, 'key must match [A-Za-z0-9_.-]{1,64}');

export const secretFieldInputSchema = z.strictObject({
  key: secretKeySchema,
  value: z.string().max(1_000_000),
  sensitive: z.boolean().optional(),
});
export type SecretFieldInput = z.infer<typeof secretFieldInputSchema>;

const uniqueKeys = (fields: { key: string }[]) => new Set(fields.map((f) => f.key)).size === fields.length;

export const secretInputSchema = z.strictObject({
  name: secretNameSchema,
  description: z.string().max(5000).default(''),
  tags: tagsSchema.default([]),
  fields: z.array(secretFieldInputSchema).min(1).max(200).refine(uniqueKeys, 'duplicate field keys'),
});
export type SecretInput = z.infer<typeof secretInputSchema>;

export const secretPatchSchema = z.strictObject({
  name: secretNameSchema.optional(),
  description: z.string().max(5000).optional(),
  tags: tagsSchema.optional(),
  fields: z.array(secretFieldInputSchema).max(200).refine(uniqueKeys, 'duplicate field keys').optional(),
  removeFields: z.array(secretKeySchema).optional(),
});
export type SecretPatch = z.infer<typeof secretPatchSchema>;

export const docSlugSchema = slugSchema;

export const documentInputSchema = z.strictObject({
  title: z.string().min(1).max(300),
  category: z.enum(DOC_CATEGORIES),
  body_md: z.string().max(2_000_000),
  force: z.boolean().default(false),
});
export type DocumentInput = z.infer<typeof documentInputSchema>;

export const tokenInputSchema = z.strictObject({
  name: z.string().min(1).max(100),
  scopes: z.array(scopeSchema).min(1),
  projects: z.array(slugSchema).nullable().default(null),
  expires_at: z.number().int().positive().nullable().default(null),
});
export type TokenInput = z.infer<typeof tokenInputSchema>;

export const authTokenRequestSchema = z.strictObject({
  username: z.string().min(1).max(100),
  password: z.string().min(1).max(1000),
  name: z.string().min(1).max(100).default('cli'),
});
export type AuthTokenRequest = z.infer<typeof authTokenRequestSchema>;
```
Note: `import { z } from 'zod'` must be at the top of the file — move it above the constants when editing.

- [ ] **Step 4: Run tests**

Run: `npx vitest run packages/shared/test/schemas.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): add zod input schemas

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Secret reference parser

**Files:**
- Create: `packages/shared/src/refs.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/test/refs.test.ts`

**Interfaces:**
- Produces: `interface SecretRef { raw: string; project: string | null; global: boolean; name: string }`, `parseSecretRefs(md: string): SecretRef[]` (deduplicated, in first-seen order). `project === null && !global` means "same project as the document".

- [ ] **Step 1: Write failing tests**

`packages/shared/test/refs.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { parseSecretRefs } from '../src/index.js';

describe('parseSecretRefs', () => {
  it('parses project-local refs', () => {
    expect(parseSecretRefs('Use {{secret:Staging server}} to deploy.')).toEqual([
      { raw: '{{secret:Staging server}}', project: null, global: false, name: 'Staging server' },
    ]);
  });
  it('parses global and cross-project refs and tolerates whitespace', () => {
    const refs = parseSecretRefs('{{ secret:global/GitHub PAT }} and {{secret:critter-hero/Prod DB}}');
    expect(refs).toEqual([
      { raw: '{{ secret:global/GitHub PAT }}', project: null, global: true, name: 'GitHub PAT' },
      { raw: '{{secret:critter-hero/Prod DB}}', project: 'critter-hero', global: false, name: 'Prod DB' },
    ]);
  });
  it('deduplicates identical targets', () => {
    expect(parseSecretRefs('{{secret:A}} {{secret:A}} {{secret:global/A}}')).toHaveLength(2);
  });
  it('ignores malformed refs', () => {
    expect(parseSecretRefs('{{secret:}} {{secret:/x}} {{secret:x/}} {{secrets:A}} {{ secret }}')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/shared/test/refs.test.ts`
Expected: FAIL — `parseSecretRefs` is not a function.

- [ ] **Step 3: Implement**

`packages/shared/src/refs.ts`:
```ts
export interface SecretRef {
  raw: string;
  /** Project slug for cross-project refs; null for same-project or global refs. */
  project: string | null;
  global: boolean;
  name: string;
}

const REF_RE = /\{\{\s*secret:([^}]*?)\s*\}\}/g;

export function parseSecretRefs(md: string): SecretRef[] {
  const out: SecretRef[] = [];
  const seen = new Set<string>();
  for (const m of md.matchAll(REF_RE)) {
    const target = (m[1] ?? '').trim();
    if (!target) continue;
    let ref: SecretRef;
    const slash = target.indexOf('/');
    if (slash === -1) {
      ref = { raw: m[0], project: null, global: false, name: target };
    } else {
      const scope = target.slice(0, slash).trim();
      const name = target.slice(slash + 1).trim();
      if (!scope || !name) continue;
      ref =
        scope === 'global'
          ? { raw: m[0], project: null, global: true, name }
          : { raw: m[0], project: scope, global: false, name };
    }
    const key = `${ref.global ? 'global' : (ref.project ?? '')}/${ref.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}
```

Add to `packages/shared/src/index.ts`: `export * from './refs.js';`

- [ ] **Step 4: Run tests**

Run: `npx vitest run packages/shared/test/refs.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): add secret reference parser

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Secret-value lint for documents

**Files:**
- Create: `packages/shared/src/lint.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/test/lint.test.ts`

**Interfaces:**
- Produces: `interface LintFinding { line: number; reason: string }` (1-based line), `lintForSecrets(md: string): LintFinding[]`.

- [ ] **Step 1: Write failing tests**

`packages/shared/test/lint.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { lintForSecrets } from '../src/index.js';

const reasons = (md: string) => lintForSecrets(md).map((f) => f.reason);

describe('lintForSecrets', () => {
  it('flags PEM private keys with the right line number', () => {
    const md = 'intro\n-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----';
    const f = lintForSecrets(md);
    expect(f[0]).toEqual({ line: 2, reason: 'PEM private key block' });
  });
  it('flags well-known key shapes', () => {
    expect(reasons('AKIAIOSFODNN7EXAMPLE')).toContain('AWS access key id');
    expect(reasons('sk_live_4eC39HqLyjWDarjtT1zdp7dc')).toContain('Stripe secret key');
    expect(reasons('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345')).toContain('GitHub token');
    expect(reasons('github_pat_11ABCDEFG0123456789_abcdefghijkl')).toContain('GitHub token');
    expect(reasons('xoxb-1234567890-abcdefghij')).toContain('Slack token');
    expect(reasons('sk-proj-abcdefghijklmnopqrstuvwxyz')).toContain('API secret key (sk-...)');
  });
  it('flags credential assignments with real-looking values', () => {
    expect(reasons('password: Tr0ub4dor&3')).toContain('credential assignment');
    expect(reasons('DB_PASSWORD=hunter2hunter2')).toContain('credential assignment');
    expect(reasons('api_key = "abcd1234efgh"')).toContain('credential assignment');
  });
  it('does not flag placeholders, refs, env vars, or short words', () => {
    expect(reasons('password: {{secret:Staging server}}')).toEqual([]);
    expect(reasons('password: <your-password>')).toEqual([]);
    expect(reasons('password: $PIDB_PASSWORD')).toEqual([]);
    expect(reasons('password: stored')).toEqual([]);
    expect(reasons('The token is rotated monthly.')).toEqual([]);
  });
  it('flags long base64/hex blobs but not git SHA-1 hashes', () => {
    expect(reasons('key: dGhpcyBpcyBhIHZlcnkgbG9uZyBiYXNlNjQgc3RyaW5nIQ==')).toContain('long base64/hex string');
    expect(reasons('commit 9fceb02d0ae598e95dc970b74767f19372d61af8')).toEqual([]);
  });
  it('skips fenced code blocks tagged example', () => {
    const md = '```example\nAKIAIOSFODNN7EXAMPLE\n```\n\n```bash\nAKIAIOSFODNN7EXAMPLE\n```';
    const f = lintForSecrets(md);
    expect(f).toHaveLength(1);
    expect(f[0]?.line).toBe(6);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/shared/test/lint.test.ts`
Expected: FAIL — `lintForSecrets` not exported.

- [ ] **Step 3: Implement**

`packages/shared/src/lint.ts`:
```ts
export interface LintFinding {
  line: number;
  reason: string;
}

interface Pattern {
  re: RegExp;
  reason: string;
}

const PATTERNS: Pattern[] = [
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, reason: 'PEM private key block' },
  { re: /\bAKIA[0-9A-Z]{16}\b/, reason: 'AWS access key id' },
  { re: /\bsk_(?:live|test)_[A-Za-z0-9]{10,}/, reason: 'Stripe secret key' },
  { re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/, reason: 'GitHub token' },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/, reason: 'Slack token' },
  { re: /\bsk-[A-Za-z0-9_-]{20,}\b/, reason: 'API secret key (sk-...)' },
];

const ASSIGN_RE = /\b(password|passwd|pwd|secret|token|api[_-]?key)\b\s*[:=]\s*["']?([^\s"'{}<>$]{6,})/gi;
const BASE64_RE = /(?<![A-Za-z0-9+/=])[A-Za-z0-9+/]{32,}={0,2}(?![A-Za-z0-9+/=])/;
const HEX_RE = /\b[0-9a-fA-F]{48,}\b/;
const FENCE_RE = /^\s*(```|~~~)\s*([A-Za-z0-9_-]*)/;

function looksLikeRealValue(v: string): boolean {
  if (v.length >= 12) return true;
  return /[0-9!@#%^&*()_+\-=[\]|;,.?/\\]/.test(v);
}

export function lintForSecrets(md: string): LintFinding[] {
  const findings: LintFinding[] = [];
  const lines = md.split(/\r?\n/);
  let inFence = false;
  let fenceIsExample = false;
  let fenceMarker = '';

  lines.forEach((line, idx) => {
    const lineNo = idx + 1;
    const fence = FENCE_RE.exec(line);
    if (fence) {
      const marker = fence[1] ?? '';
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
        fenceIsExample = (fence[2] ?? '').toLowerCase() === 'example';
      } else if (marker === fenceMarker) {
        inFence = false;
        fenceIsExample = false;
      }
      return;
    }
    if (inFence && fenceIsExample) return;

    for (const p of PATTERNS) {
      if (p.re.test(line)) findings.push({ line: lineNo, reason: p.reason });
    }
    for (const m of line.matchAll(ASSIGN_RE)) {
      const value = m[2] ?? '';
      if (looksLikeRealValue(value)) {
        findings.push({ line: lineNo, reason: 'credential assignment' });
        break;
      }
    }
    const b64 = BASE64_RE.exec(line);
    const isB64Blob = b64 !== null && !/^[0-9a-fA-F]+={0,2}$/.test(b64[0]);
    if (isB64Blob || HEX_RE.test(line)) {
      findings.push({ line: lineNo, reason: 'long base64/hex string' });
    }
  });
  return findings;
}
```
Notes: a 40-char git SHA-1 is pure hex, below the 48-char `HEX_RE` threshold, and excluded from the base64 rule by the pure-hex check, so it is not flagged. `AKIAIOSFODNN7EXAMPLE` is 20 chars, so the fenced-block test yields exactly one finding on line 6.

Add to `packages/shared/src/index.ts`: `export * from './lint.js';`

- [ ] **Step 4: Run tests**

Run: `npx vitest run packages/shared`
Expected: all PASS. If the credential-assignment test for `hunter2hunter2` fails, confirm `looksLikeRealValue` returns true for length ≥ 12.

- [ ] **Step 5: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): add secret-value lint for documents

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Server config loader

**Files:**
- Create: `packages/server/src/config.ts`
- Test: `packages/server/test/config.test.ts`

**Interfaces:**
- Produces: `class ConfigError extends Error`, `interface KeyRing { current: number; keys: Map<number, Buffer> }`, `interface Config { host: string; port: number; dataDir: string; dbPath: string; keyRing: KeyRing; logLevel: string }`, `loadConfig(env?: NodeJS.ProcessEnv, readFile?: (path: string) => string): Config`.

- [ ] **Step 1: Write failing tests**

`packages/server/test/config.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { loadConfig, ConfigError } from '../src/config.js';

const key = () => randomBytes(32).toString('base64');

describe('loadConfig', () => {
  it('throws without a master key', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
  });
  it('rejects a key that is not 32 bytes', () => {
    expect(() => loadConfig({ PIDB_MASTER_KEY: randomBytes(16).toString('base64') })).toThrow(/32 bytes/);
  });
  it('loads key from env with defaults', () => {
    const k = key();
    const c = loadConfig({ PIDB_MASTER_KEY: k });
    expect(c.keyRing.current).toBe(1);
    expect(c.keyRing.keys.get(1)?.toString('base64')).toBe(k);
    expect(c.port).toBe(8080);
    expect(c.host).toBe('0.0.0.0');
    expect(c.dataDir).toBe('/data');
    expect(c.dbPath).toBe('/data/pidb.sqlite');
  });
  it('loads key from file via injected reader', () => {
    const k = key();
    const c = loadConfig({ PIDB_MASTER_KEY_FILE: '/run/secrets/mk' }, (p) => (p === '/run/secrets/mk' ? k + '\n' : ''));
    expect(c.keyRing.keys.get(1)?.toString('base64')).toBe(k);
  });
  it('parses version and previous keys', () => {
    const k2 = key();
    const k1 = key();
    const c = loadConfig({ PIDB_MASTER_KEY: k2, PIDB_MASTER_KEY_VERSION: '2', PIDB_MASTER_KEY_PREVIOUS: `1:${k1}` });
    expect(c.keyRing.current).toBe(2);
    expect(c.keyRing.keys.get(1)?.toString('base64')).toBe(k1);
    expect(c.keyRing.keys.get(2)?.toString('base64')).toBe(k2);
  });
  it('rejects previous key version >= current', () => {
    expect(() => loadConfig({ PIDB_MASTER_KEY: key(), PIDB_MASTER_KEY_PREVIOUS: `1:${key()}` })).toThrow(ConfigError);
  });
  it('honours PIDB_PORT, PIDB_DATA_DIR, PIDB_DB_PATH', () => {
    const c = loadConfig({ PIDB_MASTER_KEY: key(), PIDB_PORT: '9000', PIDB_DATA_DIR: '/tmp/x', PIDB_DB_PATH: '/tmp/y.sqlite' });
    expect(c.port).toBe(9000);
    expect(c.dataDir).toBe('/tmp/x');
    expect(c.dbPath).toBe('/tmp/y.sqlite');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/server/test/config.test.ts`
Expected: FAIL — cannot find module `../src/config.js`.

- [ ] **Step 3: Implement**

`packages/server/src/config.ts`:
```ts
import { readFileSync } from 'node:fs';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface KeyRing {
  current: number;
  keys: Map<number, Buffer>;
}

export interface Config {
  host: string;
  port: number;
  dataDir: string;
  dbPath: string;
  keyRing: KeyRing;
  logLevel: string;
}

function parseKey(b64: string, label: string): Buffer {
  const buf = Buffer.from(b64.trim(), 'base64');
  if (buf.length !== 32) throw new ConfigError(`${label} must decode to 32 bytes (got ${buf.length})`);
  return buf;
}

function parseIntStrict(value: string, label: string): number {
  if (!/^\d+$/.test(value)) throw new ConfigError(`${label} must be an integer`);
  return Number.parseInt(value, 10);
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  readFile: (path: string) => string = (p) => readFileSync(p, 'utf8'),
): Config {
  let raw = env.PIDB_MASTER_KEY;
  if (!raw && env.PIDB_MASTER_KEY_FILE) raw = readFile(env.PIDB_MASTER_KEY_FILE);
  if (!raw || !raw.trim()) throw new ConfigError('PIDB_MASTER_KEY or PIDB_MASTER_KEY_FILE is required');

  const current = parseIntStrict(env.PIDB_MASTER_KEY_VERSION ?? '1', 'PIDB_MASTER_KEY_VERSION');
  if (current < 1) throw new ConfigError('PIDB_MASTER_KEY_VERSION must be >= 1');

  const keys = new Map<number, Buffer>();
  keys.set(current, parseKey(raw, 'PIDB_MASTER_KEY'));

  const previous = (env.PIDB_MASTER_KEY_PREVIOUS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const entry of previous) {
    const idx = entry.indexOf(':');
    if (idx === -1) throw new ConfigError(`PIDB_MASTER_KEY_PREVIOUS entry must be <version>:<base64>`);
    const version = parseIntStrict(entry.slice(0, idx), 'PIDB_MASTER_KEY_PREVIOUS version');
    if (version < 1 || version >= current) {
      throw new ConfigError(`previous key version ${version} must be >= 1 and lower than current (${current})`);
    }
    keys.set(version, parseKey(entry.slice(idx + 1), `PIDB_MASTER_KEY_PREVIOUS[${version}]`));
  }

  const port = parseIntStrict(env.PIDB_PORT ?? '8080', 'PIDB_PORT');
  if (port > 65535) throw new ConfigError('PIDB_PORT must be <= 65535');
  const dataDir = env.PIDB_DATA_DIR ?? '/data';

  return {
    host: env.PIDB_HOST ?? '0.0.0.0',
    port,
    dataDir,
    dbPath: env.PIDB_DB_PATH ?? `${dataDir}/pidb.sqlite`,
    keyRing: { current, keys },
    logLevel: env.PIDB_LOG_LEVEL ?? 'info',
  };
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run packages/server/test/config.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/server
git commit -m "feat(server): add config loader with master key ring

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: SQLite connection + migrations

**Files:**
- Create: `packages/server/src/db/migrations.ts`, `packages/server/src/db/connection.ts`
- Test: `packages/server/test/db.test.ts`

**Interfaces:**
- Produces: `type Db = import('better-sqlite3').Database`, `openDb(path: string): Db` (sets pragmas, runs migrations), `runMigrations(db: Db): number` (returns count applied), `MIGRATIONS: { id: number; sql: string }[]`.

- [ ] **Step 1: Write failing tests**

`packages/server/test/db.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations.js';

describe('db', () => {
  it('creates all tables', () => {
    const db = openDb(':memory:');
    const names = db
      .prepare(`SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name`)
      .all()
      .map((r) => (r as { name: string }).name);
    for (const t of ['projects', 'secrets', 'secret_fields', 'documents', 'documents_fts', 'api_tokens', 'audit_log', 'admin', 'sessions', 'schema_migrations']) {
      expect(names).toContain(t);
    }
  });
  it('is idempotent', () => {
    const db = openDb(':memory:');
    expect(runMigrations(db)).toBe(0);
  });
  it('enforces foreign keys with cascade', () => {
    const db = openDb(':memory:');
    db.prepare(`INSERT INTO projects (id, slug, name, created_at, updated_at) VALUES (1, 'p', 'P', 0, 0)`).run();
    db.prepare(`INSERT INTO documents (project_id, slug, title, category, body_md, created_at, updated_at) VALUES (1, 'd', 'D', 'notes', 'x', 0, 0)`).run();
    db.prepare(`DELETE FROM projects WHERE id = 1`).run();
    expect(db.prepare(`SELECT COUNT(*) AS c FROM documents`).get()).toEqual({ c: 0 });
  });
  it('keeps FTS index in sync via triggers', () => {
    const db = openDb(':memory:');
    db.prepare(`INSERT INTO documents (id, project_id, slug, title, category, body_md, created_at, updated_at) VALUES (7, NULL, 'g', 'Guide', 'guidelines', 'deploy with caddy', 0, 0)`).run();
    const hit = db.prepare(`SELECT rowid FROM documents_fts WHERE documents_fts MATCH 'caddy'`).all();
    expect(hit).toEqual([{ rowid: 7 }]);
    db.prepare(`UPDATE documents SET body_md = 'deploy with nginx' WHERE id = 7`).run();
    expect(db.prepare(`SELECT rowid FROM documents_fts WHERE documents_fts MATCH 'caddy'`).all()).toEqual([]);
    expect(db.prepare(`SELECT rowid FROM documents_fts WHERE documents_fts MATCH 'nginx'`).all()).toEqual([{ rowid: 7 }]);
    db.prepare(`DELETE FROM documents WHERE id = 7`).run();
    expect(db.prepare(`SELECT rowid FROM documents_fts WHERE documents_fts MATCH 'nginx'`).all()).toEqual([]);
  });
  it('enforces unique secret name per project including global', () => {
    const db = openDb(':memory:');
    const ins = db.prepare(`INSERT INTO secrets (project_id, name, dek_wrapped, key_version, created_at, updated_at) VALUES (?, 'A', x'00', 1, 0, 0)`);
    ins.run(null);
    expect(() => ins.run(null)).toThrow(/UNIQUE/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/server/test/db.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement migrations**

`packages/server/src/db/migrations.ts`:
```ts
import type Database from 'better-sqlite3';

export interface Migration {
  id: number;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    sql: `
CREATE TABLE projects (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  tags TEXT NOT NULL DEFAULT '[]',
  summary TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE secrets (
  id INTEGER PRIMARY KEY,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  dek_wrapped BLOB NOT NULL,
  key_version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX secrets_project_name ON secrets(COALESCE(project_id, 0), name);

CREATE TABLE secret_fields (
  id INTEGER PRIMARY KEY,
  secret_id INTEGER NOT NULL REFERENCES secrets(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value_enc BLOB NOT NULL,
  is_sensitive INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  UNIQUE(secret_id, key)
);

CREATE TABLE documents (
  id INTEGER PRIMARY KEY,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  body_md TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX documents_project_slug ON documents(COALESCE(project_id, 0), slug);

CREATE VIRTUAL TABLE documents_fts USING fts5(title, body_md, content='documents', content_rowid='id');
CREATE TRIGGER documents_ai AFTER INSERT ON documents BEGIN
  INSERT INTO documents_fts(rowid, title, body_md) VALUES (new.id, new.title, new.body_md);
END;
CREATE TRIGGER documents_ad AFTER DELETE ON documents BEGIN
  INSERT INTO documents_fts(documents_fts, rowid, title, body_md) VALUES ('delete', old.id, old.title, old.body_md);
END;
CREATE TRIGGER documents_au AFTER UPDATE ON documents BEGIN
  INSERT INTO documents_fts(documents_fts, rowid, title, body_md) VALUES ('delete', old.id, old.title, old.body_md);
  INSERT INTO documents_fts(rowid, title, body_md) VALUES (new.id, new.title, new.body_md);
END;

CREATE TABLE api_tokens (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL,
  project_ids TEXT,
  expires_at INTEGER,
  last_used_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX api_tokens_prefix ON api_tokens(prefix);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id INTEGER,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id INTEGER,
  field_key TEXT,
  ip TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT '',
  meta TEXT
);
CREATE INDEX audit_log_ts ON audit_log(ts);

CREATE TABLE admin (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  admin_id INTEGER NOT NULL REFERENCES admin(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  ip TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT ''
);
`,
  },
];

export function runMigrations(db: Database.Database): number {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)`);
  const applied = new Set(
    (db.prepare(`SELECT id FROM schema_migrations`).all() as { id: number }[]).map((r) => r.id),
  );
  const insert = db.prepare(`INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)`);
  let count = 0;
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      insert.run(m.id, Date.now());
    })();
    count++;
  }
  return count;
}
```

`packages/server/src/db/connection.ts`:
```ts
import Database from 'better-sqlite3';
import { runMigrations } from './migrations.js';

export type Db = Database.Database;

export function openDb(path: string): Db {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  runMigrations(db);
  return db;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run packages/server/test/db.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/server
git commit -m "feat(server): add sqlite connection and schema migrations

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Crypto — envelope, tokens, passwords, errors

**Files:**
- Create: `packages/server/src/errors.ts`, `packages/server/src/crypto/envelope.ts`, `packages/server/src/crypto/tokens.ts`, `packages/server/src/crypto/passwords.ts`
- Test: `packages/server/test/crypto.test.ts`

**Interfaces:**
- Produces (errors): `AppError(status, code, message?, details?)`, `NotFoundError`, `UnauthorizedError`, `ForbiddenError(scope)`, `ValidationError(issues)`, `ConflictError`, `UnprocessableError(code, details)`, `CryptoError`.
- Produces (envelope): `seal(key: Buffer, plaintext: Buffer, aad: string): Buffer`, `open(key, blob, aad): Buffer`, `generateDek(): Buffer`, `wrapDek(masterKey, dek): Buffer`, `unwrapDek(masterKey, wrapped): Buffer`, `encryptField(dek, secretId: number, key: string, value: string): Buffer`, `decryptField(dek, secretId, key, blob): string`.
- Produces (tokens): `generateToken(): { token: string; prefix: string; hash: string }`, `hashToken(token): string`, `parseTokenPrefix(token): string | null`, `hashesEqual(aHex, bHex): boolean`.
- Produces (passwords): `hashPassword(pw): Promise<string>`, `verifyPassword(hash, pw): Promise<boolean>`.

- [ ] **Step 1: Write failing tests**

`packages/server/test/crypto.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { seal, open, generateDek, wrapDek, unwrapDek, encryptField, decryptField } from '../src/crypto/envelope.js';
import { generateToken, hashToken, parseTokenPrefix, hashesEqual } from '../src/crypto/tokens.js';
import { hashPassword, verifyPassword } from '../src/crypto/passwords.js';
import { CryptoError } from '../src/errors.js';

describe('envelope', () => {
  const master = randomBytes(32);
  it('round-trips a field through DEK wrap/unwrap', () => {
    const dek = generateDek();
    const wrapped = wrapDek(master, dek);
    expect(wrapped.length).toBe(12 + 16 + 32);
    expect(unwrapDek(master, wrapped).equals(dek)).toBe(true);
    const blob = encryptField(dek, 42, 'password', 'hunter2');
    expect(decryptField(dek, 42, 'password', blob)).toBe('hunter2');
  });
  it('fails on wrong AAD (moved ciphertext) and tampering', () => {
    const dek = generateDek();
    const blob = encryptField(dek, 42, 'password', 'hunter2');
    expect(() => decryptField(dek, 42, 'username', blob)).toThrow(CryptoError);
    expect(() => decryptField(dek, 43, 'password', blob)).toThrow(CryptoError);
    const tampered = Buffer.from(blob);
    tampered[tampered.length - 1] ^= 0x01;
    expect(() => decryptField(dek, 42, 'password', tampered)).toThrow(CryptoError);
  });
  it('fails to unwrap with wrong master key', () => {
    const wrapped = wrapDek(master, generateDek());
    expect(() => unwrapDek(randomBytes(32), wrapped)).toThrow(CryptoError);
  });
  it('uses a fresh nonce per seal', () => {
    const a = seal(master, Buffer.from('x'), 'aad');
    const b = seal(master, Buffer.from('x'), 'aad');
    expect(a.equals(b)).toBe(false);
    expect(open(master, a, 'aad').toString()).toBe('x');
  });
  it('handles empty and unicode values', () => {
    const dek = generateDek();
    expect(decryptField(dek, 1, 'k', encryptField(dek, 1, 'k', ''))).toBe('');
    expect(decryptField(dek, 1, 'k', encryptField(dek, 1, 'k', 'пароль ✓'))).toBe('пароль ✓');
  });
});

describe('tokens', () => {
  it('generates pidb_<prefix>_<secret> tokens', () => {
    const t = generateToken();
    expect(t.token).toMatch(/^pidb_[A-Za-z0-9_-]{8}_[A-Za-z0-9_-]{43}$/);
    expect(parseTokenPrefix(t.token)).toBe(t.prefix);
    expect(hashToken(t.token)).toBe(t.hash);
    expect(t.hash).toMatch(/^[0-9a-f]{64}$/);
  });
  it('rejects malformed tokens', () => {
    expect(parseTokenPrefix('nope')).toBeNull();
    expect(parseTokenPrefix('pidb_short_x')).toBeNull();
  });
  it('compares hashes in constant time helper', () => {
    const t = generateToken();
    expect(hashesEqual(t.hash, t.hash)).toBe(true);
    expect(hashesEqual(t.hash, generateToken().hash)).toBe(false);
    expect(hashesEqual(t.hash, 'abc')).toBe(false);
  });
});

describe('passwords', () => {
  it('hashes with argon2id and verifies', async () => {
    const h = await hashPassword('correct horse');
    expect(h.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(h, 'correct horse')).toBe(true);
    expect(await verifyPassword(h, 'wrong')).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/server/test/crypto.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement errors**

`packages/server/src/errors.ts`:
```ts
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message?: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message ?? code);
    this.name = 'AppError';
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'not found') {
    super(404, 'not_found', message);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'unauthorized') {
    super(401, 'unauthorized', message);
  }
}

export class ForbiddenError extends AppError {
  constructor(scope: string) {
    super(403, 'missing_scope', `missing scope ${scope}`, { scope });
  }
}

export class ValidationError extends AppError {
  constructor(issues: unknown) {
    super(400, 'validation', 'validation failed', { issues });
  }
}

export class ConflictError extends AppError {
  constructor(message = 'conflict') {
    super(409, 'conflict', message);
  }
}

export class UnprocessableError extends AppError {
  constructor(code: string, details: Record<string, unknown>, message?: string) {
    super(422, code, message ?? code, details);
  }
}

export class CryptoError extends AppError {
  constructor(message = 'decrypt failed') {
    super(500, 'decrypt_failed', message);
  }
}
```

- [ ] **Step 4: Implement envelope**

`packages/server/src/crypto/envelope.ts`:
```ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { CryptoError } from '../errors.js';

const NONCE_LEN = 12;
const TAG_LEN = 16;
const DEK_AAD = 'secret-dek';

export function seal(key: Buffer, plaintext: Buffer, aad: string): Buffer {
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ct]);
}

export function open(key: Buffer, blob: Buffer, aad: string): Buffer {
  if (blob.length < NONCE_LEN + TAG_LEN) throw new CryptoError('ciphertext too short');
  const nonce = blob.subarray(0, NONCE_LEN);
  const tag = blob.subarray(NONCE_LEN, NONCE_LEN + TAG_LEN);
  const ct = blob.subarray(NONCE_LEN + TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    throw new CryptoError();
  }
}

export function generateDek(): Buffer {
  return randomBytes(32);
}

export function wrapDek(masterKey: Buffer, dek: Buffer): Buffer {
  return seal(masterKey, dek, DEK_AAD);
}

export function unwrapDek(masterKey: Buffer, wrapped: Buffer): Buffer {
  return open(masterKey, wrapped, DEK_AAD);
}

export function fieldAad(secretId: number, key: string): string {
  return `${secretId}:${key}`;
}

export function encryptField(dek: Buffer, secretId: number, key: string, value: string): Buffer {
  return seal(dek, Buffer.from(value, 'utf8'), fieldAad(secretId, key));
}

export function decryptField(dek: Buffer, secretId: number, key: string, blob: Buffer): string {
  return open(dek, blob, fieldAad(secretId, key)).toString('utf8');
}
```

- [ ] **Step 5: Implement tokens and passwords**

`packages/server/src/crypto/tokens.ts`:
```ts
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const TOKEN_RE = /^pidb_([A-Za-z0-9_-]{8})_[A-Za-z0-9_-]{43}$/;

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function generateToken(): { token: string; prefix: string; hash: string } {
  const prefix = randomBytes(6).toString('base64url');
  const secret = randomBytes(32).toString('base64url');
  const token = `pidb_${prefix}_${secret}`;
  return { token, prefix, hash: hashToken(token) };
}

export function parseTokenPrefix(token: string): string | null {
  const m = TOKEN_RE.exec(token);
  return m ? (m[1] ?? null) : null;
}

export function hashesEqual(aHex: string, bHex: string): boolean {
  const a = Buffer.from(aHex, 'hex');
  const b = Buffer.from(bHex, 'hex');
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}
```

`packages/server/src/crypto/passwords.ts`:
```ts
import argon2 from 'argon2';

const OPTIONS = { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 } as const;

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, OPTIONS);
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}
```

- [ ] **Step 6: Run tests**

Run: `npx vitest run packages/server/test/crypto.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 7: Commit**

```bash
git add packages/server
git commit -m "feat(server): add envelope crypto, token hashing, argon2 passwords

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Repos — projects and documents

**Files:**
- Create: `packages/server/src/repos/util.ts`, `packages/server/src/repos/projects.ts`, `packages/server/src/repos/documents.ts`
- Test: `packages/server/test/repos.projects.test.ts`, `packages/server/test/repos.documents.test.ts`

**Interfaces:**
- Produces (util): `now(): number`, `parseJsonArray<T>(s: string | null): T[]`, `isUniqueViolation(err: unknown): boolean`, `inList(ids: number[]): string` (returns `?,?,?`).
- Produces (projects): `interface ProjectRow { id; slug; name; status: ProjectStatus; tags: string[]; summary; created_at; updated_at }`, `createProject(db, input: ProjectInput): ProjectRow`, `getProjectById(db, id): ProjectRow | null`, `getProjectBySlug(db, slug): ProjectRow | null`, `listProjects(db, projectIds: number[] | null): ProjectRow[]`, `updateProject(db, id, patch: ProjectPatch): ProjectRow`, `deleteProject(db, id): boolean`.
- Produces (documents): `interface DocumentRow { id; project_id: number | null; slug; title; category: DocCategory; body_md; created_at; updated_at }`, `type DocumentSummary = Omit<DocumentRow, 'body_md'>`, `interface DocumentSearchHit { id; project_id; slug; title; category; snippet }`, `upsertDocument(db, { projectId, slug, title, category, body_md }): { doc: DocumentRow; created: boolean }`, `getDocument(db, projectId, slug): DocumentRow | null`, `listDocuments(db, projectId): DocumentSummary[]`, `deleteDocument(db, projectId, slug): boolean`, `searchDocuments(db, query, projectIds: number[] | null, limit?): DocumentSearchHit[]`, `toFtsQuery(q): string`.

- [ ] **Step 1: Write failing tests**

`packages/server/test/repos.projects.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db/connection.js';
import { createProject, getProjectBySlug, listProjects, updateProject, deleteProject } from '../src/repos/projects.js';
import { ConflictError, NotFoundError } from '../src/errors.js';

const input = (slug: string) => ({ slug, name: slug.toUpperCase(), status: 'active' as const, tags: ['wp'], summary: 's' });

describe('projects repo', () => {
  it('creates and reads', () => {
    const db = openDb(':memory:');
    const p = createProject(db, input('alpha'));
    expect(p.id).toBeGreaterThan(0);
    expect(p.tags).toEqual(['wp']);
    expect(getProjectBySlug(db, 'alpha')?.name).toBe('ALPHA');
    expect(getProjectBySlug(db, 'nope')).toBeNull();
  });
  it('rejects duplicate slug', () => {
    const db = openDb(':memory:');
    createProject(db, input('alpha'));
    expect(() => createProject(db, input('alpha'))).toThrow(ConflictError);
  });
  it('lists all or a subset', () => {
    const db = openDb(':memory:');
    const a = createProject(db, input('alpha'));
    createProject(db, input('beta'));
    expect(listProjects(db, null).map((p) => p.slug)).toEqual(['alpha', 'beta']);
    expect(listProjects(db, [a.id]).map((p) => p.slug)).toEqual(['alpha']);
    expect(listProjects(db, [])).toEqual([]);
  });
  it('updates partial fields and bumps updated_at', () => {
    const db = openDb(':memory:');
    const a = createProject(db, input('alpha'));
    const u = updateProject(db, a.id, { status: 'archived', tags: [] });
    expect(u.status).toBe('archived');
    expect(u.tags).toEqual([]);
    expect(u.name).toBe('ALPHA');
    expect(u.updated_at).toBeGreaterThanOrEqual(a.updated_at);
    expect(() => updateProject(db, 999, { name: 'x' })).toThrow(NotFoundError);
  });
  it('deletes', () => {
    const db = openDb(':memory:');
    const a = createProject(db, input('alpha'));
    expect(deleteProject(db, a.id)).toBe(true);
    expect(deleteProject(db, a.id)).toBe(false);
  });
});
```

`packages/server/test/repos.documents.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db/connection.js';
import { createProject } from '../src/repos/projects.js';
import { upsertDocument, getDocument, listDocuments, deleteDocument, searchDocuments, toFtsQuery } from '../src/repos/documents.js';

function setup() {
  const db = openDb(':memory:');
  const p = createProject(db, { slug: 'alpha', name: 'A', status: 'active', tags: [], summary: '' });
  const q = createProject(db, { slug: 'beta', name: 'B', status: 'active', tags: [], summary: '' });
  return { db, p, q };
}

describe('documents repo', () => {
  it('upserts (create then update) and reads project + global docs', () => {
    const { db, p } = setup();
    const c = upsertDocument(db, { projectId: p.id, slug: 'context', title: 'Ctx', category: 'context', body_md: 'v1' });
    expect(c.created).toBe(true);
    const u = upsertDocument(db, { projectId: p.id, slug: 'context', title: 'Ctx2', category: 'context', body_md: 'v2' });
    expect(u.created).toBe(false);
    expect(u.doc.id).toBe(c.doc.id);
    expect(getDocument(db, p.id, 'context')?.body_md).toBe('v2');
    upsertDocument(db, { projectId: null, slug: 'guidelines', title: 'G', category: 'guidelines', body_md: 'global' });
    expect(getDocument(db, null, 'guidelines')?.body_md).toBe('global');
    expect(getDocument(db, p.id, 'guidelines')).toBeNull();
  });
  it('lists summaries without body', () => {
    const { db, p } = setup();
    upsertDocument(db, { projectId: p.id, slug: 'a', title: 'A', category: 'notes', body_md: 'x' });
    const list = listDocuments(db, p.id);
    expect(list).toHaveLength(1);
    expect(list[0]).not.toHaveProperty('body_md');
  });
  it('deletes', () => {
    const { db, p } = setup();
    upsertDocument(db, { projectId: p.id, slug: 'a', title: 'A', category: 'notes', body_md: 'x' });
    expect(deleteDocument(db, p.id, 'a')).toBe(true);
    expect(deleteDocument(db, p.id, 'a')).toBe(false);
  });
  it('searches with project scoping and includes global docs', () => {
    const { db, p, q } = setup();
    upsertDocument(db, { projectId: p.id, slug: 'a', title: 'Deploy', category: 'deploy', body_md: 'uses caddy for tls' });
    upsertDocument(db, { projectId: q.id, slug: 'b', title: 'Deploy', category: 'deploy', body_md: 'uses caddy too' });
    upsertDocument(db, { projectId: null, slug: 'g', title: 'Guide', category: 'guidelines', body_md: 'caddy is the proxy' });
    expect(searchDocuments(db, 'caddy', null)).toHaveLength(3);
    const scoped = searchDocuments(db, 'caddy', [p.id]);
    expect(scoped.map((h) => h.project_id).sort()).toEqual([null, p.id].sort());
    expect(scoped[0]?.snippet).toContain('caddy');
    expect(searchDocuments(db, 'caddy', [])).toHaveLength(1);
  });
  it('does not throw on FTS-special characters', () => {
    const { db } = setup();
    expect(toFtsQuery('a "b" (c) OR')).toBe('"a" "b" "(c)" "OR"');
    expect(searchDocuments(db, '"unbalanced (', null)).toEqual([]);
    expect(searchDocuments(db, '   ', null)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/server/test/repos.projects.test.ts packages/server/test/repos.documents.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement util**

`packages/server/src/repos/util.ts`:
```ts
export function now(): number {
  return Date.now();
}

export function parseJsonArray<T>(s: string | null): T[] {
  if (!s) return [];
  try {
    const v: unknown = JSON.parse(s);
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

export function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE'
  );
}

export function inList(ids: number[]): string {
  return ids.map(() => '?').join(',');
}
```

- [ ] **Step 4: Implement projects repo**

`packages/server/src/repos/projects.ts`:
```ts
import type { ProjectInput, ProjectPatch, ProjectStatus } from '@pidb/shared';
import type { Db } from '../db/connection.js';
import { ConflictError, NotFoundError } from '../errors.js';
import { inList, isUniqueViolation, now, parseJsonArray } from './util.js';

export interface ProjectRow {
  id: number;
  slug: string;
  name: string;
  status: ProjectStatus;
  tags: string[];
  summary: string;
  created_at: number;
  updated_at: number;
}

interface RawProject {
  id: number;
  slug: string;
  name: string;
  status: string;
  tags: string;
  summary: string;
  created_at: number;
  updated_at: number;
}

function toRow(r: RawProject): ProjectRow {
  return { ...r, status: r.status as ProjectStatus, tags: parseJsonArray<string>(r.tags) };
}

const COLS = 'id, slug, name, status, tags, summary, created_at, updated_at';

export function getProjectById(db: Db, id: number): ProjectRow | null {
  const r = db.prepare(`SELECT ${COLS} FROM projects WHERE id = ?`).get(id) as RawProject | undefined;
  return r ? toRow(r) : null;
}

export function getProjectBySlug(db: Db, slug: string): ProjectRow | null {
  const r = db.prepare(`SELECT ${COLS} FROM projects WHERE slug = ?`).get(slug) as RawProject | undefined;
  return r ? toRow(r) : null;
}

export function createProject(db: Db, input: ProjectInput): ProjectRow {
  const ts = now();
  try {
    const info = db
      .prepare(`INSERT INTO projects (slug, name, status, tags, summary, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(input.slug, input.name, input.status, JSON.stringify(input.tags), input.summary, ts, ts);
    return getProjectById(db, Number(info.lastInsertRowid))!;
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConflictError(`project slug "${input.slug}" already exists`);
    throw err;
  }
}

export function listProjects(db: Db, projectIds: number[] | null): ProjectRow[] {
  if (projectIds !== null && projectIds.length === 0) return [];
  const where = projectIds === null ? '' : `WHERE id IN (${inList(projectIds)})`;
  const rows = db.prepare(`SELECT ${COLS} FROM projects ${where} ORDER BY name COLLATE NOCASE`).all(...(projectIds ?? [])) as RawProject[];
  return rows.map(toRow);
}

export function updateProject(db: Db, id: number, patch: ProjectPatch): ProjectRow {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (patch.slug !== undefined) { sets.push('slug = ?'); values.push(patch.slug); }
  if (patch.name !== undefined) { sets.push('name = ?'); values.push(patch.name); }
  if (patch.status !== undefined) { sets.push('status = ?'); values.push(patch.status); }
  if (patch.tags !== undefined) { sets.push('tags = ?'); values.push(JSON.stringify(patch.tags)); }
  if (patch.summary !== undefined) { sets.push('summary = ?'); values.push(patch.summary); }
  sets.push('updated_at = ?');
  values.push(now());
  try {
    const info = db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
    if (info.changes === 0) throw new NotFoundError('project not found');
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConflictError(`project slug "${patch.slug}" already exists`);
    throw err;
  }
  return getProjectById(db, id)!;
}

export function deleteProject(db: Db, id: number): boolean {
  return db.prepare(`DELETE FROM projects WHERE id = ?`).run(id).changes > 0;
}
```

- [ ] **Step 5: Implement documents repo**

`packages/server/src/repos/documents.ts`:
```ts
import type { DocCategory } from '@pidb/shared';
import type { Db } from '../db/connection.js';
import { inList, now } from './util.js';

export interface DocumentRow {
  id: number;
  project_id: number | null;
  slug: string;
  title: string;
  category: DocCategory;
  body_md: string;
  created_at: number;
  updated_at: number;
}
export type DocumentSummary = Omit<DocumentRow, 'body_md'>;
export interface DocumentSearchHit {
  id: number;
  project_id: number | null;
  slug: string;
  title: string;
  category: DocCategory;
  snippet: string;
}

export interface DocumentUpsert {
  projectId: number | null;
  slug: string;
  title: string;
  category: DocCategory;
  body_md: string;
}

const COLS = 'id, project_id, slug, title, category, body_md, created_at, updated_at';

export function getDocument(db: Db, projectId: number | null, slug: string): DocumentRow | null {
  const r = db.prepare(`SELECT ${COLS} FROM documents WHERE project_id IS ? AND slug = ?`).get(projectId, slug) as DocumentRow | undefined;
  return r ?? null;
}

export function upsertDocument(db: Db, input: DocumentUpsert): { doc: DocumentRow; created: boolean } {
  const ts = now();
  const existing = getDocument(db, input.projectId, input.slug);
  if (existing) {
    db.prepare(`UPDATE documents SET title = ?, category = ?, body_md = ?, updated_at = ? WHERE id = ?`).run(
      input.title, input.category, input.body_md, ts, existing.id,
    );
    return { doc: getDocument(db, input.projectId, input.slug)!, created: false };
  }
  db.prepare(`INSERT INTO documents (project_id, slug, title, category, body_md, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    input.projectId, input.slug, input.title, input.category, input.body_md, ts, ts,
  );
  return { doc: getDocument(db, input.projectId, input.slug)!, created: true };
}

export function listDocuments(db: Db, projectId: number | null): DocumentSummary[] {
  return db
    .prepare(`SELECT id, project_id, slug, title, category, created_at, updated_at FROM documents WHERE project_id IS ? ORDER BY category, title COLLATE NOCASE`)
    .all(projectId) as DocumentSummary[];
}

export function deleteDocument(db: Db, projectId: number | null, slug: string): boolean {
  return db.prepare(`DELETE FROM documents WHERE project_id IS ? AND slug = ?`).run(projectId, slug).changes > 0;
}

export function toFtsQuery(q: string): string {
  return q
    .split(/\s+/)
    .map((t) => t.replace(/"/g, ''))
    .filter(Boolean)
    .map((t) => `"${t}"`)
    .join(' ');
}

export function searchDocuments(db: Db, query: string, projectIds: number[] | null, limit = 20): DocumentSearchHit[] {
  const fts = toFtsQuery(query);
  if (!fts) return [];
  const scope = projectIds === null ? '1=1' : projectIds.length === 0 ? 'd.project_id IS NULL' : `(d.project_id IS NULL OR d.project_id IN (${inList(projectIds)}))`;
  const params: unknown[] = [fts, ...(projectIds ?? []), limit];
  return db
    .prepare(
      `SELECT d.id, d.project_id, d.slug, d.title, d.category, snippet(documents_fts, 1, '[', ']', '…', 12) AS snippet
       FROM documents_fts f JOIN documents d ON d.id = f.rowid
       WHERE documents_fts MATCH ? AND ${scope}
       ORDER BY bm25(documents_fts) LIMIT ?`,
    )
    .all(...params) as DocumentSearchHit[];
}
```

- [ ] **Step 6: Run tests**

Run: `npx vitest run packages/server/test/repos.projects.test.ts packages/server/test/repos.documents.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 7: Commit**

```bash
git add packages/server
git commit -m "feat(server): add project and document repositories with FTS search

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Repo — secrets (encrypted)

**Files:**
- Create: `packages/server/src/repos/secrets.ts`
- Test: `packages/server/test/repos.secrets.test.ts`

**Interfaces:**
- Consumes: `KeyRing` (Task 5), envelope functions (Task 7), `defaultSensitive` (Task 1), `SecretInput`/`SecretPatch` (Task 2).
- Produces: `interface SecretFieldMeta { key: string; sensitive: boolean; value?: string }` (value present only when `sensitive === false`), `interface SecretMeta { id; project_id: number | null; name; description; tags: string[]; created_at; updated_at; fields: SecretFieldMeta[] }`, `createSecret(db, ring, { projectId, ...SecretInput }): SecretMeta`, `getSecretMetaById(db, ring, id): SecretMeta | null`, `getSecretMeta(db, ring, projectId, name): SecretMeta | null`, `listSecrets(db, ring, projectId): SecretMeta[]`, `revealField(db, ring, secretId, key): string | null`, `revealAllFields(db, ring, secretId): { key: string; sensitive: boolean; value: string }[]`, `updateSecret(db, ring, id, patch: SecretPatch): SecretMeta`, `deleteSecret(db, projectId, name): boolean`, `searchSecretNames(db, q, projectIds, limit?): { id; project_id; name; tags: string[] }[]`, `rewrapAllSecrets(db, ring): number`.

- [ ] **Step 1: Write failing tests**

`packages/server/test/repos.secrets.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { openDb } from '../src/db/connection.js';
import { createProject } from '../src/repos/projects.js';
import {
  createSecret, getSecretMeta, listSecrets, revealField, revealAllFields, updateSecret, deleteSecret, searchSecretNames, rewrapAllSecrets,
} from '../src/repos/secrets.js';
import { ConflictError, CryptoError } from '../src/errors.js';
import type { KeyRing } from '../src/config.js';

function setup() {
  const db = openDb(':memory:');
  const ring: KeyRing = { current: 1, keys: new Map([[1, randomBytes(32)]]) };
  const p = createProject(db, { slug: 'alpha', name: 'A', status: 'active', tags: [], summary: '' });
  return { db, ring, p };
}
const staging = { name: 'Staging server', description: 'ssh box', tags: ['ssh'], fields: [
  { key: 'host', value: '10.0.0.1' }, { key: 'username', value: 'deploy' }, { key: 'password', value: 'pw-1' },
  { key: 'note', value: 'visible', sensitive: false },
] };

describe('secrets repo', () => {
  it('creates and returns meta with non-sensitive values only', () => {
    const { db, ring, p } = setup();
    const s = createSecret(db, ring, { projectId: p.id, ...staging });
    expect(s.fields).toEqual([
      { key: 'host', sensitive: false, value: '10.0.0.1' },
      { key: 'username', sensitive: false, value: 'deploy' },
      { key: 'password', sensitive: true },
      { key: 'note', sensitive: false, value: 'visible' },
    ]);
    const raw = db.prepare(`SELECT value_enc FROM secret_fields WHERE key = 'password'`).get() as { value_enc: Buffer };
    expect(raw.value_enc.toString('utf8')).not.toContain('pw-1');
  });
  it('enforces unique name per project and allows same name globally', () => {
    const { db, ring, p } = setup();
    createSecret(db, ring, { projectId: p.id, ...staging });
    expect(() => createSecret(db, ring, { projectId: p.id, ...staging })).toThrow(ConflictError);
    expect(createSecret(db, ring, { projectId: null, ...staging }).project_id).toBeNull();
    expect(getSecretMeta(db, ring, null, 'Staging server')).not.toBeNull();
    expect(listSecrets(db, ring, p.id)).toHaveLength(1);
  });
  it('reveals fields', () => {
    const { db, ring, p } = setup();
    const s = createSecret(db, ring, { projectId: p.id, ...staging });
    expect(revealField(db, ring, s.id, 'password')).toBe('pw-1');
    expect(revealField(db, ring, s.id, 'missing')).toBeNull();
    expect(revealAllFields(db, ring, s.id)).toEqual([
      { key: 'host', sensitive: false, value: '10.0.0.1' },
      { key: 'username', sensitive: false, value: 'deploy' },
      { key: 'password', sensitive: true, value: 'pw-1' },
      { key: 'note', sensitive: false, value: 'visible' },
    ]);
  });
  it('updates meta, upserts and removes fields, keeps sensitivity when unspecified', () => {
    const { db, ring, p } = setup();
    const s = createSecret(db, ring, { projectId: p.id, ...staging });
    const u = updateSecret(db, ring, s.id, {
      description: 'new', fields: [{ key: 'password', value: 'pw-2' }, { key: 'note', value: 'v2' }, { key: 'port', value: '22' }], removeFields: ['username'],
    });
    expect(u.description).toBe('new');
    expect(u.fields.map((f) => f.key)).toEqual(['host', 'password', 'note', 'port']);
    expect(u.fields.find((f) => f.key === 'note')).toEqual({ key: 'note', sensitive: false, value: 'v2' });
    expect(u.fields.find((f) => f.key === 'port')).toEqual({ key: 'port', sensitive: false, value: '22' });
    expect(revealField(db, ring, s.id, 'password')).toBe('pw-2');
    expect(revealField(db, ring, s.id, 'username')).toBeNull();
  });
  it('deletes and searches by name', () => {
    const { db, ring, p } = setup();
    createSecret(db, ring, { projectId: p.id, ...staging });
    createSecret(db, ring, { projectId: null, name: 'GitHub PAT', description: '', tags: [], fields: [{ key: 'token', value: 't' }] });
    expect(searchSecretNames(db, 'server', null).map((s) => s.name)).toEqual(['Staging server']);
    expect(searchSecretNames(db, 'git', [p.id]).map((s) => s.name)).toEqual(['GitHub PAT']);
    expect(searchSecretNames(db, 'server', [])).toEqual([]);
    expect(searchSecretNames(db, 'pw-1', null)).toEqual([]);
    expect(deleteSecret(db, p.id, 'Staging server')).toBe(true);
    expect(deleteSecret(db, p.id, 'Staging server')).toBe(false);
  });
  it('rewraps DEKs on key rotation and fails with a missing key', () => {
    const { db, ring, p } = setup();
    const s = createSecret(db, ring, { projectId: p.id, ...staging });
    const ring2: KeyRing = { current: 2, keys: new Map([[1, ring.keys.get(1)!], [2, randomBytes(32)]]) };
    expect(rewrapAllSecrets(db, ring2)).toBe(1);
    expect(rewrapAllSecrets(db, ring2)).toBe(0);
    expect(revealField(db, ring2, s.id, 'password')).toBe('pw-1');
    const ringOnlyNew: KeyRing = { current: 2, keys: new Map([[2, ring2.keys.get(2)!]]) };
    expect(revealField(db, ringOnlyNew, s.id, 'password')).toBe('pw-1');
    expect(() => revealField(db, ring, s.id, 'password')).toThrow(CryptoError);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/server/test/repos.secrets.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/server/src/repos/secrets.ts`:
```ts
import { defaultSensitive, type SecretInput, type SecretPatch } from '@pidb/shared';
import type { Db } from '../db/connection.js';
import type { KeyRing } from '../config.js';
import { decryptField, encryptField, generateDek, unwrapDek, wrapDek } from '../crypto/envelope.js';
import { ConflictError, CryptoError, NotFoundError } from '../errors.js';
import { inList, isUniqueViolation, now, parseJsonArray } from './util.js';

export interface SecretFieldMeta {
  key: string;
  sensitive: boolean;
  value?: string;
}
export interface SecretMeta {
  id: number;
  project_id: number | null;
  name: string;
  description: string;
  tags: string[];
  created_at: number;
  updated_at: number;
  fields: SecretFieldMeta[];
}
export interface RevealedField {
  key: string;
  sensitive: boolean;
  value: string;
}

interface RawSecret {
  id: number;
  project_id: number | null;
  name: string;
  description: string;
  tags: string;
  dek_wrapped: Buffer;
  key_version: number;
  created_at: number;
  updated_at: number;
}
interface RawField {
  key: string;
  value_enc: Buffer;
  is_sensitive: number;
}

const COLS = 'id, project_id, name, description, tags, dek_wrapped, key_version, created_at, updated_at';

function masterKey(ring: KeyRing, version: number): Buffer {
  const k = ring.keys.get(version);
  if (!k) throw new CryptoError(`no master key for version ${version}`);
  return k;
}

function loadDek(ring: KeyRing, row: RawSecret): Buffer {
  return unwrapDek(masterKey(ring, row.key_version), row.dek_wrapped);
}

function rawById(db: Db, id: number): RawSecret | null {
  return (db.prepare(`SELECT ${COLS} FROM secrets WHERE id = ?`).get(id) as RawSecret | undefined) ?? null;
}

function rawFields(db: Db, secretId: number): RawField[] {
  return db.prepare(`SELECT key, value_enc, is_sensitive FROM secret_fields WHERE secret_id = ? ORDER BY sort, id`).all(secretId) as RawField[];
}

function toMeta(db: Db, ring: KeyRing, row: RawSecret): SecretMeta {
  const fields = rawFields(db, row.id);
  const hasPublic = fields.some((f) => f.is_sensitive === 0);
  const dek = hasPublic ? loadDek(ring, row) : null;
  return {
    id: row.id,
    project_id: row.project_id,
    name: row.name,
    description: row.description,
    tags: parseJsonArray<string>(row.tags),
    created_at: row.created_at,
    updated_at: row.updated_at,
    fields: fields.map((f) =>
      f.is_sensitive === 0
        ? { key: f.key, sensitive: false, value: decryptField(dek!, row.id, f.key, f.value_enc) }
        : { key: f.key, sensitive: true },
    ),
  };
}

export function getSecretMetaById(db: Db, ring: KeyRing, id: number): SecretMeta | null {
  const row = rawById(db, id);
  return row ? toMeta(db, ring, row) : null;
}

export function getSecretMeta(db: Db, ring: KeyRing, projectId: number | null, name: string): SecretMeta | null {
  const row = db.prepare(`SELECT ${COLS} FROM secrets WHERE project_id IS ? AND name = ?`).get(projectId, name) as RawSecret | undefined;
  return row ? toMeta(db, ring, row) : null;
}

export function listSecrets(db: Db, ring: KeyRing, projectId: number | null): SecretMeta[] {
  const rows = db.prepare(`SELECT ${COLS} FROM secrets WHERE project_id IS ? ORDER BY name COLLATE NOCASE`).all(projectId) as RawSecret[];
  return rows.map((r) => toMeta(db, ring, r));
}

export function createSecret(db: Db, ring: KeyRing, input: SecretInput & { projectId: number | null }): SecretMeta {
  const dek = generateDek();
  const wrapped = wrapDek(masterKey(ring, ring.current), dek);
  const ts = now();
  return db.transaction(() => {
    let id: number;
    try {
      const info = db
        .prepare(`INSERT INTO secrets (project_id, name, description, tags, dek_wrapped, key_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(input.projectId, input.name, input.description, JSON.stringify(input.tags), wrapped, ring.current, ts, ts);
      id = Number(info.lastInsertRowid);
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictError(`secret "${input.name}" already exists`);
      throw err;
    }
    const ins = db.prepare(`INSERT INTO secret_fields (secret_id, key, value_enc, is_sensitive, sort) VALUES (?, ?, ?, ?, ?)`);
    input.fields.forEach((f, i) => {
      const sensitive = f.sensitive ?? defaultSensitive(f.key);
      ins.run(id, f.key, encryptField(dek, id, f.key, f.value), sensitive ? 1 : 0, i);
    });
    return getSecretMetaById(db, ring, id)!;
  })();
}

export function revealField(db: Db, ring: KeyRing, secretId: number, key: string): string | null {
  const row = rawById(db, secretId);
  if (!row) throw new NotFoundError('secret not found');
  const f = db.prepare(`SELECT key, value_enc, is_sensitive FROM secret_fields WHERE secret_id = ? AND key = ?`).get(secretId, key) as RawField | undefined;
  if (!f) return null;
  return decryptField(loadDek(ring, row), secretId, key, f.value_enc);
}

export function revealAllFields(db: Db, ring: KeyRing, secretId: number): RevealedField[] {
  const row = rawById(db, secretId);
  if (!row) throw new NotFoundError('secret not found');
  const dek = loadDek(ring, row);
  return rawFields(db, secretId).map((f) => ({
    key: f.key,
    sensitive: f.is_sensitive === 1,
    value: decryptField(dek, secretId, f.key, f.value_enc),
  }));
}

export function updateSecret(db: Db, ring: KeyRing, id: number, patch: SecretPatch): SecretMeta {
  return db.transaction(() => {
    const row = rawById(db, id);
    if (!row) throw new NotFoundError('secret not found');
    const sets: string[] = [];
    const values: unknown[] = [];
    if (patch.name !== undefined) { sets.push('name = ?'); values.push(patch.name); }
    if (patch.description !== undefined) { sets.push('description = ?'); values.push(patch.description); }
    if (patch.tags !== undefined) { sets.push('tags = ?'); values.push(JSON.stringify(patch.tags)); }
    sets.push('updated_at = ?');
    values.push(now());
    try {
      db.prepare(`UPDATE secrets SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictError(`secret "${patch.name}" already exists`);
      throw err;
    }
    if (patch.removeFields?.length) {
      const del = db.prepare(`DELETE FROM secret_fields WHERE secret_id = ? AND key = ?`);
      for (const k of patch.removeFields) del.run(id, k);
    }
    if (patch.fields?.length) {
      const dek = loadDek(ring, row);
      const existing = db.prepare(`SELECT key, is_sensitive FROM secret_fields WHERE secret_id = ?`).all(id) as { key: string; is_sensitive: number }[];
      const existingMap = new Map(existing.map((e) => [e.key, e.is_sensitive === 1]));
      let sort = (db.prepare(`SELECT COALESCE(MAX(sort), -1) AS m FROM secret_fields WHERE secret_id = ?`).get(id) as { m: number }).m;
      const upsert = db.prepare(
        `INSERT INTO secret_fields (secret_id, key, value_enc, is_sensitive, sort) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(secret_id, key) DO UPDATE SET value_enc = excluded.value_enc, is_sensitive = excluded.is_sensitive`,
      );
      for (const f of patch.fields) {
        const prior = existingMap.get(f.key);
        const sensitive = f.sensitive ?? prior ?? defaultSensitive(f.key);
        sort += 1;
        upsert.run(id, f.key, encryptField(dek, id, f.key, f.value), sensitive ? 1 : 0, sort);
      }
    }
    return getSecretMetaById(db, ring, id)!;
  })();
}

export function deleteSecret(db: Db, projectId: number | null, name: string): boolean {
  return db.prepare(`DELETE FROM secrets WHERE project_id IS ? AND name = ?`).run(projectId, name).changes > 0;
}

export interface SecretNameHit {
  id: number;
  project_id: number | null;
  name: string;
  tags: string[];
}

export function searchSecretNames(db: Db, q: string, projectIds: number[] | null, limit = 20): SecretNameHit[] {
  const term = q.trim();
  if (!term) return [];
  const like = `%${term.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  const scope = projectIds === null ? '1=1' : projectIds.length === 0 ? 'project_id IS NULL' : `(project_id IS NULL OR project_id IN (${inList(projectIds)}))`;
  const rows = db
    .prepare(`SELECT id, project_id, name, tags FROM secrets WHERE name LIKE ? ESCAPE '\\' AND ${scope} ORDER BY name COLLATE NOCASE LIMIT ?`)
    .all(like, ...(projectIds ?? []), limit) as { id: number; project_id: number | null; name: string; tags: string }[];
  return rows.map((r) => ({ ...r, tags: parseJsonArray<string>(r.tags) }));
}

export function rewrapAllSecrets(db: Db, ring: KeyRing): number {
  const current = masterKey(ring, ring.current);
  const rows = db.prepare(`SELECT ${COLS} FROM secrets WHERE key_version != ?`).all(ring.current) as RawSecret[];
  const upd = db.prepare(`UPDATE secrets SET dek_wrapped = ?, key_version = ? WHERE id = ?`);
  return db.transaction(() => {
    for (const row of rows) {
      const dek = loadDek(ring, row);
      upd.run(wrapDek(current, dek), ring.current, row.id);
    }
    return rows.length;
  })();
}
```
Note: the `sort` for upserted existing fields is bumped on conflict? No — `DO UPDATE` only sets `value_enc` and `is_sensitive`, so existing field order is kept and new fields append. The test expects `['host','password','note','port']`: `username` removed, `password`/`note` keep their original sort, `port` appended. Correct.

- [ ] **Step 4: Run tests**

Run: `npx vitest run packages/server/test/repos.secrets.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/server
git commit -m "feat(server): add encrypted secrets repository with rotation

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Repos — tokens, audit, admin/sessions

**Files:**
- Create: `packages/server/src/repos/tokens.ts`, `packages/server/src/repos/audit.ts`, `packages/server/src/repos/admin.ts`
- Test: `packages/server/test/repos.auth.test.ts`

**Interfaces:**
- Produces (tokens): `interface TokenRow { id; name; prefix; scopes: Scope[]; project_ids: number[] | null; expires_at: number | null; last_used_at: number | null; revoked_at: number | null; created_at }`, `createToken(db, { name, scopes, projectIds, expiresAt }): { token: string; row: TokenRow }`, `findActiveTokenByValue(db, token, nowTs?): TokenRow | null`, `touchToken(db, id, ts?)`, `listTokens(db): TokenRow[]`, `revokeToken(db, id, ts?): boolean`.
- Produces (audit): `interface AuditEntry { actor_type: 'admin' | 'token'; actor_id: number | null; action: string; target_type?: string | null; target_id?: number | null; field_key?: string | null; ip?: string; user_agent?: string; meta?: Record<string, unknown> | null }`, `interface AuditRow extends Required<AuditEntry> { id; ts }`, `writeAudit(db, entry, ts?): number`, `listAudit(db, { limit?, before?, action?, actorType? }): AuditRow[]`.
- Produces (admin): `interface AdminRow { id; username; password_hash; created_at }`, `createAdmin(db, username, passwordHash): AdminRow` (ConflictError if an admin exists), `getAdmin(db): AdminRow | null`, `getAdminByUsername(db, username): AdminRow | null`, `createSession(db, adminId, ttlMs, ip, ua): string`, `getSession(db, id, nowTs?): { id; admin_id; expires_at } | null`, `deleteSession(db, id): boolean`, `purgeExpiredSessions(db, nowTs?): number`.

- [ ] **Step 1: Write failing tests**

`packages/server/test/repos.auth.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db/connection.js';
import { createToken, findActiveTokenByValue, touchToken, listTokens, revokeToken } from '../src/repos/tokens.js';
import { writeAudit, listAudit } from '../src/repos/audit.js';
import { createAdmin, getAdmin, getAdminByUsername, createSession, getSession, deleteSession, purgeExpiredSessions } from '../src/repos/admin.js';
import { ConflictError } from '../src/errors.js';

describe('tokens repo', () => {
  it('creates, finds by value, and hides hash', () => {
    const db = openDb(':memory:');
    const { token, row } = createToken(db, { name: 'cc', scopes: ['docs:read'], projectIds: [1, 2], expiresAt: null });
    expect(token).toMatch(/^pidb_/);
    expect(row).not.toHaveProperty('token_hash');
    expect(row.project_ids).toEqual([1, 2]);
    const found = findActiveTokenByValue(db, token);
    expect(found?.id).toBe(row.id);
    expect(found?.scopes).toEqual(['docs:read']);
    expect(findActiveTokenByValue(db, token.slice(0, -1) + 'x')).toBeNull();
    expect(findActiveTokenByValue(db, 'garbage')).toBeNull();
  });
  it('rejects expired and revoked tokens', () => {
    const db = openDb(':memory:');
    const t1 = createToken(db, { name: 'a', scopes: ['admin'], projectIds: null, expiresAt: 1000 });
    expect(findActiveTokenByValue(db, t1.token, 999)).not.toBeNull();
    expect(findActiveTokenByValue(db, t1.token, 1000)).toBeNull();
    const t2 = createToken(db, { name: 'b', scopes: ['admin'], projectIds: null, expiresAt: null });
    expect(revokeToken(db, t2.row.id)).toBe(true);
    expect(revokeToken(db, t2.row.id)).toBe(false);
    expect(findActiveTokenByValue(db, t2.token)).toBeNull();
    expect(listTokens(db).map((t) => t.name)).toEqual(['a', 'b']);
  });
  it('touches last_used_at', () => {
    const db = openDb(':memory:');
    const { row } = createToken(db, { name: 'a', scopes: ['admin'], projectIds: null, expiresAt: null });
    touchToken(db, row.id, 12345);
    expect(listTokens(db)[0]?.last_used_at).toBe(12345);
  });
});

describe('audit repo', () => {
  it('writes and lists with filters', () => {
    const db = openDb(':memory:');
    writeAudit(db, { actor_type: 'token', actor_id: 1, action: 'secret.reveal', target_type: 'secret', target_id: 5, field_key: 'password', ip: '1.1.1.1', user_agent: 'ua', meta: { x: 1 } }, 100);
    writeAudit(db, { actor_type: 'admin', actor_id: 1, action: 'doc.write' }, 200);
    const all = listAudit(db, {});
    expect(all.map((r) => r.action)).toEqual(['doc.write', 'secret.reveal']);
    expect(all[1]?.meta).toEqual({ x: 1 });
    expect(all[0]?.meta).toBeNull();
    expect(listAudit(db, { action: 'secret.reveal' })).toHaveLength(1);
    expect(listAudit(db, { actorType: 'admin' })).toHaveLength(1);
    expect(listAudit(db, { before: 200 }).map((r) => r.ts)).toEqual([100]);
    expect(listAudit(db, { limit: 1 })).toHaveLength(1);
  });
});

describe('admin repo', () => {
  it('allows exactly one admin', () => {
    const db = openDb(':memory:');
    expect(getAdmin(db)).toBeNull();
    const a = createAdmin(db, 'alex', 'hash');
    expect(getAdminByUsername(db, 'alex')?.id).toBe(a.id);
    expect(() => createAdmin(db, 'other', 'hash')).toThrow(ConflictError);
  });
  it('manages sessions with expiry', () => {
    const db = openDb(':memory:');
    const a = createAdmin(db, 'alex', 'hash');
    const id = createSession(db, a.id, 1000, '1.1.1.1', 'ua');
    expect(id).toHaveLength(64);
    expect(getSession(db, id, Date.now())?.admin_id).toBe(a.id);
    expect(getSession(db, id, Date.now() + 2000)).toBeNull();
    expect(purgeExpiredSessions(db, Date.now() + 2000)).toBe(1);
    expect(deleteSession(db, id)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/server/test/repos.auth.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement tokens repo**

`packages/server/src/repos/tokens.ts`:
```ts
import type { Scope } from '@pidb/shared';
import type { Db } from '../db/connection.js';
import { generateToken, hashToken, hashesEqual, parseTokenPrefix } from '../crypto/tokens.js';
import { now, parseJsonArray } from './util.js';

export interface TokenRow {
  id: number;
  name: string;
  prefix: string;
  scopes: Scope[];
  project_ids: number[] | null;
  expires_at: number | null;
  last_used_at: number | null;
  revoked_at: number | null;
  created_at: number;
}

interface RawToken extends Omit<TokenRow, 'scopes' | 'project_ids'> {
  scopes: string;
  project_ids: string | null;
  token_hash: string;
}

const COLS = 'id, name, prefix, token_hash, scopes, project_ids, expires_at, last_used_at, revoked_at, created_at';

function toRow(r: RawToken): TokenRow {
  const { token_hash: _hash, ...rest } = r;
  return {
    ...rest,
    scopes: parseJsonArray<Scope>(r.scopes),
    project_ids: r.project_ids === null ? null : parseJsonArray<number>(r.project_ids),
  };
}

export function createToken(
  db: Db,
  input: { name: string; scopes: Scope[]; projectIds: number[] | null; expiresAt: number | null },
): { token: string; row: TokenRow } {
  const t = generateToken();
  const info = db
    .prepare(`INSERT INTO api_tokens (name, prefix, token_hash, scopes, project_ids, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(input.name, t.prefix, t.hash, JSON.stringify(input.scopes), input.projectIds === null ? null : JSON.stringify(input.projectIds), input.expiresAt, now());
  const row = db.prepare(`SELECT ${COLS} FROM api_tokens WHERE id = ?`).get(Number(info.lastInsertRowid)) as RawToken;
  return { token: t.token, row: toRow(row) };
}

export function findActiveTokenByValue(db: Db, token: string, nowTs: number = now()): TokenRow | null {
  const prefix = parseTokenPrefix(token);
  if (!prefix) return null;
  const hash = hashToken(token);
  const candidates = db.prepare(`SELECT ${COLS} FROM api_tokens WHERE prefix = ?`).all(prefix) as RawToken[];
  for (const c of candidates) {
    if (!hashesEqual(c.token_hash, hash)) continue;
    if (c.revoked_at !== null) return null;
    if (c.expires_at !== null && c.expires_at <= nowTs) return null;
    return toRow(c);
  }
  return null;
}

export function touchToken(db: Db, id: number, ts: number = now()): void {
  db.prepare(`UPDATE api_tokens SET last_used_at = ? WHERE id = ?`).run(ts, id);
}

export function listTokens(db: Db): TokenRow[] {
  return (db.prepare(`SELECT ${COLS} FROM api_tokens ORDER BY id`).all() as RawToken[]).map(toRow);
}

export function revokeToken(db: Db, id: number, ts: number = now()): boolean {
  return db.prepare(`UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`).run(ts, id).changes > 0;
}
```

- [ ] **Step 4: Implement audit repo**

`packages/server/src/repos/audit.ts`:
```ts
import type { Db } from '../db/connection.js';
import { now } from './util.js';

export interface AuditEntry {
  actor_type: 'admin' | 'token';
  actor_id: number | null;
  action: string;
  target_type?: string | null;
  target_id?: number | null;
  field_key?: string | null;
  ip?: string;
  user_agent?: string;
  meta?: Record<string, unknown> | null;
}

export interface AuditRow {
  id: number;
  ts: number;
  actor_type: 'admin' | 'token';
  actor_id: number | null;
  action: string;
  target_type: string | null;
  target_id: number | null;
  field_key: string | null;
  ip: string;
  user_agent: string;
  meta: Record<string, unknown> | null;
}

export function writeAudit(db: Db, e: AuditEntry, ts: number = now()): number {
  const info = db
    .prepare(
      `INSERT INTO audit_log (ts, actor_type, actor_id, action, target_type, target_id, field_key, ip, user_agent, meta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(ts, e.actor_type, e.actor_id, e.action, e.target_type ?? null, e.target_id ?? null, e.field_key ?? null, e.ip ?? '', e.user_agent ?? '', e.meta ? JSON.stringify(e.meta) : null);
  return Number(info.lastInsertRowid);
}

export interface AuditQuery {
  limit?: number;
  before?: number;
  action?: string;
  actorType?: string;
}

export function listAudit(db: Db, q: AuditQuery): AuditRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.before !== undefined) { where.push('ts < ?'); params.push(q.before); }
  if (q.action) { where.push('action = ?'); params.push(q.action); }
  if (q.actorType) { where.push('actor_type = ?'); params.push(q.actorType); }
  const limit = Math.min(Math.max(q.limit ?? 100, 1), 1000);
  const sql = `SELECT id, ts, actor_type, actor_id, action, target_type, target_id, field_key, ip, user_agent, meta FROM audit_log
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ts DESC, id DESC LIMIT ?`;
  const rows = db.prepare(sql).all(...params, limit) as (Omit<AuditRow, 'meta'> & { meta: string | null })[];
  return rows.map((r) => ({ ...r, meta: r.meta ? (JSON.parse(r.meta) as Record<string, unknown>) : null }));
}
```

- [ ] **Step 5: Implement admin repo**

`packages/server/src/repos/admin.ts`:
```ts
import { randomBytes } from 'node:crypto';
import type { Db } from '../db/connection.js';
import { ConflictError } from '../errors.js';
import { now } from './util.js';

export interface AdminRow {
  id: number;
  username: string;
  password_hash: string;
  created_at: number;
}

export function getAdmin(db: Db): AdminRow | null {
  return (db.prepare(`SELECT id, username, password_hash, created_at FROM admin ORDER BY id LIMIT 1`).get() as AdminRow | undefined) ?? null;
}

export function getAdminByUsername(db: Db, username: string): AdminRow | null {
  return (db.prepare(`SELECT id, username, password_hash, created_at FROM admin WHERE username = ?`).get(username) as AdminRow | undefined) ?? null;
}

export function createAdmin(db: Db, username: string, passwordHash: string): AdminRow {
  if (getAdmin(db)) throw new ConflictError('admin already exists');
  const info = db.prepare(`INSERT INTO admin (username, password_hash, created_at) VALUES (?, ?, ?)`).run(username, passwordHash, now());
  return db.prepare(`SELECT id, username, password_hash, created_at FROM admin WHERE id = ?`).get(Number(info.lastInsertRowid)) as AdminRow;
}

export interface SessionRow {
  id: string;
  admin_id: number;
  expires_at: number;
}

export function createSession(db: Db, adminId: number, ttlMs: number, ip: string, ua: string): string {
  const id = randomBytes(32).toString('hex');
  const ts = now();
  db.prepare(`INSERT INTO sessions (id, admin_id, expires_at, created_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)`).run(id, adminId, ts + ttlMs, ts, ip, ua);
  return id;
}

export function getSession(db: Db, id: string, nowTs: number = now()): SessionRow | null {
  const r = db.prepare(`SELECT id, admin_id, expires_at FROM sessions WHERE id = ?`).get(id) as SessionRow | undefined;
  if (!r || r.expires_at <= nowTs) return null;
  return r;
}

export function deleteSession(db: Db, id: string): boolean {
  return db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id).changes > 0;
}

export function purgeExpiredSessions(db: Db, nowTs: number = now()): number {
  return db.prepare(`DELETE FROM sessions WHERE expires_at <= ?`).run(nowTs).changes;
}
```

- [ ] **Step 6: Run tests**

Run: `npx vitest run packages/server/test/repos.auth.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 7: Commit**

```bash
git add packages/server
git commit -m "feat(server): add token, audit, and admin/session repositories

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: HTTP app skeleton — auth hook, error handler, health, `/me`, test helpers

**Files:**
- Create: `packages/server/src/auth/principal.ts`, `packages/server/src/http/context.ts`, `packages/server/src/http/auth.ts`, `packages/server/src/http/helpers.ts`, `packages/server/src/http/app.ts`, `packages/server/src/http/routes/health.ts`, `packages/server/src/services/common.ts`
- Create: `packages/server/test/helpers.ts`
- Test: `packages/server/test/http.auth.test.ts`

**Interfaces:**
- Produces (principal): `interface Principal { kind: 'admin' | 'token'; id: number; scopes: Scope[]; projectIds: number[] | null }`, `interface Actor { principal: Principal; ip: string; userAgent: string }`, `hasScope(p, scope): boolean`, `assertScope(p, scope): void` (throws `ForbiddenError`), `canAccessProject(p, projectId): boolean`.
- Produces (context): `interface AppContext { db: Db; ring: KeyRing; logLevel?: string; trustProxy?: boolean }`.
- Produces (auth): `registerAuth(app, ctx)`; sets `req.principal` for bearer tokens; routes with `config: { public: true }` skip auth; 20 failed bearer attempts per IP per minute → 429.
- Produces (helpers): `actorOf(req): Actor`, `parseBody<T>(schema, value): T`, `principalOf(req): Principal`.
- Produces (services/common): `loadProjectFor(ctx, principal, slug): ProjectRow` (404 if missing or inaccessible), `auditAs(ctx, actor, entry): void`.
- Produces (app): `buildApp(ctx): Promise<FastifyInstance>`; routes `GET /health` (public) and `GET /api/v1/me`.
- Produces (test helpers): `makeTestApp(): Promise<TestCtx>` with `{ app, db, ring, ctx, token(scopes, projects?), project(slug) }`, `auth(token): { authorization }`.

- [ ] **Step 1: Write failing tests**

`packages/server/test/helpers.ts`:
```ts
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Scope } from '@pidb/shared';
import { openDb, type Db } from '../src/db/connection.js';
import type { KeyRing } from '../src/config.js';
import type { AppContext } from '../src/http/context.js';
import { buildApp } from '../src/http/app.js';
import { createToken } from '../src/repos/tokens.js';
import { createProject, getProjectBySlug, type ProjectRow } from '../src/repos/projects.js';

export interface TestCtx {
  app: FastifyInstance;
  db: Db;
  ring: KeyRing;
  ctx: AppContext;
  token: (scopes: Scope[], projects?: string[] | null) => string;
  project: (slug: string) => ProjectRow;
}

export async function makeTestApp(): Promise<TestCtx> {
  const db = openDb(':memory:');
  const ring: KeyRing = { current: 1, keys: new Map([[1, randomBytes(32)]]) };
  const ctx: AppContext = { db, ring, logLevel: 'silent' };
  const app = await buildApp(ctx);
  return {
    app,
    db,
    ring,
    ctx,
    token: (scopes, projects = null) => {
      const ids = projects === null ? null : projects.map((s) => getProjectBySlug(db, s)!.id);
      return createToken(db, { name: 'test', scopes, projectIds: ids, expiresAt: null }).token;
    },
    project: (slug) => createProject(db, { slug, name: slug.toUpperCase(), status: 'active', tags: [], summary: '' }),
  };
}

export const auth = (token: string) => ({ authorization: `Bearer ${token}` });
```

`packages/server/test/http.auth.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { makeTestApp, auth } from './helpers.js';
import { listAudit } from '../src/repos/audit.js';

describe('http auth', () => {
  it('serves /health without auth', async () => {
    const t = await makeTestApp();
    const r = await t.app.inject({ method: 'GET', url: '/health' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true });
  });
  it('returns 401 for missing, malformed, unknown tokens and audits failures', async () => {
    const t = await makeTestApp();
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/me' })).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/me', headers: { authorization: 'Basic x' } })).statusCode).toBe(401);
    const bad = await t.app.inject({ method: 'GET', url: '/api/v1/me', headers: auth('pidb_AAAAAAAA_' + 'B'.repeat(43)) });
    expect(bad.statusCode).toBe(401);
    expect(bad.json()).toEqual({ error: 'unauthorized', message: 'unauthorized' });
    const audit = listAudit(t.db, { action: 'auth.token_failed' });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.meta).toEqual({ prefix: 'AAAAAAAA' });
  });
  it('returns principal info on /me and touches last_used_at', async () => {
    const t = await makeTestApp();
    t.project('alpha');
    const tok = t.token(['docs:read'], ['alpha']);
    const r = await t.app.inject({ method: 'GET', url: '/api/v1/me', headers: auth(tok) });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ kind: 'token', scopes: ['docs:read'], projects: ['alpha'] });
    const row = t.db.prepare(`SELECT last_used_at FROM api_tokens`).get() as { last_used_at: number | null };
    expect(row.last_used_at).not.toBeNull();
  });
  it('rate limits repeated auth failures per IP', async () => {
    const t = await makeTestApp();
    let last = 0;
    for (let i = 0; i < 21; i++) {
      last = (await t.app.inject({ method: 'GET', url: '/api/v1/me', headers: auth('pidb_AAAAAAAA_' + 'B'.repeat(43)) })).statusCode;
    }
    expect(last).toBe(429);
  });
  it('returns JSON 404 for unknown routes when authenticated', async () => {
    const t = await makeTestApp();
    const r = await t.app.inject({ method: 'GET', url: '/api/v1/nope', headers: auth(t.token(['admin'])) });
    expect(r.statusCode).toBe(404);
    expect(r.json()).toEqual({ error: 'not_found' });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/server/test/http.auth.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement principal + context**

`packages/server/src/auth/principal.ts`:
```ts
import type { Scope } from '@pidb/shared';
import { ForbiddenError } from '../errors.js';

export interface Principal {
  kind: 'admin' | 'token';
  id: number;
  scopes: Scope[];
  projectIds: number[] | null;
}

export interface Actor {
  principal: Principal;
  ip: string;
  userAgent: string;
}

export function hasScope(p: Principal, scope: Scope): boolean {
  return p.scopes.includes('admin') || p.scopes.includes(scope);
}

export function assertScope(p: Principal, scope: Scope): void {
  if (!hasScope(p, scope)) throw new ForbiddenError(scope);
}

export function canAccessProject(p: Principal, projectId: number): boolean {
  return p.projectIds === null || p.projectIds.includes(projectId);
}
```

`packages/server/src/http/context.ts`:
```ts
import type { Db } from '../db/connection.js';
import type { KeyRing } from '../config.js';

export interface AppContext {
  db: Db;
  ring: KeyRing;
  logLevel?: string;
  trustProxy?: boolean;
}
```

- [ ] **Step 4: Implement auth hook**

`packages/server/src/http/auth.ts`:
```ts
import type { FastifyInstance } from 'fastify';
import { AppError, UnauthorizedError } from '../errors.js';
import type { Principal } from '../auth/principal.js';
import { findActiveTokenByValue, touchToken } from '../repos/tokens.js';
import { writeAudit } from '../repos/audit.js';
import { parseTokenPrefix } from '../crypto/tokens.js';
import type { AppContext } from './context.js';

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null;
  }
  interface FastifyContextConfig {
    public?: boolean;
  }
}

export class FailureLimiter {
  private hits = new Map<string, number[]>();
  constructor(
    private readonly max = 20,
    private readonly windowMs = 60_000,
  ) {}
  private prune(ip: string, ts: number): number[] {
    const list = (this.hits.get(ip) ?? []).filter((t) => ts - t < this.windowMs);
    this.hits.set(ip, list);
    return list;
  }
  record(ip: string, ts = Date.now()): void {
    this.prune(ip, ts).push(ts);
  }
  isBlocked(ip: string, ts = Date.now()): boolean {
    return this.prune(ip, ts).length >= this.max;
  }
}

const BEARER_RE = /^Bearer\s+(\S+)$/i;

export function registerAuth(app: FastifyInstance, ctx: AppContext): void {
  const limiter = new FailureLimiter();
  app.decorateRequest('principal', null);
  app.addHook('onRequest', async (req) => {
    if (req.routeOptions.config.public) return;
    if (req.principal) return; // set by an earlier resolver (e.g. admin session, Plan 3)
    const ip = req.ip;
    if (limiter.isBlocked(ip)) throw new AppError(429, 'rate_limited', 'too many failed authentication attempts');
    const m = BEARER_RE.exec(req.headers.authorization ?? '');
    const token = m?.[1];
    if (!token) throw new UnauthorizedError();
    const row = findActiveTokenByValue(ctx.db, token);
    if (!row) {
      limiter.record(ip);
      writeAudit(ctx.db, {
        actor_type: 'token',
        actor_id: null,
        action: 'auth.token_failed',
        ip,
        user_agent: req.headers['user-agent'] ?? '',
        meta: { prefix: parseTokenPrefix(token) },
      });
      throw new UnauthorizedError();
    }
    touchToken(ctx.db, row.id);
    req.principal = { kind: 'token', id: row.id, scopes: row.scopes, projectIds: row.project_ids };
  });
}
```

- [ ] **Step 5: Implement helpers + services/common**

`packages/server/src/http/helpers.ts`:
```ts
import type { FastifyRequest } from 'fastify';
import type { ZodType } from 'zod';
import type { Actor, Principal } from '../auth/principal.js';
import { UnauthorizedError, ValidationError } from '../errors.js';

export function principalOf(req: FastifyRequest): Principal {
  if (!req.principal) throw new UnauthorizedError();
  return req.principal;
}

export function actorOf(req: FastifyRequest): Actor {
  return { principal: principalOf(req), ip: req.ip, userAgent: req.headers['user-agent'] ?? '' };
}

export function parseBody<T>(schema: ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value ?? {});
  if (!r.success) throw new ValidationError(r.error.issues);
  return r.data;
}
```

`packages/server/src/services/common.ts`:
```ts
import type { AppContext } from '../http/context.js';
import { canAccessProject, type Actor, type Principal } from '../auth/principal.js';
import { NotFoundError } from '../errors.js';
import { getProjectBySlug, type ProjectRow } from '../repos/projects.js';
import { writeAudit, type AuditEntry } from '../repos/audit.js';

export function loadProjectFor(ctx: AppContext, principal: Principal, slug: string): ProjectRow {
  const project = getProjectBySlug(ctx.db, slug);
  if (!project || !canAccessProject(principal, project.id)) throw new NotFoundError('project not found');
  return project;
}

export type AuditInput = Omit<AuditEntry, 'actor_type' | 'actor_id' | 'ip' | 'user_agent'>;

export function auditAs(ctx: AppContext, actor: Actor, entry: AuditInput): void {
  writeAudit(ctx.db, {
    ...entry,
    actor_type: actor.principal.kind,
    actor_id: actor.principal.id,
    ip: actor.ip,
    user_agent: actor.userAgent,
  });
}
```

- [ ] **Step 6: Implement app + health + me**

`packages/server/src/http/routes/health.ts`:
```ts
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { principalOf } from '../helpers.js';
import { listProjects } from '../../repos/projects.js';

export function registerHealthRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/health', { config: { public: true } }, async () => ({ ok: true }));

  app.get('/api/v1/me', async (req) => {
    const p = principalOf(req);
    return {
      kind: p.kind,
      scopes: p.scopes,
      projects: p.projectIds === null ? null : listProjects(ctx.db, p.projectIds).map((x) => x.slug),
    };
  });
}
```

`packages/server/src/http/app.ts`:
```ts
import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { AppError } from '../errors.js';
import type { AppContext } from './context.js';
import { registerAuth } from './auth.js';
import { registerHealthRoutes } from './routes/health.js';

export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: ctx.logLevel ?? 'info', redact: ['req.headers.authorization', 'req.headers.cookie'] },
    trustProxy: ctx.trustProxy ?? false,
  });

  await app.register(rateLimit, { global: false });
  registerAuth(app, ctx);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.status).send({ error: err.code, message: err.message, ...err.details });
    }
    const e = err as { statusCode?: number; message?: string };
    if (e.statusCode && e.statusCode < 500) {
      return reply.status(e.statusCode).send({ error: 'bad_request', message: e.message ?? 'bad request' });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({ error: 'internal' });
  });
  app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: 'not_found' }));

  registerHealthRoutes(app, ctx);
  return app;
}
```
Later tasks add one `registerXRoutes(app, ctx)` line each after `registerHealthRoutes`.

- [ ] **Step 7: Run tests**

Run: `npx vitest run packages/server/test/http.auth.test.ts`
Expected: PASS (5 tests). If `req.routeOptions.config.public` fails typecheck, the `FastifyContextConfig` module augmentation in `auth.ts` must be picked up — ensure `auth.ts` is imported by `app.ts` (it is).

- [ ] **Step 8: Commit**

```bash
git add packages/server
git commit -m "feat(server): add fastify app with bearer auth, error handler, health

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: Projects service + routes

**Files:**
- Create: `packages/server/src/http/serialize.ts`, `packages/server/src/services/projects.ts`, `packages/server/src/http/routes/projects.ts`
- Modify: `packages/server/src/http/app.ts` (register routes)
- Test: `packages/server/test/http.projects.test.ts`

**Interfaces:**
- Produces (serialize): `PublicProject { slug; name; status; tags; summary; created_at; updated_at }`, `publicProject(row)`, `PublicDocSummary { slug; title; category; created_at; updated_at }`, `publicDocSummary(row)`, `PublicDoc extends PublicDocSummary { body_md }`, `publicDoc(row)`, `PublicSecret { name; description; tags; fields: SecretFieldMeta[]; created_at; updated_at }`, `publicSecret(meta)`.
- Produces (services/projects): `listProjectsFor(ctx, principal): PublicProject[]`, `getProjectDetailFor(ctx, principal, slug): PublicProject & { documents: PublicDocSummary[]; secrets: PublicSecret[] }`, `createProjectFor(ctx, actor, input): PublicProject`, `updateProjectFor(ctx, actor, slug, patch): PublicProject`, `deleteProjectFor(ctx, actor, slug): void`.
- Routes: `GET /api/v1/projects`, `GET /api/v1/projects/:slug`, `POST /api/v1/projects` (201), `PATCH /api/v1/projects/:slug`, `DELETE /api/v1/projects/:slug` (204).

- [ ] **Step 1: Write failing tests**

`packages/server/test/http.projects.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { makeTestApp, auth } from './helpers.js';
import { createSecret } from '../src/repos/secrets.js';
import { upsertDocument } from '../src/repos/documents.js';
import { listAudit } from '../src/repos/audit.js';

describe('projects routes', () => {
  it('lists only accessible projects', async () => {
    const t = await makeTestApp();
    t.project('alpha');
    t.project('beta');
    const r = await t.app.inject({ method: 'GET', url: '/api/v1/projects', headers: auth(t.token(['projects:read'], ['alpha'])) });
    expect(r.statusCode).toBe(200);
    expect(r.json().map((p: { slug: string }) => p.slug)).toEqual(['alpha']);
    expect(r.json()[0]).not.toHaveProperty('id');
    const all = await t.app.inject({ method: 'GET', url: '/api/v1/projects', headers: auth(t.token(['projects:read'])) });
    expect(all.json()).toHaveLength(2);
  });
  it('requires projects:read', async () => {
    const t = await makeTestApp();
    const r = await t.app.inject({ method: 'GET', url: '/api/v1/projects', headers: auth(t.token(['docs:read'])) });
    expect(r.statusCode).toBe(403);
    expect(r.json()).toMatchObject({ error: 'missing_scope', scope: 'projects:read' });
  });
  it('returns 404 for unknown and out-of-scope projects alike', async () => {
    const t = await makeTestApp();
    t.project('alpha');
    t.project('beta');
    const tok = t.token(['projects:read'], ['alpha']);
    const a = await t.app.inject({ method: 'GET', url: '/api/v1/projects/beta', headers: auth(tok) });
    const b = await t.app.inject({ method: 'GET', url: '/api/v1/projects/zzz', headers: auth(tok) });
    expect(a.statusCode).toBe(404);
    expect(b.statusCode).toBe(404);
    expect(a.json()).toEqual(b.json());
  });
  it('returns detail with docs and secret meta depending on scopes', async () => {
    const t = await makeTestApp();
    const p = t.project('alpha');
    upsertDocument(t.db, { projectId: p.id, slug: 'context', title: 'Ctx', category: 'context', body_md: 'hello' });
    createSecret(t.db, t.ring, { projectId: p.id, name: 'Staging', description: '', tags: [], fields: [{ key: 'host', value: 'h' }, { key: 'password', value: 'p' }] });
    const full = await t.app.inject({ method: 'GET', url: '/api/v1/projects/alpha', headers: auth(t.token(['projects:read', 'docs:read', 'secrets:meta'])) });
    const body = full.json();
    expect(body.documents).toEqual([expect.objectContaining({ slug: 'context', title: 'Ctx' })]);
    expect(body.documents[0]).not.toHaveProperty('body_md');
    expect(body.secrets[0].fields).toEqual([{ key: 'host', sensitive: false, value: 'h' }, { key: 'password', sensitive: true }]);
    expect(JSON.stringify(body)).not.toContain('"p"');
    const minimal = await t.app.inject({ method: 'GET', url: '/api/v1/projects/alpha', headers: auth(t.token(['projects:read'])) });
    expect(minimal.json().documents).toEqual([]);
    expect(minimal.json().secrets).toEqual([]);
  });
  it('creates, updates, deletes with admin scope and audits', async () => {
    const t = await makeTestApp();
    const admin = auth(t.token(['admin']));
    const c = await t.app.inject({ method: 'POST', url: '/api/v1/projects', headers: admin, payload: { slug: 'gamma', name: 'Gamma', tags: ['x'] } });
    expect(c.statusCode).toBe(201);
    expect(c.json()).toMatchObject({ slug: 'gamma', status: 'active', tags: ['x'] });
    const dup = await t.app.inject({ method: 'POST', url: '/api/v1/projects', headers: admin, payload: { slug: 'gamma', name: 'Gamma' } });
    expect(dup.statusCode).toBe(409);
    const bad = await t.app.inject({ method: 'POST', url: '/api/v1/projects', headers: admin, payload: { slug: 'Bad Slug', name: 'x' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('validation');
    const u = await t.app.inject({ method: 'PATCH', url: '/api/v1/projects/gamma', headers: admin, payload: { status: 'paused' } });
    expect(u.json().status).toBe('paused');
    const d = await t.app.inject({ method: 'DELETE', url: '/api/v1/projects/gamma', headers: admin });
    expect(d.statusCode).toBe(204);
    expect(listAudit(t.db, {}).map((a) => a.action)).toEqual(['project.delete', 'project.update', 'project.create']);
    const noAdmin = await t.app.inject({ method: 'POST', url: '/api/v1/projects', headers: auth(t.token(['secrets:write'])), payload: { slug: 'z', name: 'z' } });
    expect(noAdmin.statusCode).toBe(403);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/server/test/http.projects.test.ts`
Expected: FAIL — routes return 404.

- [ ] **Step 3: Implement serializers**

`packages/server/src/http/serialize.ts`:
```ts
import type { DocCategory, ProjectStatus } from '@pidb/shared';
import type { ProjectRow } from '../repos/projects.js';
import type { DocumentRow, DocumentSummary } from '../repos/documents.js';
import type { SecretFieldMeta, SecretMeta } from '../repos/secrets.js';

export interface PublicProject {
  slug: string;
  name: string;
  status: ProjectStatus;
  tags: string[];
  summary: string;
  created_at: number;
  updated_at: number;
}
export function publicProject(p: ProjectRow): PublicProject {
  return { slug: p.slug, name: p.name, status: p.status, tags: p.tags, summary: p.summary, created_at: p.created_at, updated_at: p.updated_at };
}

export interface PublicDocSummary {
  slug: string;
  title: string;
  category: DocCategory;
  created_at: number;
  updated_at: number;
}
export function publicDocSummary(d: DocumentSummary): PublicDocSummary {
  return { slug: d.slug, title: d.title, category: d.category, created_at: d.created_at, updated_at: d.updated_at };
}

export interface PublicDoc extends PublicDocSummary {
  body_md: string;
}
export function publicDoc(d: DocumentRow): PublicDoc {
  return { ...publicDocSummary(d), body_md: d.body_md };
}

export interface PublicSecret {
  name: string;
  description: string;
  tags: string[];
  fields: SecretFieldMeta[];
  created_at: number;
  updated_at: number;
}
export function publicSecret(s: SecretMeta): PublicSecret {
  return { name: s.name, description: s.description, tags: s.tags, fields: s.fields, created_at: s.created_at, updated_at: s.updated_at };
}
```

- [ ] **Step 4: Implement service**

`packages/server/src/services/projects.ts`:
```ts
import type { ProjectInput, ProjectPatch } from '@pidb/shared';
import type { AppContext } from '../http/context.js';
import { assertScope, hasScope, type Actor, type Principal } from '../auth/principal.js';
import { createProject, deleteProject, listProjects, updateProject } from '../repos/projects.js';
import { listDocuments } from '../repos/documents.js';
import { listSecrets } from '../repos/secrets.js';
import { publicDocSummary, publicProject, publicSecret, type PublicDocSummary, type PublicProject, type PublicSecret } from '../http/serialize.js';
import { auditAs, loadProjectFor } from './common.js';

export interface ProjectDetail extends PublicProject {
  documents: PublicDocSummary[];
  secrets: PublicSecret[];
}

export function listProjectsFor(ctx: AppContext, principal: Principal): PublicProject[] {
  assertScope(principal, 'projects:read');
  return listProjects(ctx.db, principal.projectIds).map(publicProject);
}

export function getProjectDetailFor(ctx: AppContext, principal: Principal, slug: string): ProjectDetail {
  assertScope(principal, 'projects:read');
  const project = loadProjectFor(ctx, principal, slug);
  return {
    ...publicProject(project),
    documents: hasScope(principal, 'docs:read') ? listDocuments(ctx.db, project.id).map(publicDocSummary) : [],
    secrets: hasScope(principal, 'secrets:meta') ? listSecrets(ctx.db, ctx.ring, project.id).map(publicSecret) : [],
  };
}

export function createProjectFor(ctx: AppContext, actor: Actor, input: ProjectInput): PublicProject {
  assertScope(actor.principal, 'admin');
  const project = createProject(ctx.db, input);
  auditAs(ctx, actor, { action: 'project.create', target_type: 'project', target_id: project.id });
  return publicProject(project);
}

export function updateProjectFor(ctx: AppContext, actor: Actor, slug: string, patch: ProjectPatch): PublicProject {
  assertScope(actor.principal, 'admin');
  const project = loadProjectFor(ctx, actor.principal, slug);
  const updated = updateProject(ctx.db, project.id, patch);
  auditAs(ctx, actor, { action: 'project.update', target_type: 'project', target_id: project.id, meta: { fields: Object.keys(patch) } });
  return publicProject(updated);
}

export function deleteProjectFor(ctx: AppContext, actor: Actor, slug: string): void {
  assertScope(actor.principal, 'admin');
  const project = loadProjectFor(ctx, actor.principal, slug);
  deleteProject(ctx.db, project.id);
  auditAs(ctx, actor, { action: 'project.delete', target_type: 'project', target_id: project.id, meta: { slug } });
}
```

- [ ] **Step 5: Implement routes and register**

`packages/server/src/http/routes/projects.ts`:
```ts
import type { FastifyInstance } from 'fastify';
import { projectInputSchema, projectPatchSchema } from '@pidb/shared';
import type { AppContext } from '../context.js';
import { actorOf, parseBody, principalOf } from '../helpers.js';
import { createProjectFor, deleteProjectFor, getProjectDetailFor, listProjectsFor, updateProjectFor } from '../../services/projects.js';

type SlugParams = { Params: { slug: string } };

export function registerProjectRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/v1/projects', async (req) => listProjectsFor(ctx, principalOf(req)));

  app.get<SlugParams>('/api/v1/projects/:slug', async (req) => getProjectDetailFor(ctx, principalOf(req), req.params.slug));

  app.post('/api/v1/projects', async (req, reply) => {
    const input = parseBody(projectInputSchema, req.body);
    return reply.status(201).send(createProjectFor(ctx, actorOf(req), input));
  });

  app.patch<SlugParams>('/api/v1/projects/:slug', async (req) => {
    const patch = parseBody(projectPatchSchema, req.body);
    return updateProjectFor(ctx, actorOf(req), req.params.slug, patch);
  });

  app.delete<SlugParams>('/api/v1/projects/:slug', async (req, reply) => {
    deleteProjectFor(ctx, actorOf(req), req.params.slug);
    return reply.status(204).send();
  });
}
```

In `packages/server/src/http/app.ts` add `import { registerProjectRoutes } from './routes/projects.js';` and call `registerProjectRoutes(app, ctx);` right after `registerHealthRoutes(app, ctx);`.

- [ ] **Step 6: Run tests**

Run: `npx vitest run packages/server/test/http.projects.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 7: Commit**

```bash
git add packages/server
git commit -m "feat(server): add project service and REST routes

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 13: Documents service + routes + search

**Files:**
- Create: `packages/server/src/services/documents.ts`, `packages/server/src/services/search.ts`, `packages/server/src/http/routes/documents.ts`, `packages/server/src/http/routes/search.ts`
- Modify: `packages/server/src/http/app.ts`
- Test: `packages/server/test/http.documents.test.ts`

**Interfaces:**
- Produces (services/documents): `resolveDocScope(ctx, principal, projectSlug: string | null): ProjectRow | null`, `interface ResolvedRef { ref: string; name: string; project: string | null; fields: { key; sensitive }[] }`, `resolveRefs(ctx, principal, project: ProjectRow | null, md): { resolved: ResolvedRef[]; unresolved: string[] }`, `listDocumentsFor(ctx, principal, projectSlug): PublicDocSummary[]`, `readDocumentFor(ctx, principal, projectSlug, slug, withRefs: boolean): PublicDoc & { refs?: ResolvedRef[] }`, `writeDocumentFor(ctx, actor, projectSlug, slug, input: DocumentInput): { doc: PublicDoc; created: boolean }`, `deleteDocumentFor(ctx, actor, projectSlug, slug): void`.
- Produces (services/search): `searchFor(ctx, principal, q): { projects?: PublicProject[]; documents?: { project: string | null; slug; title; category; snippet }[]; secrets?: { project: string | null; name; tags }[] }`.
- Routes: `GET|PUT|DELETE /api/v1/docs[/:doc]`, `GET|PUT|DELETE /api/v1/projects/:slug/docs[/:doc]`, `GET /api/v1/search?q=`.

- [ ] **Step 1: Write failing tests**

`packages/server/test/http.documents.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { makeTestApp, auth } from './helpers.js';
import { createSecret } from '../src/repos/secrets.js';
import { listAudit } from '../src/repos/audit.js';

const doc = (body_md: string, extra: Record<string, unknown> = {}) => ({ title: 'Deploy', category: 'deploy', body_md, ...extra });

describe('documents routes', () => {
  it('creates (201) then updates (200) a project doc and reads it back', async () => {
    const t = await makeTestApp();
    t.project('alpha');
    const tok = auth(t.token(['docs:read', 'docs:write'], ['alpha']));
    const c = await t.app.inject({ method: 'PUT', url: '/api/v1/projects/alpha/docs/deploy', headers: tok, payload: doc('v1') });
    expect(c.statusCode).toBe(201);
    const u = await t.app.inject({ method: 'PUT', url: '/api/v1/projects/alpha/docs/deploy', headers: tok, payload: doc('v2') });
    expect(u.statusCode).toBe(200);
    const g = await t.app.inject({ method: 'GET', url: '/api/v1/projects/alpha/docs/deploy', headers: tok });
    expect(g.json()).toMatchObject({ slug: 'deploy', title: 'Deploy', category: 'deploy', body_md: 'v2' });
    const l = await t.app.inject({ method: 'GET', url: '/api/v1/projects/alpha/docs', headers: tok });
    expect(l.json()).toEqual([expect.objectContaining({ slug: 'deploy' })]);
    expect(listAudit(t.db, { action: 'doc.write' })).toHaveLength(2);
  });
  it('handles global docs and 404s', async () => {
    const t = await makeTestApp();
    const tok = auth(t.token(['docs:read', 'docs:write']));
    expect((await t.app.inject({ method: 'PUT', url: '/api/v1/docs/guidelines', headers: tok, payload: doc('g', { category: 'guidelines' }) })).statusCode).toBe(201);
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/docs/guidelines', headers: tok })).json().body_md).toBe('g');
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/docs/nope', headers: tok })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'DELETE', url: '/api/v1/docs/guidelines', headers: tok })).statusCode).toBe(204);
    expect((await t.app.inject({ method: 'DELETE', url: '/api/v1/docs/guidelines', headers: tok })).statusCode).toBe(404);
  });
  it('enforces scopes and project access', async () => {
    const t = await makeTestApp();
    t.project('alpha');
    t.project('beta');
    const ro = auth(t.token(['docs:read'], ['alpha']));
    expect((await t.app.inject({ method: 'PUT', url: '/api/v1/projects/alpha/docs/x', headers: ro, payload: doc('v') })).statusCode).toBe(403);
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/projects/beta/docs', headers: ro })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'PUT', url: '/api/v1/projects/alpha/docs/Bad', headers: auth(t.token(['docs:write'])), payload: doc('v') })).statusCode).toBe(400);
  });
  it('rejects secret-looking content with 422 unless forced, and audits the force', async () => {
    const t = await makeTestApp();
    t.project('alpha');
    const tok = auth(t.token(['docs:write'], ['alpha']));
    const r = await t.app.inject({ method: 'PUT', url: '/api/v1/projects/alpha/docs/x', headers: tok, payload: doc('password: Tr0ub4dor&3') });
    expect(r.statusCode).toBe(422);
    expect(r.json()).toMatchObject({ error: 'lint', findings: [{ line: 1, reason: 'credential assignment' }] });
    const f = await t.app.inject({ method: 'PUT', url: '/api/v1/projects/alpha/docs/x', headers: tok, payload: doc('password: Tr0ub4dor&3', { force: true }) });
    expect(f.statusCode).toBe(201);
    expect(listAudit(t.db, { action: 'doc.write' })[0]?.meta).toEqual({ lint_forced: true, unresolved_refs: 0 });
  });
  it('validates secret refs and returns ref meta on ?resolve=meta', async () => {
    const t = await makeTestApp();
    const p = t.project('alpha');
    t.project('beta');
    createSecret(t.db, t.ring, { projectId: p.id, name: 'Staging server', description: '', tags: [], fields: [{ key: 'host', value: 'h' }, { key: 'password', value: 'p' }] });
    createSecret(t.db, t.ring, { projectId: null, name: 'GitHub PAT', description: '', tags: [], fields: [{ key: 'token', value: 't' }] });
    const tok = auth(t.token(['docs:read', 'docs:write', 'secrets:meta'], ['alpha']));
    const bad = await t.app.inject({ method: 'PUT', url: '/api/v1/projects/alpha/docs/x', headers: tok, payload: doc('{{secret:Nope}} {{secret:beta/X}}') });
    expect(bad.statusCode).toBe(422);
    expect(bad.json()).toEqual({ error: 'unresolved_refs', message: 'unresolved_refs', unresolved: ['{{secret:Nope}}', '{{secret:beta/X}}'] });
    const ok = await t.app.inject({ method: 'PUT', url: '/api/v1/projects/alpha/docs/x', headers: tok, payload: doc('ssh via {{secret:Staging server}}, push with {{secret:global/GitHub PAT}}') });
    expect(ok.statusCode).toBe(201);
    const g = await t.app.inject({ method: 'GET', url: '/api/v1/projects/alpha/docs/x?resolve=meta', headers: tok });
    expect(g.json().refs).toEqual([
      { ref: '{{secret:Staging server}}', name: 'Staging server', project: 'alpha', fields: [{ key: 'host', sensitive: false }, { key: 'password', sensitive: true }] },
      { ref: '{{secret:global/GitHub PAT}}', name: 'GitHub PAT', project: null, fields: [{ key: 'token', sensitive: true }] },
    ]);
    expect(JSON.stringify(g.json())).not.toContain('"h"');
  });
});

describe('search route', () => {
  it('searches per scope and never matches secret values', async () => {
    const t = await makeTestApp();
    const p = t.project('alpha');
    t.project('beta');
    await t.app.inject({ method: 'PUT', url: '/api/v1/projects/alpha/docs/d', headers: auth(t.token(['docs:write'])), payload: doc('deploy with caddy') });
    createSecret(t.db, t.ring, { projectId: p.id, name: 'Caddy admin', description: '', tags: ['web'], fields: [{ key: 'password', value: 'caddy-secret-value' }] });
    const full = await t.app.inject({ method: 'GET', url: '/api/v1/search?q=caddy', headers: auth(t.token(['projects:read', 'docs:read', 'secrets:meta'], ['alpha'])) });
    expect(full.json()).toEqual({
      projects: [],
      documents: [{ project: 'alpha', slug: 'd', title: 'Deploy', category: 'deploy', snippet: expect.stringContaining('caddy') }],
      secrets: [{ project: 'alpha', name: 'Caddy admin', tags: ['web'] }],
    });
    const none = await t.app.inject({ method: 'GET', url: '/api/v1/search?q=caddy-secret-value', headers: auth(t.token(['admin'])) });
    expect(none.json().secrets).toEqual([]);
    const docsOnly = await t.app.inject({ method: 'GET', url: '/api/v1/search?q=caddy', headers: auth(t.token(['docs:read'])) });
    expect(Object.keys(docsOnly.json())).toEqual(['documents']);
    const byName = await t.app.inject({ method: 'GET', url: '/api/v1/search?q=alp', headers: auth(t.token(['projects:read'])) });
    expect(byName.json().projects.map((x: { slug: string }) => x.slug)).toEqual(['alpha']);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/server/test/http.documents.test.ts`
Expected: FAIL — 404s.

- [ ] **Step 3: Implement documents service**

`packages/server/src/services/documents.ts`:
```ts
import { docSlugSchema, lintForSecrets, parseSecretRefs, type DocumentInput } from '@pidb/shared';
import type { AppContext } from '../http/context.js';
import { assertScope, canAccessProject, type Actor, type Principal } from '../auth/principal.js';
import { NotFoundError, UnprocessableError, ValidationError } from '../errors.js';
import { getProjectBySlug, type ProjectRow } from '../repos/projects.js';
import { deleteDocument, getDocument, listDocuments, upsertDocument } from '../repos/documents.js';
import { getSecretMeta } from '../repos/secrets.js';
import { publicDoc, publicDocSummary, type PublicDoc, type PublicDocSummary } from '../http/serialize.js';
import { auditAs, loadProjectFor } from './common.js';

export interface ResolvedRef {
  ref: string;
  name: string;
  project: string | null;
  fields: { key: string; sensitive: boolean }[];
}

export function resolveDocScope(ctx: AppContext, principal: Principal, projectSlug: string | null): ProjectRow | null {
  return projectSlug === null ? null : loadProjectFor(ctx, principal, projectSlug);
}

export function resolveRefs(
  ctx: AppContext,
  principal: Principal,
  project: ProjectRow | null,
  md: string,
): { resolved: ResolvedRef[]; unresolved: string[] } {
  const resolved: ResolvedRef[] = [];
  const unresolved: string[] = [];
  for (const ref of parseSecretRefs(md)) {
    let projectId: number | null;
    let projectSlug: string | null;
    if (ref.global) {
      projectId = null;
      projectSlug = null;
    } else if (ref.project !== null) {
      const p = getProjectBySlug(ctx.db, ref.project);
      if (!p || !canAccessProject(principal, p.id)) {
        unresolved.push(ref.raw);
        continue;
      }
      projectId = p.id;
      projectSlug = p.slug;
    } else {
      projectId = project?.id ?? null;
      projectSlug = project?.slug ?? null;
    }
    const s = getSecretMeta(ctx.db, ctx.ring, projectId, ref.name);
    if (!s) {
      unresolved.push(ref.raw);
      continue;
    }
    resolved.push({ ref: ref.raw, name: s.name, project: projectSlug, fields: s.fields.map((f) => ({ key: f.key, sensitive: f.sensitive })) });
  }
  return { resolved, unresolved };
}

function validSlug(slug: string): string {
  const r = docSlugSchema.safeParse(slug);
  if (!r.success) throw new ValidationError(r.error.issues);
  return r.data;
}

export function listDocumentsFor(ctx: AppContext, principal: Principal, projectSlug: string | null): PublicDocSummary[] {
  assertScope(principal, 'docs:read');
  const project = resolveDocScope(ctx, principal, projectSlug);
  return listDocuments(ctx.db, project?.id ?? null).map(publicDocSummary);
}

export function readDocumentFor(
  ctx: AppContext,
  principal: Principal,
  projectSlug: string | null,
  slug: string,
  withRefs: boolean,
): PublicDoc & { refs?: ResolvedRef[] } {
  assertScope(principal, 'docs:read');
  const project = resolveDocScope(ctx, principal, projectSlug);
  const doc = getDocument(ctx.db, project?.id ?? null, slug);
  if (!doc) throw new NotFoundError('document not found');
  const out: PublicDoc & { refs?: ResolvedRef[] } = publicDoc(doc);
  if (withRefs) out.refs = resolveRefs(ctx, principal, project, doc.body_md).resolved;
  return out;
}

export function writeDocumentFor(
  ctx: AppContext,
  actor: Actor,
  projectSlug: string | null,
  slug: string,
  input: DocumentInput,
): { doc: PublicDoc; created: boolean } {
  assertScope(actor.principal, 'docs:write');
  const project = resolveDocScope(ctx, actor.principal, projectSlug);
  const cleanSlug = validSlug(slug);
  const findings = lintForSecrets(input.body_md);
  const { unresolved } = resolveRefs(ctx, actor.principal, project, input.body_md);
  if (!input.force) {
    if (findings.length) throw new UnprocessableError('lint', { findings });
    if (unresolved.length) throw new UnprocessableError('unresolved_refs', { unresolved });
  }
  const { doc, created } = upsertDocument(ctx.db, {
    projectId: project?.id ?? null,
    slug: cleanSlug,
    title: input.title,
    category: input.category,
    body_md: input.body_md,
  });
  const forced = input.force && (findings.length > 0 || unresolved.length > 0);
  auditAs(ctx, actor, {
    action: 'doc.write',
    target_type: 'document',
    target_id: doc.id,
    meta: forced ? { lint_forced: findings.length > 0, unresolved_refs: unresolved.length } : null,
  });
  return { doc: publicDoc(doc), created };
}

export function deleteDocumentFor(ctx: AppContext, actor: Actor, projectSlug: string | null, slug: string): void {
  assertScope(actor.principal, 'docs:write');
  const project = resolveDocScope(ctx, actor.principal, projectSlug);
  const doc = getDocument(ctx.db, project?.id ?? null, slug);
  if (!doc) throw new NotFoundError('document not found');
  deleteDocument(ctx.db, project?.id ?? null, slug);
  auditAs(ctx, actor, { action: 'doc.delete', target_type: 'document', target_id: doc.id, meta: { slug } });
}
```

- [ ] **Step 4: Implement search service**

`packages/server/src/services/search.ts`:
```ts
import type { AppContext } from '../http/context.js';
import { hasScope, type Principal } from '../auth/principal.js';
import { getProjectById, listProjects } from '../repos/projects.js';
import { searchDocuments } from '../repos/documents.js';
import { searchSecretNames } from '../repos/secrets.js';
import { publicProject, type PublicProject } from '../http/serialize.js';

export interface SearchResult {
  projects?: PublicProject[];
  documents?: { project: string | null; slug: string; title: string; category: string; snippet: string }[];
  secrets?: { project: string | null; name: string; tags: string[] }[];
}

export function searchFor(ctx: AppContext, principal: Principal, q: string): SearchResult {
  const term = q.trim().toLowerCase();
  const out: SearchResult = {};
  const slugCache = new Map<number, string | null>();
  const slugOf = (id: number | null): string | null => {
    if (id === null) return null;
    if (!slugCache.has(id)) slugCache.set(id, getProjectById(ctx.db, id)?.slug ?? null);
    return slugCache.get(id) ?? null;
  };
  if (hasScope(principal, 'projects:read')) {
    out.projects = term
      ? listProjects(ctx.db, principal.projectIds)
          .filter((p) => p.slug.includes(term) || p.name.toLowerCase().includes(term) || p.tags.some((t) => t.toLowerCase().includes(term)))
          .map(publicProject)
      : [];
  }
  if (hasScope(principal, 'docs:read')) {
    out.documents = searchDocuments(ctx.db, q, principal.projectIds).map((h) => ({
      project: slugOf(h.project_id), slug: h.slug, title: h.title, category: h.category, snippet: h.snippet,
    }));
  }
  if (hasScope(principal, 'secrets:meta')) {
    out.secrets = searchSecretNames(ctx.db, q, principal.projectIds).map((s) => ({ project: slugOf(s.project_id), name: s.name, tags: s.tags }));
  }
  return out;
}
```

- [ ] **Step 5: Implement routes and register**

`packages/server/src/http/routes/documents.ts`:
```ts
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { documentInputSchema } from '@pidb/shared';
import type { AppContext } from '../context.js';
import { actorOf, parseBody, principalOf } from '../helpers.js';
import { deleteDocumentFor, listDocumentsFor, readDocumentFor, writeDocumentFor } from '../../services/documents.js';

type DocParams = { Params: { slug?: string; doc: string }; Querystring: { resolve?: string } };

export function registerDocumentRoutes(app: FastifyInstance, ctx: AppContext): void {
  const prefixes: { base: string; projectOf: (req: FastifyRequest<DocParams>) => string | null }[] = [
    { base: '/api/v1/docs', projectOf: () => null },
    { base: '/api/v1/projects/:slug/docs', projectOf: (req) => req.params.slug ?? null },
  ];

  for (const { base, projectOf } of prefixes) {
    app.get<DocParams>(base, async (req) => listDocumentsFor(ctx, principalOf(req), projectOf(req)));

    app.get<DocParams>(`${base}/:doc`, async (req) =>
      readDocumentFor(ctx, principalOf(req), projectOf(req), req.params.doc, req.query.resolve === 'meta'),
    );

    app.put<DocParams>(`${base}/:doc`, async (req, reply) => {
      const input = parseBody(documentInputSchema, req.body);
      const { doc, created } = writeDocumentFor(ctx, actorOf(req), projectOf(req), req.params.doc, input);
      return reply.status(created ? 201 : 200).send(doc);
    });

    app.delete<DocParams>(`${base}/:doc`, async (req, reply) => {
      deleteDocumentFor(ctx, actorOf(req), projectOf(req), req.params.doc);
      return reply.status(204).send();
    });
  }
}
```

`packages/server/src/http/routes/search.ts`:
```ts
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { principalOf } from '../helpers.js';
import { searchFor } from '../../services/search.js';

export function registerSearchRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get<{ Querystring: { q?: string } }>('/api/v1/search', async (req) => searchFor(ctx, principalOf(req), req.query.q ?? ''));
}
```

In `app.ts` import and call `registerDocumentRoutes(app, ctx);` and `registerSearchRoutes(app, ctx);` after `registerProjectRoutes`.

- [ ] **Step 6: Run tests**

Run: `npx vitest run packages/server/test/http.documents.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 7: Commit**

```bash
git add packages/server
git commit -m "feat(server): add document routes with lint, ref validation, and search

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 14: Secrets service + routes (reveal + audit)

**Files:**
- Create: `packages/server/src/services/secrets.ts`, `packages/server/src/http/routes/secrets.ts`
- Modify: `packages/server/src/http/app.ts`
- Test: `packages/server/test/http.secrets.test.ts`

**Interfaces:**
- Produces (services/secrets): `listSecretsFor(ctx, principal, projectSlug): PublicSecret[]`, `getSecretFor(ctx, principal, projectSlug, name): PublicSecret`, `revealFieldFor(ctx, actor, projectSlug, name, key): string` (checks sensitivity → scope; audits sensitive reveal), `revealAllFor(ctx, actor, projectSlug, name): { name; fields: Record<string, string> }` (requires `secrets:reveal`, one audit row per sensitive field), `createSecretFor(ctx, actor, projectSlug, input): PublicSecret`, `updateSecretFor(ctx, actor, projectSlug, name, patch): PublicSecret`, `deleteSecretFor(ctx, actor, projectSlug, name): void`.
- Routes (both `/api/v1/secrets` and `/api/v1/projects/:slug/secrets`): `GET`, `GET /:name`, `GET /:name/fields`, `GET /:name/fields/:key` (JSON `{ key, value }` or `text/plain` when `Accept: text/plain`), `POST` (201), `PATCH /:name`, `DELETE /:name` (204).

- [ ] **Step 1: Write failing tests**

`packages/server/test/http.secrets.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { makeTestApp, auth } from './helpers.js';
import { listAudit } from '../src/repos/audit.js';

const staging = { name: 'Staging server', description: 'box', tags: ['ssh'], fields: [{ key: 'host', value: '10.0.0.1' }, { key: 'password', value: 'pw-1' }, { key: 'private_key', value: 'KEYDATA' }] };

describe('secrets routes', () => {
  it('creates and lists meta without sensitive values', async () => {
    const t = await makeTestApp();
    t.project('alpha');
    const w = auth(t.token(['secrets:write', 'secrets:meta'], ['alpha']));
    const c = await t.app.inject({ method: 'POST', url: '/api/v1/projects/alpha/secrets', headers: w, payload: staging });
    expect(c.statusCode).toBe(201);
    expect(c.json().fields).toEqual([{ key: 'host', sensitive: false, value: '10.0.0.1' }, { key: 'password', sensitive: true }, { key: 'private_key', sensitive: true }]);
    expect(JSON.stringify(c.json())).not.toContain('pw-1');
    const l = await t.app.inject({ method: 'GET', url: '/api/v1/projects/alpha/secrets', headers: w });
    expect(l.json()).toHaveLength(1);
    const one = await t.app.inject({ method: 'GET', url: '/api/v1/projects/alpha/secrets/Staging%20server', headers: w });
    expect(one.json().name).toBe('Staging server');
    expect((await t.app.inject({ method: 'POST', url: '/api/v1/projects/alpha/secrets', headers: w, payload: staging })).statusCode).toBe(409);
    expect((await t.app.inject({ method: 'POST', url: '/api/v1/projects/alpha/secrets', headers: w, payload: { name: 'x', fields: [{ key: 'port', value: 22 }] } })).statusCode).toBe(400);
  });
  it('reveals a sensitive field only with secrets:reveal and audits it', async () => {
    const t = await makeTestApp();
    t.project('alpha');
    await t.app.inject({ method: 'POST', url: '/api/v1/projects/alpha/secrets', headers: auth(t.token(['secrets:write'])), payload: staging });
    const meta = auth(t.token(['secrets:meta'], ['alpha']));
    const reveal = auth(t.token(['secrets:reveal'], ['alpha']));
    const denied = await t.app.inject({ method: 'GET', url: '/api/v1/projects/alpha/secrets/Staging%20server/fields/password', headers: meta });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().scope).toBe('secrets:reveal');
    const host = await t.app.inject({ method: 'GET', url: '/api/v1/projects/alpha/secrets/Staging%20server/fields/host', headers: meta });
    expect(host.json()).toEqual({ key: 'host', value: '10.0.0.1' });
    const pw = await t.app.inject({ method: 'GET', url: '/api/v1/projects/alpha/secrets/Staging%20server/fields/password', headers: reveal });
    expect(pw.json()).toEqual({ key: 'password', value: 'pw-1' });
    const plain = await t.app.inject({ method: 'GET', url: '/api/v1/projects/alpha/secrets/Staging%20server/fields/password', headers: { ...reveal, accept: 'text/plain' } });
    expect(plain.headers['content-type']).toContain('text/plain');
    expect(plain.body).toBe('pw-1');
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/projects/alpha/secrets/Staging%20server/fields/nope', headers: reveal })).statusCode).toBe(404);
    const audits = listAudit(t.db, { action: 'secret.reveal' });
    expect(audits).toHaveLength(2);
    expect(audits.map((a) => a.field_key)).toEqual(['password', 'password']);
    expect(audits[0]?.actor_type).toBe('token');
  });
  it('reveals all fields with one audit row per sensitive field', async () => {
    const t = await makeTestApp();
    t.project('alpha');
    await t.app.inject({ method: 'POST', url: '/api/v1/projects/alpha/secrets', headers: auth(t.token(['secrets:write'])), payload: staging });
    const r = await t.app.inject({ method: 'GET', url: '/api/v1/projects/alpha/secrets/Staging%20server/fields', headers: auth(t.token(['secrets:reveal'], ['alpha'])) });
    expect(r.json()).toEqual({ name: 'Staging server', fields: { host: '10.0.0.1', password: 'pw-1', private_key: 'KEYDATA' } });
    expect(listAudit(t.db, { action: 'secret.reveal' }).map((a) => a.field_key).sort()).toEqual(['password', 'private_key']);
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/projects/alpha/secrets/Staging%20server/fields', headers: auth(t.token(['secrets:meta'])) })).statusCode).toBe(403);
  });
  it('updates and deletes with secrets:write, global secrets work', async () => {
    const t = await makeTestApp();
    const w = auth(t.token(['secrets:write', 'secrets:reveal']));
    expect((await t.app.inject({ method: 'POST', url: '/api/v1/secrets', headers: w, payload: { name: 'GitHub PAT', fields: [{ key: 'token', value: 't1' }] } })).statusCode).toBe(201);
    const u = await t.app.inject({ method: 'PATCH', url: '/api/v1/secrets/GitHub%20PAT', headers: w, payload: { fields: [{ key: 'token', value: 't2' }, { key: 'url', value: 'https://github.com' }], description: 'd' } });
    expect(u.statusCode).toBe(200);
    expect(u.json().fields).toEqual([{ key: 'token', sensitive: true }, { key: 'url', sensitive: false, value: 'https://github.com' }]);
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/secrets/GitHub%20PAT/fields/token', headers: w })).json().value).toBe('t2');
    expect((await t.app.inject({ method: 'DELETE', url: '/api/v1/secrets/GitHub%20PAT', headers: w })).statusCode).toBe(204);
    expect((await t.app.inject({ method: 'DELETE', url: '/api/v1/secrets/GitHub%20PAT', headers: w })).statusCode).toBe(404);
    expect(listAudit(t.db, {}).map((a) => a.action)).toEqual(['secret.delete', 'secret.reveal', 'secret.update', 'secret.create']);
  });
  it('hides out-of-scope projects as 404', async () => {
    const t = await makeTestApp();
    t.project('alpha');
    t.project('beta');
    const r = await t.app.inject({ method: 'GET', url: '/api/v1/projects/beta/secrets', headers: auth(t.token(['secrets:meta'], ['alpha'])) });
    expect(r.statusCode).toBe(404);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/server/test/http.secrets.test.ts`
Expected: FAIL — 404s.

- [ ] **Step 3: Implement service**

`packages/server/src/services/secrets.ts`:
```ts
import type { SecretInput, SecretPatch } from '@pidb/shared';
import type { AppContext } from '../http/context.js';
import { assertScope, type Actor, type Principal } from '../auth/principal.js';
import { NotFoundError } from '../errors.js';
import type { ProjectRow } from '../repos/projects.js';
import { createSecret, deleteSecret, getSecretMeta, listSecrets, revealAllFields, revealField, updateSecret, type SecretMeta } from '../repos/secrets.js';
import { publicSecret, type PublicSecret } from '../http/serialize.js';
import { auditAs, loadProjectFor } from './common.js';

function scopeProject(ctx: AppContext, principal: Principal, projectSlug: string | null): ProjectRow | null {
  return projectSlug === null ? null : loadProjectFor(ctx, principal, projectSlug);
}

function mustGet(ctx: AppContext, projectId: number | null, name: string): SecretMeta {
  const s = getSecretMeta(ctx.db, ctx.ring, projectId, name);
  if (!s) throw new NotFoundError('secret not found');
  return s;
}

export function listSecretsFor(ctx: AppContext, principal: Principal, projectSlug: string | null): PublicSecret[] {
  assertScope(principal, 'secrets:meta');
  const project = scopeProject(ctx, principal, projectSlug);
  return listSecrets(ctx.db, ctx.ring, project?.id ?? null).map(publicSecret);
}

export function getSecretFor(ctx: AppContext, principal: Principal, projectSlug: string | null, name: string): PublicSecret {
  assertScope(principal, 'secrets:meta');
  const project = scopeProject(ctx, principal, projectSlug);
  return publicSecret(mustGet(ctx, project?.id ?? null, name));
}

export function revealFieldFor(ctx: AppContext, actor: Actor, projectSlug: string | null, name: string, key: string): string {
  const project = scopeProject(ctx, actor.principal, projectSlug);
  const secret = mustGet(ctx, project?.id ?? null, name);
  const field = secret.fields.find((f) => f.key === key);
  if (!field) throw new NotFoundError('field not found');
  assertScope(actor.principal, field.sensitive ? 'secrets:reveal' : 'secrets:meta');
  const value = revealField(ctx.db, ctx.ring, secret.id, key);
  if (value === null) throw new NotFoundError('field not found');
  if (field.sensitive) auditAs(ctx, actor, { action: 'secret.reveal', target_type: 'secret', target_id: secret.id, field_key: key });
  return value;
}

export function revealAllFor(ctx: AppContext, actor: Actor, projectSlug: string | null, name: string): { name: string; fields: Record<string, string> } {
  assertScope(actor.principal, 'secrets:reveal');
  const project = scopeProject(ctx, actor.principal, projectSlug);
  const secret = mustGet(ctx, project?.id ?? null, name);
  const fields: Record<string, string> = {};
  for (const f of revealAllFields(ctx.db, ctx.ring, secret.id)) {
    fields[f.key] = f.value;
    if (f.sensitive) auditAs(ctx, actor, { action: 'secret.reveal', target_type: 'secret', target_id: secret.id, field_key: f.key });
  }
  return { name: secret.name, fields };
}

export function createSecretFor(ctx: AppContext, actor: Actor, projectSlug: string | null, input: SecretInput): PublicSecret {
  assertScope(actor.principal, 'secrets:write');
  const project = scopeProject(ctx, actor.principal, projectSlug);
  const s = createSecret(ctx.db, ctx.ring, { ...input, projectId: project?.id ?? null });
  auditAs(ctx, actor, { action: 'secret.create', target_type: 'secret', target_id: s.id, meta: { name: s.name, keys: s.fields.map((f) => f.key) } });
  return publicSecret(s);
}

export function updateSecretFor(ctx: AppContext, actor: Actor, projectSlug: string | null, name: string, patch: SecretPatch): PublicSecret {
  assertScope(actor.principal, 'secrets:write');
  const project = scopeProject(ctx, actor.principal, projectSlug);
  const existing = mustGet(ctx, project?.id ?? null, name);
  const s = updateSecret(ctx.db, ctx.ring, existing.id, patch);
  auditAs(ctx, actor, {
    action: 'secret.update',
    target_type: 'secret',
    target_id: s.id,
    meta: { fields: patch.fields?.map((f) => f.key) ?? [], removed: patch.removeFields ?? [], meta: Object.keys(patch).filter((k) => k !== 'fields' && k !== 'removeFields') },
  });
  return publicSecret(s);
}

export function deleteSecretFor(ctx: AppContext, actor: Actor, projectSlug: string | null, name: string): void {
  assertScope(actor.principal, 'secrets:write');
  const project = scopeProject(ctx, actor.principal, projectSlug);
  const existing = mustGet(ctx, project?.id ?? null, name);
  deleteSecret(ctx.db, project?.id ?? null, name);
  auditAs(ctx, actor, { action: 'secret.delete', target_type: 'secret', target_id: existing.id, meta: { name } });
}
```

- [ ] **Step 4: Implement routes and register**

`packages/server/src/http/routes/secrets.ts`:
```ts
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { secretInputSchema, secretPatchSchema } from '@pidb/shared';
import type { AppContext } from '../context.js';
import { actorOf, parseBody, principalOf } from '../helpers.js';
import { createSecretFor, deleteSecretFor, getSecretFor, listSecretsFor, revealAllFor, revealFieldFor, updateSecretFor } from '../../services/secrets.js';

type P = { Params: { slug?: string; name: string; key: string } };

export function registerSecretRoutes(app: FastifyInstance, ctx: AppContext): void {
  const prefixes: { base: string; projectOf: (req: FastifyRequest<P>) => string | null }[] = [
    { base: '/api/v1/secrets', projectOf: () => null },
    { base: '/api/v1/projects/:slug/secrets', projectOf: (req) => req.params.slug ?? null },
  ];

  for (const { base, projectOf } of prefixes) {
    app.get<P>(base, async (req) => listSecretsFor(ctx, principalOf(req), projectOf(req)));

    app.get<P>(`${base}/:name`, async (req) => getSecretFor(ctx, principalOf(req), projectOf(req), req.params.name));

    app.get<P>(`${base}/:name/fields`, async (req) => revealAllFor(ctx, actorOf(req), projectOf(req), req.params.name));

    app.get<P>(`${base}/:name/fields/:key`, async (req, reply) => {
      const value = revealFieldFor(ctx, actorOf(req), projectOf(req), req.params.name, req.params.key);
      if ((req.headers.accept ?? '').includes('text/plain')) return reply.type('text/plain; charset=utf-8').send(value);
      return { key: req.params.key, value };
    });

    app.post<P>(base, async (req, reply) => {
      const input = parseBody(secretInputSchema, req.body);
      return reply.status(201).send(createSecretFor(ctx, actorOf(req), projectOf(req), input));
    });

    app.patch<P>(`${base}/:name`, async (req) => {
      const patch = parseBody(secretPatchSchema, req.body);
      return updateSecretFor(ctx, actorOf(req), projectOf(req), req.params.name, patch);
    });

    app.delete<P>(`${base}/:name`, async (req, reply) => {
      deleteSecretFor(ctx, actorOf(req), projectOf(req), req.params.name);
      return reply.status(204).send();
    });
  }
}
```

In `app.ts` add `registerSecretRoutes(app, ctx);` after the document routes.

- [ ] **Step 5: Run tests**

Run: `npx vitest run packages/server/test/http.secrets.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/server
git commit -m "feat(server): add secret routes with scoped reveal and audit logging

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 15: Admin routes — tokens, audit log, password → token exchange

**Files:**
- Create: `packages/server/src/services/admin.ts`, `packages/server/src/http/routes/admin.ts`
- Modify: `packages/server/src/http/app.ts`
- Test: `packages/server/test/http.admin.test.ts`

**Interfaces:**
- Produces (services/admin): `listTokensFor(ctx, principal): PublicToken[]`, `createTokenFor(ctx, actor, input: TokenInput): PublicToken & { token: string }`, `revokeTokenFor(ctx, actor, id): void`, `listAuditFor(ctx, principal, query): AuditRow[]`, `exchangePassword(ctx, { username, password, name }, ip, ua): Promise<{ token: string; id: number; name: string } | null>`.
- `PublicToken { id; name; prefix; scopes; projects: string[] | null; expires_at; last_used_at; revoked_at; created_at }`.
- Routes: `GET /api/v1/tokens`, `POST /api/v1/tokens` (201, includes `token` once), `DELETE /api/v1/tokens/:id` (204), `GET /api/v1/audit?limit&before&action&actor`, `POST /api/v1/auth/token` (public, rate-limited 5/min, 201 or 401).

- [ ] **Step 1: Write failing tests**

`packages/server/test/http.admin.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { makeTestApp, auth } from './helpers.js';
import { createAdmin } from '../src/repos/admin.js';
import { hashPassword } from '../src/crypto/passwords.js';
import { listAudit } from '../src/repos/audit.js';

describe('admin routes', () => {
  it('creates, lists, revokes tokens (admin only) with project slugs', async () => {
    const t = await makeTestApp();
    t.project('alpha');
    const admin = auth(t.token(['admin']));
    const c = await t.app.inject({ method: 'POST', url: '/api/v1/tokens', headers: admin, payload: { name: 'cc', scopes: ['docs:read', 'secrets:reveal'], projects: ['alpha'] } });
    expect(c.statusCode).toBe(201);
    expect(c.json().token).toMatch(/^pidb_/);
    expect(c.json().projects).toEqual(['alpha']);
    const bad = await t.app.inject({ method: 'POST', url: '/api/v1/tokens', headers: admin, payload: { name: 'cc', scopes: ['docs:read'], projects: ['nope'] } });
    expect(bad.statusCode).toBe(400);
    const l = await t.app.inject({ method: 'GET', url: '/api/v1/tokens', headers: admin });
    expect(l.json().map((x: { name: string }) => x.name)).toEqual(['test', 'cc']);
    expect(JSON.stringify(l.json())).not.toContain('pidb_');
    const useNew = await t.app.inject({ method: 'GET', url: '/api/v1/projects/alpha/docs', headers: auth(c.json().token) });
    expect(useNew.statusCode).toBe(200);
    const d = await t.app.inject({ method: 'DELETE', url: `/api/v1/tokens/${c.json().id}`, headers: admin });
    expect(d.statusCode).toBe(204);
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/projects/alpha/docs', headers: auth(c.json().token) })).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'DELETE', url: `/api/v1/tokens/${c.json().id}`, headers: admin })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/tokens', headers: auth(t.token(['secrets:reveal'])) })).statusCode).toBe(403);
  });
  it('lists audit with filters', async () => {
    const t = await makeTestApp();
    const admin = auth(t.token(['admin']));
    await t.app.inject({ method: 'POST', url: '/api/v1/projects', headers: admin, payload: { slug: 'a', name: 'A' } });
    const r = await t.app.inject({ method: 'GET', url: '/api/v1/audit?action=project.create&limit=5', headers: admin });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual([expect.objectContaining({ action: 'project.create', actor_type: 'token' })]);
  });
  it('exchanges admin password for an admin token', async () => {
    const t = await makeTestApp();
    createAdmin(t.db, 'alex', await hashPassword('correct horse'));
    const bad = await t.app.inject({ method: 'POST', url: '/api/v1/auth/token', payload: { username: 'alex', password: 'wrong' } });
    expect(bad.statusCode).toBe(401);
    const ok = await t.app.inject({ method: 'POST', url: '/api/v1/auth/token', payload: { username: 'alex', password: 'correct horse', name: 'cli-mac' } });
    expect(ok.statusCode).toBe(201);
    const me = await t.app.inject({ method: 'GET', url: '/api/v1/me', headers: auth(ok.json().token) });
    expect(me.json()).toEqual({ kind: 'token', scopes: ['admin'], projects: null });
    expect(listAudit(t.db, {}).map((a) => a.action)).toEqual(['auth.login', 'auth.login_failed']);
    expect(listAudit(t.db, { action: 'auth.login' })[0]?.actor_type).toBe('admin');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/server/test/http.admin.test.ts`
Expected: FAIL — 404s.

- [ ] **Step 3: Implement service**

`packages/server/src/services/admin.ts`:
```ts
import type { AuthTokenRequest, TokenInput } from '@pidb/shared';
import type { AppContext } from '../http/context.js';
import { assertScope, type Actor, type Principal } from '../auth/principal.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { createToken, listTokens, revokeToken, type TokenRow } from '../repos/tokens.js';
import { getProjectBySlug, listProjects } from '../repos/projects.js';
import { listAudit, writeAudit, type AuditQuery, type AuditRow } from '../repos/audit.js';
import { getAdminByUsername } from '../repos/admin.js';
import { verifyPassword } from '../crypto/passwords.js';
import { auditAs } from './common.js';

export interface PublicToken {
  id: number;
  name: string;
  prefix: string;
  scopes: TokenRow['scopes'];
  projects: string[] | null;
  expires_at: number | null;
  last_used_at: number | null;
  revoked_at: number | null;
  created_at: number;
}

function publicToken(ctx: AppContext, t: TokenRow): PublicToken {
  const { project_ids, ...rest } = t;
  return { ...rest, projects: project_ids === null ? null : listProjects(ctx.db, project_ids).map((p) => p.slug) };
}

export function listTokensFor(ctx: AppContext, principal: Principal): PublicToken[] {
  assertScope(principal, 'admin');
  return listTokens(ctx.db).map((t) => publicToken(ctx, t));
}

export function createTokenFor(ctx: AppContext, actor: Actor, input: TokenInput): PublicToken & { token: string } {
  assertScope(actor.principal, 'admin');
  let projectIds: number[] | null = null;
  if (input.projects !== null) {
    projectIds = [];
    for (const slug of input.projects) {
      const p = getProjectBySlug(ctx.db, slug);
      if (!p) throw new ValidationError([{ path: ['projects'], message: `unknown project "${slug}"` }]);
      projectIds.push(p.id);
    }
  }
  const { token, row } = createToken(ctx.db, { name: input.name, scopes: input.scopes, projectIds, expiresAt: input.expires_at });
  auditAs(ctx, actor, { action: 'token.create', target_type: 'token', target_id: row.id, meta: { name: row.name, scopes: row.scopes } });
  return { ...publicToken(ctx, row), token };
}

export function revokeTokenFor(ctx: AppContext, actor: Actor, id: number): void {
  assertScope(actor.principal, 'admin');
  if (!revokeToken(ctx.db, id)) throw new NotFoundError('token not found');
  auditAs(ctx, actor, { action: 'token.revoke', target_type: 'token', target_id: id });
}

export function listAuditFor(ctx: AppContext, principal: Principal, query: AuditQuery): AuditRow[] {
  assertScope(principal, 'admin');
  return listAudit(ctx.db, query);
}

export async function exchangePassword(
  ctx: AppContext,
  input: AuthTokenRequest,
  ip: string,
  userAgent: string,
): Promise<{ token: string; id: number; name: string } | null> {
  const admin = getAdminByUsername(ctx.db, input.username);
  const ok = admin ? await verifyPassword(admin.password_hash, input.password) : false;
  if (!admin || !ok) {
    writeAudit(ctx.db, { actor_type: 'admin', actor_id: admin?.id ?? null, action: 'auth.login_failed', ip, user_agent: userAgent, meta: { username: input.username } });
    return null;
  }
  const { token, row } = createToken(ctx.db, { name: input.name, scopes: ['admin'], projectIds: null, expiresAt: null });
  writeAudit(ctx.db, { actor_type: 'admin', actor_id: admin.id, action: 'auth.login', target_type: 'token', target_id: row.id, ip, user_agent: userAgent, meta: { name: row.name } });
  return { token, id: row.id, name: row.name };
}
```

- [ ] **Step 4: Implement routes and register**

`packages/server/src/http/routes/admin.ts`:
```ts
import type { FastifyInstance } from 'fastify';
import { authTokenRequestSchema, tokenInputSchema } from '@pidb/shared';
import type { AppContext } from '../context.js';
import { actorOf, parseBody, principalOf } from '../helpers.js';
import { UnauthorizedError, ValidationError } from '../../errors.js';
import { createTokenFor, exchangePassword, listAuditFor, listTokensFor, revokeTokenFor } from '../../services/admin.js';

type AuditQs = { Querystring: { limit?: string; before?: string; action?: string; actor?: string } };

function optInt(v: string | undefined, name: string): number | undefined {
  if (v === undefined) return undefined;
  if (!/^\d+$/.test(v)) throw new ValidationError([{ path: [name], message: 'must be an integer' }]);
  return Number.parseInt(v, 10);
}

export function registerAdminRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/v1/tokens', async (req) => listTokensFor(ctx, principalOf(req)));

  app.post('/api/v1/tokens', async (req, reply) => {
    const input = parseBody(tokenInputSchema, req.body);
    return reply.status(201).send(createTokenFor(ctx, actorOf(req), input));
  });

  app.delete<{ Params: { id: string } }>('/api/v1/tokens/:id', async (req, reply) => {
    const id = optInt(req.params.id, 'id') ?? -1;
    revokeTokenFor(ctx, actorOf(req), id);
    return reply.status(204).send();
  });

  app.get<AuditQs>('/api/v1/audit', async (req) =>
    listAuditFor(ctx, principalOf(req), {
      limit: optInt(req.query.limit, 'limit'),
      before: optInt(req.query.before, 'before'),
      action: req.query.action,
      actorType: req.query.actor,
    }),
  );

  app.post(
    '/api/v1/auth/token',
    { config: { public: true, rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const input = parseBody(authTokenRequestSchema, req.body);
      const result = await exchangePassword(ctx, input, req.ip, req.headers['user-agent'] ?? '');
      if (!result) throw new UnauthorizedError('invalid credentials');
      return reply.status(201).send(result);
    },
  );
}
```

In `app.ts` add `registerAdminRoutes(app, ctx);`.

- [ ] **Step 5: Run tests**

Run: `npx vitest run packages/server/test/http.admin.test.ts`
Expected: PASS (3 tests). Then run the whole suite: `npx vitest run` → all PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server
git commit -m "feat(server): add token management, audit listing, and password exchange

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 16: MCP endpoint (Streamable HTTP, no reveal tool)

**Files:**
- Create: `packages/server/src/http/mcp.ts`
- Modify: `packages/server/src/http/app.ts`
- Test: `packages/server/test/http.mcp.test.ts`

**Interfaces:**
- Produces: `buildMcpServer(ctx, actor): McpServer` with tools `list_projects`, `get_project`, `list_documents`, `read_document`, `write_document`, `search`, `list_secrets`; `registerMcpRoutes(app, ctx)` mounting `POST /mcp` (bearer-authenticated by the existing hook; stateless; JSON responses) and `GET|DELETE /mcp` → 405.

- [ ] **Step 1: Write failing tests**

`packages/server/test/http.mcp.test.ts`:
```ts
import { describe, it, expect, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { makeTestApp, type TestCtx } from './helpers.js';
import { createSecret } from '../src/repos/secrets.js';
import { upsertDocument } from '../src/repos/documents.js';

let t: TestCtx;
afterEach(async () => {
  await t?.app.close();
});

async function connect(token: string): Promise<Client> {
  const address = await t.app.listen({ port: 0, host: '127.0.0.1' });
  const transport = new StreamableHTTPClientTransport(new URL(`${address}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

const textOf = (r: Awaited<ReturnType<Client['callTool']>>): string => {
  const c = (r.content as { type: string; text?: string }[])[0];
  return c?.text ?? '';
};

describe('mcp', () => {
  it('lists tools without any reveal tool', async () => {
    t = await makeTestApp();
    const client = await connect(t.token(['admin']));
    const names = (await client.listTools()).tools.map((x) => x.name).sort();
    expect(names).toEqual(['get_project', 'list_documents', 'list_projects', 'list_secrets', 'read_document', 'search', 'write_document']);
    expect(names.join(' ')).not.toMatch(/reveal|get_secret|field/);
  });
  it('get_project and list_secrets return meta only; write_document lints', async () => {
    t = await makeTestApp();
    const p = t.project('alpha');
    createSecret(t.db, t.ring, { projectId: p.id, name: 'Staging', description: '', tags: [], fields: [{ key: 'host', value: 'h1' }, { key: 'password', value: 'sekret' }] });
    upsertDocument(t.db, { projectId: p.id, slug: 'context', title: 'Ctx', category: 'context', body_md: 'hello {{secret:Staging}}' });
    const client = await connect(t.token(['projects:read', 'docs:read', 'docs:write', 'secrets:meta', 'secrets:reveal'], ['alpha']));
    const proj = JSON.parse(textOf(await client.callTool({ name: 'get_project', arguments: { slug: 'alpha' } })));
    expect(proj.secrets[0].fields).toEqual([{ key: 'host', sensitive: false, value: 'h1' }, { key: 'password', sensitive: true }]);
    const secrets = textOf(await client.callTool({ name: 'list_secrets', arguments: { project: 'alpha' } }));
    expect(secrets).toContain('Staging');
    expect(secrets).not.toContain('sekret');
    const doc = JSON.parse(textOf(await client.callTool({ name: 'read_document', arguments: { project: 'alpha', slug: 'context' } })));
    expect(doc.body_md).toBe('hello {{secret:Staging}}');
    expect(doc.refs[0].fields).toEqual([{ key: 'host', sensitive: false }, { key: 'password', sensitive: true }]);
    const lint = await client.callTool({ name: 'write_document', arguments: { project: 'alpha', slug: 'notes', title: 'N', category: 'notes', body_md: 'password: Tr0ub4dor&3' } });
    expect(lint.isError).toBe(true);
    expect(textOf(lint)).toContain('lint');
    const ok = await client.callTool({ name: 'write_document', arguments: { project: 'alpha', slug: 'notes', title: 'N', category: 'notes', body_md: 'clean' } });
    expect(ok.isError).toBeFalsy();
    const missing = await client.callTool({ name: 'get_project', arguments: { slug: 'beta' } });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain('not_found');
  });
  it('rejects unauthenticated MCP requests', async () => {
    t = await makeTestApp();
    const r = await t.app.inject({ method: 'POST', url: '/mcp', payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
    expect(r.statusCode).toBe(401);
    expect((await t.app.inject({ method: 'GET', url: '/mcp', headers: { authorization: `Bearer ${t.token(['admin'])}` } })).statusCode).toBe(405);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/server/test/http.mcp.test.ts`
Expected: FAIL — 404 on /mcp (client connect throws).

- [ ] **Step 3: Implement**

`packages/server/src/http/mcp.ts`:
```ts
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
        body_md: z.string(),
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
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });

  app.get('/mcp', async (_req, reply) => reply.status(405).send({ error: 'method_not_allowed' }));
  app.delete('/mcp', async (_req, reply) => reply.status(405).send({ error: 'method_not_allowed' }));
}
```

In `app.ts` add `import { registerMcpRoutes } from './mcp.js';` and `registerMcpRoutes(app, ctx);`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run packages/server/test/http.mcp.test.ts`
Expected: PASS (3 tests). If the client hangs on `connect`, verify `enableJsonResponse: true` is set and that Fastify parsed the JSON body (the client sends `Content-Type: application/json`). If the SDK's `registerTool` types reject the raw-shape `inputSchema`, wrap each shape in `z.object({...})` — SDK 1.30 accepts both.

- [ ] **Step 5: Commit**

```bash
git add packages/server
git commit -m "feat(server): add MCP streamable HTTP endpoint with metadata-only tools

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 17: Ops (init / rotate-key / backup) + `pidb-server` CLI + guidelines seed

**Files:**
- Create: `packages/server/src/seed/guidelines.ts`, `packages/server/src/ops.ts`, `packages/server/src/cli.ts`
- Modify: `packages/server/src/index.ts` (exports)
- Test: `packages/server/test/ops.test.ts`

**Interfaces:**
- Produces: `GUIDELINES_MD: string`, `runInit(db, { username, password }): Promise<{ adminCreated: boolean; guidelinesSeeded: boolean }>`, `runRotateKey(db, ring): number`, `runBackup(db, dir, keep?, now?): string` (returns created file path), `startServer(config): Promise<FastifyInstance>`.
- Bin `pidb-server` with subcommands `init`, `start`, `rotate-key`, `backup [--out <dir>] [--keep <n>]`.

- [ ] **Step 1: Write failing tests**

`packages/server/test/ops.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { openDb } from '../src/db/connection.js';
import { runInit, runRotateKey, runBackup } from '../src/ops.js';
import { getAdmin } from '../src/repos/admin.js';
import { getDocument } from '../src/repos/documents.js';
import { createSecret, revealField } from '../src/repos/secrets.js';
import { verifyPassword } from '../src/crypto/passwords.js';
import type { KeyRing } from '../src/config.js';

describe('ops', () => {
  it('init creates admin and seeds guidelines once', async () => {
    const db = openDb(':memory:');
    const first = await runInit(db, { username: 'alex', password: 'pw' });
    expect(first).toEqual({ adminCreated: true, guidelinesSeeded: true });
    expect(await verifyPassword(getAdmin(db)!.password_hash, 'pw')).toBe(true);
    expect(getDocument(db, null, 'guidelines')?.category).toBe('guidelines');
    const second = await runInit(db, { username: 'other', password: 'x' });
    expect(second).toEqual({ adminCreated: false, guidelinesSeeded: false });
    expect(getAdmin(db)!.username).toBe('alex');
  });
  it('rotate-key rewraps secrets', () => {
    const db = openDb(':memory:');
    const ring1: KeyRing = { current: 1, keys: new Map([[1, randomBytes(32)]]) };
    const s = createSecret(db, ring1, { projectId: null, name: 'A', description: '', tags: [], fields: [{ key: 'k', value: 'v' }] });
    const ring2: KeyRing = { current: 2, keys: new Map([[1, ring1.keys.get(1)!], [2, randomBytes(32)]]) };
    expect(runRotateKey(db, ring2)).toBe(1);
    expect(revealField(db, { current: 2, keys: new Map([[2, ring2.keys.get(2)!]]) }, s.id, 'k')).toBe('v');
  });
  it('backup writes a consistent copy and prunes old ones', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pidb-backup-'));
    const db = openDb(join(dir, 'pidb.sqlite'));
    db.prepare(`INSERT INTO projects (slug, name, created_at, updated_at) VALUES ('p', 'P', 0, 0)`).run();
    const out = join(dir, 'backups');
    for (let i = 0; i < 3; i++) {
      runBackup(db, out, 2, new Date(Date.UTC(2001, 0, i + 1)));
    }
    const files = readdirSync(out).sort();
    expect(files).toEqual(['pidb-2001-01-02T00-00-00.sqlite', 'pidb-2001-01-03T00-00-00.sqlite']);
    const copy = new Database(join(out, files[1]!), { readonly: true });
    expect(copy.prepare(`SELECT COUNT(*) AS c FROM projects`).get()).toEqual({ c: 1 });
    copy.close();
    db.close();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/server/test/ops.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement guidelines seed**

`packages/server/src/seed/guidelines.ts`:
```ts
export const GUIDELINES_MD = `# Documentation guidelines

This server stores two kinds of things per project:

- **Secrets** — named, flat key/value maps (all strings). Example names: "Staging server", "Admin login", "Production DB", "GitHub PAT" (global).
- **Documents** — free-form Markdown, grouped by category.

## Categories

| category | use for |
|---|---|
| context | what the project is, who it is for, current state, priorities |
| architecture | stack, structure, key modules, data flow |
| deploy | environments, hosts, how to build/deploy/rollback |
| conventions | coding style, branching, commit rules, review process |
| client | client contacts, billing notes, communication preferences |
| notes | anything else, meeting notes, decisions |
| guidelines | this document (global) |

Recommended per-project documents: \`context\`, \`architecture\`, \`deploy\`, \`conventions\`.

## Referencing secrets

Never paste a secret value into a document. Reference it by name instead:

- \`{{secret:Staging server}}\` — secret in the same project
- \`{{secret:global/GitHub PAT}}\` — global secret
- \`{{secret:other-project/Prod DB}}\` — secret in another project

Saving a document that looks like it contains a real credential is rejected; fix the text or save with \`force\` if it is a false positive.

## How agents use secrets

Agents read documents and secret *metadata* (names, field keys, non-sensitive fields like host/username). Values are consumed through the CLI so they never enter the model context:

\`\`\`example
pidb secret exec my-project "Staging server" -- ssh $PIDB_USERNAME@$PIDB_HOST
pidb secret write my-project "Staging server" private_key --out ~/.ssh/staging_key --mode 600
pidb secret env my-project "App env" --out .env
\`\`\`

## Writing style

- Start each document with a one-paragraph summary.
- Use headings for sections, bullet lists for facts, tables for structured data.
- Keep commands in fenced code blocks. Use \`\`\`example fences for illustrative values so the lint ignores them.
- Prefer updating an existing document over creating a new one.
`;
```

- [ ] **Step 4: Implement ops**

`packages/server/src/ops.ts`:
```ts
import { mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { openDb, type Db } from './db/connection.js';
import type { KeyRing, Config } from './config.js';
import { createAdmin, getAdmin } from './repos/admin.js';
import { getDocument, upsertDocument } from './repos/documents.js';
import { rewrapAllSecrets } from './repos/secrets.js';
import { hashPassword } from './crypto/passwords.js';
import { GUIDELINES_MD } from './seed/guidelines.js';
import { buildApp } from './http/app.js';

export async function runInit(db: Db, opts: { username: string; password: string }): Promise<{ adminCreated: boolean; guidelinesSeeded: boolean }> {
  let adminCreated = false;
  if (!getAdmin(db)) {
    createAdmin(db, opts.username, await hashPassword(opts.password));
    adminCreated = true;
  }
  let guidelinesSeeded = false;
  if (!getDocument(db, null, 'guidelines')) {
    upsertDocument(db, { projectId: null, slug: 'guidelines', title: 'Documentation guidelines', category: 'guidelines', body_md: GUIDELINES_MD });
    guidelinesSeeded = true;
  }
  return { adminCreated, guidelinesSeeded };
}

export function runRotateKey(db: Db, ring: KeyRing): number {
  return rewrapAllSecrets(db, ring);
}

const BACKUP_RE = /^pidb-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.sqlite$/;

export function runBackup(db: Db, dir: string, keep = 14, now: Date = new Date()): string {
  mkdirSync(dir, { recursive: true });
  const stamp = now.toISOString().replace(/\.\d{3}Z$/, '').replace(/:/g, '-');
  const file = join(dir, `pidb-${stamp}.sqlite`);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const existing = readdirSync(dir).filter((f) => BACKUP_RE.test(f)).sort();
  for (const old of existing.slice(0, Math.max(0, existing.length - keep))) unlinkSync(join(dir, old));
  return file;
}

export async function startServer(config: Config): Promise<FastifyInstance> {
  mkdirSync(config.dataDir, { recursive: true });
  const db = openDb(config.dbPath);
  const app = await buildApp({ db, ring: config.keyRing, logLevel: config.logLevel, trustProxy: true });
  app.addHook('onClose', async () => {
    db.close();
  });
  await app.listen({ port: config.port, host: config.host });
  return app;
}
```

- [ ] **Step 5: Implement CLI**

`packages/server/src/cli.ts`:
```ts
#!/usr/bin/env node
import { Command } from 'commander';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { loadConfig, ConfigError } from './config.js';
import { openDb } from './db/connection.js';
import { runBackup, runInit, runRotateKey, startServer } from './ops.js';

const CTRL_C = '\u0003';
const BACKSPACE = '\u007f';

async function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

function promptHidden(question: string): Promise<string> {
  stdout.write(question);
  if (!stdin.isTTY) return prompt('');
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise<string>((resolve) => {
    let buf = '';
    const onData = (chunk: Buffer) => {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\n' || ch === '\r') {
          stdin.setRawMode(false);
          stdin.off('data', onData);
          stdin.pause();
          stdout.write('\n');
          resolve(buf.trim());
          return;
        }
        if (ch === CTRL_C) process.exit(130);
        if (ch === BACKSPACE) buf = buf.slice(0, -1);
        else buf += ch;
      }
    };
    stdin.on('data', onData);
  });
}

function fatal(err: unknown): never {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`error: ${msg}`);
  process.exit(err instanceof ConfigError ? 2 : 1);
}

const program = new Command().name('pidb-server').description('Projects Info DB server');

program
  .command('init')
  .description('Run migrations, create the admin user, seed the guidelines document')
  .action(async () => {
    try {
      const config = loadConfig();
      mkdirSync(config.dataDir, { recursive: true });
      const db = openDb(config.dbPath);
      const username = process.env.PIDB_ADMIN_USERNAME ?? (await prompt('Admin username: '));
      const password = process.env.PIDB_ADMIN_PASSWORD ?? (await promptHidden('Admin password: '));
      if (!username || !password) throw new Error('username and password are required');
      const r = await runInit(db, { username, password });
      console.log(`admin: ${r.adminCreated ? 'created' : 'already exists'}; guidelines: ${r.guidelinesSeeded ? 'seeded' : 'already present'}`);
      db.close();
    } catch (err) {
      fatal(err);
    }
  });

program
  .command('start')
  .description('Start the HTTP server')
  .action(async () => {
    try {
      const config = loadConfig();
      const app = await startServer(config);
      const shutdown = async () => {
        await app.close();
        process.exit(0);
      };
      process.on('SIGTERM', () => void shutdown());
      process.on('SIGINT', () => void shutdown());
    } catch (err) {
      fatal(err);
    }
  });

program
  .command('rotate-key')
  .description('Rewrap all secret DEKs with the current master key version')
  .action(() => {
    try {
      const config = loadConfig();
      const db = openDb(config.dbPath);
      console.log(`rewrapped ${runRotateKey(db, config.keyRing)} secrets to key version ${config.keyRing.current}`);
      db.close();
    } catch (err) {
      fatal(err);
    }
  });

program
  .command('backup')
  .description('Write a consistent SQLite copy and prune old backups')
  .option('--out <dir>', 'backup directory (default: <dataDir>/backups)')
  .option('--keep <n>', 'number of backups to keep', '14')
  .action((opts: { out?: string; keep: string }) => {
    try {
      const config = loadConfig();
      const db = openDb(config.dbPath);
      const file = runBackup(db, opts.out ?? join(config.dataDir, 'backups'), Number.parseInt(opts.keep, 10));
      console.log(`backup written: ${file}`);
      db.close();
    } catch (err) {
      fatal(err);
    }
  });

program.parseAsync(process.argv).catch(fatal);
```

`packages/server/src/index.ts`:
```ts
export { buildApp } from './http/app.js';
export type { AppContext } from './http/context.js';
export { loadConfig, ConfigError } from './config.js';
export type { Config, KeyRing } from './config.js';
export { openDb } from './db/connection.js';
export type { Db } from './db/connection.js';
export { runInit, runRotateKey, runBackup, startServer } from './ops.js';
```

- [ ] **Step 6: Run tests, build, smoke-run**

Run: `npx vitest run` → all PASS.
Run: `npm run build` → exit 0. Then smoke-test the built CLI:
```bash
export PIDB_MASTER_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
export PIDB_DATA_DIR=/tmp/pidb-smoke PIDB_PORT=8089
PIDB_ADMIN_USERNAME=alex PIDB_ADMIN_PASSWORD=pw node packages/server/dist/cli.js init
node packages/server/dist/cli.js start &
sleep 1
curl -s localhost:8089/health
curl -s -XPOST localhost:8089/api/v1/auth/token -H 'content-type: application/json' -d '{"username":"alex","password":"pw"}'
kill %1
rm -rf /tmp/pidb-smoke
```
Expected: `admin: created; guidelines: seeded`, then `{"ok":true}`, then a JSON object containing `"token":"pidb_..."`.

- [ ] **Step 7: Commit**

```bash
git add packages/server
git commit -m "feat(server): add pidb-server CLI with init, start, rotate-key, backup

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 18: README + final verification

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write README**

`README.md`:
````markdown
# pidb — Projects Info DB

Self-hosted store for project documentation and encrypted secrets, with a scoped REST API and an MCP endpoint for AI agents. Secret values never enter an agent's context: agents read metadata and documents, and consume values through the `pidb` CLI (`exec` / `write` / `env`).

Spec: `docs/superpowers/specs/2026-09-12-projects-info-db-design.md`.

## Packages

- `packages/shared` — zod schemas, secret-reference parser (`{{secret:Name}}`), secret-value lint
- `packages/server` — Fastify server: REST (`/api/v1`), MCP (`/mcp`), `pidb-server` ops CLI
- `packages/cli` — `pidb` client CLI (Plan 2)

## Quick start (development)

```bash
npm install
export PIDB_MASTER_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
export PIDB_DATA_DIR=./data
npm run build
PIDB_ADMIN_USERNAME=alex PIDB_ADMIN_PASSWORD=change-me node packages/server/dist/cli.js init
node packages/server/dist/cli.js start
```

Get an admin token:

```bash
curl -s -XPOST localhost:8080/api/v1/auth/token -H 'content-type: application/json' \
  -d '{"username":"alex","password":"change-me","name":"cli"}'
```

Create a scoped token for an agent (scopes: `projects:read docs:read docs:write secrets:meta secrets:reveal secrets:write admin`):

```bash
curl -s -XPOST localhost:8080/api/v1/tokens -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"name":"claude-code","scopes":["projects:read","docs:read","docs:write","secrets:meta"],"projects":["my-project"]}'
```

Register the MCP server in Claude Code:

```bash
claude mcp add --transport http pidb http://localhost:8080/mcp --header "Authorization: Bearer $AGENT_TOKEN"
```

## Environment

| variable | default | purpose |
|---|---|---|
| `PIDB_MASTER_KEY` | — | base64 32-byte key (or `PIDB_MASTER_KEY_FILE`) — **required**; back it up separately |
| `PIDB_MASTER_KEY_VERSION` | `1` | current key version |
| `PIDB_MASTER_KEY_PREVIOUS` | — | `1:<base64>,2:<base64>` older keys for rotation |
| `PIDB_DATA_DIR` | `/data` | sqlite + backups |
| `PIDB_DB_PATH` | `$PIDB_DATA_DIR/pidb.sqlite` | |
| `PIDB_PORT` / `PIDB_HOST` | `8080` / `0.0.0.0` | |
| `PIDB_LOG_LEVEL` | `info` | |

## Scripts

`npm test` · `npm run typecheck` · `npm run build`
````

- [ ] **Step 2: Full verification**

Run, in order, and confirm each exits 0:
```bash
npm run build
npm run typecheck
npx vitest run
```
Expected: build OK, typecheck OK, all tests PASS. Fix any type errors in place (they indicate real bugs — do not add `any` or `// @ts-ignore`).

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "docs: add README with quick start and environment reference

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Plan self-review notes

- Spec coverage: §3 layout (T1), §4 schema (T6), §5 crypto + lint (T4, T7), §6 refs (T3, T13), §7 auth/scopes/404-vs-403 (T11–T15), §8 REST (T12–T15), §9 MCP (T16, plus an extra `list_documents` tool), §10 server CLI (T17), §13 error mapping (T7, T11), §14 tests (each task). §10 client CLI, §11 admin UI, §12 Docker are Plans 2 and 3.
- `GET .../secrets/:name/fields` returns `{ name, fields: { key: value } }` (T14) — the CLI in Plan 2 consumes this shape.
- Admin-session (cookie) auth is intentionally absent; `registerAuth` already skips bearer parsing when `req.principal` was set by an earlier hook, which Plan 3 will add.
