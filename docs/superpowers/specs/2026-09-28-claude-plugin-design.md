# pidb Claude Code Plugin — Design

Status: approved in conversation 2026-09-28 (sections 1–2 approved by the user; sections 3–5 written by the controller from the agreed decisions, user asked to proceed straight to implementation).

## Goal
Give Claude Code a stable, safe working context for pidb: it knows the bound project, reads/writes documentation and non-secret data itself, and uses secret values **only by substitution** (env/file injection) — never seeing them. The user's involvement shrinks to: approving a login in the browser, and typing secret values into the admin UI.

## Decisions (from the user)
- D1 Plugin code lives in this repo (`plugin/`); the repo is a local marketplace `pidb`. Edited locally, reinstalled like wp-developer.
- D2 Works on macOS and Windows.
- D3 Claude may use secret values, but only through substitution (`exec` env injection, `write`/`env` files). Maximum practical hardening.
- D4 Repo ↔ project binding is local only (plugin data), not a committed file.
- D5 Login = browser device flow (`pidb connect`); admin credentials and the token never pass through the terminal or chat.
- D6 One agent token per server profile, limited to the projects approved in the browser; widening = connect again.
- D7 New secrets: Claude produces a prefilled link to the admin UI form; the user types values there.
- D8 Architecture: local stdio MCP bridge + bundled agent-mode CLI + skill + hooks.

## 1. Server

### 1.1 Scopes and token kind
- New scopes appended to `SCOPES` in `packages/shared/src/schemas.ts`: `projects:write`, `secrets:meta-write`, `secrets:use`.
- `AGENT_SCOPES = ['projects:read','projects:write','docs:read','docs:write','secrets:meta','secrets:meta-write','secrets:use']` exported from shared. An agent token can never hold `admin`, `secrets:reveal` or `secrets:write`.
- Migration 4: `ALTER TABLE api_tokens ADD COLUMN kind TEXT NOT NULL DEFAULT 'user'` (`'user' | 'agent'`). `TokenRow.kind`. Principal gains `agent: boolean`.
- `projects:write`: `PATCH /api/v1/projects/:slug` (summary, tags, status, name — not slug) for projects the token can access. Create/delete/slug change stay `admin`.
- `secrets:meta-write`:
  - `POST .../secrets` allowed only when every field is `sensitive: false`;
  - `PATCH .../secrets/:name` allowed when it changes name/description/tags, and `fields` only for keys that are non-sensitive before and after (adding a new non-sensitive field is allowed; touching, adding or removing a sensitive field → 403 `forbidden` "sensitive fields need secrets:write");
  - DELETE stays `secrets:write`.
- Existing scope rules unchanged for user tokens. Globals keep current semantics (a project-scoped token also sees global docs/secrets); the connect approval page says so.
- Tokens UI (`/tokens`): shows an `agent` pill for kind agent and the three new scopes in the create form (for user tokens too).

### 1.2 Secret use endpoint
- `POST /api/v1/projects/:slug/secrets/:name/use` and `POST /api/v1/global/secrets/:name/use`, body `{ purpose: 'exec' | 'write' | 'env', fields?: string[] }` → `{ name, fields: Record<string,string> }` (all fields, or the listed ones).
- Allowed with `secrets:use` or `secrets:reveal`. Audit `secret.used` per request: target secret, meta `{ purpose, fields: [keys], agent: bool }` — never values.
- The existing reveal endpoints (`GET .../fields`, `GET .../fields/:key` for sensitive fields) keep requiring `secrets:reveal` — so an agent token cannot read a value outside the use endpoint, and `pidb secret get --print` fails server-side for it.
- Rate limit 60/min per token-less IP bucket as other secret routes (reuse existing config if any; else `{max: 120, timeWindow: '1 minute'}`).

### 1.3 Device flow (`pidb connect`)
- Migration 4 also creates:
  ```sql
  CREATE TABLE connect_requests (
    id INTEGER PRIMARY KEY,
    device_hash TEXT NOT NULL UNIQUE,   -- sha256 of device_code
    user_code TEXT NOT NULL UNIQUE,     -- e.g. WXYZ-1234
    name TEXT NOT NULL,                 -- token name, e.g. claude-prod@laptop
    scopes TEXT NOT NULL,               -- JSON, subset of AGENT_SCOPES
    projects TEXT NOT NULL,             -- JSON array of slugs requested (may be empty)
    expires_days INTEGER NOT NULL,
    status TEXT NOT NULL,               -- pending | approved | denied
    approved_scopes TEXT, approved_project_ids TEXT, approved_expires_days INTEGER,
    ip TEXT NOT NULL DEFAULT '', user_agent TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
  );
  ```
- `POST /api/v1/connect/start` (public; rate limit 10/min): body `{ name (1–100), scopes (non-empty subset of AGENT_SCOPES), projects (slugs, ≤200), expires_days (1–365, default 90) }` → 201 `{ device_code, user_code, verification_url: <origin>/connect?code=<user_code>, expires_in: 600, interval: 3 }`. `device_code` = 32 random bytes base64url; `user_code` = 8 chars from `BCDFGHJKLMNPQRSTVWXZ` as `XXXX-XXXX`. Unknown slugs are kept and shown as "unknown" on the page (not an error). Audit `connect.started`.
- `GET /connect?code=` (admin session required; the login flow preserves a safe `next` = same-origin relative path starting with `/connect`): shows name, IP, user agent, requested scopes (checkboxes, only requested ones pre-checked, only AGENT_SCOPES offered), all projects (requested ones pre-checked), expiry days, a note that global docs/secrets are visible to any project-scoped token, and Approve / Deny buttons. Unknown / expired / already-decided code → error page. `cache-control: no-store` (already global).
- `POST /connect/approve` / `POST /connect/deny` (CSRF, rate limit 10/min): approve requires ≥1 project and ≥1 scope; stores approved values, status `approved`; deny → `denied`. Audit `connect.approved` / `connect.denied`.
- `POST /api/v1/connect/poll` (public; rate limit 60/min): body `{ device_code }`:
  - unknown → 400 `invalid_request`; expired → 410 `expired`; pending → 428 `authorization_pending`; denied → 403 `access_denied` (row deleted).
  - approved → in one transaction: revoke active `kind='agent'` tokens with the same `name`, create the token (`kind='agent'`, approved scopes/projects, expiry), delete the request; 200 `{ token, id, name, scopes, projects: [slugs], expires_at }`. Audit `connect.token_issued`.
- Expired requests are purged opportunistically on start/poll.

### 1.4 Prefilled secret form
- `GET /p/:slug/secrets/new` and `/global/secrets/new` accept `name`, `description`, `tags` (comma-separated), `keys` (comma-separated field keys; a key ending in `!` is non-sensitive, e.g. `host!,password`) and prefill the form (sensitive = default checked unless `!`). Values are never accepted from the query. Nothing is created until the user submits.

### 1.5 MCP tools (server `/mcp`)
- `update_project(slug, name?, status?, tags?, summary?)` — `projects:write`.
- `upsert_secret_meta(project?, name, description?, tags?, fields?: [{key, value}])` — `secrets:meta-write`; creates (non-sensitive fields only) or patches per 1.1.
- `secret_request_link(project?, name, description?, tags?, keys: [{key, sensitive}])` — any secrets scope; returns `{ url }` built from the request origin (trust-proxy aware) per 1.4. Tool description: "give this link to the user; they type the values; then call list_secrets to confirm."
- Server instructions text updated: values are consumed only via `pidb secret exec|write|env`.

## 2. Plugin

### 2.1 Layout
```
.claude-plugin/marketplace.json      # repo root: { name: "pidb", plugins: [{ name: "pidb", source: "./plugin" }] }
plugin/
  .claude-plugin/plugin.json         # name pidb, version, description
  .mcp.json                          # { "mcpServers": { "pidb": { "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/dist/mcp.mjs"], "env": { "PIDB_PLUGIN_DATA": "${CLAUDE_PLUGIN_DATA}" } } } }
  bin/pidb                           # sh shim: exec node "<plugin root>/dist/pidb.mjs" "$@" with PIDB_AGENT=1
  bin/pidb.cmd                       # Windows shim, same
  hooks/hooks.json                   # SessionStart, PreToolUse (Bash|Read|Grep|Glob|Edit|Write|mcp__*), PostToolUse (Bash)
  skills/pidb/SKILL.md
  commands/connect.md, server.md, bind.md, status.md
  package.json                       # runtime deps installed into plugin data: @napi-rs/keyring
  dist/pidb.mjs, dist/mcp.mjs, dist/hook.mjs   # esbuild bundles, committed
```
- Root script `npm run build:plugin` (esbuild, dev dependency) bundles three entries from `packages/cli/src/agent/` (all plugin code lives there so vitest covers it): `pidb.mjs` (agent CLI), `mcp.mjs` (bridge), `hook.mjs` (hook dispatcher: `node hook.mjs guard|redact|session-start`) into `plugin/dist`. `@napi-rs/keyring` is external (native, installed at first run); everything else (commander, `@modelcontextprotocol/sdk`, shared) is bundled.
- Plugin data dir resolution (bin shims do not receive `CLAUDE_PLUGIN_DATA`): hooks and MCP get it from env; the CLI uses `PIDB_PLUGIN_DATA` if set, else derives it from its own path (`.../plugins/cache/<marketplace>/<plugin>/<version>/dist/pidb.mjs` → `~/.claude/plugins/data/<plugin>-<marketplace>`), else `~/.claude/plugins/data/pidb-pidb`.
- First run: SessionStart hook runs `npm install --omit=dev --no-audit --no-fund --prefix <data>` with the plugin's `package.json` if `<data>/node_modules/@napi-rs/keyring` is missing (timeout-tolerant; reports status in context). Bundles resolve keyring via `createRequire(<data>/package.json)`.

### 2.2 State (plugin data dir)
- `profiles.json` `{ default: string|null, profiles: { [name]: { url } } }`.
- `bindings.json` `{ [repoRoot]: { profile, project } }` — key = git top-level (or cwd), normalized (`path.resolve`, forward slashes, lower-cased drive letter on Windows).
- `written.json` `{ paths: string[] }` — absolute paths produced by `pidb secret write|env` in agent mode.
- Token: keyring entry service `pidb`, account `profile:<name>`. No keyring → hard error "no OS credential store available"; never a file fallback.
- All JSON writes are atomic (temp + rename).

### 2.3 Agent-mode CLI (`PIDB_AGENT=1`)
- Commands: `connect [--profile] [--url]`, `profile list|add <name> <url>|use <name>|remove <name>`, `bind <project>` / `unbind`, `status`, `projects list|get`, `docs list|get|put`, `secrets list`, `secret exec|write|env`.
- Not available (exit 2 with "not available to the Claude agent — ask the user"): `login`, `secret get`, `secret set`, `token *`.
- Config: url from the profile (bound profile for the cwd repo, else default), token from keyring. `PIDB_URL`/`PIDB_TOKEN` env ignored in agent mode.
- `connect`: start → print `Open <verification_url> and approve code <user_code>` → try to open the browser (`open` on macOS, `cmd /c start "" <url>` on Windows, `xdg-open` otherwise; failure is fine) → poll every `interval` s until success/deny/expiry (max 10 min) → store token in keyring → print name, projects, scopes, expiry (never the token). Requested scopes = all AGENT_SCOPES; requested projects = the bound project (if any) plus projects of the existing token.
- `secret exec|write|env` call the use endpoint (1.2) with the purpose.
- **exec redaction**: child stdout/stderr are piped; every occurrence of each value (length ≥ 4) and of its base64, base64url, URL-encoded and JSON-escaped forms is replaced by `[pidb:redacted]` before writing to the CLI's own stdout/stderr, correctly across chunk boundaries (hold back `maxPatternLength-1` bytes). stdin is inherited. Exit code preserved.
- **write/env** record the absolute output path in `written.json`; refuse to write inside the plugin data dir.

### 2.4 MCP bridge (`dist/mcp.mjs`, stdio)
- Resolves profile + token per call (cwd = Claude Code's project dir). Proxies server MCP tools by forwarding JSON-RPC `tools/list` / `tools/call` to `<url>/mcp` with the bearer token (MCP SDK client over Streamable HTTP).
- Local tools: `pidb_status` (profile, url, bound project, token present, token expiry/projects if known), `pidb_bind(project, profile?)`, `pidb_profiles()`.
- Server errors are returned as tool errors with a hint (`401 token_expired` → "run `pidb connect`"; 403 → "the token lacks access — run `pidb connect` to widen").
- Never returns the token; never exposes a reveal/use tool.

## 3. Hardening (hooks + skill)

### 3.1 PreToolUse guard (`hook.mjs guard`)
Deny (with a reason telling Claude the safe alternative) when:
- Bash command contains `pidb` together with `secret get`/`--print`, or `login`, or `token`.
- Bash command runs `pidb secret exec` and the child command prints environment: `echo`/`printf` of `$PIDB_`/`${PIDB_`/`%PIDB_`/`$env:PIDB_`, `env`, `printenv`, `set` (bare), `export -p`, `Get-ChildItem env:`, `gci env:`, `dir env:`, `ls env:`, `node -e`/`python -c` containing `process.env`/`os.environ`.
- Any tool touches protected paths: plugin data dir, `~/.config/pidb`, `%APPDATA%\pidb`, any path in `written.json` (Read/Grep/Glob/Edit/Write file paths, and Bash commands mentioning them: `cat`, `type`, `Get-Content`, `less`, `head`, `tail`, `grep`, `sed`, `awk`, `cp`, `base64`, `xxd`, `od`, `strings`).
- Bash reads OS credential stores: `security find-generic-password`/`find-internet-password`, `cmdkey /list`, `Get-StoredCredential`, `secret-tool lookup`, `keyring get`.
- Bash `curl`/`wget`/`Invoke-WebRequest`/`iwr`/`irm` targeting a configured pidb server URL (forces use of MCP/CLI).
The guard is heuristic defense-in-depth; the skill states the rules plainly.

### 3.2 PostToolUse redaction (`hook.mjs redact`, Bash)
Replace in tool output (via `updatedOutput`): pidb tokens (`pidb_[A-Za-z0-9_-]{20,}`), PEM private key blocks, `AKIA[0-9A-Z]{16}`, and `KEY=value` lines whose key matches `/(PASS(WORD)?|SECRET|TOKEN|API_?KEY|PRIVATE)/i` (value → `[pidb:redacted]`). Does not fetch secret values.

### 3.3 SessionStart (`hook.mjs session-start`)
- Ensures deps (2.1). Resolves binding for cwd. Injects `additionalContext` (≤ ~4 KB): profile + url, connection status, bound project summary, document index (slugs + titles), secret names with field keys (sensitive marked `*`), and the 6 golden rules (below). Unbound repo: short note + "call pidb_bind or ask the user which project". Not connected: "run `pidb connect`". Never throws; on any failure injects a one-line status.

### 3.4 Skill `pidb` — golden rules
1. Never ask the user to paste a secret or token into chat; never print, echo, log, cat or base64 a secret.
2. Use values only via `pidb secret exec <target> "<name>" -- <cmd>` (env `PIDB_<KEY>`), or `pidb secret write|env --out <file>` for tools that need files; never read those files back.
3. Missing secret → call `secret_request_link` and give the user the link; wait; verify with `list_secrets`.
4. Keep project docs current with `write_document` (architecture, runbooks, decisions — the project "memory"); update project summary/tags with `update_project`; non-secret connection facts (host, port, username) go into non-sensitive fields via `upsert_secret_meta`.
5. 401/expired → run `pidb connect` (the user approves in the browser); 403 on a project → `pidb connect` to widen.
6. Never use curl against the pidb server; use MCP tools / the CLI.
Plus: data model, tool list, profile/bind commands, Windows vs macOS notes.

### 3.5 Commands
`/pidb:connect [profile]`, `/pidb:server [name url | use name]`, `/pidb:bind [project]`, `/pidb:status` — each instructs Claude to run the matching agent CLI command / MCP tool.

## 4. Flows
- **First use:** install plugin → session start installs deps → "not connected" → `/pidb:server prod https://pidb.example.com` → `/pidb:connect` → browser approve → `/pidb:bind acme` → next session starts with the acme context.
- **New secret:** Claude needs Stripe → `secret_request_link` → user fills UI → Claude `list_secrets` → `pidb secret exec acme "Stripe" -- npm run sync`.
- **Docs:** after meaningful work Claude updates `write_document(project, 'architecture', ...)`.
- **Switch server:** `/pidb:server use local` → bindings keep their own profile.

## 5. Testing
- Server: vitest with `app.inject` — scopes/meta-write matrix, use endpoint + audit, device flow (start/poll states, approve/deny UI with CSRF, revoke same-name agent tokens, expiry), prefill form, MCP tools.
- CLI agent mode: in-memory token store injected in tests; redactor unit tests (chunk boundaries, encodings); exec e2e against `makeServer()`; disabled commands; written.json.
- Plugin: guard/redact/session-start hooks as pure functions with table tests (bash, zsh, PowerShell, cmd samples); MCP bridge against a test server; bundle smoke (`node plugin/dist/pidb.mjs --help`, mcp `tools/list`).
- Manual (controller): install the plugin from the local marketplace in Claude Code on macOS; connect to the local server; run a session. Windows verified by tests only (no Windows machine here) — noted as residual.

## 6. Out of scope
- Claude Desktop / claude.ai (plugin `bin/` is unsupported there).
- Linux keyring support beyond what `@napi-rs/keyring` gives for free.
- Guaranteeing secrecy against a deliberately malicious agent (the token scope + audit are the hard boundary).
