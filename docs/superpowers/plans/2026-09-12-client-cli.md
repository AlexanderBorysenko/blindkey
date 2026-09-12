# pidb Client CLI (`packages/cli`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `packages/cli` — the `pidb` command-line client that talks to the pidb server over HTTP and injects secret values into processes and files without ever printing them.

**Architecture:** A thin, dependency-light ESM package. `config.ts` resolves `{url, token}` from env or `~/.config/pidb/config.json`; `client.ts` is a `fetch` wrapper that maps server error bodies (`{error, message, ...details}`) onto CLI exit codes; each command lives in its own module under `src/commands/` and returns a `CommandResult` (`{json, text}`) that `cli.ts` renders as a table or as JSON. Value-consuming commands (`secret exec|write|env`) never route values through a `CommandResult` — they hand them to a child process or a `0600` file directly.

**Tech Stack:** Node 22, TypeScript 5 (ESM, `NodeNext`), `commander` v15, native `fetch`, `@pidb/shared` for scope/slug schemas, vitest for tests.

**Spec:** `docs/superpowers/specs/2026-09-12-projects-info-db-design.md` (§10 "Client CLI", §13 exit codes, §14 CLI tests). Binding. Plan 1's rulings live in `docs/superpowers/plans/2026-09-12-core-server-execution-log.md` — the server contract below already reflects them.

**Predecessor:** Plan 1 (`docs/superpowers/plans/2026-09-12-core-server.md`) is merged; `packages/shared` and `packages/server` exist at commit `d3c6401` or later.

## Global Constraints

- Node `>=22`, TypeScript `strict` + `noUncheckedIndexedAccess` (inherited from `tsconfig.base.json`), ESM only (`"type": "module"`), `module`/`moduleResolution` = `NodeNext` — **every relative import must carry the `.js` extension**, even from a `.ts` file.
- New runtime dependencies for `@pidb/cli`: `commander@^15.0.0` and `@pidb/shared@0.1.0`. Nothing else. Use native `fetch` (Node 22), not `undici`.
- **Secret values never reach stdout or stderr** except from `pidb secret get --print`. No logging of values, no values in error messages, no values in `CommandResult.json`.
- Exit codes (spec §13): `1` generic, `2` refused (a guard rail said no), `3` auth (401/403), `4` not found (404).
- Tests live in `packages/cli/test/**/*.test.ts` (the root `vitest.config.ts` already globs `packages/*/test/**/*.test.ts`). Never write into `$HOME` from a test: always set `PIDB_CONFIG_HOME` to a `mkdtempSync` directory.
- Every task ends with a commit. Conventional Commits (`feat(cli): …`, `test(cli): …`, `docs: …`). Every commit message ends with the trailer:
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`
  After committing, run `git log -1 --format=%B` and verify the trailer is present and names Opus 5.
- If a step cannot be completed as written (a command fails in a way the plan does not describe, or the plan contradicts the server), **STOP and report BLOCKED with the exact output. Do not improvise a different design.**

## Server contract (authoritative, read before Task 3)

Base URL `<url>/api/v1`, bearer auth: `Authorization: Bearer pidb_…`. All JSON unless noted.

| method + path | body | success | notes |
|---|---|---|---|
| `POST /auth/token` | `{username, password, name?}` | `201 {token, id, name}` | **public** (no bearer), rate-limited 5/min |
| `GET /projects` | — | `200 PublicProject[]` | `projects:read` |
| `GET /projects/:slug` | — | `200 PublicProject & {documents: PublicDocSummary[], secrets: PublicSecret[]}` | |
| `GET /docs`, `GET /projects/:slug/docs` | — | `200 PublicDocSummary[]` | `docs:read` |
| `GET /docs/:doc`, `GET /projects/:slug/docs/:doc` | — | `200 PublicDoc (+ refs when ?resolve=meta and secrets:meta)` | |
| `PUT` same paths | `{title, category, body_md, force?}` | `201` created / `200` updated, `PublicDoc` | `docs:write`; 422 `lint` / `unresolved_refs` |
| `DELETE` same paths | — | `204` | |
| `GET /secrets`, `GET /projects/:slug/secrets` | — | `200 PublicSecret[]` | `secrets:meta` |
| `GET …/secrets/:name` | — | `200 PublicSecret` | |
| `GET …/secrets/:name/fields` | — | `200 {name, fields: {key: value}}` | `secrets:reveal`; audits every sensitive field |
| `GET …/secrets/:name/fields/:key` | — | `200 {key, value}`; with `Accept: text/plain` the raw value | `secrets:meta` **or** `secrets:reveal` up front; sensitive values need `secrets:reveal` |
| `POST …/secrets` | `{name, description?, tags?, fields: [{key, value, sensitive?}]}` | `201 PublicSecret` | `secrets:write`; `fields` min 1 |
| `PATCH …/secrets/:name` | `{name?, description?, tags?, fields?, removeFields?}` | `200 PublicSecret` | `secrets:write` |
| `DELETE …/secrets/:name` | — | `204` | |
| `GET /search?q=` | — | `200 {projects?, documents?, secrets?}` | sections omitted when scope missing |
| `GET /tokens` | — | `200 PublicToken[]` | `admin` |
| `POST /tokens` | `{name, scopes, projects?, expires_at?}` | `201 PublicToken & {token}` | `admin`; `projects` is a slug array or `null`; `expires_at` is **epoch milliseconds** |
| `DELETE /tokens/:id` | — | `204` | `admin` |

Global (non-project) secrets and documents use the `/api/v1/secrets/…` and `/api/v1/docs/…` prefixes.

Response shapes (from `packages/server/src/http/serialize.ts` and `services/admin.ts`):

```ts
PublicProject    = { slug, name, status: 'active'|'paused'|'archived', tags: string[], summary, created_at: number, updated_at: number }
PublicDocSummary = { slug, title, category: DocCategory, created_at: number, updated_at: number }
PublicDoc        = PublicDocSummary & { body_md: string, refs?: ResolvedRef[] }
ResolvedRef      = { ref: string, name: string, project: string | null, fields: { key: string, sensitive: boolean }[] }
PublicSecret     = { name, description, tags: string[], fields: { key: string, sensitive: boolean, value?: string }[], created_at, updated_at }
PublicToken      = { id, name, prefix, scopes: Scope[], projects: string[] | null, expires_at: number|null, last_used_at: number|null, revoked_at: number|null, created_at }
SearchResult     = { projects?: PublicProject[], documents?: {project: string|null, slug, title, category, snippet}[], secrets?: {project: string|null, name, tags: string[]}[] }
```

All timestamps are **epoch milliseconds** (`Date.now()`).

Error bodies: `{ error: <code>, message?: string, ...details }`. 5xx bodies carry no `message`. Codes: `unauthorized`, `missing_scope` (+ `scope`), `not_found`, `validation` (+ `issues`), `conflict`, `lint` (+ `findings: {line, reason}[]`), `unresolved_refs` (+ `unresolved: string[]`), `rate_limited`, `payload_too_large`, `unsupported_media_type`, `bad_request`, `decrypt_failed`, `internal`.

## Command surface (spec §10, exact)

```
pidb login <url> [--username <u>] [--name <token-name>]
pidb projects list [--json]
pidb projects get <slug> [--json]
pidb docs list [<slug>] [--json]
pidb docs get <target> [<doc>] [--json] [--refs]
pidb docs put <target> [<doc>] --file <path> --title <t> --category <c> [--force]
pidb secrets list [<slug>] [--json]
pidb secret get <target> <name> <field> [--print]
pidb secret set <target> <name> <field> [--from-file <path>] [--sensitive|--non-sensitive] [--create]
pidb secret exec <target> <name> -- <command...>
pidb secret write <target> <name> <field> --out <path> [--mode 600] [--force]
pidb secret env <target> <name> --out <path> [--force]
pidb token create --name <n> --scopes <a,b> [--projects <x,y>] [--expires <90d>]
pidb token list [--json]
pidb token revoke <id>
pidb search <query> [--json]
```

`<target>` is a project slug or the literal `global`. For `docs get`/`docs put`, when the second positional is omitted the first one is the document slug and the target is `global` (so `pidb docs get guidelines` reads the global guidelines document, and `pidb docs get acme deploy` reads `acme`'s deploy doc). `docs list` and `secrets list` take an optional target which defaults to `global`.

## File structure

| file | responsibility |
|---|---|
| `packages/cli/package.json` | package manifest, `bin.pidb` → `dist/cli.js` |
| `packages/cli/tsconfig.json` | build config (mirrors `packages/server/tsconfig.json`) |
| `packages/cli/src/errors.ts` | `CliError` + exit-code constants |
| `packages/cli/src/config.ts` | config dir/path resolution, load (env → file), save with `0600` |
| `packages/cli/src/api-types.ts` | TypeScript mirrors of the server's public response shapes |
| `packages/cli/src/client.ts` | `PidbClient` (fetch wrapper), `ApiError`, path helpers |
| `packages/cli/src/output.ts` | `CommandResult`, `table()`, `fmtTime()`, `emit()` |
| `packages/cli/src/prompt.ts` | TTY-safe `prompt()` / `promptHidden()` |
| `packages/cli/src/commands/login.ts` | `pidb login` |
| `packages/cli/src/commands/projects.ts` | `projects list|get`, `search` |
| `packages/cli/src/commands/docs.ts` | `docs list|get|put` |
| `packages/cli/src/commands/secrets.ts` | `secrets list`, `secret get|set` |
| `packages/cli/src/commands/exec.ts` | `secret exec` |
| `packages/cli/src/commands/files.ts` | `secret write`, `secret env` |
| `packages/cli/src/commands/tokens.ts` | `token create|list|revoke` |
| `packages/cli/src/cli.ts` | commander wiring, error→exit-code handling, `#!/usr/bin/env node` |
| `packages/cli/src/index.ts` | library re-exports (`main` entry) |
| `packages/cli/test/helpers.ts` | live-server fixture + `runCli()` spawn helper |
| `packages/cli/test/*.test.ts` | one test file per source area |

---

## Task 1: Package scaffold, errors, workspace wiring

**Files:**
- Create: `packages/cli/package.json`, `packages/cli/tsconfig.json`, `packages/cli/src/errors.ts`, `packages/cli/src/index.ts`
- Modify: `package.json` (root: `build` and `typecheck` scripts)
- Test: `packages/cli/test/errors.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `CliError` class with `exitCode: number`; constants `EXIT_GENERIC = 1`, `EXIT_REFUSED = 2`, `EXIT_AUTH = 3`, `EXIT_NOT_FOUND = 4`. Every later task imports these from `./errors.js`.

- [ ] **Step 1: Create the package manifest**

`packages/cli/package.json`:

```json
{
  "name": "@pidb/cli",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "bin": { "pidb": "./dist/cli.js" },
  "files": ["dist"],
  "scripts": {
    "build": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "@pidb/shared": "0.1.0",
    "commander": "^15.0.0"
  }
}
```

- [ ] **Step 2: Create the TypeScript config**

`packages/cli/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist", "types": ["node"] },
  "include": ["src"]
}
```

- [ ] **Step 3: Write the failing test**

`packages/cli/test/errors.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { CliError, EXIT_AUTH, EXIT_GENERIC, EXIT_NOT_FOUND, EXIT_REFUSED } from '../src/errors.js';

describe('CliError', () => {
  it('defaults to the generic exit code', () => {
    const err = new CliError('boom');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('CliError');
    expect(err.message).toBe('boom');
    expect(err.exitCode).toBe(EXIT_GENERIC);
  });

  it('carries the exit code it was given', () => {
    expect(new CliError('nope', EXIT_REFUSED).exitCode).toBe(2);
  });

  it('uses the exit codes from the spec', () => {
    expect([EXIT_GENERIC, EXIT_REFUSED, EXIT_AUTH, EXIT_NOT_FOUND]).toEqual([1, 2, 3, 4]);
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npx vitest run packages/cli/test/errors.test.ts`
Expected: FAIL — cannot resolve `../src/errors.js`.

- [ ] **Step 5: Write the implementation**

`packages/cli/src/errors.ts`:

```ts
/** Exit codes, spec §13: 1 generic, 2 refused, 3 auth, 4 not found. */
export const EXIT_GENERIC = 1;
export const EXIT_REFUSED = 2;
export const EXIT_AUTH = 3;
export const EXIT_NOT_FOUND = 4;

export class CliError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number = EXIT_GENERIC,
  ) {
    super(message);
    this.name = 'CliError';
  }
}
```

`packages/cli/src/index.ts`:

```ts
export * from './errors.js';
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run packages/cli/test/errors.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 7: Wire the package into the workspace scripts**

In the root `package.json`, replace the `build` and `typecheck` scripts with:

```json
    "build": "npm run build -w @pidb/shared && npm run build -w @pidb/server && npm run build -w @pidb/cli",
    "typecheck": "npm run build -w @pidb/shared && tsc -p packages/server/tsconfig.json --noEmit && tsc -p packages/cli/tsconfig.json --noEmit",
```

- [ ] **Step 8: Install and verify the workspace resolves**

Run: `npm install`
Expected: adds `packages/cli` to the workspace, installs `commander`, links `@pidb/shared`.

Run: `npm run build`
Expected: all three packages compile; `packages/cli/dist/index.js` exists.

- [ ] **Step 9: Commit**

```bash
git add packages/cli package.json package-lock.json
git commit -m "feat(cli): scaffold @pidb/cli package with exit-code errors

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
git log -1 --format=%B
```

---

## Task 2: Config resolution and storage

**Files:**
- Create: `packages/cli/src/config.ts`
- Modify: `packages/cli/src/index.ts`
- Test: `packages/cli/test/config.test.ts`

**Interfaces:**
- Consumes: `CliError`, `EXIT_AUTH` from `./errors.js`.
- Produces:
  - `interface CliConfig { url: string; token: string }`
  - `configDir(env?: NodeJS.ProcessEnv): string`, `configPath(env?): string`
  - `normalizeUrl(url: string): string` — trims, strips trailing slashes, requires `http:`/`https:`
  - `loadConfig(env?: NodeJS.ProcessEnv): CliConfig` — env beats file, per field; throws `CliError(…, EXIT_AUTH)` when either is missing
  - `saveConfig(cfg: CliConfig, env?): string` — writes `config.json` with mode `0600`, returns the path

- [ ] **Step 1: Write the failing test**

`packages/cli/test/config.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, statSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configPath, loadConfig, normalizeUrl, saveConfig } from '../src/config.js';
import { CliError } from '../src/errors.js';

let home: string;
const envWith = (extra: Record<string, string> = {}) => ({ PIDB_CONFIG_HOME: home, ...extra }) as NodeJS.ProcessEnv;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'pidb-cfg-'));
});

describe('normalizeUrl', () => {
  it('strips trailing slashes and whitespace', () => {
    expect(normalizeUrl('  https://pidb.example.com/  ')).toBe('https://pidb.example.com');
  });
  it('rejects non-http(s) urls', () => {
    expect(() => normalizeUrl('ftp://x/')).toThrow(/invalid server url|must be http/i);
    expect(() => normalizeUrl('not a url')).toThrow(CliError);
  });
});

describe('loadConfig', () => {
  it('reads the config file', () => {
    writeFileSync(configPath(envWith()), JSON.stringify({ url: 'http://localhost:8080/', token: 'pidb_file' }));
    expect(loadConfig(envWith())).toEqual({ url: 'http://localhost:8080', token: 'pidb_file' });
  });

  it('prefers env vars over the file, per field', () => {
    writeFileSync(configPath(envWith()), JSON.stringify({ url: 'http://file', token: 'pidb_file' }));
    expect(loadConfig(envWith({ PIDB_TOKEN: 'pidb_env' }))).toEqual({ url: 'http://file', token: 'pidb_env' });
    expect(loadConfig(envWith({ PIDB_URL: 'http://env' }))).toEqual({ url: 'http://env', token: 'pidb_file' });
  });

  it('exits 3 when nothing is configured', () => {
    try {
      loadConfig(envWith());
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).exitCode).toBe(3);
      expect((err as CliError).message).toMatch(/pidb login/);
    }
  });

  it('reports a corrupt config file', () => {
    writeFileSync(configPath(envWith()), '{not json');
    expect(() => loadConfig(envWith())).toThrow(/not valid JSON/);
  });
});

describe('saveConfig', () => {
  it('writes config.json with mode 0600 inside a 0700 directory', () => {
    const dir = join(home, 'nested');
    const env = { PIDB_CONFIG_HOME: dir } as NodeJS.ProcessEnv;
    const path = saveConfig({ url: 'https://pidb.example.com', token: 'pidb_abc' }, env);
    expect(path).toBe(join(dir, 'config.json'));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ url: 'https://pidb.example.com', token: 'pidb_abc' });
  });

  it('tightens the mode of a pre-existing world-readable file', () => {
    mkdirSync(join(home, 'd'), { recursive: true });
    const env = { PIDB_CONFIG_HOME: join(home, 'd') } as NodeJS.ProcessEnv;
    writeFileSync(join(home, 'd', 'config.json'), '{}', { mode: 0o644 });
    const path = saveConfig({ url: 'http://x', token: 't' }, env);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe('configPath', () => {
  it('falls back to XDG_CONFIG_HOME then HOME', () => {
    expect(configPath({ XDG_CONFIG_HOME: '/xdg' } as NodeJS.ProcessEnv)).toBe('/xdg/pidb/config.json');
    expect(configPath({ HOME: '/home/alex' } as NodeJS.ProcessEnv)).toBe('/home/alex/.config/pidb/config.json');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/cli/test/config.test.ts`
Expected: FAIL — cannot resolve `../src/config.js`.

- [ ] **Step 3: Write the implementation**

`packages/cli/src/config.ts`:

```ts
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { CliError, EXIT_AUTH } from './errors.js';

export interface CliConfig {
  url: string;
  token: string;
}

/**
 * PIDB_CONFIG_HOME is the config directory itself (used by tests and by anyone
 * keeping several profiles); XDG_CONFIG_HOME and HOME get the `pidb` suffix.
 */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PIDB_CONFIG_HOME) return env.PIDB_CONFIG_HOME;
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, 'pidb');
  return join(env.HOME ?? homedir(), '.config', 'pidb');
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), 'config.json');
}

export function normalizeUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new CliError(`invalid server url "${url}"`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new CliError(`invalid server url "${url}" — must be http:// or https://`);
  }
  return trimmed;
}

function readConfigFile(env: NodeJS.ProcessEnv): Partial<CliConfig> {
  const path = configPath(env);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CliError(`config file ${path} is not valid JSON`);
  }
  if (typeof parsed !== 'object' || parsed === null) throw new CliError(`config file ${path} is not valid JSON`);
  const o = parsed as Record<string, unknown>;
  const out: Partial<CliConfig> = {};
  if (typeof o.url === 'string') out.url = o.url;
  if (typeof o.token === 'string') out.token = o.token;
  return out;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CliConfig {
  const file = readConfigFile(env);
  const url = env.PIDB_URL ?? file.url;
  const token = env.PIDB_TOKEN ?? file.token;
  if (!url || !token) {
    throw new CliError('not configured — run `pidb login <url>`, or set PIDB_URL and PIDB_TOKEN', EXIT_AUTH);
  }
  return { url: normalizeUrl(url), token };
}

export function saveConfig(config: CliConfig, env: NodeJS.ProcessEnv = process.env): string {
  const path = configPath(env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify({ url: config.url, token: config.token }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600); // writeFileSync's mode is ignored when the file already exists
  return path;
}
```

Append to `packages/cli/src/index.ts`:

```ts
export * from './config.js';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/cli/test/config.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cli
git commit -m "feat(cli): resolve and persist url/token configuration

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
git log -1 --format=%B
```

---

## Task 3: HTTP client, API types, live-server test fixture

**Files:**
- Create: `packages/cli/src/api-types.ts`, `packages/cli/src/client.ts`, `packages/cli/test/helpers.ts`
- Modify: `packages/cli/src/index.ts`
- Test: `packages/cli/test/client.test.ts`

**Interfaces:**
- Consumes: `CliConfig` (`./config.js`), `CliError` + exit constants (`./errors.js`).
- Produces:
  - `class ApiError extends CliError { status: number; body: ApiErrorBody }`
  - `class PidbClient` with `json<T>(method, path, opts?)`, `jsonStatus<T>(method, path, opts?)` → `{status, data}`, `text(method, path, opts?)`, `empty(method, path, opts?)`
  - `scopedPath(target: string, kind: 'secrets' | 'docs', rest?: string): string` and `seg(s: string): string`
  - API types `PublicProject`, `PublicDocSummary`, `PublicDoc`, `ResolvedRef`, `PublicSecret`, `PublicToken`, `SearchResult`, `ProjectDetail`, `RevealedFields`
  - test fixture `makeServer()` → `{ url, db, ring, token, project, secret, doc, close }`

- [ ] **Step 1: Write the API response types**

`packages/cli/src/api-types.ts`:

```ts
import type { DocCategory, ProjectStatus, Scope } from '@pidb/shared';

export interface PublicProject {
  slug: string;
  name: string;
  status: ProjectStatus;
  tags: string[];
  summary: string;
  created_at: number;
  updated_at: number;
}

export interface PublicDocSummary {
  slug: string;
  title: string;
  category: DocCategory;
  created_at: number;
  updated_at: number;
}

export interface ResolvedRef {
  ref: string;
  name: string;
  project: string | null;
  fields: { key: string; sensitive: boolean }[];
}

export interface PublicDoc extends PublicDocSummary {
  body_md: string;
  refs?: ResolvedRef[];
}

export interface SecretFieldMeta {
  key: string;
  sensitive: boolean;
  value?: string;
}

export interface PublicSecret {
  name: string;
  description: string;
  tags: string[];
  fields: SecretFieldMeta[];
  created_at: number;
  updated_at: number;
}

export interface ProjectDetail extends PublicProject {
  documents: PublicDocSummary[];
  secrets: PublicSecret[];
}

export interface RevealedFields {
  name: string;
  fields: Record<string, string>;
}

export interface PublicToken {
  id: number;
  name: string;
  prefix: string;
  scopes: Scope[];
  projects: string[] | null;
  expires_at: number | null;
  last_used_at: number | null;
  revoked_at: number | null;
  created_at: number;
}

export interface SearchResult {
  projects?: PublicProject[];
  documents?: { project: string | null; slug: string; title: string; category: string; snippet: string }[];
  secrets?: { project: string | null; name: string; tags: string[] }[];
}
```

- [ ] **Step 2: Write the live-server test fixture**

`packages/cli/test/helpers.ts` (imports the server package by relative path — test-only, the CLI package itself never depends on the server):

```ts
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Scope } from '@pidb/shared';
import { openDb, type Db } from '../../server/src/db/connection.js';
import { buildApp } from '../../server/src/http/app.js';
import type { KeyRing } from '../../server/src/config.js';
import { createToken } from '../../server/src/repos/tokens.js';
import { createProject, getProjectBySlug } from '../../server/src/repos/projects.js';
import { createSecret } from '../../server/src/repos/secrets.js';
import { upsertDocument } from '../../server/src/repos/documents.js';
import { createAdmin } from '../../server/src/repos/admin.js';
import { hashPassword } from '../../server/src/crypto/passwords.js';

export interface ServerFixture {
  url: string;
  db: Db;
  ring: KeyRing;
  token: (scopes: Scope[], projects?: string[] | null) => string;
  project: (slug: string) => void;
  secret: (project: string | null, name: string, fields: { key: string; value: string; sensitive?: boolean }[]) => void;
  doc: (project: string | null, slug: string, body_md: string) => void;
  admin: (username: string, password: string) => Promise<void>;
  close: () => Promise<void>;
}

export async function makeServer(): Promise<ServerFixture> {
  const db = openDb(':memory:');
  const ring: KeyRing = { current: 1, keys: new Map([[1, randomBytes(32)]]) };
  const app = await buildApp({ db, ring, logLevel: 'silent' });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address() as AddressInfo;
  const idOf = (slug: string | null) => (slug === null ? null : getProjectBySlug(db, slug)!.id);
  return {
    url: `http://127.0.0.1:${port}`,
    db,
    ring,
    token: (scopes, projects = null) =>
      createToken(db, {
        name: 'test',
        scopes,
        projectIds: projects === null ? null : projects.map((s) => getProjectBySlug(db, s)!.id),
        expiresAt: null,
      }).token,
    project: (slug) => {
      createProject(db, { slug, name: slug.toUpperCase(), status: 'active', tags: [], summary: '' });
    },
    secret: (project, name, fields) => {
      createSecret(db, ring, { projectId: idOf(project), name, description: '', tags: [], fields });
    },
    doc: (project, slug, body_md) => {
      upsertDocument(db, { projectId: idOf(project), slug, title: slug, category: 'notes', body_md });
    },
    admin: async (username, password) => {
      createAdmin(db, username, await hashPassword(password));
    },
    close: async () => {
      await app.close();
    },
  };
}
```

Note: `buildApp`'s `onClose` hook is only installed by `startServer`, so this fixture closes the app and lets the in-memory database go with the process.

- [ ] **Step 3: Write the failing test**

`packages/cli/test/client.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ApiError, PidbClient, scopedPath } from '../src/client.js';
import type { PublicProject } from '../src/api-types.js';
import { makeServer, type ServerFixture } from './helpers.js';

let s: ServerFixture;
const client = (token: string) => new PidbClient({ url: s.url, token });

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

describe('scopedPath', () => {
  it('maps global and project targets', () => {
    expect(scopedPath('global', 'secrets')).toBe('/api/v1/secrets');
    expect(scopedPath('acme', 'docs', '/deploy')).toBe('/api/v1/projects/acme/docs/deploy');
    expect(scopedPath('a b', 'secrets')).toBe('/api/v1/projects/a%20b/secrets');
  });
});

describe('PidbClient', () => {
  it('sends the bearer token and parses JSON', async () => {
    const projects = await client(s.token(['projects:read'])).json<PublicProject[]>('GET', '/api/v1/projects');
    expect(projects.map((p) => p.slug)).toEqual(['acme']);
  });

  it('appends query parameters and skips undefined ones', async () => {
    const res = await client(s.token(['docs:read'])).json<Record<string, unknown>>('GET', '/api/v1/search', {
      query: { q: 'acme', missing: undefined },
    });
    expect(res).toHaveProperty('documents');
  });

  it('returns a raw value for text/plain', async () => {
    const value = await client(s.token(['secrets:reveal'])).text(
      'GET',
      '/api/v1/projects/acme/secrets/DB/fields/password',
    );
    expect(value).toBe('hunter2hunter2');
  });

  it('maps 401 to exit code 3', async () => {
    const err = await client('pidb_nope').json('GET', '/api/v1/projects').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).exitCode).toBe(3);
    expect((err as ApiError).status).toBe(401);
  });

  it('maps 403 to exit code 3 and names the missing scope', async () => {
    const err = await client(s.token(['docs:read'])).json('GET', '/api/v1/projects').catch((e: unknown) => e);
    expect((err as ApiError).exitCode).toBe(3);
    expect((err as ApiError).message).toContain('projects:read');
  });

  it('maps 404 to exit code 4', async () => {
    const err = await client(s.token(['projects:read'])).json('GET', '/api/v1/projects/nope').catch((e: unknown) => e);
    expect((err as ApiError).exitCode).toBe(4);
  });

  it('renders 422 lint findings and unresolved refs', async () => {
    const c = client(s.token(['docs:write', 'docs:read']));
    const lint = await c
      .json('PUT', '/api/v1/projects/acme/docs/notes', {
        body: { title: 'T', category: 'notes', body_md: 'password = hunter2hunter2' },
      })
      .catch((e: unknown) => e);
    expect((lint as ApiError).status).toBe(422);
    expect((lint as ApiError).message).toMatch(/lint/);
    expect((lint as ApiError).message).toMatch(/line 1/);

    const refs = await c
      .json('PUT', '/api/v1/projects/acme/docs/notes', {
        body: { title: 'T', category: 'notes', body_md: 'see {{secret:Missing}}' },
      })
      .catch((e: unknown) => e);
    expect((refs as ApiError).message).toMatch(/\{\{secret:Missing\}\}/);
  });

  it('reports an unreachable server as a generic error', async () => {
    const err = await new PidbClient({ url: 'http://127.0.0.1:1', token: 't' })
      .json('GET', '/api/v1/projects')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as ApiError).exitCode).toBe(1);
    expect((err as Error).message).toMatch(/cannot reach/);
  });

  it('handles 204 responses', async () => {
    const c = client(s.token(['docs:write']));
    await c.json('PUT', '/api/v1/docs/tmp-doc', { body: { title: 'T', category: 'notes', body_md: 'hi' } });
    await expect(c.empty('DELETE', '/api/v1/docs/tmp-doc')).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npx vitest run packages/cli/test/client.test.ts`
Expected: FAIL — cannot resolve `../src/client.js`.

- [ ] **Step 5: Write the implementation**

`packages/cli/src/client.ts`:

```ts
import type { CliConfig } from './config.js';
import { CliError, EXIT_AUTH, EXIT_GENERIC, EXIT_NOT_FOUND } from './errors.js';

export interface ApiErrorBody {
  error: string;
  message?: string;
  [key: string]: unknown;
}

function exitCodeFor(status: number): number {
  if (status === 401 || status === 403) return EXIT_AUTH;
  if (status === 404) return EXIT_NOT_FOUND;
  return EXIT_GENERIC;
}

function describeError(status: number, body: ApiErrorBody): string {
  const head = body.message && body.message !== body.error ? `${body.error}: ${body.message}` : body.error;
  const lines = [`${head} (HTTP ${status})`];
  if (typeof body.scope === 'string') lines.push(`  required scope: ${body.scope}`);
  if (Array.isArray(body.findings)) {
    for (const f of body.findings) {
      const finding = f as { line?: number; reason?: string };
      lines.push(`  line ${finding.line ?? '?'}: ${finding.reason ?? 'possible secret value'}`);
    }
    lines.push('  re-run with --force to save anyway');
  }
  if (Array.isArray(body.unresolved)) {
    lines.push(`  unresolved refs: ${body.unresolved.join(', ')}`);
    lines.push('  re-run with --force to save anyway');
  }
  if (Array.isArray(body.issues)) {
    for (const i of body.issues) {
      const issue = i as { path?: unknown[]; message?: string };
      const path = (issue.path ?? []).join('.') || '(root)';
      lines.push(`  ${path}: ${issue.message ?? 'invalid'}`);
    }
  }
  return lines.join('\n');
}

export class ApiError extends CliError {
  constructor(
    public readonly status: number,
    public readonly body: ApiErrorBody,
  ) {
    super(describeError(status, body), exitCodeFor(status));
    this.name = 'ApiError';
  }
}

export interface RequestOptions {
  body?: unknown;
  accept?: string;
  query?: Record<string, string | number | undefined>;
}

export function seg(value: string): string {
  return encodeURIComponent(value);
}

/** `global` targets the top-level collection; anything else is a project slug. */
export function scopedPath(target: string, kind: 'secrets' | 'docs', rest = ''): string {
  const base = target === 'global' ? `/api/v1/${kind}` : `/api/v1/projects/${seg(target)}/${kind}`;
  return `${base}${rest}`;
}

export class PidbClient {
  constructor(
    private readonly config: CliConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get url(): string {
    return this.config.url;
  }

  private target(path: string, query: RequestOptions['query']): string {
    const u = new URL(this.config.url + path);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) u.searchParams.set(key, String(value));
    }
    return u.toString();
  }

  private async send(method: string, path: string, opts: RequestOptions = {}): Promise<Response> {
    const headers: Record<string, string> = { accept: opts.accept ?? 'application/json' };
    if (this.config.token) headers.authorization = `Bearer ${this.config.token}`;
    if (opts.body !== undefined) headers['content-type'] = 'application/json';

    let res: Response;
    try {
      res = await this.fetchImpl(this.target(path, opts.query), {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new CliError(`cannot reach ${this.config.url}: ${reason}`);
    }

    if (!res.ok) {
      const text = await res.text();
      let body: ApiErrorBody = { error: 'http_error', message: text.slice(0, 500) };
      try {
        const parsed = JSON.parse(text) as unknown;
        if (parsed && typeof parsed === 'object' && typeof (parsed as ApiErrorBody).error === 'string') {
          body = parsed as ApiErrorBody;
        }
      } catch {
        // keep the raw-text fallback
      }
      throw new ApiError(res.status, body);
    }
    return res;
  }

  async json<T>(method: string, path: string, opts?: RequestOptions): Promise<T> {
    const res = await this.send(method, path, opts);
    return (await res.json()) as T;
  }

  /** Same as json(), but keeps the status code — `PUT /docs/:doc` answers 201 on create and 200 on update. */
  async jsonStatus<T>(method: string, path: string, opts?: RequestOptions): Promise<{ status: number; data: T }> {
    const res = await this.send(method, path, opts);
    return { status: res.status, data: (await res.json()) as T };
  }

  async text(method: string, path: string, opts?: RequestOptions): Promise<string> {
    const res = await this.send(method, path, { ...opts, accept: 'text/plain' });
    return await res.text();
  }

  async empty(method: string, path: string, opts?: RequestOptions): Promise<void> {
    await this.send(method, path, opts);
  }
}
```

Append to `packages/cli/src/index.ts`:

```ts
export * from './api-types.js';
export * from './client.js';
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run packages/cli/test/client.test.ts`
Expected: PASS (10 tests).

If the `lint` assertion fails because the server did not flag `password = hunter2hunter2`, STOP and report BLOCKED with the actual response body — do not weaken the assertion.

- [ ] **Step 7: Commit**

```bash
git add packages/cli
git commit -m "feat(cli): add HTTP client with server error to exit-code mapping

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
git log -1 --format=%B
```

---

## Task 4: Output helpers

**Files:**
- Create: `packages/cli/src/output.ts`
- Modify: `packages/cli/src/index.ts`
- Test: `packages/cli/test/output.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface CommandResult { json: unknown; text: string }` — every command function in Tasks 5–11 returns this
  - `table(columns: string[], rows: (string | number | null | undefined)[][]): string`
  - `fmtTime(ms: number | null | undefined): string` — `2026-09-12T14:03:15Z`
  - `emit(result: CommandResult, asJson: boolean, out?: NodeJS.WritableStream): void`

- [ ] **Step 1: Write the failing test**

`packages/cli/test/output.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { emit, fmtTime, table, type CommandResult } from '../src/output.js';

describe('table', () => {
  it('pads columns and underlines the header', () => {
    const out = table(['SLUG', 'NAME'], [['acme', 'Acme Inc'], ['x', 'X']]);
    expect(out.split('\n')).toEqual(['SLUG  NAME', '----  ----', 'acme  Acme Inc', 'x     X']);
  });

  it('renders empty and nullish cells without trailing spaces', () => {
    expect(table(['A', 'B'], [['a', null], ['b', undefined]]).split('\n')).toEqual(['A  B', '-  -', 'a', 'b']);
  });

  it('handles zero rows', () => {
    expect(table(['A'], [])).toBe('A\n-');
  });
});

describe('fmtTime', () => {
  it('formats epoch milliseconds as second-precision UTC', () => {
    expect(fmtTime(Date.UTC(2026, 8, 12, 14, 3, 15, 533))).toBe('2026-09-12T14:03:15Z');
  });
  it('renders nothing for null', () => {
    expect(fmtTime(null)).toBe('');
  });
});

describe('emit', () => {
  const capture = () => {
    const chunks: string[] = [];
    return { chunks, out: { write: (c: string) => chunks.push(c) } as unknown as NodeJS.WritableStream };
  };
  const result: CommandResult = { json: { a: 1 }, text: 'a=1' };

  it('writes text by default', () => {
    const { chunks, out } = capture();
    emit(result, false, out);
    expect(chunks.join('')).toBe('a=1\n');
  });

  it('writes pretty JSON with --json', () => {
    const { chunks, out } = capture();
    emit(result, true, out);
    expect(chunks.join('')).toBe('{\n  "a": 1\n}\n');
  });

  it('writes nothing for empty text', () => {
    const { chunks, out } = capture();
    emit({ json: null, text: '' }, false, out);
    expect(chunks.join('')).toBe('');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/cli/test/output.test.ts`
Expected: FAIL — cannot resolve `../src/output.js`.

- [ ] **Step 3: Write the implementation**

`packages/cli/src/output.ts`:

```ts
export interface CommandResult {
  json: unknown;
  text: string;
}

type Cell = string | number | null | undefined;

export function table(columns: string[], rows: Cell[][]): string {
  const cells = rows.map((row) => columns.map((_, i) => (row[i] === null || row[i] === undefined ? '' : String(row[i]))));
  const widths = columns.map((column, i) => Math.max(column.length, ...cells.map((row) => (row[i] ?? '').length)));
  const line = (row: string[]) => row.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join('  ').trimEnd();
  return [line(columns), line(widths.map((w) => '-'.repeat(w))), ...cells.map(line)].join('\n');
}

export function fmtTime(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '';
  return `${new Date(ms).toISOString().slice(0, 19)}Z`;
}

export function emit(result: CommandResult, asJson: boolean, out: NodeJS.WritableStream = process.stdout): void {
  if (asJson) {
    out.write(`${JSON.stringify(result.json, null, 2)}\n`);
    return;
  }
  if (result.text) out.write(`${result.text}\n`);
}
```

`Math.max` with an empty spread returns `-Infinity`; the column header length is always included first, so `widths` is safe for zero rows.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/cli/test/output.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cli
git commit -m "feat(cli): add table, timestamp and emit output helpers

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
git log -1 --format=%B
```

---

## Task 5: CLI entry point, prompts, `pidb login`

**Files:**
- Create: `packages/cli/src/prompt.ts`, `packages/cli/src/commands/login.ts`, `packages/cli/src/cli.ts`
- Modify: `packages/cli/src/index.ts`
- Test: `packages/cli/test/login.test.ts`

**Interfaces:**
- Consumes: `PidbClient` (`../client.js`), `saveConfig` / `normalizeUrl` / `loadConfig` (`../config.js`), `CommandResult` (`../output.js`), `CliError` (`../errors.js`).
- Produces:
  - `prompt(question: string): Promise<string>`, `promptHidden(question: string): Promise<string>` (`./prompt.js`)
  - `runLogin(url: string, opts: LoginOptions, env?, io?): Promise<CommandResult>` where
    `interface LoginOptions { username?: string; name?: string }` and
    `interface LoginIo { prompt: (q: string) => Promise<string>; promptHidden: (q: string) => Promise<string> }`
  - `packages/cli/src/cli.ts` exporting `buildProgram(): Command` and running it when executed as the bin. Later tasks register their commands inside `buildProgram`.
  - `clientFrom(env?: NodeJS.ProcessEnv): PidbClient` (in `cli.ts`) — builds a client from `loadConfig`.

- [ ] **Step 1: Write the prompt module**

`packages/cli/src/prompt.ts` (same TTY handling as `packages/server/src/cli.ts`, including the Ruling R16 raw-mode restore and the Ruling R22 non-TTY `terminal: false`):

```ts
import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const CTRL_C = '\u0003';
const BACKSPACE = '\u007f';

export async function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

export function promptHidden(question: string): Promise<string> {
  stdout.write(question);
  if (!stdin.isTTY) {
    // terminal:false — readline echoes input when stdout is a TTY, which would
    // print the password for a piped stdin.
    const rl = readline.createInterface({ input: stdin, output: stdout, terminal: false });
    return rl.question('').then((answer) => {
      rl.close();
      return answer.trim();
    });
  }
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
        if (ch === CTRL_C) {
          stdin.setRawMode(false);
          stdout.write('\n');
          process.exit(130);
        }
        if (ch === BACKSPACE) buf = buf.slice(0, -1);
        else buf += ch;
      }
    };
    stdin.on('data', onData);
  });
}
```

- [ ] **Step 2: Write the failing test**

`packages/cli/test/login.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLogin } from '../src/commands/login.js';
import { configPath } from '../src/config.js';
import { CliError } from '../src/errors.js';
import { makeServer, type ServerFixture } from './helpers.js';

let s: ServerFixture;
let home: string;
const env = () => ({ PIDB_CONFIG_HOME: home }) as NodeJS.ProcessEnv;
const io = (password: string, username = 'alex') => ({
  prompt: async () => username,
  promptHidden: async () => password,
});

beforeAll(async () => {
  s = await makeServer();
  await s.admin('alex', 'correct horse battery');
});
afterAll(async () => {
  await s.close();
});
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'pidb-login-'));
});

describe('runLogin', () => {
  it('exchanges credentials for a token and saves a 0600 config', async () => {
    const result = await runLogin(`${s.url}/`, { name: 'cli-test' }, env(), io('correct horse battery'));
    const saved = JSON.parse(readFileSync(configPath(env()), 'utf8')) as { url: string; token: string };
    expect(saved.url).toBe(s.url);
    expect(saved.token).toMatch(/^pidb_/);
    expect(statSync(configPath(env())).mode & 0o777).toBe(0o600);
    expect(result.text).toContain(s.url);
    expect(result.text).toContain('cli-test');
    expect(result.text).not.toContain(saved.token);
    expect(JSON.stringify(result.json)).not.toContain(saved.token);
  });

  it('defaults the token name to cli-<hostname>', async () => {
    await runLogin(s.url, {}, env(), io('correct horse battery'));
    const token = (JSON.parse(readFileSync(configPath(env()), 'utf8')) as { token: string }).token;
    const rows = s.db.prepare('SELECT name FROM api_tokens ORDER BY id DESC LIMIT 1').all() as { name: string }[];
    expect(rows[0]!.name).toMatch(/^cli-/);
    expect(token).toMatch(/^pidb_/);
  });

  it('exits 3 on bad credentials and writes no config', async () => {
    const err = await runLogin(s.url, {}, env(), io('wrong')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(3);
    expect(() => readFileSync(configPath(env()), 'utf8')).toThrow();
  });

  it('takes the username from --username without prompting', async () => {
    const io2 = {
      prompt: async () => {
        throw new Error('should not prompt for a username');
      },
      promptHidden: async () => 'correct horse battery',
    };
    await expect(runLogin(s.url, { username: 'alex' }, env(), io2)).resolves.toBeTruthy();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run packages/cli/test/login.test.ts`
Expected: FAIL — cannot resolve `../src/commands/login.js`.

- [ ] **Step 4: Write the login command**

`packages/cli/src/commands/login.ts`:

```ts
import { hostname } from 'node:os';
import { PidbClient } from '../client.js';
import { normalizeUrl, saveConfig } from '../config.js';
import { CliError } from '../errors.js';
import type { CommandResult } from '../output.js';
import { prompt as defaultPrompt, promptHidden as defaultPromptHidden } from '../prompt.js';

export interface LoginOptions {
  username?: string;
  name?: string;
}

export interface LoginIo {
  prompt: (question: string) => Promise<string>;
  promptHidden: (question: string) => Promise<string>;
}

interface AuthTokenResponse {
  token: string;
  id: number;
  name: string;
}

export async function runLogin(
  rawUrl: string,
  opts: LoginOptions,
  env: NodeJS.ProcessEnv = process.env,
  io: LoginIo = { prompt: defaultPrompt, promptHidden: defaultPromptHidden },
): Promise<CommandResult> {
  const url = normalizeUrl(rawUrl);
  const username = opts.username ?? (await io.prompt('Admin username: '));
  const password = await io.promptHidden('Admin password: ');
  if (!username || !password) throw new CliError('username and password are required');
  const name = opts.name ?? `cli-${hostname()}`;

  // No token yet: the /auth/token route is public, and PidbClient omits the
  // Authorization header for an empty token.
  const client = new PidbClient({ url, token: '' });
  const res = await client.json<AuthTokenResponse>('POST', '/api/v1/auth/token', {
    body: { username, password, name },
  });
  const path = saveConfig({ url, token: res.token }, env);
  return {
    json: { url, token_id: res.id, token_name: res.name, config: path },
    text: `logged in to ${url}; admin token "${res.name}" (id ${res.id}) saved to ${path}`,
  };
}
```

- [ ] **Step 5: Write the CLI entry point**

`packages/cli/src/cli.ts`:

```ts
#!/usr/bin/env node
import { Command } from 'commander';
import { PidbClient } from './client.js';
import { loadConfig } from './config.js';
import { CliError } from './errors.js';
import { emit } from './output.js';
import { runLogin } from './commands/login.js';

export function clientFrom(env: NodeJS.ProcessEnv = process.env): PidbClient {
  return new PidbClient(loadConfig(env));
}

export function buildProgram(): Command {
  const program = new Command()
    .name('pidb')
    .description('Projects Info DB client')
    .showHelpAfterError();

  program
    .command('login')
    .argument('<url>', 'server base url, e.g. https://pidb.example.com')
    .option('--username <username>', 'admin username (prompts when omitted)')
    .option('--name <name>', 'token name (default: cli-<hostname>)')
    .description('Exchange admin credentials for an API token and save it')
    .action(async (url: string, opts: { username?: string; name?: string }) => {
      emit(await runLogin(url, opts), false);
    });

  return program;
}

export function exitCodeOf(err: unknown): number {
  return err instanceof CliError ? err.exitCode : 1;
}

export async function main(argv: string[] = process.argv): Promise<void> {
  try {
    await buildProgram().parseAsync(argv);
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(exitCodeOf(err));
  }
}

// Run only when this module is the entry point, so tests can import it freely.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
```

Note: commander exits the process itself for `--help` and for usage errors; only thrown `CliError`s reach the `catch`.

Append to `packages/cli/src/index.ts`:

```ts
export * from './output.js';
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run packages/cli/test/login.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 7: Verify the binary runs**

Run: `npx tsx packages/cli/src/cli.ts --help`
Expected: usage text listing `login`. Exit code 0.

- [ ] **Step 8: Commit**

```bash
git add packages/cli
git commit -m "feat(cli): add cli entry point, prompts and pidb login

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
git log -1 --format=%B
```

---

## Task 6: `projects list|get` and `search`

**Files:**
- Create: `packages/cli/src/commands/projects.ts`
- Modify: `packages/cli/src/cli.ts`
- Test: `packages/cli/test/projects.test.ts`

**Interfaces:**
- Consumes: `PidbClient`, `scopedPath`/`seg`, API types, `CommandResult`/`table`/`fmtTime`.
- Produces:
  - `runProjectsList(client): Promise<CommandResult>`
  - `runProjectsGet(client, slug: string): Promise<CommandResult>`
  - `runSearch(client, query: string): Promise<CommandResult>`

- [ ] **Step 1: Write the failing test**

`packages/cli/test/projects.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PidbClient } from '../src/client.js';
import { runProjectsGet, runProjectsList, runSearch } from '../src/commands/projects.js';
import type { ProjectDetail, PublicProject } from '../src/api-types.js';
import { makeServer, type ServerFixture } from './helpers.js';

let s: ServerFixture;
const client = (scopes: Parameters<ServerFixture['token']>[0]) => new PidbClient({ url: s.url, token: s.token(scopes) });

beforeAll(async () => {
  s = await makeServer();
  s.project('acme');
  s.project('beta');
  s.doc('acme', 'deploy', 'how to deploy acme');
  s.secret('acme', 'DB', [{ key: 'host', value: 'db.internal' }, { key: 'password', value: 'hunter2hunter2' }]);
});
afterAll(async () => {
  await s.close();
});

describe('projects list', () => {
  it('renders a table of projects', async () => {
    const result = await runProjectsList(client(['projects:read']));
    expect(result.text.split('\n')[0]).toMatch(/^SLUG\s+NAME\s+STATUS\s+TAGS\s+UPDATED$/);
    expect(result.text).toContain('acme');
    expect(result.text).toContain('beta');
    expect((result.json as PublicProject[]).map((p) => p.slug)).toEqual(['acme', 'beta']);
  });

  it('says so when there is nothing to list', async () => {
    s.db.exec("DELETE FROM projects WHERE slug = 'beta'");
    const result = await runProjectsList(client(['projects:read']));
    expect(result.text).toContain('acme');
    s.project('beta');
  });
});

describe('projects get', () => {
  it('shows the project with its documents and secret names', async () => {
    const result = await runProjectsGet(client(['projects:read', 'docs:read', 'secrets:meta']), 'acme');
    expect(result.text).toContain('acme');
    expect(result.text).toContain('deploy');
    expect(result.text).toContain('DB');
    const detail = result.json as ProjectDetail;
    expect(detail.documents.map((d) => d.slug)).toEqual(['deploy']);
    expect(detail.secrets[0]!.fields.map((f) => f.key).sort()).toEqual(['host', 'password']);
  });

  it('never prints a sensitive value', async () => {
    const result = await runProjectsGet(client(['projects:read', 'secrets:meta']), 'acme');
    expect(result.text).not.toContain('hunter2hunter2');
    expect(JSON.stringify(result.json)).not.toContain('hunter2hunter2');
  });
});

describe('search', () => {
  it('renders each section the token can see', async () => {
    const result = await runSearch(client(['projects:read', 'docs:read', 'secrets:meta']), 'deploy');
    expect(result.text).toMatch(/documents/i);
    expect(result.text).toContain('deploy');
  });

  it('omits sections the token cannot see', async () => {
    const result = await runSearch(client(['docs:read']), 'deploy');
    expect(result.text).not.toMatch(/secrets/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/cli/test/projects.test.ts`
Expected: FAIL — cannot resolve `../src/commands/projects.js`.

- [ ] **Step 3: Write the implementation**

`packages/cli/src/commands/projects.ts`:

```ts
import type { PidbClient } from '../client.js';
import { seg } from '../client.js';
import type { ProjectDetail, PublicProject, SearchResult } from '../api-types.js';
import { fmtTime, table, type CommandResult } from '../output.js';

export async function runProjectsList(client: PidbClient): Promise<CommandResult> {
  const projects = await client.json<PublicProject[]>('GET', '/api/v1/projects');
  return {
    json: projects,
    text: table(
      ['SLUG', 'NAME', 'STATUS', 'TAGS', 'UPDATED'],
      projects.map((p) => [p.slug, p.name, p.status, p.tags.join(','), fmtTime(p.updated_at)]),
    ),
  };
}

export async function runProjectsGet(client: PidbClient, slug: string): Promise<CommandResult> {
  const detail = await client.json<ProjectDetail>('GET', `/api/v1/projects/${seg(slug)}`);
  const sections = [
    `${detail.slug}  ${detail.name}  [${detail.status}]${detail.tags.length ? `  tags: ${detail.tags.join(',')}` : ''}`,
  ];
  if (detail.summary) sections.push('', detail.summary);
  sections.push('', 'Documents:', table(['SLUG', 'TITLE', 'CATEGORY', 'UPDATED'],
    detail.documents.map((d) => [d.slug, d.title, d.category, fmtTime(d.updated_at)])));
  sections.push('', 'Secrets:', table(['NAME', 'FIELDS', 'TAGS', 'DESCRIPTION'],
    detail.secrets.map((s) => [
      s.name,
      s.fields.map((f) => (f.sensitive ? `${f.key}*` : f.key)).join(','),
      s.tags.join(','),
      s.description,
    ])));
  sections.push('', '* = sensitive; consume values with `pidb secret exec|write|env`');
  return { json: detail, text: sections.join('\n') };
}

export async function runSearch(client: PidbClient, query: string): Promise<CommandResult> {
  const result = await client.json<SearchResult>('GET', '/api/v1/search', { query: { q: query } });
  const sections: string[] = [];
  if (result.projects) {
    sections.push('Projects:', table(['SLUG', 'NAME', 'STATUS'], result.projects.map((p) => [p.slug, p.name, p.status])), '');
  }
  if (result.documents) {
    sections.push('Documents:', table(['PROJECT', 'SLUG', 'TITLE', 'SNIPPET'],
      result.documents.map((d) => [d.project ?? 'global', d.slug, d.title, d.snippet.replace(/\s+/g, ' ')])), '');
  }
  if (result.secrets) {
    sections.push('Secrets:', table(['PROJECT', 'NAME', 'TAGS'],
      result.secrets.map((x) => [x.project ?? 'global', x.name, x.tags.join(',')])), '');
  }
  return { json: result, text: sections.join('\n').trimEnd() };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/cli/test/projects.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Register the commands**

In `packages/cli/src/cli.ts`, add the imports:

```ts
import { runProjectsGet, runProjectsList, runSearch } from './commands/projects.js';
```

and inside `buildProgram()`, before `return program;`:

```ts
  const projects = program.command('projects').description('Projects');
  projects
    .command('list')
    .option('--json', 'raw JSON output')
    .action(async (opts: { json?: boolean }) => {
      emit(await runProjectsList(clientFrom()), opts.json === true);
    });
  projects
    .command('get')
    .argument('<slug>')
    .option('--json', 'raw JSON output')
    .action(async (slug: string, opts: { json?: boolean }) => {
      emit(await runProjectsGet(clientFrom(), slug), opts.json === true);
    });

  program
    .command('search')
    .argument('<query>')
    .option('--json', 'raw JSON output')
    .description('Search projects, documents and secret names (never values)')
    .action(async (query: string, opts: { json?: boolean }) => {
      emit(await runSearch(clientFrom(), query), opts.json === true);
    });
```

- [ ] **Step 6: Verify the wiring**

Run: `npx tsx packages/cli/src/cli.ts projects --help`
Expected: lists `list` and `get`. Exit code 0.

- [ ] **Step 7: Commit**

```bash
git add packages/cli
git commit -m "feat(cli): add projects list/get and search commands

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
git log -1 --format=%B
```

---

## Task 7: `docs list|get|put`

**Files:**
- Create: `packages/cli/src/commands/docs.ts`
- Modify: `packages/cli/src/cli.ts`
- Test: `packages/cli/test/docs.test.ts`

**Interfaces:**
- Consumes: `PidbClient` (incl. `jsonStatus`), `scopedPath`, `seg`, `PublicDoc`, `PublicDocSummary`, `CommandResult`, `table`, `fmtTime`, `CliError`.
- Produces:
  - `resolveDocTarget(a: string, b?: string): { target: string; doc: string }` — one positional means a global document
  - `runDocsList(client, target: string): Promise<CommandResult>`
  - `runDocsGet(client, target: string, doc: string, opts: { refs?: boolean }): Promise<CommandResult>`
  - `runDocsPut(client, target: string, doc: string, opts: DocsPutOptions): Promise<CommandResult>` where
    `interface DocsPutOptions { file: string; title: string; category: string; force?: boolean }`

- [ ] **Step 1: Write the failing test**

`packages/cli/test/docs.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PidbClient } from '../src/client.js';
import { ApiError } from '../src/client.js';
import { resolveDocTarget, runDocsGet, runDocsList, runDocsPut } from '../src/commands/docs.js';
import type { PublicDoc } from '../src/api-types.js';
import { makeServer, type ServerFixture } from './helpers.js';

let s: ServerFixture;
let dir: string;
const client = (scopes: Parameters<ServerFixture['token']>[0]) => new PidbClient({ url: s.url, token: s.token(scopes) });

beforeAll(async () => {
  s = await makeServer();
  dir = mkdtempSync(join(tmpdir(), 'pidb-docs-'));
  s.project('acme');
  s.doc('acme', 'deploy', '# Deploy\n\nssh to the box.\n');
  s.doc(null, 'guidelines', '# Guidelines\n');
  s.secret('acme', 'DB', [{ key: 'host', value: 'db.internal' }]);
});
afterAll(async () => {
  await s.close();
});

describe('resolveDocTarget', () => {
  it('treats a single positional as a global document', () => {
    expect(resolveDocTarget('guidelines')).toEqual({ target: 'global', doc: 'guidelines' });
    expect(resolveDocTarget('acme', 'deploy')).toEqual({ target: 'acme', doc: 'deploy' });
    expect(resolveDocTarget('global', 'guidelines')).toEqual({ target: 'global', doc: 'guidelines' });
  });
});

describe('docs list', () => {
  it('lists project documents', async () => {
    const result = await runDocsList(client(['docs:read']), 'acme');
    expect(result.text).toContain('deploy');
    expect(result.text).not.toContain('guidelines');
  });

  it('lists global documents', async () => {
    const result = await runDocsList(client(['docs:read']), 'global');
    expect(result.text).toContain('guidelines');
  });
});

describe('docs get', () => {
  it('prints the raw markdown body', async () => {
    const result = await runDocsGet(client(['docs:read']), 'acme', 'deploy', {});
    expect(result.text).toBe('# Deploy\n\nssh to the box.\n');
    expect((result.json as PublicDoc).slug).toBe('deploy');
  });

  it('appends resolved refs with --refs', async () => {
    await runDocsPut(client(['docs:write']), 'acme', 'refs-doc', {
      file: write(join(dir, 'refs.md'), 'db lives at {{secret:DB}}\n'),
      title: 'Refs',
      category: 'notes',
    });
    const result = await runDocsGet(client(['docs:read', 'secrets:meta']), 'acme', 'refs-doc', { refs: true });
    expect(result.text).toContain('{{secret:DB}}');
    expect(result.text).toMatch(/host/);
    expect(result.text).toMatch(/pidb secret exec/);
  });

  it('exits 4 for an unknown document', async () => {
    const err = await runDocsGet(client(['docs:read']), 'acme', 'nope', {}).catch((e: unknown) => e);
    expect((err as ApiError).exitCode).toBe(4);
  });
});

describe('docs put', () => {
  it('creates and then updates a document from a file', async () => {
    const file = write(join(dir, 'notes.md'), '# Notes\n');
    const created = await runDocsPut(client(['docs:write']), 'acme', 'notes', { file, title: 'Notes', category: 'notes' });
    expect(created.text).toMatch(/created/);
    const updated = await runDocsPut(client(['docs:write']), 'acme', 'notes', { file, title: 'Notes 2', category: 'notes' });
    expect(updated.text).toMatch(/updated/);
  });

  it('surfaces lint findings and accepts --force', async () => {
    const file = write(join(dir, 'leak.md'), 'db password = hunter2hunter2\n');
    const err = await runDocsPut(client(['docs:write']), 'acme', 'leak', { file, title: 'Leak', category: 'notes' }).catch((e: unknown) => e);
    expect((err as ApiError).status).toBe(422);
    expect((err as ApiError).message).toMatch(/--force/);
    await expect(
      runDocsPut(client(['docs:write']), 'acme', 'leak', { file, title: 'Leak', category: 'notes', force: true }),
    ).resolves.toBeTruthy();
  });

  it('reports a missing file as a generic error', async () => {
    const err = await runDocsPut(client(['docs:write']), 'acme', 'x', {
      file: join(dir, 'missing.md'),
      title: 'X',
      category: 'notes',
    }).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/cannot read/);
    expect((err as { exitCode?: number }).exitCode).toBe(1);
  });

  it('rejects an unknown category before calling the server', async () => {
    const err = await runDocsPut(client(['docs:write']), 'acme', 'x', {
      file: write(join(dir, 'ok.md'), 'hi\n'),
      title: 'X',
      category: 'nonsense',
    }).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/category/);
  });
});

function write(path: string, content: string): string {
  writeFileSync(path, content);
  return path;
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/cli/test/docs.test.ts`
Expected: FAIL — cannot resolve `../src/commands/docs.js`.

- [ ] **Step 3: Write the implementation**

`packages/cli/src/commands/docs.ts`:

```ts
import { readFileSync } from 'node:fs';
import { DOC_CATEGORIES, type DocCategory } from '@pidb/shared';
import { scopedPath, seg, type PidbClient } from '../client.js';
import type { PublicDoc, PublicDocSummary } from '../api-types.js';
import { CliError } from '../errors.js';
import { fmtTime, table, type CommandResult } from '../output.js';

export interface DocsPutOptions {
  file: string;
  title: string;
  category: string;
  force?: boolean;
}

/** `pidb docs get guidelines` is the global doc; `pidb docs get acme deploy` is the project one. */
export function resolveDocTarget(a: string, b?: string): { target: string; doc: string } {
  return b === undefined ? { target: 'global', doc: a } : { target: a, doc: b };
}

export async function runDocsList(client: PidbClient, target: string): Promise<CommandResult> {
  const docs = await client.json<PublicDocSummary[]>('GET', scopedPath(target, 'docs'));
  return {
    json: docs,
    text: table(['SLUG', 'TITLE', 'CATEGORY', 'UPDATED'], docs.map((d) => [d.slug, d.title, d.category, fmtTime(d.updated_at)])),
  };
}

export async function runDocsGet(
  client: PidbClient,
  target: string,
  doc: string,
  opts: { refs?: boolean },
): Promise<CommandResult> {
  const result = await client.json<PublicDoc>('GET', scopedPath(target, 'docs', `/${seg(doc)}`), {
    query: { resolve: opts.refs ? 'meta' : undefined },
  });
  let text = result.body_md;
  if (opts.refs) {
    const refs = result.refs ?? [];
    const rows = refs.map((r) => [
      r.ref,
      r.project ?? 'global',
      r.name,
      r.fields.map((f) => (f.sensitive ? `${f.key}*` : f.key)).join(','),
    ]);
    text = [
      text.replace(/\n+$/, ''),
      '',
      '--- secret references ---',
      table(['REF', 'PROJECT', 'SECRET', 'FIELDS'], rows),
      '',
      'consume values with: pidb secret exec <project|global> "<secret>" -- <command>',
    ].join('\n');
  }
  return { json: result, text };
}

export async function runDocsPut(
  client: PidbClient,
  target: string,
  doc: string,
  opts: DocsPutOptions,
): Promise<CommandResult> {
  if (!(DOC_CATEGORIES as readonly string[]).includes(opts.category)) {
    throw new CliError(`unknown category "${opts.category}" — one of: ${DOC_CATEGORIES.join(', ')}`);
  }
  let body_md: string;
  try {
    body_md = readFileSync(opts.file, 'utf8');
  } catch (err) {
    throw new CliError(`cannot read ${opts.file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const { status, data: saved } = await client.jsonStatus<PublicDoc>('PUT', scopedPath(target, 'docs', `/${seg(doc)}`), {
    body: { title: opts.title, category: opts.category as DocCategory, body_md, force: opts.force === true },
  });
  const created = status === 201; // the server answers 201 on create, 200 on update
  return {
    json: saved,
    text: `${created ? 'created' : 'updated'} ${target === 'global' ? '' : `${target}/`}${saved.slug} (${saved.category})`,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/cli/test/docs.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Register the commands**

In `packages/cli/src/cli.ts` add:

```ts
import { resolveDocTarget, runDocsGet, runDocsList, runDocsPut } from './commands/docs.js';
```

and inside `buildProgram()`:

```ts
  const docs = program.command('docs').description('Documents (Markdown)');
  docs
    .command('list')
    .argument('[target]', 'project slug or "global"', 'global')
    .option('--json', 'raw JSON output')
    .action(async (target: string, opts: { json?: boolean }) => {
      emit(await runDocsList(clientFrom(), target), opts.json === true);
    });
  docs
    .command('get')
    .argument('<target>', 'project slug, or the document slug for a global document')
    .argument('[doc]', 'document slug')
    .option('--refs', 'resolve {{secret:...}} references')
    .option('--json', 'raw JSON output')
    .action(async (a: string, b: string | undefined, opts: { refs?: boolean; json?: boolean }) => {
      const { target, doc } = resolveDocTarget(a, b);
      emit(await runDocsGet(clientFrom(), target, doc, { refs: opts.refs }), opts.json === true);
    });
  docs
    .command('put')
    .argument('<target>', 'project slug, or the document slug for a global document')
    .argument('[doc]', 'document slug')
    .requiredOption('--file <path>', 'Markdown file to upload')
    .requiredOption('--title <title>', 'document title')
    .requiredOption('--category <category>', 'document category')
    .option('--force', 'save despite lint findings or unresolved refs')
    .option('--json', 'raw JSON output')
    .action(
      async (
        a: string,
        b: string | undefined,
        opts: { file: string; title: string; category: string; force?: boolean; json?: boolean },
      ) => {
        const { target, doc } = resolveDocTarget(a, b);
        emit(await runDocsPut(clientFrom(), target, doc, opts), opts.json === true);
      },
    );
```

- [ ] **Step 6: Verify the wiring**

Run: `npx tsx packages/cli/src/cli.ts docs --help`
Expected: lists `list`, `get`, `put`. Exit code 0.

- [ ] **Step 7: Commit**

```bash
git add packages/cli
git commit -m "feat(cli): add docs list/get/put commands

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
git log -1 --format=%B
```

---

## Task 8: `secrets list`, `secret get`, `secret set`

**Files:**
- Create: `packages/cli/src/commands/secrets.ts`
- Modify: `packages/cli/src/cli.ts`
- Test: `packages/cli/test/secrets.test.ts`

**Interfaces:**
- Consumes: `PidbClient`, `scopedPath`, `seg`, `ApiError`, `PublicSecret`, `CommandResult`, `table`, `CliError`, `EXIT_REFUSED`, `EXIT_NOT_FOUND`.
- Produces:
  - `runSecretsList(client, target: string): Promise<CommandResult>`
  - `runSecretGet(client, target, name, field, opts: { print?: boolean }): Promise<CommandResult>` — without `print`, throws `CliError(…, EXIT_REFUSED)`
  - `runSecretSet(client, target, name, field, opts: SecretSetOptions, stdin?): Promise<CommandResult>` where
    `interface SecretSetOptions { fromFile?: string; sensitive?: boolean; nonSensitive?: boolean; create?: boolean }`
  - `readSecretValue(opts, stdin): Promise<string>` (exported for the test)

- [ ] **Step 1: Write the failing test**

`packages/cli/test/secrets.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Readable } from 'node:stream';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiError, PidbClient } from '../src/client.js';
import { runSecretGet, runSecretSet, runSecretsList } from '../src/commands/secrets.js';
import type { PublicSecret } from '../src/api-types.js';
import { CliError } from '../src/errors.js';
import { makeServer, type ServerFixture } from './helpers.js';

let s: ServerFixture;
let dir: string;
const client = (scopes: Parameters<ServerFixture['token']>[0]) => new PidbClient({ url: s.url, token: s.token(scopes) });
const stdinOf = (text: string) => Readable.from([text]) as unknown as NodeJS.ReadableStream;

beforeAll(async () => {
  s = await makeServer();
  dir = mkdtempSync(join(tmpdir(), 'pidb-secrets-'));
  s.project('acme');
  s.secret('acme', 'DB', [
    { key: 'host', value: 'db.internal' },
    { key: 'password', value: 'hunter2hunter2' },
  ]);
  s.secret(null, 'Cloudflare', [{ key: 'api_key', value: 'cf-key-value' }]);
});
afterAll(async () => {
  await s.close();
});

describe('secrets list', () => {
  it('lists names, fields and sensitivity without values', async () => {
    const result = await runSecretsList(client(['secrets:meta']), 'acme');
    expect(result.text).toContain('DB');
    expect(result.text).toContain('password*');
    expect(result.text).toContain('host');
    expect(result.text).not.toContain('hunter2hunter2');
    expect((result.json as PublicSecret[])[0]!.name).toBe('DB');
  });

  it('lists global secrets', async () => {
    const result = await runSecretsList(client(['secrets:meta']), 'global');
    expect(result.text).toContain('Cloudflare');
  });
});

describe('secret get', () => {
  it('refuses to print without --print and exits 2', async () => {
    const err = await runSecretGet(client(['secrets:reveal']), 'acme', 'DB', 'password', {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(2);
    expect((err as CliError).message).toMatch(/pidb secret exec/);
    expect((err as CliError).message).not.toContain('hunter2hunter2');
  });

  it('prints the raw value with --print', async () => {
    const result = await runSecretGet(client(['secrets:reveal']), 'acme', 'DB', 'password', { print: true });
    expect(result.text).toBe('hunter2hunter2');
    expect(result.json).toEqual({ key: 'password', value: 'hunter2hunter2' });
  });

  it('exits 3 without the reveal scope', async () => {
    const err = await runSecretGet(client(['secrets:meta']), 'acme', 'DB', 'password', { print: true }).catch((e: unknown) => e);
    expect((err as ApiError).exitCode).toBe(3);
  });
});

describe('secret set', () => {
  it('upserts a field read from stdin, stripping one trailing newline', async () => {
    const result = await runSecretSet(client(['secrets:write']), 'acme', 'DB', 'token', {}, stdinOf('abc123\n'));
    expect(result.text).toMatch(/DB/);
    expect(result.text).not.toContain('abc123');
    const value = await client(['secrets:reveal']).text('GET', '/api/v1/projects/acme/secrets/DB/fields/token');
    expect(value).toBe('abc123');
  });

  it('reads --from-file verbatim', async () => {
    const path = join(dir, 'body.txt');
    writeFileSync(path, 'line1\nline2\n');
    await runSecretSet(client(['secrets:write']), 'acme', 'DB', 'blob', { fromFile: path });
    const value = await client(['secrets:reveal']).text('GET', '/api/v1/projects/acme/secrets/DB/fields/blob');
    expect(value).toBe('line1\nline2\n');
  });

  it('honours --non-sensitive', async () => {
    await runSecretSet(client(['secrets:write']), 'acme', 'DB', 'region', { nonSensitive: true }, stdinOf('eu-west-1'));
    const secret = await client(['secrets:meta']).json<PublicSecret>('GET', '/api/v1/projects/acme/secrets/DB');
    expect(secret.fields.find((f) => f.key === 'region')!.sensitive).toBe(false);
  });

  it('exits 4 for an unknown secret, and creates it with --create', async () => {
    const err = await runSecretSet(client(['secrets:write']), 'acme', 'NEW', 'k', {}, stdinOf('v')).catch((e: unknown) => e);
    expect((err as ApiError).exitCode).toBe(4);
    const created = await runSecretSet(client(['secrets:write']), 'acme', 'NEW', 'k', { create: true }, stdinOf('v'));
    expect(created.text).toMatch(/created/);
  });

  it('rejects contradictory sensitivity flags', async () => {
    const err = await runSecretSet(
      client(['secrets:write']),
      'acme',
      'DB',
      'k',
      { sensitive: true, nonSensitive: true },
      stdinOf('v'),
    ).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/--sensitive|--non-sensitive/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/cli/test/secrets.test.ts`
Expected: FAIL — cannot resolve `../src/commands/secrets.js`.

- [ ] **Step 3: Write the implementation**

`packages/cli/src/commands/secrets.ts`:

```ts
import { readFileSync } from 'node:fs';
import { ApiError, scopedPath, seg, type PidbClient } from '../client.js';
import type { PublicSecret } from '../api-types.js';
import { CliError, EXIT_REFUSED } from '../errors.js';
import { table, type CommandResult } from '../output.js';

export interface SecretSetOptions {
  fromFile?: string;
  sensitive?: boolean;
  nonSensitive?: boolean;
  create?: boolean;
}

export async function runSecretsList(client: PidbClient, target: string): Promise<CommandResult> {
  const secrets = await client.json<PublicSecret[]>('GET', scopedPath(target, 'secrets'));
  return {
    json: secrets,
    text: [
      table(
        ['NAME', 'FIELDS', 'TAGS', 'DESCRIPTION'],
        secrets.map((s) => [
          s.name,
          s.fields.map((f) => (f.sensitive ? `${f.key}*` : f.key)).join(','),
          s.tags.join(','),
          s.description,
        ]),
      ),
      '',
      '* = sensitive; consume values with `pidb secret exec|write|env`',
    ].join('\n'),
  };
}

export async function runSecretGet(
  client: PidbClient,
  target: string,
  name: string,
  field: string,
  opts: { print?: boolean },
): Promise<CommandResult> {
  if (opts.print !== true) {
    throw new CliError(
      [
        'refusing to print a secret value without --print.',
        'Prefer a command that never puts the value on screen:',
        `  pidb secret exec ${target} "${name}" -- <command>     # value as $PIDB_${field.toUpperCase()}`,
        `  pidb secret write ${target} "${name}" ${field} --out <path>`,
        `  pidb secret env ${target} "${name}" --out <path>`,
        'Re-run with --print if you really want it on stdout.',
      ].join('\n'),
      EXIT_REFUSED,
    );
  }
  const value = await client.text('GET', scopedPath(target, 'secrets', `/${seg(name)}/fields/${seg(field)}`));
  return { json: { key: field, value }, text: value };
}

async function readStdin(stdin: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString('utf8');
}

export async function readSecretValue(opts: SecretSetOptions, stdin: NodeJS.ReadableStream): Promise<string> {
  if (opts.fromFile !== undefined) {
    try {
      return readFileSync(opts.fromFile, 'utf8'); // verbatim, trailing newline included
    } catch (err) {
      throw new CliError(`cannot read ${opts.fromFile}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const raw = await readStdin(stdin);
  return raw.replace(/\n$/, ''); // one trailing newline, so `echo v | pidb secret set` does the obvious thing
}

export async function runSecretSet(
  client: PidbClient,
  target: string,
  name: string,
  field: string,
  opts: SecretSetOptions,
  stdin: NodeJS.ReadableStream = process.stdin,
): Promise<CommandResult> {
  if (opts.sensitive === true && opts.nonSensitive === true) {
    throw new CliError('--sensitive and --non-sensitive are mutually exclusive');
  }
  const value = await readSecretValue(opts, stdin);
  if (!value) throw new CliError('refusing to store an empty value', EXIT_REFUSED);
  const sensitive = opts.sensitive === true ? true : opts.nonSensitive === true ? false : undefined;
  const fieldInput = { key: field, value, ...(sensitive === undefined ? {} : { sensitive }) };

  try {
    const secret = await client.json<PublicSecret>('PATCH', scopedPath(target, 'secrets', `/${seg(name)}`), {
      body: { fields: [fieldInput] },
    });
    return { json: secret, text: `updated ${target}/${secret.name} field "${field}"` };
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 404 || opts.create !== true) throw err;
    const secret = await client.json<PublicSecret>('POST', scopedPath(target, 'secrets'), {
      body: { name, fields: [fieldInput] },
    });
    return { json: secret, text: `created ${target}/${secret.name} with field "${field}"` };
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/cli/test/secrets.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Register the commands**

In `packages/cli/src/cli.ts` add:

```ts
import { runSecretGet, runSecretSet, runSecretsList } from './commands/secrets.js';
```

and inside `buildProgram()`:

```ts
  const secrets = program.command('secrets').description('Secret metadata (never values)');
  secrets
    .command('list', { isDefault: true })
    .argument('[target]', 'project slug or "global"', 'global')
    .option('--json', 'raw JSON output')
    .action(async (target: string, opts: { json?: boolean }) => {
      emit(await runSecretsList(clientFrom(), target), opts.json === true);
    });

  const secret = program.command('secret').description('Consume a single secret');
  secret
    .command('get')
    .argument('<target>', 'project slug or "global"')
    .argument('<name>', 'secret name')
    .argument('<field>', 'field key')
    .option('--print', 'print the value to stdout (refused without this flag)')
    .option('--json', 'raw JSON output')
    .action(async (target: string, name: string, field: string, opts: { print?: boolean; json?: boolean }) => {
      emit(await runSecretGet(clientFrom(), target, name, field, opts), opts.json === true);
    });
  secret
    .command('set')
    .argument('<target>', 'project slug or "global"')
    .argument('<name>', 'secret name')
    .argument('<field>', 'field key')
    .option('--from-file <path>', 'read the value from a file instead of stdin')
    .option('--sensitive', 'mark the field sensitive')
    .option('--non-sensitive', 'mark the field non-sensitive')
    .option('--create', 'create the secret when it does not exist')
    .option('--json', 'raw JSON output')
    .action(
      async (
        target: string,
        name: string,
        field: string,
        opts: { fromFile?: string; sensitive?: boolean; nonSensitive?: boolean; create?: boolean; json?: boolean },
      ) => {
        emit(await runSecretSet(clientFrom(), target, name, field, opts), opts.json === true);
      },
    );
```

`isDefault: true` makes both `pidb secrets list acme` and `pidb secrets acme` work. If commander v15 rejects a default subcommand that takes its own argument, drop `{ isDefault: true }` and keep only `pidb secrets list [target]` — report which form you used.

- [ ] **Step 6: Verify the wiring**

Run: `npx tsx packages/cli/src/cli.ts secret --help`
Expected: lists `get` and `set`. Exit code 0.

- [ ] **Step 7: Commit**

```bash
git add packages/cli
git commit -m "feat(cli): add secrets list and secret get/set commands

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
git log -1 --format=%B
```

---

## Task 9: `secret exec`

**Files:**
- Create: `packages/cli/src/commands/exec.ts`
- Modify: `packages/cli/src/cli.ts`
- Test: `packages/cli/test/exec.test.ts`

**Interfaces:**
- Consumes: `PidbClient`, `scopedPath`, `seg`, `RevealedFields`, `CliError`.
- Produces:
  - `envKeyFor(key: string): string` — `PIDB_` + uppercased key with every character outside `[A-Z0-9_]` replaced by `_`
  - `buildEnv(fields: Record<string, string>, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv` — throws `CliError` on a key collision
  - `runSecretExec(client, target, name, command: string[]): Promise<number>` — returns the child's exit code; prints nothing itself

- [ ] **Step 1: Write the failing test**

`packages/cli/test/exec.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PidbClient } from '../src/client.js';
import { buildEnv, envKeyFor, runSecretExec } from '../src/commands/exec.js';
import { CliError } from '../src/errors.js';
import { makeServer, type ServerFixture } from './helpers.js';

let s: ServerFixture;
let dir: string;
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const client = (scopes: Parameters<ServerFixture['token']>[0]) => new PidbClient({ url: s.url, token: s.token(scopes) });

beforeAll(async () => {
  s = await makeServer();
  dir = mkdtempSync(join(tmpdir(), 'pidb-exec-'));
  s.project('acme');
  s.secret('acme', 'DB', [
    { key: 'host', value: 'db.internal' },
    { key: 'password', value: 'hunter2hunter2' },
    { key: 'api.key-1', value: 'dotted-value' },
  ]);
});
afterAll(async () => {
  await s.close();
});

describe('envKeyFor', () => {
  it('uppercases and sanitizes', () => {
    expect(envKeyFor('password')).toBe('PIDB_PASSWORD');
    expect(envKeyFor('api.key-1')).toBe('PIDB_API_KEY_1');
  });
});

describe('buildEnv', () => {
  it('rejects two fields that map to the same env var', () => {
    expect(() => buildEnv({ 'a.b': '1', 'a-b': '2' }, {})).toThrow(CliError);
  });
  it('keeps the parent environment', () => {
    expect(buildEnv({ host: 'h' }, { PATH: '/bin' })).toEqual({ PATH: '/bin', PIDB_HOST: 'h' });
  });
});

describe('runSecretExec', () => {
  it('injects PIDB_* into the child and returns its exit code', async () => {
    const out = join(dir, 'child.txt');
    const code = await runSecretExec(client(['secrets:reveal']), 'acme', 'DB', [
      process.execPath,
      '-e',
      `require('fs').writeFileSync(${JSON.stringify(out)}, [process.env.PIDB_HOST, process.env.PIDB_PASSWORD, process.env.PIDB_API_KEY_1].join('|'))`,
    ]);
    expect(code).toBe(0);
    expect(readFileSync(out, 'utf8')).toBe('db.internal|hunter2hunter2|dotted-value');
  });

  it('propagates a non-zero child exit code', async () => {
    const code = await runSecretExec(client(['secrets:reveal']), 'acme', 'DB', [process.execPath, '-e', 'process.exit(7)']);
    expect(code).toBe(7);
  });

  it('audits every sensitive field it revealed', async () => {
    const before = (s.db.prepare("SELECT COUNT(*) AS c FROM audit_log WHERE action = 'secret.reveal'").get() as { c: number }).c;
    await runSecretExec(client(['secrets:reveal']), 'acme', 'DB', [process.execPath, '-e', '']);
    const after = (s.db.prepare("SELECT COUNT(*) AS c FROM audit_log WHERE action = 'secret.reveal'").get() as { c: number }).c;
    expect(after).toBeGreaterThan(before);
  });
});

describe('pidb secret exec (spawned)', () => {
  it('prints no secret value on stdout or stderr', () => {
    const token = s.token(['secrets:reveal']);
    const r = spawnSync(
      join(repoRoot, 'node_modules/.bin/tsx'),
      [join(repoRoot, 'packages/cli/src/cli.ts'), 'secret', 'exec', 'acme', 'DB', '--', process.execPath, '-e', 'console.log("child ran")'],
      {
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', PIDB_URL: s.url, PIDB_TOKEN: token, PIDB_CONFIG_HOME: dir },
      },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('child ran');
    expect(r.stdout).not.toContain('hunter2hunter2');
    expect(r.stderr).not.toContain('hunter2hunter2');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/cli/test/exec.test.ts`
Expected: FAIL — cannot resolve `../src/commands/exec.js`.

- [ ] **Step 3: Write the implementation**

`packages/cli/src/commands/exec.ts`:

```ts
import { spawn } from 'node:child_process';
import { scopedPath, seg, type PidbClient } from '../client.js';
import type { RevealedFields } from '../api-types.js';
import { CliError } from '../errors.js';

/** Field keys allow [A-Za-z0-9_.-]; env vars do not, so `.` and `-` become `_`. */
export function envKeyFor(key: string): string {
  return `PIDB_${key.toUpperCase().replace(/[^A-Z0-9_]/g, '_')}`;
}

export function buildEnv(fields: Record<string, string>, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  const seen = new Map<string, string>();
  for (const [key, value] of Object.entries(fields)) {
    const name = envKeyFor(key);
    const previous = seen.get(name);
    if (previous !== undefined) {
      throw new CliError(`fields "${previous}" and "${key}" both map to ${name} — rename one of them`);
    }
    seen.set(name, key);
    env[name] = value;
  }
  return env;
}

export async function runSecretExec(
  client: PidbClient,
  target: string,
  name: string,
  command: string[],
): Promise<number> {
  const [bin, ...args] = command;
  if (!bin) throw new CliError('no command given — usage: pidb secret exec <target> "<name>" -- <command...>');

  const revealed = await client.json<RevealedFields>('GET', scopedPath(target, 'secrets', `/${seg(name)}/fields`));
  const env = buildEnv(revealed.fields, process.env);

  return await new Promise<number>((resolve, reject) => {
    const child = spawn(bin, args, { stdio: 'inherit', env });
    child.on('error', (err) => reject(new CliError(`cannot run ${bin}: ${err.message}`)));
    child.on('close', (code, signal) => {
      if (signal) {
        // Report the conventional 128+signal code without printing anything of the secret.
        resolve(128 + (typeof signal === 'string' ? signalNumber(signal) : 0));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

function signalNumber(signal: NodeJS.Signals): number {
  const table: Partial<Record<NodeJS.Signals, number>> = { SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 };
  return table[signal] ?? 1;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/cli/test/exec.test.ts`
Expected: PASS (6 tests). The spawned test takes a few seconds (tsx startup).

- [ ] **Step 5: Register the command**

In `packages/cli/src/cli.ts` add:

```ts
import { runSecretExec } from './commands/exec.js';
```

and inside `buildProgram()`, on the existing `secret` command:

```ts
  secret
    .command('exec')
    .argument('<target>', 'project slug or "global"')
    .argument('<name>', 'secret name')
    .argument('<command...>', 'command to run after --')
    .description('Run a command with the secret fields injected as PIDB_<KEY> environment variables')
    .action(async (target: string, name: string, command: string[]) => {
      process.exitCode = await runSecretExec(clientFrom(), target, name, command);
    });
```

Commander passes everything after `--` through to the variadic argument; do not add `.allowUnknownOption()`.

- [ ] **Step 6: Verify the wiring by hand**

Run: `npx tsx packages/cli/src/cli.ts secret exec --help`
Expected: usage showing `<target> <name> <command...>`. Exit code 0.

- [ ] **Step 7: Commit**

```bash
git add packages/cli
git commit -m "feat(cli): add secret exec with PIDB_* env injection

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
git log -1 --format=%B
```

---

## Task 10: `secret write` and `secret env`

**Files:**
- Create: `packages/cli/src/commands/files.ts`
- Modify: `packages/cli/src/cli.ts`
- Test: `packages/cli/test/files.test.ts`

**Interfaces:**
- Consumes: `PidbClient`, `scopedPath`, `seg`, `RevealedFields`, `CommandResult`, `CliError`, `EXIT_REFUSED`.
- Produces:
  - `parseMode(mode: string | undefined): number` — octal string (`600`, `0600`) → number, default `0o600`
  - `writeSecretFile(path: string, content: string, mode: number, force: boolean): void` — refuses an existing file without `force` (`EXIT_REFUSED`)
  - `runSecretWrite(client, target, name, field, opts: { out: string; mode?: string; force?: boolean }): Promise<CommandResult>`
  - `runSecretEnv(client, target, name, opts: { out: string; mode?: string; force?: boolean }): Promise<CommandResult>`

- [ ] **Step 1: Write the failing test**

`packages/cli/test/files.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PidbClient } from '../src/client.js';
import { parseMode, runSecretEnv, runSecretWrite } from '../src/commands/files.js';
import { CliError } from '../src/errors.js';
import { makeServer, type ServerFixture } from './helpers.js';

let s: ServerFixture;
let dir: string;
const client = (scopes: Parameters<ServerFixture['token']>[0]) => new PidbClient({ url: s.url, token: s.token(scopes) });

beforeAll(async () => {
  s = await makeServer();
  s.project('acme');
  s.secret('acme', 'DB', [
    { key: 'host', value: 'db.internal' },
    { key: 'password', value: 'hunter2hunter2' },
  ]);
  s.secret('acme', 'SSH', [{ key: 'content', value: '-----BEGIN KEY-----\nabc\n-----END KEY-----\n' }]);
});
afterAll(async () => {
  await s.close();
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pidb-files-'));
});

describe('parseMode', () => {
  it('parses octal with and without a leading zero', () => {
    expect(parseMode(undefined)).toBe(0o600);
    expect(parseMode('600')).toBe(0o600);
    expect(parseMode('0640')).toBe(0o640);
  });
  it('rejects nonsense', () => {
    expect(() => parseMode('go+rw')).toThrow(CliError);
    expect(() => parseMode('999')).toThrow(CliError);
  });
});

describe('secret write', () => {
  it('writes the raw value with mode 0600', async () => {
    const out = join(dir, 'key.pem');
    const result = await runSecretWrite(client(['secrets:reveal']), 'acme', 'SSH', 'content', { out });
    expect(readFileSync(out, 'utf8')).toBe('-----BEGIN KEY-----\nabc\n-----END KEY-----\n');
    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(result.text).toContain(out);
    expect(result.text).not.toContain('BEGIN KEY');
  });

  it('refuses to overwrite without --force and exits 2', async () => {
    const out = join(dir, 'key.pem');
    writeFileSync(out, 'existing');
    const err = await runSecretWrite(client(['secrets:reveal']), 'acme', 'SSH', 'content', { out }).catch((e: unknown) => e);
    expect((err as CliError).exitCode).toBe(2);
    expect(readFileSync(out, 'utf8')).toBe('existing');
  });

  it('overwrites with --force and still tightens the mode', async () => {
    const out = join(dir, 'key.pem');
    writeFileSync(out, 'existing', { mode: 0o644 });
    await runSecretWrite(client(['secrets:reveal']), 'acme', 'SSH', 'content', { out, force: true });
    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(readFileSync(out, 'utf8')).toContain('BEGIN KEY');
  });

  it('honours --mode', async () => {
    const out = join(dir, 'key.pem');
    await runSecretWrite(client(['secrets:reveal']), 'acme', 'SSH', 'content', { out, mode: '640' });
    expect(statSync(out).mode & 0o777).toBe(0o640);
  });
});

describe('secret env', () => {
  it('writes key=value lines with the stored keys, mode 0600', async () => {
    const out = join(dir, '.env');
    const result = await runSecretEnv(client(['secrets:reveal']), 'acme', 'DB', { out });
    expect(readFileSync(out, 'utf8')).toBe('host=db.internal\npassword=hunter2hunter2\n');
    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(result.text).not.toContain('hunter2hunter2');
    expect(JSON.stringify(result.json)).not.toContain('hunter2hunter2');
  });

  it('refuses a multi-line value and points at secret write', async () => {
    const err = await runSecretEnv(client(['secrets:reveal']), 'acme', 'SSH', { out: join(dir, '.env') }).catch((e: unknown) => e);
    expect((err as CliError).message).toMatch(/pidb secret write/);
    expect((err as CliError).message).not.toContain('BEGIN KEY');
  });

  it('refuses to overwrite without --force', async () => {
    const out = join(dir, '.env');
    writeFileSync(out, 'existing');
    const err = await runSecretEnv(client(['secrets:reveal']), 'acme', 'DB', { out }).catch((e: unknown) => e);
    expect((err as CliError).exitCode).toBe(2);
    expect(readFileSync(out, 'utf8')).toBe('existing');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/cli/test/files.test.ts`
Expected: FAIL — cannot resolve `../src/commands/files.js`.

- [ ] **Step 3: Write the implementation**

`packages/cli/src/commands/files.ts`:

```ts
import { chmodSync, writeFileSync } from 'node:fs';
import { scopedPath, seg, type PidbClient } from '../client.js';
import type { RevealedFields } from '../api-types.js';
import { CliError, EXIT_REFUSED } from '../errors.js';
import type { CommandResult } from '../output.js';

export function parseMode(mode: string | undefined): number {
  if (mode === undefined) return 0o600;
  if (!/^0?[0-7]{3}$/.test(mode)) throw new CliError(`invalid --mode "${mode}" — use an octal mode such as 600`);
  return Number.parseInt(mode, 8);
}

export function writeSecretFile(path: string, content: string, mode: number, force: boolean): void {
  try {
    writeFileSync(path, content, { mode, flag: force ? 'w' : 'wx' });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') throw new CliError(`${path} already exists — pass --force to overwrite`, EXIT_REFUSED);
    throw new CliError(`cannot write ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  chmodSync(path, mode); // writeFileSync's mode is ignored when overwriting an existing file
}

export async function runSecretWrite(
  client: PidbClient,
  target: string,
  name: string,
  field: string,
  opts: { out: string; mode?: string; force?: boolean },
): Promise<CommandResult> {
  const mode = parseMode(opts.mode);
  const value = await client.text('GET', scopedPath(target, 'secrets', `/${seg(name)}/fields/${seg(field)}`));
  writeSecretFile(opts.out, value, mode, opts.force === true);
  return {
    json: { path: opts.out, mode: mode.toString(8).padStart(4, '0'), secret: name, field, bytes: Buffer.byteLength(value) },
    text: `wrote ${name}.${field} to ${opts.out} (mode ${mode.toString(8).padStart(4, '0')})`,
  };
}

export async function runSecretEnv(
  client: PidbClient,
  target: string,
  name: string,
  opts: { out: string; mode?: string; force?: boolean },
): Promise<CommandResult> {
  const mode = parseMode(opts.mode);
  const revealed = await client.json<RevealedFields>('GET', scopedPath(target, 'secrets', `/${seg(name)}/fields`));
  const lines: string[] = [];
  for (const [key, value] of Object.entries(revealed.fields)) {
    if (value.includes('\n')) {
      throw new CliError(
        `field "${key}" spans multiple lines and cannot go into a key=value file — use: pidb secret write ${target} "${name}" ${key} --out <path>`,
      );
    }
    lines.push(`${key}=${value}`);
  }
  writeSecretFile(opts.out, `${lines.join('\n')}\n`, mode, opts.force === true);
  return {
    json: { path: opts.out, mode: mode.toString(8).padStart(4, '0'), secret: name, keys: Object.keys(revealed.fields) },
    text: `wrote ${lines.length} field(s) of ${name} to ${opts.out} (mode ${mode.toString(8).padStart(4, '0')})`,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/cli/test/files.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Register the commands**

In `packages/cli/src/cli.ts` add:

```ts
import { runSecretEnv, runSecretWrite } from './commands/files.js';
```

and on the existing `secret` command:

```ts
  secret
    .command('write')
    .argument('<target>', 'project slug or "global"')
    .argument('<name>', 'secret name')
    .argument('<field>', 'field key')
    .requiredOption('--out <path>', 'destination file')
    .option('--mode <mode>', 'octal file mode', '600')
    .option('--force', 'overwrite an existing file')
    .option('--json', 'raw JSON output')
    .description('Write one field value to a file (never printed)')
    .action(
      async (target: string, name: string, field: string, opts: { out: string; mode?: string; force?: boolean; json?: boolean }) => {
        emit(await runSecretWrite(clientFrom(), target, name, field, opts), opts.json === true);
      },
    );
  secret
    .command('env')
    .argument('<target>', 'project slug or "global"')
    .argument('<name>', 'secret name')
    .requiredOption('--out <path>', 'destination file')
    .option('--mode <mode>', 'octal file mode', '600')
    .option('--force', 'overwrite an existing file')
    .option('--json', 'raw JSON output')
    .description('Write every field as key=value lines to a file (never printed)')
    .action(async (target: string, name: string, opts: { out: string; mode?: string; force?: boolean; json?: boolean }) => {
      emit(await runSecretEnv(clientFrom(), target, name, opts), opts.json === true);
    });
```

- [ ] **Step 6: Commit**

```bash
git add packages/cli
git commit -m "feat(cli): add secret write and secret env file injection

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
git log -1 --format=%B
```

---

## Task 11: `token create|list|revoke`

**Files:**
- Create: `packages/cli/src/commands/tokens.ts`
- Modify: `packages/cli/src/cli.ts`
- Test: `packages/cli/test/tokens.test.ts`

**Interfaces:**
- Consumes: `PidbClient`, `PublicToken`, `CommandResult`, `table`, `fmtTime`, `CliError`, `SCOPES`/`Scope` from `@pidb/shared`.
- Produces:
  - `parseScopes(raw: string): Scope[]` — comma-separated, validated against `SCOPES`
  - `parseExpires(raw: string | undefined, now?: number): number | null` — `90d` / `12h` / `30m` → epoch **milliseconds**
  - `runTokenCreate(client, opts: TokenCreateOptions): Promise<CommandResult>` where
    `interface TokenCreateOptions { name: string; scopes: string; projects?: string; expires?: string }`
  - `runTokenList(client): Promise<CommandResult>`
  - `runTokenRevoke(client, id: string): Promise<CommandResult>`

- [ ] **Step 1: Write the failing test**

`packages/cli/test/tokens.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ApiError, PidbClient } from '../src/client.js';
import { parseExpires, parseScopes, runTokenCreate, runTokenList, runTokenRevoke } from '../src/commands/tokens.js';
import type { PublicToken } from '../src/api-types.js';
import { CliError } from '../src/errors.js';
import { makeServer, type ServerFixture } from './helpers.js';

let s: ServerFixture;
const admin = () => new PidbClient({ url: s.url, token: s.token(['admin']) });

beforeAll(async () => {
  s = await makeServer();
  s.project('acme');
});
afterAll(async () => {
  await s.close();
});

describe('parseScopes', () => {
  it('splits and validates', () => {
    expect(parseScopes('docs:read, secrets:meta')).toEqual(['docs:read', 'secrets:meta']);
  });
  it('rejects an unknown scope', () => {
    expect(() => parseScopes('docs:read,nope')).toThrow(/nope/);
  });
  it('rejects an empty list', () => {
    expect(() => parseScopes('  ')).toThrow(CliError);
  });
});

describe('parseExpires', () => {
  const now = Date.UTC(2026, 0, 1);
  it('understands d/h/m suffixes and returns epoch milliseconds', () => {
    expect(parseExpires('90d', now)).toBe(now + 90 * 86_400_000);
    expect(parseExpires('12h', now)).toBe(now + 12 * 3_600_000);
    expect(parseExpires('30m', now)).toBe(now + 30 * 60_000);
  });
  it('returns null when omitted', () => {
    expect(parseExpires(undefined, now)).toBeNull();
  });
  it('rejects other shapes', () => {
    expect(() => parseExpires('tomorrow', now)).toThrow(CliError);
  });
});

describe('token create', () => {
  it('creates a scoped token and shows the value exactly once', async () => {
    const result = await runTokenCreate(admin(), {
      name: 'claude-code',
      scopes: 'projects:read,docs:read',
      projects: 'acme',
      expires: '90d',
    });
    const json = result.json as PublicToken & { token: string };
    expect(json.scopes).toEqual(['projects:read', 'docs:read']);
    expect(json.projects).toEqual(['acme']);
    expect(json.expires_at).toBeGreaterThan(Date.now());
    expect(result.text).toContain(json.token);
    expect(result.text).toMatch(/shown once/i);
  });

  it('defaults to all projects when --projects is omitted', async () => {
    const result = await runTokenCreate(admin(), { name: 'all', scopes: 'docs:read' });
    expect((result.json as PublicToken).projects).toBeNull();
  });

  it('fails on an unknown project slug', async () => {
    const err = await runTokenCreate(admin(), { name: 'x', scopes: 'docs:read', projects: 'nope' }).catch((e: unknown) => e);
    expect((err as ApiError).status).toBe(400);
  });
});

describe('token list and revoke', () => {
  it('lists tokens without their values and marks revoked ones', async () => {
    const created = (await runTokenCreate(admin(), { name: 'to-revoke', scopes: 'docs:read' })).json as PublicToken & { token: string };
    const list = await runTokenList(admin());
    expect(list.text).toContain('to-revoke');
    expect(list.text).not.toContain(created.token);

    const revoked = await runTokenRevoke(admin(), String(created.id));
    expect(revoked.text).toContain(String(created.id));
    const after = await runTokenList(admin());
    const row = (after.json as PublicToken[]).find((t) => t.id === created.id)!;
    expect(row.revoked_at).not.toBeNull();
  });

  it('rejects a non-numeric id before calling the server', async () => {
    await expect(runTokenRevoke(admin(), 'abc')).rejects.toThrow(/id/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/cli/test/tokens.test.ts`
Expected: FAIL — cannot resolve `../src/commands/tokens.js`.

- [ ] **Step 3: Write the implementation**

`packages/cli/src/commands/tokens.ts`:

```ts
import { SCOPES, type Scope } from '@pidb/shared';
import type { PidbClient } from '../client.js';
import type { PublicToken } from '../api-types.js';
import { CliError } from '../errors.js';
import { fmtTime, table, type CommandResult } from '../output.js';

export interface TokenCreateOptions {
  name: string;
  scopes: string;
  projects?: string;
  expires?: string;
}

export function parseScopes(raw: string): Scope[] {
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length === 0) throw new CliError(`--scopes is required — one or more of: ${SCOPES.join(', ')}`);
  for (const part of parts) {
    if (!(SCOPES as readonly string[]).includes(part)) {
      throw new CliError(`unknown scope "${part}" — one of: ${SCOPES.join(', ')}`);
    }
  }
  return parts as Scope[];
}

const UNITS: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000 };

export function parseExpires(raw: string | undefined, now: number = Date.now()): number | null {
  if (raw === undefined) return null;
  const m = /^(\d+)([dhm])$/.exec(raw.trim());
  const unit = m ? UNITS[m[2] as string] : undefined;
  if (!m || unit === undefined) throw new CliError(`invalid --expires "${raw}" — use 90d, 12h or 30m`);
  return now + Number.parseInt(m[1] as string, 10) * unit;
}

export async function runTokenCreate(client: PidbClient, opts: TokenCreateOptions): Promise<CommandResult> {
  const scopes = parseScopes(opts.scopes);
  const projects =
    opts.projects === undefined
      ? null
      : opts.projects
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
  const expires_at = parseExpires(opts.expires);
  const created = await client.json<PublicToken & { token: string }>('POST', '/api/v1/tokens', {
    body: { name: opts.name, scopes, projects, expires_at },
  });
  return {
    json: created,
    text: [
      `created token ${created.id} "${created.name}"`,
      `  scopes:   ${created.scopes.join(',')}`,
      `  projects: ${created.projects === null ? 'all' : created.projects.join(',')}`,
      `  expires:  ${created.expires_at === null ? 'never' : fmtTime(created.expires_at)}`,
      '',
      created.token,
      '',
      'This value is shown once and cannot be retrieved again.',
    ].join('\n'),
  };
}

export async function runTokenList(client: PidbClient): Promise<CommandResult> {
  const tokens = await client.json<PublicToken[]>('GET', '/api/v1/tokens');
  return {
    json: tokens,
    text: table(
      ['ID', 'NAME', 'PREFIX', 'SCOPES', 'PROJECTS', 'EXPIRES', 'LAST USED', 'STATE'],
      tokens.map((t) => [
        t.id,
        t.name,
        t.prefix,
        t.scopes.join(','),
        t.projects === null ? 'all' : t.projects.join(','),
        t.expires_at === null ? 'never' : fmtTime(t.expires_at),
        fmtTime(t.last_used_at),
        t.revoked_at === null ? 'active' : `revoked ${fmtTime(t.revoked_at)}`,
      ]),
    ),
  };
}

export async function runTokenRevoke(client: PidbClient, id: string): Promise<CommandResult> {
  if (!/^\d+$/.test(id.trim())) throw new CliError(`invalid token id "${id}" — expected a number (see \`pidb token list\`)`);
  await client.empty('DELETE', `/api/v1/tokens/${id.trim()}`);
  return { json: { id: Number.parseInt(id, 10), revoked: true }, text: `revoked token ${id.trim()}` };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/cli/test/tokens.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Register the commands**

In `packages/cli/src/cli.ts` add:

```ts
import { runTokenCreate, runTokenList, runTokenRevoke } from './commands/tokens.js';
```

and inside `buildProgram()`:

```ts
  const token = program.command('token').description('API tokens (requires an admin token)');
  token
    .command('create')
    .requiredOption('--name <name>', 'token name')
    .requiredOption('--scopes <scopes>', 'comma-separated scopes')
    .option('--projects <slugs>', 'comma-separated project slugs (default: all projects)')
    .option('--expires <duration>', 'expiry such as 90d, 12h, 30m')
    .option('--json', 'raw JSON output')
    .action(async (opts: { name: string; scopes: string; projects?: string; expires?: string; json?: boolean }) => {
      emit(await runTokenCreate(clientFrom(), opts), opts.json === true);
    });
  token
    .command('list')
    .option('--json', 'raw JSON output')
    .action(async (opts: { json?: boolean }) => {
      emit(await runTokenList(clientFrom()), opts.json === true);
    });
  token
    .command('revoke')
    .argument('<id>')
    .option('--json', 'raw JSON output')
    .action(async (id: string, opts: { json?: boolean }) => {
      emit(await runTokenRevoke(clientFrom(), id), opts.json === true);
    });
```

- [ ] **Step 6: Commit**

```bash
git add packages/cli
git commit -m "feat(cli): add token create/list/revoke commands

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
git log -1 --format=%B
```

---

## Task 12: End-to-end exit codes, README, full verification

**Files:**
- Create: `packages/cli/test/cli.e2e.test.ts`
- Modify: `README.md`, `packages/cli/src/index.ts`
- Test: the whole suite

**Interfaces:**
- Consumes: everything from Tasks 1–11.
- Produces: no new source interfaces; `index.ts` finishes re-exporting the command modules so the package is usable as a library.

- [ ] **Step 1: Write the failing end-to-end test**

`packages/cli/test/cli.e2e.test.ts` — this is the spec §14 check that the *process* (not just the function) exits with the documented codes:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeServer, type ServerFixture } from './helpers.js';

let s: ServerFixture;
let dir: string;
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

function runCli(args: string[], env: Record<string, string> = {}) {
  return spawnSync(join(repoRoot, 'node_modules/.bin/tsx'), [join(repoRoot, 'packages/cli/src/cli.ts'), ...args], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      PIDB_CONFIG_HOME: dir,
      PIDB_URL: s.url,
      PIDB_TOKEN: s.token(['secrets:reveal', 'secrets:meta', 'projects:read']),
      ...env,
    },
  });
}

beforeAll(async () => {
  s = await makeServer();
  dir = mkdtempSync(join(tmpdir(), 'pidb-e2e-'));
  s.project('acme');
  s.secret('acme', 'DB', [
    { key: 'host', value: 'db.internal' },
    { key: 'password', value: 'hunter2hunter2' },
  ]);
});
afterAll(async () => {
  await s.close();
});

describe('pidb exit codes', () => {
  it('exits 2 for `secret get` without --print and prints no value', () => {
    const r = runCli(['secret', 'get', 'acme', 'DB', 'password']);
    expect(r.status).toBe(2);
    expect(r.stdout).not.toContain('hunter2hunter2');
    expect(r.stderr).not.toContain('hunter2hunter2');
    expect(r.stderr).toMatch(/--print/);
  });

  it('exits 0 and prints the value with --print', () => {
    const r = runCli(['secret', 'get', 'acme', 'DB', 'password', '--print']);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('hunter2hunter2');
  });

  it('exits 3 with a bad token', () => {
    const r = runCli(['projects', 'list'], { PIDB_TOKEN: 'pidb_not_a_token' });
    expect(r.status).toBe(3);
  });

  it('exits 3 when nothing is configured', () => {
    const r = spawnSync(join(repoRoot, 'node_modules/.bin/tsx'), [join(repoRoot, 'packages/cli/src/cli.ts'), 'projects', 'list'], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', PIDB_CONFIG_HOME: mkdtempSync(join(tmpdir(), 'pidb-empty-')) },
    });
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/pidb login/);
  });

  it('exits 4 for an unknown project', () => {
    const r = runCli(['projects', 'get', 'nope']);
    expect(r.status).toBe(4);
  });

  it('writes a 0600 file and exits 2 when asked to overwrite it', () => {
    const out = join(dir, 'pw.txt');
    const first = runCli(['secret', 'write', 'acme', 'DB', 'password', '--out', out]);
    expect(first.status).toBe(0);
    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(readFileSync(out, 'utf8')).toBe('hunter2hunter2');
    expect(first.stdout).not.toContain('hunter2hunter2');

    const second = runCli(['secret', 'write', 'acme', 'DB', 'password', '--out', out]);
    expect(second.status).toBe(2);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run packages/cli/test/cli.e2e.test.ts`
Expected: PASS (6 tests).

If a case exits with `1` instead of the documented code, the fault is in `main()`'s error handling in `cli.ts` (it must use `exitCodeOf(err)`) or in the command's thrown error type — fix that, do not change the assertion.

- [ ] **Step 3: Finish the library re-exports**

`packages/cli/src/index.ts` (complete file):

```ts
export * from './errors.js';
export * from './config.js';
export * from './api-types.js';
export * from './client.js';
export * from './output.js';
export * from './commands/login.js';
export * from './commands/projects.js';
export * from './commands/docs.js';
export * from './commands/secrets.js';
export * from './commands/exec.js';
export * from './commands/files.js';
export * from './commands/tokens.js';
```

- [ ] **Step 4: Run the whole suite, build and typecheck**

Run: `npm test`
Expected: every test passes — the 117 Plan 1 tests plus the new CLI tests.

Run: `npm run typecheck`
Expected: no output, exit code 0.

Run: `npm run build`
Expected: `packages/cli/dist/cli.js` exists.

Run: `node packages/cli/dist/cli.js --help`
Expected: usage text. Exit code 0. (The built `dist/cli.js` must have the executable shebang and run standalone.)

- [ ] **Step 5: Update the README**

In `README.md`:

1. In the **Packages** list, change the `packages/cli` line to:
   `- \`packages/cli\` — \`pidb\` client CLI: docs, secret metadata, and value injection (\`exec\` / \`write\` / \`env\`)`

2. Add a `## CLI` section after the "Quick start (development)" section:

````markdown
## CLI (`pidb`)

```bash
npm run build
node packages/cli/dist/cli.js login http://localhost:8080     # prompts for the admin credentials
```

Configuration resolves from `PIDB_URL` / `PIDB_TOKEN`, then `~/.config/pidb/config.json` (written `0600` by `pidb login`; `PIDB_CONFIG_HOME` overrides the directory).

```bash
pidb projects list
pidb projects get acme
pidb docs list acme
pidb docs get acme deploy --refs          # shows which secrets the doc references
pidb docs put acme deploy --file deploy.md --title "Deploy" --category deploy
pidb secrets list acme                    # names, field keys, sensitivity — never values
pidb search "staging database"
```

Consuming secret values — none of these print the value:

```bash
pidb secret exec acme "DB" -- psql        # fields become $PIDB_HOST, $PIDB_PASSWORD, …
pidb secret write acme "SSH" content --out ~/.ssh/acme_key --mode 600
pidb secret env acme "DB" --out .env
pidb secret set acme "DB" password        # value read from stdin
pidb secret get acme "DB" password --print   # explicit opt-in; exits 2 without --print
```

Admin:

```bash
pidb token create --name claude-code --scopes projects:read,docs:read,secrets:meta --projects acme --expires 90d
pidb token list
pidb token revoke 3
```

Exit codes: `0` success, `1` generic error, `2` refused (missing `--print`, would overwrite a file), `3` authentication or missing scope, `4` not found.
````

3. Replace the **Error codes** line with the complete list:

```markdown
`unauthorized` · `missing_scope` · `not_found` · `validation` · `conflict` · `lint` · `unresolved_refs` · `rate_limited` · `payload_too_large` · `unsupported_media_type` · `bad_request` · `decrypt_failed` · `internal`
```

(This closes the item parked at the end of Plan 1: the README's list omitted `unsupported_media_type` and `bad_request`.)

- [ ] **Step 6: Verify the README commands are real**

Run: `npx tsx packages/cli/src/cli.ts --help`
Then for each of `projects`, `docs`, `secret`, `token`: `npx tsx packages/cli/src/cli.ts <group> --help`
Expected: every command and flag named in the README appears in the help output. Fix the README or the wiring if any is missing.

- [ ] **Step 7: Commit**

```bash
git add packages/cli README.md
git commit -m "docs: document the pidb CLI and complete the error-code list

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
git log -1 --format=%B
```

---

## Done criteria

- `npm test`, `npm run typecheck`, `npm run build` all clean from the repo root.
- `node packages/cli/dist/cli.js --help` works from the built output.
- Every command in the "Command surface" section above is registered and covered by at least one test.
- No test, source file, or README example prints a secret value except `pidb secret get --print`.
