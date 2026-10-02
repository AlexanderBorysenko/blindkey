---
name: blindkey
description: Use when working in a repo bound to a blindkey (Blindkey) project, or when the task needs project docs/memory (architecture, runbooks, deploy notes), secrets or credentials (database, deploy, SSH, API keys), or the Blindkey server itself — connecting, binding a repo, reading/writing project documents, running a command with a secret injected, or asking the user for a missing secret.
---

# blindkey — project docs, memory and secrets for Claude Code

blindkey is a self-hosted server that holds, per project, **documents** (Markdown: architecture, deploy runbooks, conventions, client notes — the project's long-term memory) and **secrets** (named groups of fields such as `host`, `port`, `username`, `password`). This plugin gives you that context safely:

- The SessionStart hook injects the bound project's summary, document index and secret names (sensitive fields marked `*`).
- The `blindkey` MCP server (tools below) reads and writes docs and non-secret data.
- The `blindkey` command (on the Bash PATH) runs things with secret values **substituted** — you never see a value.
- A guard hook blocks commands that would print, read or exfiltrate secret values, tokens or blindkey's own state. If a command is denied, its reason names the safe alternative — use it; don't try to work around the guard.

## Data model

- **Project** — `slug`, name, status (`active|paused|archived`), tags, summary.
- **Document** — per project (or global), `slug`, title, category (`context|architecture|deploy|conventions|client|notes|guidelines`), Markdown body. Docs may reference secrets as `{{secret:Name}}` — never paste a value into a doc (the server rejects docs that look like they contain one).
- **Secret** — per project (or global), a `name` with fields; each field is sensitive (value hidden) or not. Only these keys are non-sensitive by default: `host`, `port`, `url`, `username`, `database`, `public_key` — every other key (`password`, `account_id`, `api_key`, …) is sensitive. Global docs/secrets are visible to every project-scoped token.
- **Binding** — this repo (git top level) → `{ profile, project }`, stored locally in the plugin data dir (never committed).
- **Profile** — a named server URL (`prod`, `local`, …) with its agent token kept in the OS credential store.

## Golden rules

1. Never ask the user to paste a secret or token into chat; never print, echo, log, cat or base64 a secret.
2. Use values only via `blindkey secret exec <target> "<name>" -- <cmd>` (env `BLINDKEY_<KEY>`), or `blindkey secret write|env --out <file>` for tools that need files; never read those files back.
3. Missing secret → call `secret_request_link` and give the user the link; wait; verify with `list_secrets`.
4. Keep project docs current with `write_document` (architecture, runbooks, decisions — the project "memory"); shared infrastructure memory (servers, conventions) lives in global docs — read/write them with `project` omitted; update project summary/tags with `update_project`; non-secret connection facts go into non-sensitive fields via `upsert_secret_meta` (`host`, `port`, `url`, `username`, `database`, `public_key` by default; any other non-credential key with `sensitive: false`). A new project you need → `create_project` (needs `projects:create`); it joins your token immediately.
5. 401/expired → run `blindkey connect` (the user approves in the browser); 403 on a project → `blindkey connect` to widen.
6. Never use curl against the Blindkey server; use MCP tools / the CLI.

## MCP tools (server `blindkey`)

Local (answered by the plugin itself):
- `blindkey_status` — profile, server URL, bound project, whether a token is stored, its projects/expiry. Never the token.
- `blindkey_bind(project, profile?)` — bind this repo to a project (same as `blindkey bind`).
- `blindkey_profiles` — configured server profiles and the default.

Server (proxied with the agent token; project defaults to global when omitted):
- `list_projects`, `get_project(slug)`, `search(query)` — never searches secret values.
- `list_documents(project?)`, `read_document(project?, slug)`, `write_document(project?, slug, title, category, body_md, force?)`.
- `list_secrets(project?)` — names, field keys, sensitivity; never values.
- `create_project(slug, name, status?, tags?, summary?)` — needs `projects:create`; the project is added to this token's projects at once (same session).
- `update_project(slug, name?, status?, tags?, summary?)`.
- `upsert_secret_meta(project?, name, description?, tags?, fields?: [{key, value, sensitive?: false}])` — non-sensitive fields only: `host`, `port`, `url`, `username`, `database`, `public_key` by default, or any key passed with `sensitive: false` unless it looks like a credential (`pass`, `secret`, `token`, `key`, `salt`, `auth`, `private`, …) — that, and every sensitive field, is refused; use `secret_request_link` for it.
- `secret_request_link(project?, name, description?, tags?, keys: [{key, sensitive}])` — a prefilled admin-UI link for the user. `sensitive: false` only takes effect for the non-sensitive keys above; any other key stays sensitive.

There is deliberately no tool that returns a secret value.

## CLI (`blindkey`, agent mode)

`<target>` is a project slug or `global`. Examples are the same in bash/zsh (macOS, Linux, Git Bash on Windows) and PowerShell unless shown separately.

```sh
blindkey status                                  # profile, url, bound project, connected?
blindkey profile add prod https://blindkey.example.com
blindkey profile list | use <name> | set-url <name> <url> | remove <name>
blindkey connect [--profile prod]                # prints a URL + code; the user approves in the browser
blindkey bind acme [--profile prod]              # bind this repo; `blindkey unbind` to undo
blindkey projects list | get acme
blindkey docs list acme ; blindkey docs get acme deploy
blindkey secrets list acme                       # names/keys only
blindkey search "staging database"
```

Using a secret — fields become env vars `BLINDKEY_<KEY>` (upper-cased, non-alphanumerics → `_`) **inside the child process only**; the CLI redacts any value the child prints:

```sh
# macOS / Linux (sh, bash, zsh)
blindkey secret exec acme "API" -- npm run sync                          # the program reads BLINDKEY_* itself
blindkey secret exec acme "DB" -- sh -c 'PGPASSWORD="$BLINDKEY_PASSWORD" psql -h "$BLINDKEY_HOST" -U "$BLINDKEY_USERNAME" "$BLINDKEY_DATABASE"'
blindkey secret write acme "Deploy SSH" key --out ./.deploy_key          # file mode 600; never read it back
blindkey secret env acme "DB" --out .env                                 # KEY=value lines for dotenv tools
```

```powershell
# Windows PowerShell
blindkey secret exec acme "DB" -- pwsh -NoProfile -Command '$env:PGPASSWORD = $env:BLINDKEY_PASSWORD; psql -h $env:BLINDKEY_HOST -U $env:BLINDKEY_USERNAME $env:BLINDKEY_DATABASE'
blindkey secret env acme "DB" --out .env
```

Never: `echo`/`printf`/`Write-Output` a `BLINDKEY_*` variable, run `env`/`printenv`/`set`/`Get-ChildItem env:` inside `secret exec`, `cat`/`type`/`Get-Content` a file written by `secret write|env`, or run `blindkey login`, `blindkey token …`, `blindkey secret get|set` (the user-only commands; they are refused).

## Secret-request flow (a value you need doesn't exist yet)

1. `list_secrets(project)` — confirm it's really missing (check global too).
2. Store what isn't secret yourself: `upsert_secret_meta(project, "Postgres", description, fields: [{key: "host", value: "db.internal"}, {key: "port", value: "5432"}, {key: "username", value: "app"}, {key: "schema", value: "public", sensitive: false}])`. A credential-looking key (e.g. `password`, `api_token`) or a sensitive one is refused with "sensitive fields need secrets:write" — that is expected, not a scope problem; don't `blindkey connect` to widen, request it instead (step 3).
3. `secret_request_link(project, "Postgres", description, keys: [{key: "password", sensitive: true}])` → give the user the link and say what to type there. Don't ask for the value in chat. (Keys other than the non-sensitive ones always come out sensitive; the user can untick one in the form if it isn't secret.)
4. Wait for the user to say it's done, then `list_secrets(project)` to verify the field exists, then use it with `blindkey secret exec`.

## Keeping the project memory current

After meaningful work — a new service, a changed deploy procedure, a decision with a reason, a gotcha that cost time — update the docs before finishing:
- `read_document` first, then `write_document` with the full updated body (it replaces the doc). Use `architecture` for structure and data flow, `deploy` for runbooks (commands, hosts, `{{secret:Name}}` references — never values), `notes`/`conventions` for decisions and rules.
- Keep `update_project` summary/tags accurate when the project's shape changes.
- Record non-secret connection facts (`host`, `port`, `url`, `username`, `database`, `public_key`, or other keys with `sensitive: false`) as non-sensitive fields via `upsert_secret_meta` rather than in prose.

## Shared infrastructure memory (global docs)

Servers, domains and cross-project conventions are **global** documents (listed under "Global documents" in the session context), e.g. `hacon-vps-1` for Hacon VPS #1, with credentials in the matching global secret.
- Before touching a server: `read_document` (no `project`) and follow its conventions and "Connecting" section.
- After changing it (new site, port, service, fix): `write_document` (no `project`) with the full updated body — update the relevant section and append a dated line to its change log. Never put a secret value in it; reference `{{secret:global/Name}}`.
- A new server gets its own global doc (category `deploy`) plus a global secret (`host`/`port`/`username`/`public_key` via `upsert_secret_meta`, the private key via `secret_request_link`).

## Troubleshooting

- **"no server configured"** → ask the user for the server URL, then `blindkey profile add <name> <url>` (or `/blindkey:server <name> <url>`), then `blindkey connect`.
- **"not connected" / 401 / `token_expired`** → `blindkey connect` (run it in the background or with a long timeout: it waits up to 10 minutes while the user approves in the browser). Tell the user to open the printed URL and check the code matches.
- **"project not found" (`not_found`) from `get_project`, `blindkey_bind` checks or any project tool** → the server says this both when the project doesn't exist and when the token wasn't approved for it (it never reveals which). First offer `blindkey connect` (`/blindkey:connect`) and ask the user to tick that project on the approval page; check the slug with `list_projects` as the secondary step.
- **`missing_scope` / `forbidden` (403)** → the token lacks a scope: `blindkey connect` again to widen.
- **"not bound"** → `blindkey_bind(project)` if the user named the project, otherwise ask which project this repo is.
- **"no OS credential store available" / "installing plugin dependencies"** → first session after install: npm is installing `@napi-rs/keyring` into the plugin data dir in the background. Wait a minute or start a new session. If it keeps failing, the user can run `npm install --omit=dev` in `~/.claude/plugins/data/blindkey-blindkey` (Windows: `%USERPROFILE%\.claude\plugins\data\blindkey-blindkey`).
- **A command was denied by the blindkey guard** → read the reason; it names the allowed alternative (e.g. pass a Grep `path`/`glob` that excludes a secret file).
- **Windows** → in Git Bash, `blindkey` runs the sh shim; in PowerShell/cmd, `blindkey.cmd`. Both need `node` on PATH.

## CLI equivalents (when the MCP tools are not loaded)

- `blindkey projects create <slug> --name "<Name>" [--summary …] [--tags a,b]`
- `blindkey docs delete <project|global-doc-slug> [doc]`
- `blindkey secrets meta <project|global> "<Name>" --field key=value [--field …] [--description …] [--tags …]` (fields are sent as non-sensitive)
- `blindkey secrets request <project|global> "<Name>" --key password [--plain-key host]` → prints the link for the user
- `blindkey secret exec` masks only the secret's sensitive values in command output; non-sensitive ones (host, username) stay readable.
