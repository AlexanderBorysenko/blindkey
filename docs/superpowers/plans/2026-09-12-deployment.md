# pidb Deployment (Docker, Caddy, backups) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship spec §12 — a multi-stage Docker image, a Compose stack of `server` + `caddy` + `backup`, the master key delivered as a file secret, a 24-hour backup loop, log redaction for secret-bearing request bodies, and the deployment documentation.

**Architecture:** One image built from the monorepo (`docker/Dockerfile`, two stages: an Alpine builder that compiles the TypeScript and the two native modules, then a slim `node:22-alpine` runtime running as the built-in `node` user with `/data` as a volume). `docker/docker-compose.yml` runs that image twice — once as the HTTP server behind Caddy, once as a shell loop calling `pidb-server backup` — plus `caddy:2-alpine` terminating TLS for `$PIDB_DOMAIN` and reverse-proxying to `server:8080`. The master key never appears in an image, a compose file or a backup: it is mounted as a Docker secret at `/run/secrets/master_key` and referenced through the existing `PIDB_MASTER_KEY_FILE` support in `packages/server/src/config.ts`.

**Tech Stack:** Docker (BuildKit), Docker Compose v2, `node:22-alpine`, `caddy:2-alpine`, POSIX `sh` for the backup loop, vitest for the two code-level tests.

**Spec:** `docs/superpowers/specs/2026-09-12-projects-info-db-design.md` — §12 is deployment, §13 error handling (the master-key failure mode), §5 the master key, §14 testing. Binding.

**Predecessors:** Plan 1 (`2026-09-12-core-server.md`), Plan 2 (`2026-09-12-client-cli.md`) and Plan 3 (`2026-09-12-admin-ui.md`) are all merged to `master`. The server CLI already implements every command this plan orchestrates — `init`, `start`, `rotate-key`, and `backup --out <dir> --keep <n>` (`packages/server/src/cli.ts`, `runBackup` in `packages/server/src/ops.ts`, which does `VACUUM INTO` and prunes to `--keep`). **This plan writes no new backup logic.**

**Out of scope:** CI pipelines, image registries, off-host backup shipping, monitoring/alerting, and anything in spec §15.

## Global Constraints

- The image runs as a **non-root** user (`node`, uid 1000, already present in `node:22-alpine`), and `/data` is a declared volume owned by that user.
- **No secret material in the repository, an image layer, or a compose file.** The master key reaches the container only as the Docker secret mounted at `/run/secrets/master_key`, consumed via `PIDB_MASTER_KEY_FILE`. `docker/.env.example` carries placeholders only. `docker/.env` and `docker/secrets/` are git-ignored.
- The backup archive must not contain the master key (spec §12): `pidb-server backup` copies the SQLite file only, and nothing in this plan copies the key anywhere.
- `PIDB_TRUST_PROXY` **must** be set for the `server` service, because Caddy terminates TLS: without it Fastify reports `req.protocol === 'http'` and the admin session cookie ships without the `Secure` flag (found in the Plan 3 review, documented in the README).
- Logs are pino JSON on stdout and must never contain a secret value (spec §12).
- Node `>=22`, TypeScript `strict` + `noUncheckedIndexedAccess`, ESM (`NodeNext`) — every relative import in a `.ts` file carries the `.js` extension. Code tests live in `packages/server/test/**/*.test.ts` and may write only inside a `mkdtempSync` directory.
- Shell scripts are POSIX `sh` (the runtime image has BusyBox ash, not bash) and must be safe under `set -eu`.
- Run `npm run build` before the full vitest suite: some existing tests spawn the built CLI from `dist/`. The suite stands at **312 passing** on `master` (head `c968e21`).
- Conventional Commits. Every commit message ends with the trailer:
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`
  After committing, run `git log -1 --format=%B` and verify the trailer says "Claude Opus 5 (1M context)"; amend if it says anything else.
- If a step cannot be completed as written — an image fails to build, a library's API differs, a test fails in a way this plan does not describe — **STOP and report BLOCKED with the exact output. Do not improvise a different design.**

## Docker daemon availability

`docker` and `docker compose` are installed on this machine, but **the daemon was not running when this plan was written** (`Cannot connect to the Docker daemon`). Two consequences:

- `docker compose config` works without the daemon and is the offline validation used in Tasks 3 and 4.
- `docker build` and `docker compose up` need the daemon. If a task's verification step cannot reach it, do **not** fake output: report the step as **NOT VERIFIED — Docker daemon unavailable**, finish everything else in the task, and say so in the task report. Task 6 exists to run the full stack once the daemon is up.

## File structure

| file | responsibility |
|---|---|
| `packages/server/src/http/app.ts` (modify) | extend the pino `redact` list so a secret-bearing request body can never be logged |
| `packages/server/test/logging.test.ts` (new) | proves the redaction config hides those paths, and that a secrets POST at `trace` level emits no value |
| `docker/Dockerfile` | two-stage build; non-root runtime; `/data` volume; `HEALTHCHECK` |
| `docker/healthcheck.mjs` | dependency-free `GET /health` probe used by `HEALTHCHECK` (no curl in the image) |
| `.dockerignore` | keeps the build context small and secret-free |
| `docker/Caddyfile` | automatic TLS for `$PIDB_DOMAIN`, reverse proxy to `server:8080` |
| `docker/.env.example` | every variable the stack reads, with placeholder values |
| `docker/docker-compose.yml` | `server` + `caddy` + `backup`, volumes `pidb-data`/`caddy-data`/`caddy-config`, the `master_key` secret |
| `docker/backup-loop.sh` | the 24-hour loop that calls `pidb-server backup`; one-shot mode for tests |
| `packages/server/test/backup-loop.test.ts` (new) | runs the loop script once against a temp data directory and asserts a backup file appears |
| `README.md` (modify) | a `## Deployment (Docker)` section: first run, TLS, backups, restore, key rotation |
| `.gitignore` (modify) | ignore `docker/.env` and `docker/secrets/` |

---

## Task 1: Redact secret-bearing request bodies from the logs

**Files:**
- Modify: `packages/server/src/http/app.ts` (the `logger` option inside `buildApp`)
- Test: `packages/server/test/logging.test.ts`

**Interfaces:**
- Consumes: `buildApp(ctx)` from `../src/http/app.js`, `makeTestApp()` from `./helpers.js`.
- Produces: no new exports. The redaction list becomes part of `buildApp`'s logger options.

Spec §12 requires "secret values never logged (redaction paths configured for request bodies on secrets routes)". Fastify does not log request bodies by default, so this is defence in depth against a future serializer or a hand-written `req.log.info({ body })`: if a body is ever logged, the value-bearing paths must already be redacted.

- [ ] **Step 1: Write the failing test**

`packages/server/test/logging.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import { openDb } from '../src/db/connection.js';
import { buildApp } from '../src/http/app.js';
import type { KeyRing } from '../src/config.js';
import type { FastifyInstance } from 'fastify';
import { makeTestApp, type TestCtx } from './helpers.js';

const SECRET_VALUE = 'hunter2-do-not-log-me';

/** Collects every line the logger writes. */
function sink(): { stream: Writable; lines: string[] } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(String(chunk));
      cb();
    },
  });
  return { stream, lines };
}

describe('logging', () => {
  let t: TestCtx;
  beforeAll(async () => {
    t = await makeTestApp();
  });
  afterAll(async () => {
    await t.app.close();
  });

  it('redacts a secret-bearing request body when something logs it', async () => {
    const { stream, lines } = sink();
    const db = openDb(':memory:');
    const ring: KeyRing = { current: 1, keys: new Map([[1, randomBytes(32)]]) };
    const app: FastifyInstance = await buildApp({ db, ring, logLevel: 'trace', loggerStream: stream });
    // The path must start with /api/ — anything else is a UI path, and the
    // admin-UI guard would redirect it to /login before the handler runs.
    app.post('/api/v1/__log-probe', { config: { public: true } }, async (req, reply) => {
      req.log.info({ req: { body: req.body } }, 'probe');
      return reply.send({ ok: true });
    });
    await app.inject({
      method: 'POST',
      url: '/api/v1/__log-probe',
      payload: { name: 'DB', password: SECRET_VALUE, value: SECRET_VALUE, fields: [{ key: 'password', value: SECRET_VALUE }] },
    });
    await app.close();
    const all = lines.join('\n');
    expect(all).toContain('probe');
    expect(all).not.toContain(SECRET_VALUE);
    expect(all).toContain('[Redacted]');
  });

  it('logs nothing containing a value for a real secrets request', async () => {
    const { stream, lines } = sink();
    const db = openDb(':memory:');
    const ring: KeyRing = { current: 1, keys: new Map([[1, randomBytes(32)]]) };
    const app: FastifyInstance = await buildApp({ db, ring, logLevel: 'trace', loggerStream: stream });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/secrets', // the global (project-less) secrets collection
      payload: { name: 'Cloudflare', fields: [{ key: 'api_key', value: SECRET_VALUE }] },
    });
    expect(res.statusCode).toBe(401); // no token: the route is never reached
    await app.close();
    expect(lines.join('\n')).not.toContain(SECRET_VALUE);
  });

  it('still redacts the authorization header and the cookie', async () => {
    const { stream, lines } = sink();
    const db = openDb(':memory:');
    const ring: KeyRing = { current: 1, keys: new Map([[1, randomBytes(32)]]) };
    const app: FastifyInstance = await buildApp({ db, ring, logLevel: 'trace', loggerStream: stream });
    await app.inject({
      method: 'GET',
      url: '/api/v1/projects',
      headers: { authorization: 'Bearer pidb_super-secret-token', cookie: 'pidb_session=abc123' },
    });
    await app.close();
    const all = lines.join('\n');
    expect(all).not.toContain('pidb_super-secret-token');
    expect(all).not.toContain('abc123');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/server/test/logging.test.ts`
Expected: FAIL — `buildApp` does not accept `loggerStream`, and the body paths are not redacted.

- [ ] **Step 3: Add the logger stream option to the app context**

In `packages/server/src/http/context.ts`, add one optional field to `AppContext`:

```ts
  /** Test-only: send pino output here instead of stdout. */
  loggerStream?: import('node:stream').Writable;
```

Leave every existing field unchanged.

- [ ] **Step 4: Extend the redaction list**

In `packages/server/src/http/app.ts`, replace the `logger` option of the `Fastify({ ... })` call with:

```ts
    logger: {
      level: ctx.logLevel ?? 'info',
      // Secret material must never reach a log line (spec §12): credentials in
      // headers, and the value-bearing paths of every secrets request body.
      redact: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.body.password',
        'req.body.value',
        'req.body.fields',
        'req.body.*.value',
        'body.password',
        'body.value',
        'body.fields',
      ],
      ...(ctx.loggerStream ? { stream: ctx.loggerStream } : {}),
    },
```

Do not change `trustProxy`, `bodyLimit`, or anything else in `buildApp`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run packages/server/test/logging.test.ts`
Expected: PASS (3 tests).

Then `npm run build && npx vitest run` — expected: 312 previous + 3 new = 315 passing.

- [ ] **Step 6: Commit**

```bash
git add packages/server
git commit -m "feat(server): redact secret-bearing request bodies from the logs

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
git log -1 --format=%B
```

---

## Task 2: The image — Dockerfile, health probe, .dockerignore

**Files:**
- Create: `docker/Dockerfile`, `docker/healthcheck.mjs`, `.dockerignore`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: the monorepo's `npm ci` + `npm run build` scripts, `packages/server/dist/cli.js` (bin `pidb-server`), `PIDB_PORT` (default 8080), `GET /health` → `{ ok: true }`.
- Produces: an image whose entrypoint is `node packages/server/dist/cli.js`, default command `start`; `docker/healthcheck.mjs` exits 0 only when `/health` answers `{ ok: true }`.

Both `better-sqlite3` and `argon2` are native modules with no musl prebuilds, so the builder stage installs a toolchain and compiles them; the runtime stage reuses the same Alpine base so the compiled `.node` files match.

- [ ] **Step 1: Write the health probe**

`docker/healthcheck.mjs`:

```js
// Dependency-free health probe for HEALTHCHECK: the runtime image has no curl.
const port = process.env.PIDB_PORT ?? '8080';
try {
  const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(4000) });
  if (!res.ok) process.exit(1);
  const body = await res.json();
  process.exit(body && body.ok === true ? 0 : 1);
} catch {
  process.exit(1);
}
```

- [ ] **Step 2: Write the build-context excludes**

`.dockerignore`:

```
.git
.gitignore
.claude
.superpowers
node_modules
**/node_modules
**/dist
coverage
docs
data
*.sqlite
*.sqlite-wal
*.sqlite-shm
.env
docker/.env
docker/secrets
```

- [ ] **Step 3: Write the Dockerfile**

`docker/Dockerfile`:

```dockerfile
# syntax=docker/dockerfile:1

# ---- build: compile TypeScript and the native modules -----------------------
FROM node:22-alpine AS build
WORKDIR /app
# better-sqlite3 and argon2 have no musl prebuilds; compile them here.
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/cli/package.json packages/cli/package.json
RUN npm ci
COPY packages/shared packages/shared
COPY packages/server packages/server
COPY packages/cli packages/cli
RUN npm run build
# Drop devDependencies; keeps the compiled native modules and the workspace links.
RUN npm prune --omit=dev

# ---- runtime ----------------------------------------------------------------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    PIDB_DATA_DIR=/data \
    PIDB_PORT=8080
WORKDIR /app
RUN mkdir -p /data && chown node:node /data
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/server/package.json ./packages/server/package.json
COPY --from=build /app/packages/server/dist ./packages/server/dist
COPY --from=build /app/packages/server/scripts ./packages/server/scripts
COPY --from=build /app/packages/cli/package.json ./packages/cli/package.json
COPY --from=build /app/packages/cli/dist ./packages/cli/dist
COPY docker/healthcheck.mjs ./docker/healthcheck.mjs
COPY docker/backup-loop.sh ./docker/backup-loop.sh
USER node
EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "docker/healthcheck.mjs"]
ENTRYPOINT ["node", "packages/server/dist/cli.js"]
CMD ["start"]
```

`docker/backup-loop.sh` does not exist until Task 4; **build the image only after Task 4 lands**, or temporarily comment that one `COPY` line out while you verify Steps 1–3 and restore it in Task 4. Whichever you do, say so in your report.

- [ ] **Step 4: Ignore the operator's local secrets**

Append to `.gitignore`:

```
docker/.env
docker/secrets/
```

- [ ] **Step 5: Verify what can be verified without the daemon**

Run: `node docker/healthcheck.mjs; echo "exit=$?"`
Expected: `exit=1` (nothing is listening) — this proves the probe fails closed.

Run: `node --check docker/healthcheck.mjs` — expected: no output (valid syntax).

If the Docker daemon IS reachable, also run:

```bash
docker build -f docker/Dockerfile -t pidb-server:local .
docker run --rm pidb-server:local --help
docker run --rm pidb-server:local --version 2>/dev/null || true
docker image inspect pidb-server:local --format '{{.Config.User}} {{json .Config.Entrypoint}} {{json .Config.Cmd}}'
```

Expected: the build succeeds; `--help` prints the `pidb-server` command list (`init`, `start`, `rotate-key`, `backup`); the inspect line shows user `node` and the entrypoint/command above. Record the output. If the daemon is unavailable, report Step 5's Docker half as **NOT VERIFIED — Docker daemon unavailable**.

- [ ] **Step 6: Commit**

```bash
git add docker .dockerignore .gitignore
git commit -m "feat(deploy): add the multi-stage Docker image and health probe

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
git log -1 --format=%B
```

---

## Task 3: The Compose stack — Caddy, environment, services

**Files:**
- Create: `docker/Caddyfile`, `docker/.env.example`, `docker/docker-compose.yml`

**Interfaces:**
- Consumes: the image from Task 2 (`build: { context: .., dockerfile: docker/Dockerfile }`), `docker/backup-loop.sh` (Task 4), `PIDB_MASTER_KEY_FILE`, `PIDB_TRUST_PROXY`, `PIDB_DOMAIN`, `PIDB_ACME_EMAIL`.
- Produces: services `server`, `caddy`, `backup`; volumes `pidb-data`, `caddy-data`, `caddy-config`; secret `master_key` sourced from `./secrets/master_key`.

- [ ] **Step 1: Write the Caddyfile**

`docker/Caddyfile`:

```
{
	email {$PIDB_ACME_EMAIL}
}

{$PIDB_DOMAIN} {
	encode zstd gzip
	reverse_proxy server:8080
	log {
		output stdout
		format json
	}
}
```

- [ ] **Step 2: Write the environment template**

`docker/.env.example`:

```dotenv
# Copy to docker/.env and fill in. NEVER put the master key in this file:
# it belongs in docker/secrets/master_key (mounted at /run/secrets/master_key).

# The hostname Caddy gets a certificate for.
PIDB_DOMAIN=pidb.example.com
# Contact address for Let's Encrypt.
PIDB_ACME_EMAIL=you@example.com

# Caddy terminates TLS, so the server must trust X-Forwarded-Proto — without
# this the admin session cookie is issued without the Secure flag.
PIDB_TRUST_PROXY=true

# pino level: trace | debug | info | warn | error | fatal
PIDB_LOG_LEVEL=info

# Master key version, and previous versions during a rotation:
# PIDB_MASTER_KEY_VERSION=1
# PIDB_MASTER_KEY_PREVIOUS=1:<base64-of-32-bytes>

# Backup loop: interval in seconds and how many copies to keep.
PIDB_BACKUP_INTERVAL=86400
PIDB_BACKUP_KEEP=14
```

- [ ] **Step 3: Write the compose file**

`docker/docker-compose.yml`:

```yaml
name: pidb

x-image: &image
  build:
    context: ..
    dockerfile: docker/Dockerfile
  image: pidb-server:local

services:
  server:
    <<: *image
    restart: unless-stopped
    env_file:
      - .env
    environment:
      PIDB_MASTER_KEY_FILE: /run/secrets/master_key
      PIDB_DATA_DIR: /data
      PIDB_PORT: "8080"
    secrets:
      - master_key
    volumes:
      - pidb-data:/data
    expose:
      - "8080"

  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    depends_on:
      - server
    env_file:
      - .env
    ports:
      - "80:80"
      - "443:443"
      - "443:443/udp"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
      - caddy-config:/config

  backup:
    <<: *image
    restart: unless-stopped
    depends_on:
      - server
    env_file:
      - .env
    environment:
      PIDB_MASTER_KEY_FILE: /run/secrets/master_key
      PIDB_DATA_DIR: /data
    secrets:
      - master_key
    volumes:
      - pidb-data:/data
    entrypoint: ["/bin/sh", "/app/docker/backup-loop.sh"]

volumes:
  pidb-data:
  caddy-data:
  caddy-config:

secrets:
  master_key:
    file: ./secrets/master_key
```

Both `server` and `backup` share the same build and image via the `x-image` anchor, so Compose builds once and the backup loop runs the very same `pidb-server` binary against the same `/data` volume.

- [ ] **Step 4: Validate the stack offline**

`docker compose config` refuses to run while `./secrets/master_key` is missing, so create a throwaway one first (it is git-ignored by Task 2's `.gitignore` entry):

```bash
mkdir -p docker/secrets
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))" > docker/secrets/master_key
cp docker/.env.example docker/.env
docker compose -f docker/docker-compose.yml config
```

Expected: the rendered configuration prints with three services, three volumes and the `master_key` secret; `server` and `backup` both show `image: pidb-server:local`; no value from `docker/secrets/master_key` appears anywhere in the output. Record the output.

Then confirm nothing secret is staged: `git status --short docker` must show only `Caddyfile`, `.env.example` and `docker-compose.yml` as new files — **never** `.env` or `secrets/master_key`. If either appears, STOP and report BLOCKED.

- [ ] **Step 5: Commit**

```bash
git add docker/Caddyfile docker/.env.example docker/docker-compose.yml
git commit -m "feat(deploy): add the Compose stack with Caddy TLS and a file-mounted master key

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
git log -1 --format=%B
```

---

## Task 4: The backup loop

**Files:**
- Create: `docker/backup-loop.sh`
- Test: `packages/server/test/backup-loop.test.ts`
- Modify: `docker/Dockerfile` (only if you commented out its `COPY docker/backup-loop.sh` line in Task 2 — restore it now)

**Interfaces:**
- Consumes: `node <cli> backup --out <dir> --keep <n>` (already implemented), `PIDB_BACKUP_INTERVAL` (seconds, default 86400), `PIDB_BACKUP_KEEP` (default 14), `PIDB_BACKUP_DIR` (default `$PIDB_DATA_DIR/backups`), `PIDB_SERVER_BIN` (default `/app/packages/server/dist/cli.js`), `PIDB_BACKUP_ONCE` (non-empty: run once and exit — used by the test).
- Produces: `docker/backup-loop.sh`, the `backup` service's entrypoint.

- [ ] **Step 1: Write the failing test**

`packages/server/test/backup-loop.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { openDb } from '../src/db/connection.js';

const repoRoot = resolve(import.meta.dirname, '../../..');
const script = join(repoRoot, 'docker/backup-loop.sh');
const serverCli = join(repoRoot, 'packages/server/dist/cli.js');

describe('backup-loop.sh', () => {
  it('runs one backup into the backup directory and exits 0', () => {
    expect(existsSync(serverCli)).toBe(true); // run `npm run build` first
    const dataDir = mkdtempSync(join(tmpdir(), 'pidb-backup-'));
    const dbPath = join(dataDir, 'pidb.sqlite');
    openDb(dbPath).close(); // create a real, migrated database

    const res = spawnSync('/bin/sh', [script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PIDB_MASTER_KEY: randomBytes(32).toString('base64'),
        PIDB_DATA_DIR: dataDir,
        PIDB_DB_PATH: dbPath,
        PIDB_SERVER_BIN: serverCli,
        PIDB_BACKUP_ONCE: '1',
        PIDB_BACKUP_KEEP: '2',
      },
    });

    expect(res.status).toBe(0);
    const backups = readdirSync(join(dataDir, 'backups'));
    expect(backups.length).toBe(1);
    expect(backups[0]).toMatch(/^pidb-.*\.sqlite$/);
  });

  it('keeps only PIDB_BACKUP_KEEP copies across runs', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'pidb-backup-keep-'));
    const dbPath = join(dataDir, 'pidb.sqlite');
    openDb(dbPath).close();
    const env = {
      ...process.env,
      PIDB_MASTER_KEY: randomBytes(32).toString('base64'),
      PIDB_DATA_DIR: dataDir,
      PIDB_DB_PATH: dbPath,
      PIDB_SERVER_BIN: serverCli,
      PIDB_BACKUP_ONCE: '1',
      PIDB_BACKUP_KEEP: '2',
    };
    for (let i = 0; i < 3; i++) {
      const res = spawnSync('/bin/sh', [script], { encoding: 'utf8', env });
      expect(res.status).toBe(0);
    }
    expect(readdirSync(join(dataDir, 'backups')).length).toBeLessThanOrEqual(2);
  });

  it('exits non-zero when the master key is missing', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'pidb-backup-nokey-'));
    const env: Record<string, string> = { ...process.env } as Record<string, string>;
    delete env.PIDB_MASTER_KEY;
    delete env.PIDB_MASTER_KEY_FILE;
    const res = spawnSync('/bin/sh', [script], {
      encoding: 'utf8',
      env: { ...env, PIDB_DATA_DIR: dataDir, PIDB_SERVER_BIN: serverCli, PIDB_BACKUP_ONCE: '1' },
    });
    expect(res.status).not.toBe(0);
    expect(`${res.stdout}${res.stderr}`).toContain('PIDB_MASTER_KEY');
  });
});
```

Note: the second backup in one calendar second would collide on the timestamped filename, which is why the "keep" assertion is `toBeLessThanOrEqual(2)` rather than an exact count.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build && npx vitest run packages/server/test/backup-loop.test.ts`
Expected: FAIL — `docker/backup-loop.sh` does not exist.

- [ ] **Step 3: Write the loop**

`docker/backup-loop.sh`:

```sh
#!/bin/sh
# Periodic backup loop for the pidb `backup` compose service.
# Calls the server CLI, which does VACUUM INTO and prunes to --keep.
# The master key is NEVER copied: a backup is the SQLite file only.
set -eu

INTERVAL="${PIDB_BACKUP_INTERVAL:-86400}"
KEEP="${PIDB_BACKUP_KEEP:-14}"
DATA_DIR="${PIDB_DATA_DIR:-/data}"
OUT="${PIDB_BACKUP_DIR:-${DATA_DIR}/backups}"
CLI="${PIDB_SERVER_BIN:-/app/packages/server/dist/cli.js}"

while :; do
  if node "$CLI" backup --out "$OUT" --keep "$KEEP"; then
    status=0
  else
    status=$?
    echo "pidb backup failed with status ${status}" >&2
  fi

  if [ -n "${PIDB_BACKUP_ONCE:-}" ]; then
    exit "$status"
  fi

  sleep "$INTERVAL"
done
```

Two `sh` details this depends on: the `if node …; then … else … fi` form keeps `set -e` from killing the loop on a failed backup (a transient failure must not stop the service), and `[ -n … ]` is written as a full `if` block because `[ … ] && exit` would itself trip `set -e` when the test is false.

Make it executable: `chmod +x docker/backup-loop.sh`.

If you commented out the `COPY docker/backup-loop.sh ./docker/backup-loop.sh` line in `docker/Dockerfile` during Task 2, restore it now.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/server/test/backup-loop.test.ts`
Expected: PASS (3 tests).

Then `npm run build && npx vitest run` — expected: 315 + 3 = 318 passing.

- [ ] **Step 5: Commit**

```bash
git add docker packages/server/test/backup-loop.test.ts
git commit -m "feat(deploy): add the periodic backup loop for the compose stack

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
git log -1 --format=%B
```

---

## Task 5: Document the deployment

**Files:**
- Modify: `README.md` (add a `## Deployment (Docker)` section after the `## Admin UI` section)

**Interfaces:**
- Consumes: everything Tasks 2–4 created.
- Produces: the operator-facing runbook — first run, TLS, backups, restore, key rotation.

- [ ] **Step 1: Write the section**

Insert after the `## Admin UI` section of `README.md`:

````markdown
## Deployment (Docker)

The stack is three services: `server` (this image), `caddy` (automatic TLS, reverse proxy) and `backup` (the same image running a 24-hour backup loop). Everything lives in `docker/`.

### First run

```bash
cd docker
cp .env.example .env            # set PIDB_DOMAIN and PIDB_ACME_EMAIL
mkdir -p secrets
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))" > secrets/master_key
chmod 600 secrets/master_key
```

**Store `secrets/master_key` in your password manager before going further.** It is mounted at `/run/secrets/master_key` and read through `PIDB_MASTER_KEY_FILE`; it is never baked into an image and never included in a backup. Lose it and every stored secret value is unrecoverable.

Create the admin user and the schema, then start the stack:

```bash
docker compose run --rm \
  -e PIDB_ADMIN_USERNAME=alex \
  -e PIDB_ADMIN_PASSWORD='change-me' \
  server init
docker compose up -d
docker compose logs -f server
```

Then open `https://$PIDB_DOMAIN/login`. Point the CLI at the same host with `pidb login --server https://$PIDB_DOMAIN`.

### What each variable does

`docker/.env.example` documents them all. The ones that matter most:

- `PIDB_DOMAIN`, `PIDB_ACME_EMAIL` — Caddy's certificate hostname and ACME contact.
- `PIDB_TRUST_PROXY=true` — **required** behind Caddy. Fastify only reports `https` (and the admin session cookie only gets its `Secure` flag) when it trusts `X-Forwarded-Proto`.
- `PIDB_BACKUP_INTERVAL` (seconds, default 86400) and `PIDB_BACKUP_KEEP` (default 14) — the backup loop.
- `PIDB_LOG_LEVEL` — pino level; logs are JSON on stdout, with credentials and secret-bearing request-body paths redacted.

### Backups and restore

The `backup` service writes `pidb-<timestamp>.sqlite` into the `pidb-data` volume under `/data/backups` every `PIDB_BACKUP_INTERVAL` seconds and prunes to the newest `PIDB_BACKUP_KEEP` copies. A backup is the database only — **it does not contain the master key**, so keep the key somewhere else or the copies are worthless.

Copy one off the host:

```bash
docker compose cp server:/data/backups ./backups-$(date +%F)
```

Restore into a stopped stack:

```bash
docker compose down
docker compose run --rm --entrypoint sh server -c \
  'cp /data/backups/pidb-<timestamp>.sqlite /data/pidb.sqlite'
docker compose up -d
```

### Rotating the master key

Generate the new key, keep the old one available under its version, then rewrap:

```bash
# in docker/.env
#   PIDB_MASTER_KEY_VERSION=2
#   PIDB_MASTER_KEY_PREVIOUS=1:<old-base64-key>
# and write the NEW key into docker/secrets/master_key
docker compose run --rm server rotate-key
docker compose up -d
```

Once `rotate-key` reports every secret rewrapped, the old key can be dropped from `PIDB_MASTER_KEY_PREVIOUS`.

### Upgrading

```bash
git pull
docker compose build
docker compose up -d
```

Migrations run on startup, so no separate step is needed.
````

- [ ] **Step 2: Verify the commands you documented exist**

Run: `node packages/server/dist/cli.js --help` and confirm `init`, `start`, `rotate-key` and `backup` all appear exactly as the README uses them. Run `grep -n "PIDB_" docker/.env.example` and confirm every variable the README names is present in the template. Fix any drift in the README, not in the code.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document the Docker deployment, backups and key rotation

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
git log -1 --format=%B
```

---

## Task 6: Full verification of the running stack

**Files:** none — this task only runs things and reports.

**Interfaces:** consumes everything from Tasks 1–5.

This task needs the Docker daemon. If it is unreachable, run the non-Docker half, then report the Docker half as **NOT VERIFIED — Docker daemon unavailable** and stop; do not fabricate output.

- [ ] **Step 1: Repository-level verification**

```bash
npm run build
npm run typecheck
npx vitest run
git status --short
```

Expected: build and typecheck clean, 318 tests passing, and a clean working tree with no `docker/.env` or `docker/secrets/` staged or untracked-and-forgotten (they must be git-ignored).

- [ ] **Step 2: Build the image**

```bash
docker build -f docker/Dockerfile -t pidb-server:local .
docker image inspect pidb-server:local --format '{{.Config.User}} {{json .Config.Volumes}}'
```

Expected: a successful build; user `node`; `/data` listed as a volume.

- [ ] **Step 3: Start the stack against a throwaway domain**

Caddy cannot obtain a real certificate for a test hostname, so verify the server through the container port directly instead of through Caddy:

```bash
cd docker
cp -n .env.example .env
mkdir -p secrets
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))" > secrets/master_key
docker compose run --rm -e PIDB_ADMIN_USERNAME=alex -e PIDB_ADMIN_PASSWORD=dev-pass server init
docker compose up -d server backup
docker compose ps
```

Expected: `init` prints `admin: created; guidelines: seeded`; both services come up; `server` reaches `healthy` within a minute (`docker compose ps` shows the health state).

- [ ] **Step 4: Exercise the running server**

```bash
docker compose exec server node docker/healthcheck.mjs && echo "health ok"
docker compose exec server wget -qO- http://127.0.0.1:8080/health
docker compose exec server wget -qS -O /dev/null http://127.0.0.1:8080/login 2>&1 | head -3
docker compose logs server | tail -20
```

Expected: the probe exits 0; `/health` returns `{"ok":true}`; `/login` answers `200` with `text/html`; the logs are pino JSON containing no password or secret value. (`wget` is BusyBox's, present in Alpine; if it is missing, use `node -e "fetch(...)"` instead and say so.)

- [ ] **Step 5: Prove the backup loop works end to end**

```bash
docker compose run --rm -e PIDB_BACKUP_ONCE=1 --entrypoint /bin/sh backup /app/docker/backup-loop.sh
docker compose exec server ls -l /data/backups
```

Expected: the one-shot run prints `backup written: /data/backups/pidb-<timestamp>.sqlite` and the listing shows that file. Then confirm the backup carries no key material:

```bash
docker compose exec server sh -c 'grep -c "$(cat /run/secrets/master_key)" /data/backups/*.sqlite || echo "key not present in backup"'
```

Expected: `key not present in backup`.

- [ ] **Step 6: Tear down and report**

```bash
docker compose down -v
cd ..
git status --short
```

Expected: the stack stops, the volumes are removed, and the working tree is clean. Record every command's output in your report, including anything you had to substitute.

There is nothing to commit in this task. If any step failed, report BLOCKED with the exact output rather than editing the plan's expectations.

---

## Done criteria

- `npm run build`, `npm run typecheck` and `npx vitest run` clean from the repo root (318 tests).
- `docker build -f docker/Dockerfile .` produces an image that runs as `node`, exposes 8080, declares `/data`, and whose `HEALTHCHECK` passes once the server is up.
- `docker compose -f docker/docker-compose.yml config` renders three services (`server`, `caddy`, `backup`), three volumes (`pidb-data`, `caddy-data`, `caddy-config`) and the `master_key` file secret.
- `docker compose up -d` yields a healthy server reachable on `/health` and `/login`, with Caddy reverse-proxying `$PIDB_DOMAIN` to `server:8080`.
- The backup service writes `pidb-<timestamp>.sqlite` under `/data/backups`, prunes to `PIDB_BACKUP_KEEP`, and the archive contains no key material.
- No secret value or master key appears in the repository, an image layer, a compose file, or a log line; `docker/.env` and `docker/secrets/` are git-ignored.
- `README.md` documents first run, the variables, backup/restore, key rotation and upgrades, and every command it names exists in `pidb-server --help`.
