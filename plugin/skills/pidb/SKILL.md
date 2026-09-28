---
name: pidb
description: Use when working in a repo bound to a pidb (Projects Info DB) project, or when the task needs project docs/memory (architecture, runbooks, deploy notes), secrets or credentials (database, deploy, SSH, API keys), or the pidb server itself — connecting, binding a repo, reading/writing project documents, running a command with a secret injected, or asking the user for a missing secret.
---

# pidb — project docs, memory and secrets for Claude Code

pidb is a self-hosted server that holds, per project, **documents** (Markdown: architecture, deploy runbooks, conventions, client notes — the project's long-term memory) and **secrets** (named groups of fields such as `host`, `port`, `username`, `password`). This plugin gives you that context safely:

- The SessionStart hook injects the bound project's summary, document index and secret names (sensitive fields marked `*`).
- The `pidb` MCP server (tools below) reads and writes docs and non-secret data.
- The `pidb` command (on the Bash PATH) runs things with secret values **substituted** — you never see a value.
- A guard hook blocks commands that would print, read or exfiltrate secret values, tokens or pidb's own state. If a command is denied, its reason names the safe alternative — use it; don't try to work around the guard.

## Data model

- **Project** — `slug`, name, status (`active|paused|archived`), tags, summary.
- **Document** — per project (or global), `slug`, title, category (`context|architecture|deploy|conventions|client|notes|guidelines`), Markdown body. Docs may reference secrets as `{{secret:Name}}` — never paste a value into a doc (the server rejects docs that look like they contain one).
- **Secret** — per project (or global), a `name` with fields; each field is sensitive (value hidden) or not (e.g. `host`, `port`, `username`, `database`). Global docs/secrets are visible to every project-scoped token.
- **Binding** — this repo (git top level) → `{ profile, project }`, stored locally in the plugin data dir (never committed).
- **Profile** — a named server URL (`prod`, `local`, …) with its agent token kept in the OS credential store.

## Golden rules

1. Never ask the user to paste a secret or token into chat; never print, echo, log, cat or base64 a secret.
2. Use values only via `pidb secret exec <target> "<name>" -- <cmd>` (env `PIDB_<KEY>`), or `pidb secret write|env --out <file>` for tools that need files; never read those files back.
3. Missing secret → call `secret_request_link` and give the user the link; wait; verify with `list_secrets`.
4. Keep project docs current with `write_document` (architecture, runbooks, decisions — the project "memory"); update project summary/tags with `update_project`; non-secret connection facts (host, port, username) go into non-sensitive fields via `upsert_secret_meta`.
5. 401/expired → run `pidb connect` (the user approves in the browser); 403 on a project → `pidb connect` to widen.
6. Never use curl against the pidb server; use MCP tools / the CLI.

## MCP tools (server `pidb`)

Local (answered by the plugin itself):
- `pidb_status` — profile, server URL, bound project, whether a token is stored, its projects/expiry. Never the token.
- `pidb_bind(project, profile?)` — bind this repo to a project (same as `pidb bind`).
- `pidb_profiles` — configured server profiles and the default.

Server (proxied with the agent token; project defaults to global when omitted):
- `list_projects`, `get_project(slug)`, `search(query)` — never searches secret values.
- `list_documents(project?)`, `read_document(project?, slug)`, `write_document(project?, slug, title, category, body_md, force?)`.
- `list_secrets(project?)` — names, field keys, sensitivity; never values.
- `update_project(slug, name?, status?, tags?, summary?)`.
- `upsert_secret_meta(project?, name, description?, tags?, fields?: [{key, value}])` — only non-sensitive fields; anything sensitive is the user's job.
- `secret_request_link(project?, name, description?, tags?, keys: [{key, sensitive}])` — a prefilled admin-UI link for the user.

There is deliberately no tool that returns a secret value.

## CLI (`pidb`, agent mode)

`<target>` is a project slug or `global`. Examples are the same in bash/zsh (macOS, Linux, Git Bash on Windows) and PowerShell unless shown separately.

```sh
pidb status                                  # profile, url, bound project, connected?
pidb profile add prod https://pidb.example.com
pidb profile list | use <name> | set-url <name> <url> | remove <name>
pidb connect [--profile prod]                # prints a URL + code; the user approves in the browser
pidb bind acme [--profile prod]              # bind this repo; `pidb unbind` to undo
pidb projects list | get acme
pidb docs list acme ; pidb docs get acme deploy
pidb secrets list acme                       # names/keys only
pidb search "staging database"
```

Using a secret — fields become env vars `PIDB_<KEY>` (upper-cased, non-alphanumerics → `_`) **inside the child process only**; the CLI redacts any value the child prints:

```sh
# macOS / Linux (sh, bash, zsh)
pidb secret exec acme "API" -- npm run sync                          # the program reads PIDB_* itself
pidb secret exec acme "DB" -- sh -c 'PGPASSWORD="$PIDB_PASSWORD" psql -h "$PIDB_HOST" -U "$PIDB_USERNAME" "$PIDB_DATABASE"'
pidb secret write acme "Deploy SSH" key --out ./.deploy_key          # file mode 600; never read it back
pidb secret env acme "DB" --out .env                                 # KEY=value lines for dotenv tools
```

```powershell
# Windows PowerShell
pidb secret exec acme "DB" -- pwsh -NoProfile -Command '$env:PGPASSWORD = $env:PIDB_PASSWORD; psql -h $env:PIDB_HOST -U $env:PIDB_USERNAME $env:PIDB_DATABASE'
pidb secret env acme "DB" --out .env
```

Never: `echo`/`printf`/`Write-Output` a `PIDB_*` variable, run `env`/`printenv`/`set`/`Get-ChildItem env:` inside `secret exec`, `cat`/`type`/`Get-Content` a file written by `secret write|env`, or run `pidb login`, `pidb token …`, `pidb secret get|set` (the user-only commands; they are refused).

## Secret-request flow (a value you need doesn't exist yet)

1. `list_secrets(project)` — confirm it's really missing (check global too).
2. Store what isn't secret yourself: `upsert_secret_meta(project, "Stripe", description, fields: [{key: "account_id", value: "acct_…"}])`.
3. `secret_request_link(project, "Stripe", description, keys: [{key: "secret_key", sensitive: true}, {key: "account_id", sensitive: false}])` → give the user the link and say what to type there. Don't ask for the value in chat.
4. Wait for the user to say it's done, then `list_secrets(project)` to verify the field exists, then use it with `pidb secret exec`.

## Keeping the project memory current

After meaningful work — a new service, a changed deploy procedure, a decision with a reason, a gotcha that cost time — update the docs before finishing:
- `read_document` first, then `write_document` with the full updated body (it replaces the doc). Use `architecture` for structure and data flow, `deploy` for runbooks (commands, hosts, `{{secret:Name}}` references — never values), `notes`/`conventions` for decisions and rules.
- Keep `update_project` summary/tags accurate when the project's shape changes.
- Record non-secret connection facts (host, port, username, database, URLs) as non-sensitive fields via `upsert_secret_meta` rather than in prose.

## Troubleshooting

- **"no server configured"** → ask the user for the server URL, then `pidb profile add <name> <url>` (or `/pidb:server <name> <url>`), then `pidb connect`.
- **"not connected" / 401 / `token_expired`** → `pidb connect` (run it in the background or with a long timeout: it waits up to 10 minutes while the user approves in the browser). Tell the user to open the printed URL and check the code matches.
- **403 on a project** → the token wasn't approved for it: `pidb connect` again and ask the user to tick that project on the approval page.
- **"not bound"** → `pidb_bind(project)` if the user named the project, otherwise ask which project this repo is.
- **"no OS credential store available" / "installing plugin dependencies"** → first session after install: npm is installing `@napi-rs/keyring` into the plugin data dir in the background. Wait a minute or start a new session. If it keeps failing, the user can run `npm install --omit=dev` in `~/.claude/plugins/data/pidb-pidb` (Windows: `%USERPROFILE%\.claude\plugins\data\pidb-pidb`).
- **A command was denied by the pidb guard** → read the reason; it names the allowed alternative (e.g. pass a Grep `path`/`glob` that excludes a secret file).
- **Windows** → in Git Bash, `pidb` runs the sh shim; in PowerShell/cmd, `pidb.cmd`. Both need `node` on PATH.
