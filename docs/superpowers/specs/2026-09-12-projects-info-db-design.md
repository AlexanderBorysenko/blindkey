# Projects Info DB — Design Spec

Date: 2026-09-12
Status: approved design, pre-implementation
Codename / CLI name: `pidb`

## 1. Purpose

A self-hosted server that stores everything about the projects Alex develops:

- **Secrets**: logins, hosts, IPs, passwords, API keys, SSH key bodies, `.env` blobs — encrypted at rest, retrievable only through an audited, scoped API.
- **Documents**: free-form Markdown describing a project (context, architecture, deploy notes, conventions, client info). Documents may *reference* secrets by name but must never contain secret values.

Two kinds of consumer:

1. **Alex** (single admin) via a web UI and a CLI.
2. **AI agents** (Claude Code, Claude Desktop, scripts) via a REST API and an MCP server, authenticated with scoped bearer tokens.

Core security rule: **secret values never enter an AI agent's context by default.** Agents read metadata and documents; values are consumed through the CLI (`exec` / `write` / `env`) which injects them into processes or files without printing them.

## 2. Non-goals (v1)

- Multi-user / RBAC. One admin account.
- TOTP / 2FA on admin login.
- Vault-style "sealed at boot" mode.
- Per-secret human-approval on reveal.
- Structured document schemas. Documents are free Markdown with guidelines only.
- Client-side encryption in the browser.

## 3. Architecture

Single Node.js 22 (TypeScript 5, ESM) process built on Fastify 5, backed by SQLite. Deployed as one Docker container behind Caddy (TLS). CLI is a separate package that talks to the server over HTTPS only.

```
packages/shared   types, zod schemas, secret-reference parser, secret-value lint
packages/server   Fastify app: db (better-sqlite3 + SQL migrations), crypto, repos,
                  REST API, MCP endpoint, server-rendered admin UI
packages/cli      `pidb` — HTTP client, env/file injection of secret values
docker/           Dockerfile, docker-compose.yml (server + caddy), Caddyfile
docs/             specs and plans
```

Runtime dependencies (server): `fastify`, `@fastify/cookie`, `@fastify/formbody`, `@fastify/rate-limit`, `@fastify/static`, `@fastify/view` + `eta`, `better-sqlite3`, `argon2`, `zod`, `@modelcontextprotocol/sdk`, `marked` (Markdown render for UI), `pino`.
CLI: `commander`, `undici` (or native fetch), `zod`.
Tooling: `typescript`, `vitest`, `tsx`, `eslint`, `prettier`.

## 4. Data model

SQLite file at `/data/pidb.sqlite`. Hand-written SQL migrations applied by a small in-app migrator (`schema_migrations` table). FTS5 virtual table over documents. `PRAGMA foreign_keys = ON`, `journal_mode = WAL`.

### projects
| column | type | notes |
|---|---|---|
| id | integer pk | |
| slug | text unique | url-safe, e.g. `critter-hero` |
| name | text | |
| status | text | `active` \| `paused` \| `archived` |
| tags | text (json array) | |
| summary | text | one-paragraph, non-sensitive |
| created_at, updated_at | integer (unix ms) | |

### secrets
| column | type | notes |
|---|---|---|
| id | integer pk | |
| project_id | integer fk nullable | `NULL` = global secret |
| name | text | human name, e.g. `Staging server`; unique within project (or within global); must not contain `/` (reserved by reference syntax) |
| description | text | non-sensitive notes |
| tags | text (json array) | |
| dek_wrapped | blob | data-encryption key encrypted with master key |
| key_version | integer | master key version used to wrap DEK |
| created_at, updated_at | integer | |

Contract: a secret is a **flat, one-level object of string keys to string values**. No fixed type. Any keys allowed (`host`, `username`, `password`, `private_key`, `content`, `whatever`). Categorization is via `tags` and `description` only. The UI offers optional key presets (server, login, api key, database) purely as typing shortcuts that insert empty rows; nothing is stored about which preset was used.

### secret_fields
| column | type | notes |
|---|---|---|
| id | integer pk | |
| secret_id | integer fk | cascade delete |
| key | text | any string, unique per secret |
| value_enc | blob | AES-256-GCM ciphertext (nonce ‖ tag ‖ ct) of the UTF-8 string value |
| is_sensitive | integer bool | `false` → shown in listings; `true` → reveal-only |
| sort | integer | display order |

Default `is_sensitive`: `true` except for keys `host`, `port`, `url`, `username`, `database`, `public_key`. Admin can override per field.

### documents
| column | type | notes |
|---|---|---|
| id | integer pk | |
| project_id | integer fk nullable | `NULL` = global document (e.g. guidelines) |
| slug | text | unique within project / global |
| title | text | |
| category | text | `context` \| `architecture` \| `deploy` \| `conventions` \| `client` \| `notes` \| `guidelines` |
| body_md | text | plaintext Markdown |
| created_at, updated_at | integer | |

`documents_fts` (FTS5) over `title`, `body_md`, kept in sync via triggers.

Documents are **not** encrypted: they must not contain secrets by policy + lint, and FTS search requires plaintext. Disk-level encryption of `/data` is an ops concern.

### api_tokens
| column | type | notes |
|---|---|---|
| id | integer pk | |
| name | text | e.g. `claude-code-macbook` |
| prefix | text | first 8 chars after `pidb_`, for identification |
| token_hash | text | sha256 hex of full token |
| scopes | text (json array) | see §7 |
| project_ids | text (json array) nullable | `NULL` = all projects; global secrets/docs always readable if scope allows |
| expires_at | integer nullable | |
| last_used_at | integer nullable | |
| revoked_at | integer nullable | |
| created_at | integer | |

### audit_log
| column | type | notes |
|---|---|---|
| id | integer pk | |
| ts | integer | |
| actor_type | text | `admin` \| `token` |
| actor_id | integer | admin id or token id |
| action | text | `secret.reveal`, `secret.create`, `secret.update`, `secret.delete`, `doc.write`, `doc.delete`, `project.*`, `token.create`, `token.revoke`, `auth.login`, `auth.login_failed`, `auth.token_failed` |
| target_type | text nullable | `secret` \| `document` \| `project` \| `token` |
| target_id | integer nullable | |
| field_key | text nullable | for `secret.reveal` |
| ip | text | |
| user_agent | text | |
| meta | text (json) nullable | |

Audit log is append-only from the app's perspective (no update/delete routes).

### admin / sessions
- `admin`: single row — `id`, `username`, `password_hash` (argon2id), `created_at`. Created by `pidb-server init` (see §10).
- `sessions`: `id` (random 32B hex), `admin_id`, `expires_at`, `created_at`, `ip`, `user_agent`.

## 5. Cryptography

### Master key
- Provided via `PIDB_MASTER_KEY` (base64, 32 bytes) or `PIDB_MASTER_KEY_FILE` (path; Docker secret friendly). Server refuses to start without one.
- `PIDB_MASTER_KEY_VERSION` (integer, default 1). Previous keys for rotation via `PIDB_MASTER_KEY_PREVIOUS` (comma-separated `version:base64`).

### Envelope encryption
- On secret creation: generate random 32-byte DEK. Wrap: `AES-256-GCM(master_key, DEK, aad = "secret-dek")` → `dek_wrapped` (nonce ‖ tag ‖ ct), `key_version = current`.
- Field encrypt: `AES-256-GCM(DEK, value, aad = secret_id + ":" + field_key)` → `value_enc`. Fresh 12-byte nonce per write.
- Field decrypt: unwrap DEK with master key matching `key_version`, then decrypt with AAD. AAD binding prevents moving ciphertext between fields/secrets.
- Rotation: `pidb-server rotate-key` unwraps every DEK with old key, rewraps with current, updates `key_version`. Field ciphertext untouched.

### Passwords, tokens, sessions
- Admin password: argon2id (memory 64 MiB, time 3, parallelism 1).
- API tokens: `pidb_<prefix8>_<base64url 32 bytes>`. Shown once on creation. Stored as sha256 hex. Lookup by prefix, compare hash with `timingSafeEqual`.
- Sessions: 32-byte random id, httpOnly, `Secure`, `SameSite=Strict` cookie, 7-day expiry, sliding not needed.
- Rate limits: login 5/min per IP; token-auth failures 20/min per IP. Failed attempts audited.

### Secret-value lint (documents)
`packages/shared/lint.ts` scans document bodies for probable secret material and returns findings `{ line, reason }`. Patterns:
- PEM blocks (`-----BEGIN ... PRIVATE KEY-----`)
- AWS access keys (`AKIA[0-9A-Z]{16}`), Stripe (`sk_live_`, `sk_test_`), GitHub (`ghp_`, `github_pat_`), Slack (`xox[baprs]-`), generic `sk-[A-Za-z0-9]{20,}`
- `password|passwd|pwd|secret|token|api[_-]?key` followed by `=` or `:` and a non-placeholder value of ≥ 6 chars
- Standalone base64/hex strings ≥ 32 chars not inside a fenced code block tagged `example`

Save with findings → HTTP 422 with findings list. Retry with `force: true` (API) or "Save anyway" (UI) to override; override is audited (`doc.write` with `meta.lint_forced = true`).

## 6. Secret references in documents

Syntax: `{{secret:<name>}}` for a secret in the same project, `{{secret:global/<name>}}` for a global secret, `{{secret:<project-slug>/<name>}}` for cross-project.

- `packages/shared/refs.ts` parses references from Markdown.
- On document save, server resolves each ref; unresolved refs → 422 `{ unresolved: [...] }` (also overridable with `force`, but not audited specially).
- Admin UI renders refs as links to the secret page. API returns raw Markdown; `GET .../docs/:doc?resolve=meta` additionally returns `refs: [{ name, project, fields: [{key, sensitive}] }]` so agents know which CLI command to run.

Seeded global document `guidelines` (category `guidelines`) explains: document categories, headings convention, how to reference secrets, "never paste values", and the CLI commands agents should use.

## 7. Authentication & authorization

Two principals:

1. **Admin session** (cookie) — full access, used by the web UI. Also usable by the CLI via `pidb login` which exchanges username/password for an admin-scope API token (named `cli-<hostname>`), so the CLI never stores the password.
2. **API token** (`Authorization: Bearer pidb_...`) — used by REST, MCP, and CLI.

Scopes:
| scope | grants |
|---|---|
| `projects:read` | list/get projects |
| `docs:read` | read documents, search |
| `docs:write` | create/update/delete documents |
| `secrets:meta` | list secrets, names, tags, descriptions, non-sensitive field values |
| `secrets:reveal` | read sensitive field values |
| `secrets:write` | create/update/delete secrets and fields |
| `admin` | everything, incl. tokens, audit log, project create/delete |

Token `project_ids` restricts every project-scoped route. Requests for a project outside the allowed set return **404** (same as non-existent) — no existence leak. Missing scope returns **403** `{ error: "missing_scope", scope: "secrets:reveal" }`.

Every successful `secrets:reveal` read writes an `audit_log` row (token id, secret id, field key, ip, UA). Admin UI reveal does the same with `actor_type = admin`.

## 8. REST API

Base `/api/v1`. JSON. Errors: `{ error: <code>, message?: string, ...details }`.

Projects
- `GET /projects` → `[{ slug, name, status, tags, summary, updated_at }]`
- `GET /projects/:slug` → project + `documents: [{ slug, title, category, updated_at }]` + `secrets: [{ name, description, tags, fields: [{ key, sensitive, value? }] }]` (value present only for non-sensitive fields)
- `POST /projects`, `PATCH /projects/:slug`, `DELETE /projects/:slug` (`admin`)

Documents
- `GET /docs` / `GET /projects/:slug/docs` → index
- `GET /docs/:doc` / `GET /projects/:slug/docs/:doc` → `{ slug, title, category, body_md, updated_at }`; `?resolve=meta` adds `refs`
- `PUT` same paths with `{ title, category, body_md, force? }` → create or update (`docs:write`)
- `DELETE` (`docs:write`)

Secrets
- `GET /secrets` / `GET /projects/:slug/secrets` → meta list (`secrets:meta`)
- `GET /projects/:slug/secrets/:name` → meta for one secret (`secrets:meta`)
- `GET /projects/:slug/secrets/:name/fields/:key` → `{ key, value }` (`secrets:reveal` for sensitive, `secrets:meta` for non-sensitive); `Accept: text/plain` returns raw value
- `GET /projects/:slug/secrets/:name/fields` → all fields `{ key: value }` (`secrets:reveal`) — used by `pidb secret exec`; one audit row per sensitive field
- `POST /projects/:slug/secrets` `{ name, description, tags, fields: [{ key, value, sensitive? }] }` — keys and values must be strings (`secrets:write`)
- `PATCH /projects/:slug/secrets/:name` — meta and/or field upserts/removals (`secrets:write`)
- `DELETE /projects/:slug/secrets/:name` (`secrets:write`)
- Global secrets use `/secrets/:name/...` with identical semantics.

Search
- `GET /search?q=` → `{ projects: [...], documents: [{ project, slug, title, snippet }], secrets: [{ project, name, tags }] }` (`docs:read` for docs, `secrets:meta` for secrets; sections omitted when scope missing). Never searches values.

Admin
- `GET /tokens`, `POST /tokens` `{ name, scopes, project_ids?, expires_at? }` → returns token once, `DELETE /tokens/:id` (revoke) (`admin`)
- `GET /audit?limit&before&action&actor` (`admin`)
- `GET /health` (no auth) → `{ ok: true }`

## 9. MCP server

Mounted at `POST /mcp` (Streamable HTTP transport from `@modelcontextprotocol/sdk`), authenticated by the same bearer token. Stateless per request (no server-side session store).

Tools (all read-only except `write_document`):
| tool | scope | returns |
|---|---|---|
| `list_projects` | projects:read | slugs, names, status, summary |
| `get_project(slug)` | projects:read | summary, document index, secret meta (names/tags/non-sensitive fields) |
| `read_document(project?, slug)` | docs:read | body + refs meta |
| `write_document(project?, slug, title, category, body_md, force?)` | docs:write | ok / lint findings |
| `search(query)` | docs:read / secrets:meta | as REST |
| `list_secrets(project?)` | secrets:meta | names, descriptions, tags, non-sensitive fields |

**There is no reveal tool.** Tool descriptions instruct agents to use `pidb secret exec / write / env` to consume values.

Claude Code registration: `claude mcp add --transport http pidb https://<host>/mcp --header "Authorization: Bearer pidb_..."`.

## 10. CLI `pidb` and server CLI

### Client CLI (`packages/cli`, bin `pidb`)
Config resolution: `PIDB_URL` / `PIDB_TOKEN` env → `~/.config/pidb/config.json` `{ url, token }`.

- `pidb login <url>` — prompts admin username/password, creates an `admin` token named `cli-<hostname>`, saves config.
- `pidb projects list` / `pidb projects get <slug>` (table / `--json`)
- `pidb docs list [<slug>]` / `pidb docs get [<slug>] <doc>` / `pidb docs put [<slug>] <doc> --file x.md --title --category [--force]`
- `pidb secrets list [<slug>]` — meta table
- `pidb secret exec <slug|global> "<name>" -- <command...>` — fetches all fields, injects as env `PIDB_<KEY_UPPER>` (e.g. `PIDB_HOST`, `PIDB_PASSWORD`), spawns command with inherited stdio. Values never written to CLI stdout/stderr.
- `pidb secret write <slug|global> "<name>" <field> --out <path> [--mode 600]` — writes value to file, default mode `0600`, refuses to overwrite without `--force`.
- `pidb secret env <slug|global> "<name>" --out <path>` — writes one `key=value` line per field (keys as stored). Mode `0600`. To materialize a stored `.env` blob, keep it in a single field (e.g. `content`) and use `pidb secret write ... content --out .env`.
- `pidb secret get <slug|global> "<name>" <field> --print` — prints value to stdout. Without `--print` prints a warning explaining exec/write/env and exits 2. Intended for humans.
- `pidb secret set <slug|global> "<name>" <field>` — reads value from stdin or `--from-file`, upserts.
- `pidb token create --name --scopes a,b --projects x,y [--expires 90d]` / `pidb token list` / `pidb token revoke <id>`
- `pidb search <query>`

### Server CLI (`packages/server`, bin `pidb-server`)
- `pidb-server init` — runs migrations, creates admin (prompts or `PIDB_ADMIN_USERNAME`/`PIDB_ADMIN_PASSWORD` env), seeds `guidelines` document.
- `pidb-server start` — runs migrations if pending, starts HTTP on `PIDB_PORT` (default 8080).
- `pidb-server rotate-key` — see §5.
- `pidb-server backup [--out dir]` — `VACUUM INTO /data/backups/pidb-<ts>.sqlite`, prunes to last 14.

## 11. Admin web UI

Server-rendered with Eta templates, HTMX for partial updates, Pico CSS (vendored, served by `@fastify/static`). No build step for the front-end. Routes under `/` (not `/api`), cookie session, CSRF token on all POST forms.

Pages:
- `/login`
- `/` — projects list, status filter, search box
- `/p/:slug` — project header (name, status, tags, summary edit), tabs: Documents, Secrets
- `/p/:slug/docs/:doc` — view rendered Markdown (refs → links); `/edit` textarea + live preview (HTMX POST to `/preview`), lint findings shown inline, "Save anyway"
- `/p/:slug/secrets/:name` — fields table; sensitive fields masked with "Reveal" button (HTMX fetch, audited) and "Copy"; edit form with dynamic add/remove key/value rows, optional preset button that inserts empty common keys
- `/global/docs/...`, `/global/secrets/...` — same as above for global
- `/tokens` — list, create (shows token once), revoke
- `/audit` — paginated table with filters

Markdown rendered with `marked`, output sanitized with `sanitize-html` before templating.

## 12. Deployment

- `docker/Dockerfile`: multi-stage (build TS → prod image with `node:22-alpine`, non-root user, `/data` volume).
- `docker/docker-compose.yml`: `server` (env from `.env`, `PIDB_MASTER_KEY_FILE=/run/secrets/master_key`) + `caddy` (Caddyfile reverse-proxy with automatic TLS for `PIDB_DOMAIN`). Volumes: `pidb-data`, `caddy-data`.
- Backups: a `backup` compose service (same image) running a shell loop that calls `pidb-server backup` every 24h. Master key is **not** in the backup; Alex stores it separately (password manager).
- Logs: pino JSON to stdout; secret values never logged (redaction paths configured for request bodies on secrets routes).

## 13. Error handling

- Missing master key at boot → exit 1 with clear message.
- DEK unwrap / field decrypt failure → 500 `{ error: "decrypt_failed" }`, logged at error level with secret id (not value), no partial data returned.
- Unknown project or out-of-scope project → 404 `{ error: "not_found" }`.
- Missing scope → 403 `{ error: "missing_scope", scope }`.
- Invalid/expired/revoked token → 401 `{ error: "unauthorized" }`, audited `auth.token_failed` (prefix only).
- Validation → 400 `{ error: "validation", issues }` (zod).
- Lint / unresolved refs → 422 as in §5/§6.
- CLI: non-zero exit codes: 1 generic, 2 refused (e.g. `get` without `--print`), 3 auth, 4 not found.

## 14. Testing

Vitest across packages.

Unit (`shared`, `server/crypto`):
- envelope encrypt/decrypt round trip; tampered ciphertext / wrong AAD fails; rotation rewraps and still decrypts
- token generation/hash/verify; expired/revoked rejected
- ref parser: project-local, global, cross-project, malformed
- lint: each pattern positive + negative, `example` fenced block exemption

Integration (`server`, `fastify.inject`, in-memory SQLite, migrations applied):
- auth: no token 401, bad token 401 + audit, revoked 401
- scopes: each route × missing scope → 403; project outside `project_ids` → 404
- `GET project` hides sensitive values, shows non-sensitive
- secret create rejects non-string keys/values and nested objects (400)
- reveal writes audit row; `fields` bulk reveal writes one row per sensitive field
- document save with secret-looking content → 422; `force` → 201 + audited
- unresolved ref → 422
- search never matches on secret values
- MCP: `tools/list` has no reveal tool; `list_secrets` returns no sensitive values
- admin UI: login flow, CSRF rejection, reveal endpoint audited

CLI:
- `secret exec` sets `PIDB_*` env in child and prints nothing of the value
- `secret write` creates file with mode 0600, refuses overwrite
- `secret get` without `--print` exits 2

## 15. Future work (not in v1)

TOTP for admin, sealed mode, per-secret approval flow, multi-user, structured document templates, secret expiry reminders (domain/cert dates), webhook/notification on reveal.
