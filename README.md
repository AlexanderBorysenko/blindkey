# pidb — Projects Info DB

Self-hosted store for project documentation and encrypted secrets, with a scoped REST API and an MCP endpoint for AI agents. Secret values never enter an agent's context: agents read metadata and documents, and consume values through the `pidb` CLI (`exec` / `write` / `env`).

Spec: `docs/superpowers/specs/2026-09-12-projects-info-db-design.md`.

## Packages

- `packages/shared` — zod schemas, secret-reference parser (`{{secret:Name}}`), secret-value lint
- `packages/server` — Fastify server: REST (`/api/v1`), MCP (`/mcp`), `pidb-server` ops CLI
- `packages/cli` — `pidb` client CLI: docs, secret metadata, and value injection (`exec` / `write` / `env`)

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

`GET /api/v1/audit` accepts `before=<audit row id>` as an exclusive cursor (not a timestamp).

Create a scoped token for an agent (scopes: `projects:read docs:read docs:write secrets:meta secrets:reveal secrets:write admin`):

```bash
curl -s -XPOST localhost:8080/api/v1/tokens -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"name":"claude-code","scopes":["projects:read","docs:read","docs:write","secrets:meta"],"projects":["my-project"]}'
```

Register the MCP server in Claude Code:

```bash
claude mcp add --transport http pidb http://localhost:8080/mcp --header "Authorization: Bearer $AGENT_TOKEN"
```

## CLI (`pidb`)

```bash
npm run build
node packages/cli/dist/cli.js login http://localhost:8080     # prompts for the admin credentials
```

Configuration resolves from `PIDB_URL` / `PIDB_TOKEN`, then `~/.config/pidb/config.json` (written `0600` by `pidb login`; `PIDB_CONFIG_HOME` overrides the directory).

Put `pidb` on your `PATH` first — `npm link -w @pidb/cli` (or prefix each command below with `npx`) — so the examples run as written:

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

## Admin UI

The server renders an admin UI at `/` — the same Fastify process, no separate build.

```bash
npm run build
PIDB_ADMIN_USERNAME=alex PIDB_ADMIN_PASSWORD=change-me node packages/server/dist/cli.js init
node packages/server/dist/cli.js start
open http://localhost:8080/login
```

- Log in with the admin credentials created by `pidb-server init`; the session is a `pidb_session` cookie (httpOnly, SameSite=Lax, `Secure` behind HTTPS) valid for 7 days. The `Secure` flag is derived from `req.protocol`, which Fastify only reports as `https` when it trusts the `X-Forwarded-Proto` header from a proxy — so if TLS is terminated in front of the server (e.g. Caddy), you must also set `PIDB_TRUST_PROXY` (to `true`, or to the proxy's IP/CIDR — see [Environment](#environment)) or the cookie will be issued without `Secure`.
- Projects, documents and secrets are browsable and editable; document saves run the same secret-value lint as the API, with "Save anyway" as the audited override.
- Sensitive secret fields are masked. "Reveal" fetches one field, writes an `audit_log` row with `actor_type = admin`, and the response is `no-store`. To use a value, prefer `pidb secret exec|write|env`.
- `/tokens` creates API tokens (the value is shown once) and revokes them; `/audit` is the paginated audit log.
- Assets (Pico CSS, htmx) are served from `node_modules` under `/assets` — no CDN, so the UI works offline and under a strict CSP.

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
| `PIDB_TRUST_PROXY` | `false` | which proxy hops to trust for client IP: false, true, or a comma-separated IP/CIDR list of trusted proxies (set to the reverse-proxy address in Docker) |

## Scripts

`npm test` · `npm run typecheck` · `npm run build`

### Error codes

`unauthorized` · `missing_scope` · `not_found` · `validation` · `conflict` · `lint` · `unresolved_refs` · `rate_limited` · `payload_too_large` · `unsupported_media_type` · `bad_request` · `decrypt_failed` · `internal`
