<p align="center">
  <img src="assets/logo-wordmark.svg" alt="Blindkey" height="56">
</p>

<p align="center"><strong>Secrets your AI agents can use but never see.</strong></p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-4f46e5"></a>
  <img alt="Node 22" src="https://img.shields.io/badge/node-%E2%89%A522-4f46e5">
  <img alt="Self-hosted" src="https://img.shields.io/badge/self--hosted-yes-4f46e5">
</p>

Blindkey is a self-hosted secret manager and project-memory store built for AI coding agents such as Claude Code. Your agent can deploy, migrate a database or SSH into a box with real credentials, and the credential values never enter its context window, its transcript or its logs.

## Why

Coding agents need credentials to do useful work. The usual ways of giving them one all leak it:

- **Pasting it into chat** puts the value in the model's context, in the conversation transcript, and in whatever the provider keeps.
- **A `.env` file in the repo** is one `cat` away. The agent will read it the first time it debugs a connection error.
- **An environment variable in your shell** gets printed by `env`, `printenv`, stack traces and debug logs, and from there it lands in the transcript too.

Blindkey separates *using* a secret from *seeing* it. The agent knows a secret exists, which fields it has, and which project docs explain how to use it. When it needs the value, it runs a command through Blindkey, which injects the value into that one child process and redacts it from the output. The agent never holds the value itself.

Blindkey also stores each project's documentation (architecture notes, runbooks, deploy steps), so every new agent session starts with the project's context instead of rediscovering it.

## How it works

```
  Claude Code ──MCP──▶ Blindkey server         docs, secret names and field keys (never values)
       │
       │ Bash: blindkey secret exec acme "Prod DB" -- psql
       ▼
  blindkey CLI ──POST /secrets/:name/use──▶ server   scope secrets:use, audited as secret.used
       │                                    (value decrypted server-side, sent to the CLI only)
       ▼
  psql  ◀── env BLINDKEY_HOST, BLINDKEY_PASSWORD, …
       │
       ▼
  stdout/stderr ──▶ redactor ──▶ agent      the value and its encodings are masked
```

1. **Context.** At session start the Claude Code plugin loads the bound project's summary, document index and secret names into the session. Over MCP the agent can read and write docs and secret *metadata*.
2. **Use by substitution.** `blindkey secret exec <project> "<name>" -- <cmd>` exposes each field as `BLINDKEY_<KEY>` to the child process only. `secret write` and `secret env` write a file (an SSH key, a `.env`) that the agent is then blocked from reading.
3. **Missing secrets.** When the agent needs a secret that doesn't exist, it sends you a prefilled link to the admin UI. You type the value there, never in chat.
4. **Login.** An agent gets a token only after you approve it in the browser, and only for the projects you tick.

## Features

- **Project docs and memory:** Markdown documents per project plus global ones, full-text search, and `{{secret:Name}}` references that are linted so values never land in a doc.
- **Encrypted secrets:** flat key/value secrets with per-field sensitivity, envelope-encrypted at rest.
- **Scoped tokens:** per-project, per-scope API tokens with expiry. Agent tokens are approved in the browser through a device-code flow.
- **MCP endpoint and REST API:** a server-side MCP server plus a local stdio bridge for Claude Code.
- **Claude Code plugin:** session context, guard and redaction hooks, slash commands, and a skill that teaches the rules.
- **Admin web UI:** browse and edit everything, audited one-field reveal, token management, an audit log, and TOTP two-factor with recovery codes. It runs under a strict CSP with no CDN.
- **Operations:** a Docker image, Caddy or bring-your-own reverse proxy, scheduled integrity-checked backups, and master-key rotation.

## Security model

Blindkey's job is to keep secrets out of places they shouldn't be. Here is what it does, and where it stops.

### Encryption at rest

- Each secret has its own random 256-bit data key (DEK). Field values are encrypted with **AES-256-GCM** under that DEK, and the DEK itself is wrapped with the **master key** (envelope encryption).
- The master key comes from a file (a Docker secret at `/run/secrets/master_key`) or an environment variable. It is never stored in the database, never baked into the image, and never included in a backup.
- Key rotation (`blindkey-server rotate-key`) rewraps every DEK and every 2FA secret in one transaction. Old key versions stay readable until you retire them.
- TOTP secrets for two-factor login are encrypted with AES-256-GCM under the master key and rewrapped by the same rotation.

### Boundaries the server enforces

These don't depend on the agent behaving:

- **Agent tokens can't read values.** A token created through the browser approval page can never carry `admin`, `secrets:reveal` or `secrets:write`. The reveal endpoints, the UI and `secret get` are closed to it.
- **One audited path to values.** Values reach an agent's machine only through `POST …/secrets/:name/use` (scope `secrets:use`), which `blindkey secret exec|write|env` call. Every call writes a `secret.used` audit row with the purpose and field keys, never the values.
- **Project scope.** A token reaches only the projects you approved, **plus every global document and global secret**: globals are shared infrastructure by design, so don't store anything as global that every agent shouldn't be able to use. Revoking a token in the UI cuts the agent off on its next call.
- **Tokens are stored hashed** (SHA-256). The plaintext is shown once at creation.

### Credentials and login

- The admin password is hashed with **argon2id** (64 MiB, t=3).
- Optional **TOTP two-factor** with one-time recovery codes. Ten wrong codes lock code entry for 15 minutes.
- On the agent's machine the token lives in the **OS credential store** (macOS Keychain, Windows Credential Manager). It is never written to a file, printed, or returned by a tool.

### Web hardening

- Session cookies are `HttpOnly`, `SameSite=Lax`, and `Secure` behind HTTPS. CSRF tokens are HMACs of the session id.
- **Strict CSP:** `script-src 'self'; style-src 'self'`, with no inline scripts, handlers or styles anywhere in the UI. All assets are served locally.
- HSTS on HTTPS responses, and rate limits on login, token and device-code endpoints.
- Logs are JSON, with credentials and secret-bearing request bodies redacted.

### Defence in depth on the agent side

The Claude Code plugin adds layers that make accidental leaks unlikely:

- `secret exec` redacts every value from the child's output, along with its base64, base64url, URL-encoded and JSON-escaped forms.
- A PreToolUse guard blocks:
  - the user-only commands;
  - environment dumps inside `secret exec`;
  - reads of the plugin data dir, `~/.config/blindkey` and files written by `secret write|env`;
  - OS credential-store reads;
  - `curl`/`wget`/`Invoke-WebRequest` against the Blindkey server.
- A PostToolUse hook redacts tokens, private keys, AWS keys and `PASSWORD=`/`TOKEN=`-style lines from Bash output.

### Known limits

The agent-side layers are heuristics, not a sandbox:

- **Dotenv loaders.** A tool that loads a written `.env` and prints the result is not recognised as reading it. Examples: `docker compose config`, `node -r dotenv/config -e …`, and Python `dotenv_values`.
- **Recursive archives or copies.** Archiving, syncing or copying a *directory* that contains a written file (`tar czf x.tgz .`, `cp -r . /tmp/x`, `zip -r`) is not blocked. Only commands naming the file itself, or recursive searches over it, are blocked.
- **Deep nesting.** Pathologically nested shell constructs are allowed rather than parsed.
- **Other encodings and channels.** A child process can still send a value somewhere, or print it in an encoding the redactor doesn't know (hex, reversed, split).
- **A deliberately malicious agent is out of scope.** The token's project scope, `secrets:use`-only access, the audit log and revocation are the real limits. Give the agent only the projects it needs, and review `/audit`.

### Threat model at a glance

| Threat | Covered? |
|---|---|
| Secret value ends up in the model's context or transcript during normal work | **Yes.** Substitution, redaction and guard hooks. |
| Agent token stolen from the agent's machine | **Limited.** The attacker can use the approved projects' secrets and the global ones (audited, revocable), and, within the token's scopes, change docs and secret metadata, which future agent sessions read. It gets no admin access, cannot reveal values through the API or UI, and cannot write secret values. |
| Database file or backup stolen without the master key | **Yes.** Values are AES-256-GCM encrypted. |
| Server host compromised (root, with the master key) | **No.** Whoever controls the server controls the secrets. |
| An agent deliberately trying to exfiltrate a value it is allowed to use | **No.** Mitigated only by scope, audit and revocation. |
| Admin UI attacks (XSS, CSRF, brute force) | **Yes.** Strict CSP, CSRF tokens, rate limits, argon2id, optional 2FA. |

Found a vulnerability? See [SECURITY.md](SECURITY.md).

## Packages

- `packages/shared`: zod schemas, the secret-reference parser (`{{secret:Name}}`), and the secret-value lint.
- `packages/server`: Fastify server with REST (`/api/v1`), MCP (`/mcp`), the admin UI, and the `blindkey-server` ops CLI.
- `packages/cli`: the `blindkey` client CLI for docs, secret metadata and value injection (`exec` / `write` / `env`). It is also bundled into the Claude Code plugin.
- `plugin/`: the Claude Code plugin. This repo is its marketplace.

## Quick start

Run the server with Docker (full guide: [Deployment](#deployment-docker)):

```bash
git clone https://github.com/AlexanderBorysenko/blindkey.git && cd blindkey/docker
cp .env.example .env                       # set BLINDKEY_DOMAIN and BLINDKEY_ACME_EMAIL
mkdir -p secrets && (umask 077; openssl rand -base64 32 > secrets/master_key)
sudo chown 1000:1000 secrets/master_key
docker compose run --rm -e BLINDKEY_ADMIN_USERNAME=admin server init   # prompts for the password
docker compose up -d
```

Then install the Claude Code plugin on your machine ([Claude Code plugin](#claude-code-plugin)) and run `/blindkey:server`, `/blindkey:connect` and `/blindkey:bind`.

## CLI (`blindkey`)

```bash
npm run build
node packages/cli/dist/cli.js login http://localhost:8080     # prompts for the admin credentials
```

The token `blindkey login` saves lasts 30 days by default; `--expires <days>` sets 1–365. If two-factor authentication is on for the admin, `blindkey login` asks for a `2FA code:` after the password. Once a saved token expires, every command prints `token expired — run \`blindkey login <url>\` again` and exits with the auth exit code.

Configuration resolves from `BLINDKEY_URL` / `BLINDKEY_TOKEN`, then `~/.config/blindkey/config.json` (written `0600` by `blindkey login`; `BLINDKEY_CONFIG_HOME` overrides the directory).

Put `blindkey` on your `PATH` first — `npm link -w @blindkey/cli` (or prefix each command below with `npx`) — so the examples run as written:

```bash
blindkey projects list
blindkey projects get acme
blindkey docs list acme
blindkey docs get acme deploy --refs          # shows which secrets the doc references
blindkey docs put acme deploy --file deploy.md --title "Deploy" --category deploy
blindkey secrets list acme                    # names, field keys, sensitivity — never values
blindkey search "staging database"
```

Consuming secret values — none of these print the value:

```bash
blindkey secret exec acme "DB" -- psql        # fields become $BLINDKEY_HOST, $BLINDKEY_PASSWORD, …
blindkey secret write acme "SSH" content --out ~/.ssh/acme_key --mode 600
blindkey secret env acme "DB" --out .env
blindkey secret set acme "DB" password        # value read from stdin
blindkey secret get acme "DB" password --print   # explicit opt-in; exits 2 without --print
```

Admin:

```bash
blindkey token create --name claude-code --scopes projects:read,docs:read,secrets:meta --projects acme --expires 90d
blindkey token create --name backup-script --scopes secrets:reveal --no-expiry   # never expires
blindkey token list
blindkey token revoke 3
```

`token create` expires in 90 days by default; `--expires 90d|12h|30m` sets a duration, and `--no-expiry` creates a token that never expires (`--expires` and `--no-expiry` together are refused).

Exit codes: `0` success, `1` generic error, `2` refused (missing `--print`, would overwrite a file), `3` authentication or missing scope, `4` not found.

## Admin UI

The server renders an admin UI at `/` — the same Fastify process, no separate build.

```bash
npm run build
BLINDKEY_ADMIN_USERNAME=alex BLINDKEY_ADMIN_PASSWORD=change-me-please node packages/server/dist/cli.js init
node packages/server/dist/cli.js start
open http://localhost:8080/login
```

- Log in with the admin credentials created by `blindkey-server init`; the session is a `blindkey_session` cookie (httpOnly, SameSite=Lax, `Secure` behind HTTPS) valid for 7 days. The `Secure` flag is derived from `req.protocol`, which Fastify only reports as `https` when it trusts the `X-Forwarded-Proto` header from a proxy — so if TLS is terminated in front of the server (e.g. Caddy), you must also set `BLINDKEY_TRUST_PROXY` (to `true`, or to the proxy's IP/CIDR — see [Environment](#environment)) or the cookie will be issued without `Secure`.
- Projects, documents and secrets are browsable and editable; document saves run the same secret-value lint as the API, with "Save anyway" as the audited override.
- Sensitive secret fields are masked. "Reveal" fetches one field, writes an `audit_log` row with `actor_type = admin`, and the response is `no-store`. To use a value, prefer `blindkey secret exec|write|env`.
- `/tokens` creates API tokens (the value is shown once) and revokes them; `/audit` is the paginated audit log. The new-token dialog's "Expires in (days)" defaults to 90; its "Never expires" checkbox is the only way to create a non-expiring token, and the table flags an active non-expiring token with a `never expires` pill.
- Assets (the hand-written `app.css` stylesheet, IBM Plex fonts, htmx) are served from `node_modules`/`src/ui/public` under `/assets` — no CDN, so the UI works offline and under a strict CSP; the UI uses a small hand-written custom stylesheet (IBM Plex, light and dark themes) rather than a CSS framework (`prefers-color-scheme`).
- The UI runs under `script-src 'self'; style-src 'self'` with no exception for inline code: no view renders an inline `<script>`, an `on*=` handler or a `style=` attribute — all client-side behaviour lives in the one delegated file `/assets/app.js`.
- A project sidebar lists every project by status, plus global docs/secrets, tokens and audit — the same nav collapses to a `Menu` drawer below 800px. Each secret page shows its own recent-access panel (who revealed which field, and when), and a revealed field auto-hides itself after a short countdown.

### Two-factor authentication

- Set up TOTP two-factor at `/settings/2fa` (linked from the sidebar as "Two-factor"): scan the QR code with an authenticator app, or copy the text secret in by hand, then confirm with a 6-digit code. Confirming shows 10 one-time recovery codes — save them now, since each works only once and they are never shown again. Turning 2FA on signs out your other browser sessions; existing API tokens stay valid, so revoke old admin tokens you no longer need (the `never expires` pill marks the risky ones).
- Once enabled, the login page asks for a code after the username and password — a 6-digit TOTP code or a recovery code — and `blindkey login` prompts for `2FA code:` the same way.
- 10 wrong codes in a row lock code entry for 15 minutes; `blindkey-server 2fa reset` or `blindkey-server passwd` clears it.
- "Regenerate recovery codes" and "Turn off two-factor" (both on `/settings/2fa`) each require the current password plus a fresh second factor (a TOTP code or an unused recovery code), so an admin who lost the authenticator but kept a recovery code can still regenerate codes or turn 2FA off.
- Emergency reset — if both the authenticator and every recovery code are lost — from a shell on the host: `blindkey-server 2fa reset` (Docker: `docker compose run --rm --no-deps server 2fa reset`). It turns two-factor off for the admin account; log back in with the password and set it up again.

### Changing the password

- `/settings/password` (linked from the sidebar as "Password") asks for the current password, the new one twice, and — when two-factor is on — a fresh code (TOTP or recovery). On success every OTHER browser session is signed out; the one used to change the password stays logged in. API tokens are separate credentials and are not revoked.
- Shell recovery — if the password itself is lost — from a shell on the host: `blindkey-server passwd` (Docker: `docker compose run --rm --no-deps server passwd`). Prefer the hidden prompt (it asks twice, to catch typos, when run interactively, and is never echoed); it also reads the new password from `BLINDKEY_ADMIN_PASSWORD` if set, but that lands in shell history and the process list — the same warning as `init`'s first run — so use it only when the prompt isn't an option. Unlike the UI form it does not need the old password, so it signs out every session and clears any 2FA lockout; two-factor itself is left as is — pair it with `2fa reset` if that is also lost. `passwd` does not revoke API tokens; after a suspected compromise, review `/tokens`.

## Claude Code plugin

`plugin/` is a Claude Code plugin, and this repo is its local marketplace (`.claude-plugin/marketplace.json`, marketplace and plugin both named `blindkey`). It gives Claude a stable working context for the project a repo belongs to:

- **Session context** — each session in a bound repo starts with the project's summary, document index, secret names and field keys (sensitive ones marked `*`), plus the plugin's golden rules.
- **MCP tools** — a local stdio bridge (`dist/mcp.mjs`) proxies the server's own tools (`list_projects`, `get_project`, `create_project`, `list_documents`, `read_document`, `write_document`, `search`, `list_secrets`, `update_project`, `upsert_secret_meta`, `secret_request_link`), plus the local `blindkey_status`, `blindkey_bind` and `blindkey_profiles`. None of them returns a secret value.
- **`blindkey` on the Bash PATH** — the agent-mode CLI (`bin/blindkey`, `bin/blindkey.cmd` → `dist/blindkey.mjs`): `connect`, `profile`, `bind`/`unbind`, `status`, `projects`, `docs`, `secrets list`, `search`, and `secret exec|write|env`. The user-only commands (`login`, `token …`, `secret get|set`) are refused.
- **Skill and commands** — the `blindkey` skill (rules, tools, examples) and `/blindkey:server`, `/blindkey:connect`, `/blindkey:bind`, `/blindkey:status`.

**Your own `blindkey` inside Claude Code.** Claude Code appends the plugin's `bin/` to the *end* of PATH, so if you also installed `blindkey` yourself (`npm link`, a global install), Claude's Bash commands would run *your* copy — ungated and unredacted. To prevent that, any `blindkey` started with `CLAUDECODE=1` in its environment (Claude Code sets it for every Bash tool command) runs in agent mode: the same refusals, redaction and plugin state (`$CLAUDE_CONFIG_DIR` or `~/.claude`, `plugins/data/blindkey-blindkey`) as the plugin's shim. That includes commands you run yourself with `!blindkey …` in a Claude Code session; for those, opt out explicitly with `!BLINDKEY_ALLOW_USER_MODE=1 blindkey …` (PowerShell: `$env:BLINDKEY_ALLOW_USER_MODE='1'; blindkey …`). Outside Claude Code nothing changes.

Claude keeps the project docs current itself (`write_document`), stores non-secret facts itself (`create_project`, `update_project`, `upsert_secret_meta`), and uses secret values only by substitution. You approve logins in the browser and type secret values into the admin UI.

The security boundaries and agent-side protections are described in [Security model](#security-model).

### Install (macOS)

Requires Node.js ≥ 20 and npm on `PATH`, plus a checkout of this repo. The committed `plugin/dist` bundles mean no build step is needed.

```bash
git clone https://github.com/AlexanderBorysenko/blindkey.git ~/src/blindkey
claude plugin marketplace add ~/src/blindkey
claude plugin install blindkey@blindkey --scope user      # every project on this machine
# or, from inside one project: claude plugin install blindkey@blindkey --scope project
```

Inside Claude Code, the same is `/plugin marketplace add ~/src/blindkey`, then `/plugin install blindkey@blindkey`. Choose the scope as follows:

- `user` makes Blindkey available everywhere.
- `project` records the plugin in that repo's `.claude/settings.json`, so it is shared with everyone who opens the repo.
- `local` applies to this checkout only.

Repo bindings are always local (plugin data dir) and never committed.

### Install (Windows)

The steps are the same, in PowerShell:

```powershell
git clone https://github.com/AlexanderBorysenko/blindkey.git $HOME\src\blindkey
claude plugin marketplace add $HOME\src\blindkey
claude plugin install blindkey@blindkey --scope user
```

`node` and `npm` must be on `PATH`. In Git Bash, Claude runs the `bin/blindkey` sh shim; in PowerShell or cmd, it runs `bin/blindkey.cmd`.

### Syncing between machines

The repo is the plugin source. Each machine keeps a clone registered as the local marketplace, so local edits stay easy and every machine pulls the same version:

```bash
cd ~/src/blindkey && git pull          # get changes made on another machine
claude plugin marketplace update blindkey           # re-read the marketplace
claude plugin update blindkey@blindkey                  # takes effect for new sessions
```

After changing plugin code: `npm run build && npm run build:plugin`, bump `version` in `plugin/.claude-plugin/plugin.json`, commit (including `plugin/dist`) and `git push`. Profiles, repo bindings and tokens are per machine (plugin data dir and OS credential store) — run `/blindkey:server` and `/blindkey:connect` once on each new machine.

### First session and dependencies

The native keychain module `@napi-rs/keyring` is not bundled. On the first session start, the SessionStart hook copies `plugin/package.json` into the plugin data dir (`~/.claude/plugins/data/blindkey-blindkey`, or `%USERPROFILE%\.claude\plugins\data\blindkey-blindkey` on Windows) and runs `npm install --omit=dev` there in the background. The session context says "installing plugin dependencies…". Once npm finishes, usually within a minute, `blindkey connect` and the token work; at the latest, it works from the next session.

If the install fails, the output is in `deps-install.log` in that directory. It retries on a later session start after 10 minutes, or you can run `npm install --omit=dev` in the directory yourself.

### Update

```bash
cd ~/src/blindkey && git pull
npm install && npm run build:plugin     # only if you changed packages/cli/src/** or packages/shared/src/** yourself
claude plugin marketplace update blindkey
claude plugin update blindkey@blindkey           # then restart Claude Code
```

Claude Code caches an installed plugin by its `version` (`plugin/.claude-plugin/plugin.json`). When you change the plugin, bump that version; otherwise `claude plugin uninstall blindkey@blindkey` and install it again. The committed bundles are checked by the local test run: `npm test` (`packages/cli/test/plugin.bundle.test.ts`) rebuilds them and fails when `plugin/dist` is stale. After any change under `packages/cli/src/**` or `packages/shared/src/**`, run `npm run build:plugin` and commit `plugin/dist` with it.

### First use

1. **Server profile.** `/blindkey:server prod https://blindkey.example.com` runs `blindkey profile add`. Use `/blindkey:server use <name>` to switch the default; bound repos keep their own profile.
2. **Connect.** `/blindkey:connect` makes Claude run `blindkey connect`, which prints a URL and a code and tries to open your browser.
   - Log in to the admin UI if asked, check that the code matches, tick the projects (and scopes) this agent may reach, set the expiry, and approve.
   - The CLI receives the token and stores it in the OS keychain. Claude never sees it.
   - Connecting again later widens the token's projects or renews it. It replaces the previous agent token with the same name.
3. **Bind.** `/blindkey:bind acme` binds this repo (its git top level) to project `acme`. The next session starts with acme's context.
4. **Missing secrets.** When Claude needs a secret that doesn't exist, it gives you a prefilled link to the admin UI's secret form (`secret_request_link`). You type the values there, and Claude confirms with `list_secrets` and uses the secret via `blindkey secret exec`.

`/blindkey:status` shows the profile, server, bound project and token state at any time.

### Admin side

- **Approval page.** `/connect?code=…` is reached from the link `blindkey connect` prints, and requires the admin session. It lists the requesting name, IP and user agent. Only agent scopes are offered: `projects:read`, `projects:write`, `projects:create`, `docs:read`, `docs:write`, `secrets:meta`, `secrets:meta-write`, `secrets:use`. Global docs and secrets are visible to any project-scoped token. With `projects:create` the approval may pick no project at all: projects the agent creates are added to its token. Deny refuses the request.
- **Tokens page.** An approved request shows under "Approved — waiting for the agent" until the agent's next poll mints the token (the page refreshes itself). Each token is a card; **Manage** renames it (a display name, e.g. "Acme Shop · home PC" — a reconnect of the same agent session keeps it), changes which projects it can reach (including "all projects"), or revokes it. The approval page can set that name up front. Revoked tokens are folded away at the bottom.
- **Tokens.** `/tokens` lists agent tokens with an `agent` pill, next to user tokens. Revoke one there to cut the agent off immediately; its next call gets 401, and Claude will ask for `/blindkey:connect`.
- **Audit.** `/audit` records `connect.started`, `connect.approved`, `connect.denied`, `connect.token_issued` and every `secret.used` (purpose, field keys, whether an agent made the call).

## Deployment (Docker)

The stack is three services: `server` (this image), `caddy` (automatic TLS, reverse proxy) and `backup` (the same image running a 24-hour backup loop). Everything lives in `docker/`.

Caddy sends every response `Strict-Transport-Security: max-age=31536000` (no `includeSubDomains`, since other subdomains on `BLINDKEY_DOMAIN` are not this stack's to speak for) — once a browser has loaded the site over HTTPS, it refuses to retry over plain HTTP for a year, even if a link or a typed URL asks for `http://`.

### First run

```bash
cd docker
cp .env.example .env            # set BLINDKEY_DOMAIN and BLINDKEY_ACME_EMAIL
chmod 600 .env                  # it will hold key material during rotations
mkdir -p secrets
(
  umask 077                     # only inside this subshell, see below
  openssl rand -base64 32 > secrets/master_key
)
if [ "$(wc -c < secrets/master_key)" -eq 45 ]; then echo "key OK"; else echo "ERROR: secrets/master_key is not a 32-byte base64 key; do not continue" >&2; fi
chmod 600 secrets/master_key
sudo chown 1000:1000 secrets/master_key   # the containers run as uid 1000 (node)
```

The parentheses keep `umask 077` out of your login shell. Left set there, a later `git pull` would check out `docker/healthcheck.mjs` and `docker/backup-loop.sh` as mode 600, the image would copy them unreadable for uid 1000, the healthcheck would fail, and `caddy` and `backup` — which wait for a healthy `server` — would never start.

This does not require Node on the host — `openssl` is enough, and it's what you'll also use for rotation later. Do not use `node -e "..." > secrets/master_key` on a Docker-only VPS with no Node installed: the shell still creates the file, redirection succeeds, and you get a silently empty key.

The order matters: Compose bind-mounts this `file:` secret with its host owner and mode, and the containers run as uid 1000, so the key file must end up owned by uid 1000 — chown it after `chmod`, since once it belongs to uid 1000 a non-root operator can no longer write to it. Skip this and the server can't read the key and restarts in a loop. With userns-remap or rootless Docker, the in-container uid 1000 maps to a different host uid — chown to that mapped uid instead of 1000.

**Store `secrets/master_key` in your password manager before going further.** It is mounted at `/run/secrets/master_key` and read through `BLINDKEY_MASTER_KEY_FILE`; it is never baked into an image and never included in a backup. Lose it and every stored secret value is unrecoverable.

Create the admin user and the schema, then start the stack:

```bash
docker compose run --rm \
  -e BLINDKEY_ADMIN_USERNAME=alex \
  server init
docker compose up -d
docker compose logs -f server
```

`init` prompts for the admin password with hidden input (it is never echoed and never passed as `-e BLINDKEY_ADMIN_PASSWORD=...`, which would land in shell history and the process list). The password must be 12–1024 characters; a shorter one is rejected — just run `init` again.

Then open `https://$BLINDKEY_DOMAIN/login`. Point the CLI at the same host with `blindkey login https://$BLINDKEY_DOMAIN`.

### What each variable does

`docker/.env.example` documents them all. The ones that matter most:

- `BLINDKEY_DOMAIN`, `BLINDKEY_ACME_EMAIL` — Caddy's certificate hostname and ACME contact.
- `BLINDKEY_TRUST_PROXY=true` — **required** behind Caddy. Fastify only reports `https` (and the admin session cookie only gets its `Secure` flag) when it trusts `X-Forwarded-Proto`. The compose file already pins `BLINDKEY_TRUST_PROXY: "true"` for the `server` service, so this `.env` value is informational — it takes effect only if you run the server outside this compose file.
- `BLINDKEY_BACKUP_INTERVAL` (seconds, default 86400) and `BLINDKEY_BACKUP_KEEP` (default 14) — the backup loop.
- `BLINDKEY_LOG_LEVEL` — pino level; logs are JSON on stdout, with credentials and secret-bearing request-body paths redacted.

### Backups and restore

The `backup` service writes `blindkey-<timestamp>.sqlite` into the `blindkey-data` volume under `/data/backups` every `BLINDKEY_BACKUP_INTERVAL` seconds and prunes to the newest `BLINDKEY_BACKUP_KEEP` copies. Each backup is written to a temporary file and passed through `PRAGMA integrity_check` before being kept; a failed check deletes the temporary file and leaves no backup behind. A backup is the database only — **it does not contain the master key**, so keep the key somewhere else or the copies are worthless.

Backups live on the same `blindkey-data` volume as the database itself, so `docker compose down -v` deletes them along with everything else. Copy them off the host regularly — this needs the stack up:

```bash
docker compose cp server:/data/backups ./backups-$(date +%F)
```

Restore: stop the whole stack first (do **not** pass `-v`, or the backups you're about to restore from disappear too). List the backups and pick one:

```bash
docker compose down
docker compose run --rm --no-deps --entrypoint ls server -l /data/backups
```

Then swap the database inside a throwaway container. Set `BACKUP` to the exact file name you picked. The block stops the stack itself — the server must never have the database open during the swap, or it keeps writing to the moved-aside file and those writes vanish at its next restart — and brings it back up only if the swap succeeded:

```bash
BACKUP=blindkey-<timestamp>.sqlite
docker compose down && docker compose run --rm --no-deps -e BACKUP="$BACKUP" --entrypoint sh server -c '
  set -eu
  cd /data
  case "$BACKUP" in
    ""|*/*) echo "ERROR: set BACKUP to a file name from /data/backups; nothing changed" >&2; exit 1 ;;
  esac
  if [ ! -f "backups/$BACKUP" ] || [ ! -s "backups/$BACKUP" ]; then
    echo "ERROR: /data/backups/$BACKUP does not exist or is empty; nothing changed" >&2
    exit 1
  fi
  aside="pre-restore-$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir "$aside"
  for f in blindkey.sqlite blindkey.sqlite-wal blindkey.sqlite-shm; do
    if [ -e "$f" ]; then mv "$f" "$aside/"; fi
  done
  cp "backups/$BACKUP" blindkey.sqlite.restoring
  mv blindkey.sqlite.restoring blindkey.sqlite
  echo "restored $BACKUP; the previous database is in /data/$aside"
' && docker compose up -d
```

Nothing is deleted. The current database *and* its `-wal`/`-shm` files move together into a new timestamped `/data/pre-restore-…` directory: after an unclean stop the `-wal` file can hold committed transactions that were never checkpointed, so it is part of the old database and must stay next to it, but it must not stay next to the restored file, where SQLite would replay it. Every run gets its own directory, so running the block twice (or restoring a different backup after a wrong pick) never overwrites an earlier copy. If the block prints `ERROR` or fails part-way, `docker compose up -d` does not run — do not start the stack by hand, because the server silently creates an empty database when `/data/blindkey.sqlite` is missing. Fix the name and run the block again, or put *all* the old files back (the `-wal` file too) by naming the directory the block printed:

```bash
ASIDE=pre-restore-<timestamp>
docker compose down && docker compose run --rm --no-deps -e ASIDE="$ASIDE" --entrypoint sh server -c '
  set -eu
  cd /data
  case "$ASIDE" in pre-restore-?*) ;; *) echo "ERROR: set ASIDE to a pre-restore-… directory name" >&2; exit 1 ;; esac
  case "$ASIDE" in */*) echo "ERROR: ASIDE must be a name, not a path" >&2; exit 1 ;; esac
  if [ ! -s "$ASIDE/blindkey.sqlite" ]; then
    echo "ERROR: /data/$ASIDE/blindkey.sqlite does not exist; nothing changed" >&2
    exit 1
  fi
  rm -f blindkey.sqlite.restoring blindkey.sqlite blindkey.sqlite-wal blindkey.sqlite-shm
  mv "$ASIDE"/* .
  rmdir "$ASIDE"
  echo "moved $ASIDE back"
' && docker compose up -d
```

(That removes whatever database is in `/data` now — use it only to undo a restore that failed or restored the wrong backup. Like the swap block, it stops the stack first.)

**Verify before trusting the restore:** log in to the admin UI and reveal one secret field, or from a machine with the CLI run `blindkey secret get <target> <name> <field> --print`. Also run `docker compose run --rm --no-deps server key-versions` — expect every line `ok`. A decrypt error (in the UI, the CLI, or a `key-versions` line that isn't `ok`) means the backup was wrapped with an older master key version than the one currently loaded — see [Restoring a pre-rotation backup](#restoring-a-pre-rotation-backup). Only once you've confirmed the restore is good, remove the old copy (with the stack up), naming the directory exactly:

```bash
docker compose exec server rm -r "/data/pre-restore-<timestamp>"
```

Every stack start also runs a backup and prunes the oldest by count, so repeated restore attempts push old backups out — copy the ones you care about off the host first.

**Two-factor and restores:** restoring a backup taken before 2FA was enabled brings the server back without 2FA — the enrollment banner reappears, so enroll again. Running an older blindkey binary against a 2FA-enabled database ignores 2FA.

**Passwords, sessions and restores:** after a restore, the admin password and every session are as of the backup — anything changed since is gone. If the password changed since the backup (or you are restoring because of a suspected compromise), run `blindkey-server passwd` (Docker: `docker compose run --rm --no-deps server passwd`), which also signs out every session. API tokens are as of the backup too — review `/tokens`.

### Rotating the master key

Rotation rewraps every secret's DEK from the old key to a new one, so it needs the whole stack stopped — a server or backup process running against a live database while the key underneath it changes can wrap new secrets with the wrong version, or read the new key labelled as the old one. Secrets created in that window are lost once the old key is discarded, so don't skip the "stop" step:

```bash
docker compose stop server backup
```

Ask the database which key versions its secrets are wrapped with. This is the source of truth; `docker/.env` is only what you *think* is loaded:

```bash
docker compose run --rm --no-deps server key-versions
```

A `secrets vN: <count> rows, ok` line means every secret is wrapped with version **N**, and N+1 is the version you are rotating to; N should match the `BLINDKEY_MASTER_KEY_VERSION` line in `docker/.env` (no line means 1). Write down the `<count>` too. A `2fa vN: <count> rows, ok` line appears alongside it if any admin has 2FA enabled, and must show the same N. If there are no secrets yet but 2FA is enabled, only that `2fa vN` line appears — N is the version it shows. `no encrypted rows` means neither table has any rows yet, and N is whatever `.env` says. Any status other than `ok`, a second version line, or a non-zero exit code means stop and sort that out first — a restored pre-rotation backup is the usual cause, see [the end of this section](#restoring-a-pre-rotation-backup).

Put N in your shell for the blocks below. On the first rotation it is `N=1`, on the second `N=2`, and so on — use the number from the `key-versions` output, never one copied from an example. If your SSH session drops, set it again before continuing:

```bash
N=1
```

Read the *current* (old) key and store it in your password manager, labelled "blindkey master key version N" — you'll need it as long as any backup wrapped with it still exists:

```bash
sudo cat secrets/master_key
```

Generate the new key into a temporary file in `secrets/` (which git ignores), check its length, keep an exact copy of the old key next to the live one, and only then install the new key. The old key stays in `secrets/master_key.v$N` until the rotation is verified, so a typo in the password manager can't cost you the only copy. The block refuses to run a second time, because a second run would replace a new key you may already have stored or used:

```bash
(
  : "${N:?set N to the current key version first}"
  if [ -e "secrets/master_key.v$N" ]; then
    if sudo cmp -s secrets/master_key "secrets/master_key.v$N"; then
      echo "ERROR: secrets/master_key.v$N exists but the key was NOT replaced (an earlier run stopped part-way); run 'sudo rm secrets/master_key.v$N', then this block again" >&2
    else
      echo "ERROR: secrets/master_key.v$N exists and the key was already replaced; do not run this block again" >&2
    fi
    exit 1
  fi
  old_sum=$(sudo sha256sum secrets/master_key) || exit 1
  umask 077
  openssl rand -base64 32 > secrets/new_master_key
  if [ "$(wc -c < secrets/new_master_key)" -eq 45 ] &&
     sudo cp -p secrets/master_key "secrets/master_key.v$N" &&
     sudo install -o 1000 -g 1000 -m 600 secrets/new_master_key secrets/master_key; then
    echo "installed the new key; the version $N key is kept in secrets/master_key.v$N"
  elif [ "$(sudo sha256sum secrets/master_key)" = "$old_sum" ]; then
    sudo rm -f "secrets/master_key.v$N"
    echo "ERROR: new key NOT installed; secrets/master_key is unchanged" >&2
  else
    echo "ERROR: install failed part-way and secrets/master_key is damaged; put the old key back with 'sudo mv secrets/master_key.v$N secrets/master_key'" >&2
  fi
  rm -f secrets/new_master_key
)
```

The 45-byte check (44 base64 characters plus the trailing newline `openssl` writes) stops an empty or short file — e.g. from a failed `openssl` call, or a host with no Node where a `node -e` redirect silently produces an empty file — from ever becoming the live key. On `ERROR: new key NOT installed`, stop here: nothing has changed, and `docker compose up -d` brings the stack back as it was. On `ERROR: install failed part-way`, run the `sudo mv` it prints first — the live key file is only damaged when the copy of the old key was already complete. (With userns-remap or rootless Docker, use the mapped uid instead of 1000, as in [First run](#first-run).)

Read the new key back from its installed location and store it in the password manager, labelled "blindkey master key version N+1". The command refuses if the key-generation block did not complete or the file still holds the version N key:

```bash
if ! sudo test -f "secrets/master_key.v$N"; then echo "ERROR: no secrets/master_key.v$N, so the key-generation block did not complete" >&2; elif sudo cmp -s secrets/master_key "secrets/master_key.v$N"; then echo "ERROR: secrets/master_key is still the version $N key; do not store it as version N+1" >&2; else sudo cat secrets/master_key; fi
```

Edit `docker/.env` directly (not `echo`/`tee`, which leaves the key in shell history): set the version to N+1 and record the old key — the content of `secrets/master_key.v$N` (`sudo cat` it) — as version N. Write the actual numbers; for a second rotation that is `BLINDKEY_MASTER_KEY_VERSION=3` and `BLINDKEY_MASTER_KEY_PREVIOUS=2:<key>`:

```
BLINDKEY_MASTER_KEY_VERSION=<N+1>
BLINDKEY_MASTER_KEY_PREVIOUS=<N>:<the-key-in-secrets/master_key.vN>
```

(If `BLINDKEY_MASTER_KEY_PREVIOUS` still has entries from an earlier rotation, add this one as another comma-separated `version:key` pair rather than replacing it.)

Now rewrap every secret:

```bash
docker compose run --rm --no-deps server rotate-key
```

`rotate-key` rewraps everything — every secret and every 2FA TOTP secret — in one transaction: it either rewraps all of it or none. It now prints two lines; read them:

- **`rewrapped <count> secrets to key version <N+1>`**, with the count you wrote down: the rotation worked. Go on below.
- **`rewrapped <count> 2FA secrets`**: the second line, added for two-factor authentication. It is informational only — 0 is normal if no admin has 2FA enabled — and does not change how you read the first line above.
- **An error** (for example `no master key for version …`, a decrypt error, or a complaint about `BLINDKEY_MASTER_KEY_PREVIOUS`): nothing was rewrapped, including the 2FA secrets. Do not start the stack. `key version <v> does not decrypt …` means the *live* `secrets/master_key` — whatever is installed right now, labelled version <v> — is not the key those rows are actually wrapped with; check it against the password manager entry for version <v>, not the `PREVIOUS` entry. Any other error usually means `PREVIOUS` is wrong: compare it against `sudo cat "secrets/master_key.v$N"`, fix it, and run `rotate-key` again — or roll back as described below.
- **`rewrapped 0 secrets`** although `key-versions` showed secrets: this run changed nothing. Do not start the stack yet, and run `key-versions` again. If it still shows the same version as your first run, the numbers are wrong (N was not the version the rows use, or `.env` wasn't bumped): roll back. Only if your first run showed N and it now shows N+1 did an earlier `rotate-key` run already succeed (for example you are repeating the step after a dropped SSH session) — then the rotation is done: go on below.

To roll back — only while `key-versions` shows the same version as your first run, i.e. no `rotate-key` run has rewrapped anything — put the old key back and undo the `.env` edit:

```bash
sudo mv "secrets/master_key.v$N" secrets/master_key
```

then restore the previous `BLINDKEY_MASTER_KEY_VERSION`/`BLINDKEY_MASTER_KEY_PREVIOUS` lines in `docker/.env` and run `docker compose up -d`. You are back where you started. Delete the "version N+1" entry you stored in the password manager — that key was never used, and keeping it means a later attempt leaves you with two different "version N+1" keys.

After a successful rewrap, bring the stack back up and reveal one secret field (admin UI, or `blindkey secret get <target> <name> <field> --print`) to confirm the new key works:

```bash
docker compose up -d
```

Then check that the password-manager entry for version N matches `sudo cat "secrets/master_key.v$N"` character for character, and only then delete the on-disk copy with `sudo rm "secrets/master_key.v$N"`.

Once `rotate-key` has succeeded, you *may* also remove the `BLINDKEY_MASTER_KEY_PREVIOUS` line from `docker/.env` and run `docker compose up -d` again so the recreated containers drop it (until then, `docker inspect` and `docker compose config` still show it in plain text). Keep the `BLINDKEY_MASTER_KEY_VERSION` line: without it the server assumes version 1.

**Keep every retired key in the password manager** until no backup wrapped with it exists any more — neither in `/data/backups` (`docker compose exec server ls -l /data/backups`) nor in any copy you've moved off-host. Deleting a retired key while such a backup still exists makes that backup permanently unreadable. Backups are pruned by *count*, not by age: each backup run keeps the newest `BLINDKEY_BACKUP_KEEP` files, and the backup service runs one immediately every time its container starts — so each `docker compose up -d` also pushes the oldest copy out. If backups have been failing, pre-rotation copies can stay around far longer than `BLINDKEY_BACKUP_KEEP` days.

#### Restoring a pre-rotation backup

A backup taken before a rotation is wrapped with the old key version, so after restoring it every reveal fails with a decrypt error until you rewrap it to the current key:

1. Follow [Backups and restore](#backups-and-restore), but leave the trailing ` && docker compose up -d` off the swap block, so neither the server nor the backup service starts on data wrapped with the old key. (If the stack does start, the backup service immediately writes a new backup that is still wrapped with version M — keep key M until that backup is gone too.)
2. Make sure the stack is stopped (`docker compose stop server backup`) and run `docker compose run --rm --no-deps server key-versions`. Until step 3 below adds the version M key, this shows `secrets vM: <n> rows, no key configured` and exits 1 — that is expected here: M is the number in that line, and it is lower than your current `BLINDKEY_MASTER_KEY_VERSION`. (If it shows `secrets vM: <n> rows, ok` instead, `BLINDKEY_MASTER_KEY_PREVIOUS` still lists M from the rotation — skip step 3.)
3. Edit `docker/.env`: leave `BLINDKEY_MASTER_KEY_VERSION` at the current version and add `M:<the version M key from your password manager>` to `BLINDKEY_MASTER_KEY_PREVIOUS` (comma-separated if the line already has entries).
4. Run `docker compose run --rm --no-deps server rotate-key` and read its output exactly as above: expect `rewrapped <count> secrets to key version <current>`; on an error nothing changed — handle it as described in the error bullet above and try again. Then run `docker compose run --rm --no-deps server key-versions` — it should now show only the current version, ok.
5. `docker compose up -d`, reveal one secret field, then remove the `PREVIOUS` line as above.

### Behind an existing reverse proxy (nginx / CloudPanel)

If the host already serves 80/443 (CloudPanel, Plesk, a plain nginx), skip Caddy and let that proxy terminate TLS. Add to `docker/.env`:

```bash
COMPOSE_FILE=docker-compose.yml:docker-compose.proxy.yml
BLINDKEY_HOST_PORT=8090
```

`docker-compose.proxy.yml` moves Caddy into an unused profile and publishes the server on `127.0.0.1:8090` only. Keep it on the loopback address: Docker-published ports bypass ufw, so `0.0.0.0` would expose the server (and its trusted `X-Forwarded-*` handling) to the internet.

Point the proxy at `http://127.0.0.1:8090` and make it send `Host`, `X-Forwarded-For` and `X-Forwarded-Proto`. On CloudPanel that is one command (as root), followed by the certificate:

```bash
clpctl site:add:reverse-proxy --domainName=blindkey.example.com --reverseProxyUrl='http://127.0.0.1:8090' \
  --siteUser='example-blindkey' --siteUserPassword='<random>'
clpctl lets-encrypt:install:certificate --domainName=blindkey.example.com
```

The server itself sends `Strict-Transport-Security` on every HTTPS response (it trusts `X-Forwarded-Proto` from the proxy), so no vhost edit is needed. Everything else in this section (first run, backups, rotation, upgrades) is unchanged; the commands pick up `COMPOSE_FILE` from `docker/.env`.

### Upgrading

Take a backup first:

```bash
docker compose run --rm -e BLINDKEY_BACKUP_ONCE=1 backup
```

(the `backup` service's entrypoint is the same loop script that runs on a schedule; `BLINDKEY_BACKUP_ONCE=1` makes it run a single backup and exit instead of looping.)

```bash
git pull
docker compose build
docker compose up -d
```

Migrations run on startup, so no separate step is needed.

## Environment

| variable | default | purpose |
|---|---|---|
| `BLINDKEY_MASTER_KEY` | — | base64 32-byte key (or `BLINDKEY_MASTER_KEY_FILE`) — **required**; back it up separately |
| `BLINDKEY_MASTER_KEY_VERSION` | `1` | current key version |
| `BLINDKEY_MASTER_KEY_PREVIOUS` | — | `1:<base64>,2:<base64>` older keys for rotation |
| `BLINDKEY_DATA_DIR` | `/data` | sqlite + backups |
| `BLINDKEY_DB_PATH` | `$BLINDKEY_DATA_DIR/blindkey.sqlite` | |
| `BLINDKEY_PORT` / `BLINDKEY_HOST` | `8080` / `0.0.0.0` | |
| `BLINDKEY_LOG_LEVEL` | `info` | |
| `BLINDKEY_TRUST_PROXY` | `false` | which proxy hops to trust for client IP: false, true, or a comma-separated IP/CIDR list of trusted proxies (set to the reverse-proxy address in Docker) |
| `BLINDKEY_ADMIN_USERNAME` / `BLINDKEY_ADMIN_PASSWORD` | — | admin credentials for `blindkey-server init` (create) and `blindkey-server passwd` (reset); prompted interactively when unset |

## Scripts

`npm test` · `npm run typecheck` · `npm run build` · `npm run build:plugin` (regenerates the committed `plugin/dist` bundles)

`blindkey-server` ops CLI (see [Admin UI](#admin-ui) and [Deployment](#deployment-docker) for the recovery flows): `init` · `start` · `passwd` · `2fa reset` · `rotate-key` · `key-versions` · `backup`

### Error codes

`unauthorized` · `missing_scope` · `not_found` · `validation` · `conflict` · `lint` · `unresolved_refs` · `rate_limited` · `payload_too_large` · `unsupported_media_type` · `bad_request` · `decrypt_failed` · `internal`

## Development

```bash
npm install
export BLINDKEY_MASTER_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
export BLINDKEY_DATA_DIR=./data
npm run build
BLINDKEY_ADMIN_USERNAME=alex BLINDKEY_ADMIN_PASSWORD=change-me-please node packages/server/dist/cli.js init
node packages/server/dist/cli.js start
```

Get an admin token:

```bash
curl -s -XPOST localhost:8080/api/v1/auth/token -H 'content-type: application/json' \
  -d '{"username":"alex","password":"change-me-please","name":"cli"}'
```

`GET /api/v1/audit` accepts `before=<audit row id>` as an exclusive cursor (not a timestamp).

Create a scoped token for an agent (scopes: `projects:read docs:read docs:write secrets:meta secrets:reveal secrets:write admin`):

```bash
curl -s -XPOST localhost:8080/api/v1/tokens -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"name":"claude-code","scopes":["projects:read","docs:read","docs:write","secrets:meta"],"projects":["my-project"]}'
```

Register the MCP server in Claude Code:

```bash
claude mcp add --transport http blindkey http://localhost:8080/mcp --header "Authorization: Bearer $AGENT_TOKEN"
```

## Status and licence

Blindkey is a personal project. The author runs it in production for their own work, but there are no stability guarantees: the API, CLI and plugin may change between versions. Issues and pull requests are welcome.

Released under the [MIT licence](LICENSE).
