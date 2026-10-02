# Blindkey: rebrand and public release — design

Date: 2026-10-02. Status: draft for review.

## 1. Goal

Rename the project from **pidb (Projects Info DB)** to **Blindkey**, give it a public face (logo, UI
accent, README, SECURITY.md, MIT licence), and publish it as an open-source pet project in a **new**
public GitHub repo, while the owner keeps using it in production without data loss.

Tagline: **"Secrets your AI agents can use but never see."**
Positioning: a self-hosted secret manager and project-memory store for AI coding agents (Claude Code).

### Decisions (user-confirmed)

| # | Decision |
|---|----------|
| D1 | Full rename everywhere: binaries, packages, env vars, plugin, cookies, MCP tools, keychain, config dir, token prefix. |
| D2 | Clean break, no legacy compatibility code. A one-time runbook migrates prod and each machine. |
| D3 | New public repo `AlexanderBorysenko/blindkey`, starting from a fresh initial commit. The private `projects-info-db` repo stays private as the archive with full history. |
| D4 | Agent working materials are git-ignored and never published (§5). |
| D5 | MIT licence. |
| D6 | Visual: SVG logo (mark + wordmark), favicon, accent colour in the Pico theme, branded login page. No page redesigns. |
| D7 | Public docs in English. |

### Order (approved)

A. Code changes on branch `rebrand/blindkey` in the private repo, test-driven, all tests green.
B. Migrate prod and machines with the runbook (§7) and verify.
C. Publish: secret scan, manual review, new repo, repoint `origin` and the plugin marketplace (§8).

Nothing is published before B is verified.

## 2. Rename map

The rename is mechanical: every row is a find/replace with the listed exceptions. One prefix,
`BLINDKEY_`, covers server config, CLI config and injected secret values. That keeps the existing
reserved-name collision check in `secret exec` working 1:1.

| Area | Before | After |
|---|---|---|
| Product name (UI, README, descriptions, `--help`) | pidb / Projects Info DB | Blindkey |
| Root package | `pidb-monorepo` | `blindkey-monorepo` |
| Workspaces | `@pidb/shared`, `@pidb/server`, `@pidb/cli` | `@blindkey/shared`, `@blindkey/server`, `@blindkey/cli` |
| Client CLI bin | `pidb` | `blindkey` |
| Server ops bin | `pidb-server` | `blindkey-server` |
| Env vars (all, incl. `PIDB_URL`, `PIDB_TOKEN`, `PIDB_CONFIG_HOME`, `PIDB_AGENT`, `PIDB_PLUGIN_DATA`, server and docker vars) | `PIDB_*` | `BLINDKEY_*` |
| Injected secret fields (`secret exec`, `secret env`) | `PIDB_<KEY>` | `BLINDKEY_<KEY>` |
| API token format + parse regex | `pidb_<8>_<43>` | `bk_<8>_<43>` |
| Token redaction regex (PostToolUse) | `pidb_[A-Za-z0-9_-]{20,}` | `bk_[A-Za-z0-9_-]{20,}` |
| UI cookies | `pidb_session`, `pidb_2fa` | `blindkey_session`, `blindkey_2fa` |
| TOTP issuer | `pidb` | `Blindkey` |
| Server MCP name | `pidb` | `blindkey` |
| Local MCP tools (bridge) | `pidb_status`, `pidb_bind`, `pidb_profiles` | `blindkey_status`, `blindkey_bind`, `blindkey_profiles` |
| CLI config dir | `~/.config/pidb`, `$XDG_CONFIG_HOME/pidb`, `%APPDATA%\pidb` | `…/blindkey` |
| Keychain service | `pidb` | `blindkey` |
| Plugin + marketplace name | `pidb@pidb` | `blindkey@blindkey` |
| Plugin skill / commands | `skills/pidb`, `/pidb:connect` … | `skills/blindkey`, `/blindkey:connect` … |
| Plugin bin shims + bundle | `plugin/bin/pidb(.cmd)`, `dist/pidb.mjs` | `plugin/bin/blindkey(.cmd)`, `dist/blindkey.mjs` |
| Plugin runtime package | `pidb-plugin-runtime`, `UNLICENSED` | `blindkey-plugin-runtime`, `MIT` |
| DB file default | `${dataDir}/pidb.sqlite` | `${dataDir}/blindkey.sqlite` |
| Compose project / image / volume / backup-loop messages | `pidb`, `pidb-server:local`, `pidb-data` | `blindkey`, `blindkey-server:local`, `blindkey-data` (backup file names carry no prefix, unchanged) |

Plugin version goes to **1.0.0**. It is a breaking change and the first public release.

### 2.1 Security-sensitive rows (guard hooks)

The agent-side guard identifies the CLI and protected paths by name. Each of these needs an explicit
test with the **new** name, plus a test that the old name no longer counts as the CLI:

- `guard.ts` CLI word check (`word === 'pidb'`): the `blindkey` user-only commands must stay blocked.
- `shell.ts` `secret exec … -- <cmd>` owner unwrapping: env-dump detection inside `blindkey secret exec` must still fire.
- `paths.ts` protected dirs: `~/.config/blindkey` and `%APPDATA%\blindkey`. Reads must be blocked.
- `guard.ts` PowerShell `$env:blindkey_*` expression rule.
- `redact.ts` token regex: a `bk_…` token in Bash output must be redacted.
- `curl`/`wget` against the configured server: unchanged logic, re-verified.

Existing tests are renamed rather than deleted. The test count must not drop.

### 2.2 Not renamed

- Database schema, migrations and stored data. Nothing in the DB carries the name, apart from token
  hashes, which are invalidated by design (D2).
- Secret reference syntax `{{secret:Name}}`.
- REST paths (`/api/v1`, `/mcp`, `/health`) and MCP server tool names that are not `pidb_`-prefixed (`get_project`, `write_document`, …).

## 3. Visual branding

- **Logo:** hand-written SVG. The mark is a keyhole inside a closed eyelid (blind + key). It also
  comes in a wordmark variant. Files: `assets/logo.svg`, `assets/logo-wordmark.svg` (README), and
  `packages/server/src/ui/public/favicon.svg` (served at `/assets/favicon.svg` by the existing static route). Each is a single
  colour driven by `currentColor`, so it works in light and dark themes.
- **UI accent:** override Pico's primary colour variables in `app.css`, for both light and dark.
  Header shows mark + "Blindkey". The `<title>` suffix is "Blindkey".
- **Login page:** logo, name and tagline above the form.
- CSP stays unchanged: the favicon is same-origin and the SVGs carry no inline scripts or styles.

## 4. Public documents

### 4.1 README.md (rewritten, English)

1. Logo, tagline, one-paragraph pitch.
2. **Why:** AI coding agents need credentials to deploy, migrate and debug. Pasting secrets into
   chat puts them in model context, logs and transcripts. Blindkey gives the agent the *ability to use* a
   secret without the *value* ever entering its context.
3. **How it works:** a diagram plus the flow. The agent reads docs and secret metadata over MCP. It runs
   `blindkey secret exec <project> "<name>" -- <cmd>`, the value goes into the child's env, and the output is redacted.
4. **Features:** project docs and memory with `{{secret:…}}` refs, encrypted secrets, scoped tokens,
   browser-approved agent tokens, audit log, admin UI with 2FA, Claude Code plugin, Docker deploy with backups.
5. **Security model:**
   - Encryption at rest: envelope encryption with a per-secret DEK, AES-256-GCM, master key from a file or Docker secret, key rotation.
   - Server-enforced boundaries: agent tokens can't carry `admin`/`reveal`/`write`, `secrets:use` only, per-project scope, audit of every use.
   - Credential handling: OS keychain, never on disk. Passwords use argon2. 2FA (TOTP).
   - Web hardening: CSRF, CSP, HSTS, rate limiting, log redaction.
   - Agent-side defence in depth (guard and redaction hooks).
   - **Known limits:** the current "Security model and its limits" text, kept as is.
   - Threat model in one table: what it protects against, and what it doesn't (a malicious agent, a compromised host).
6. Quick start (Docker), CLI, plugin install, admin UI, operations (backups, restore, key rotation,
   reverse proxy, upgrading), environment table, error codes. These are carried over from the current
   README with the new names. Personal URLs are removed.
7. Licence: MIT. Status: personal project, used in production by the author, no stability guarantees.

### 4.2 SECURITY.md

How to report a vulnerability (GitHub private vulnerability reporting), what's in scope, and a link to the README security model.

### 4.3 LICENSE

MIT, © 2026 Alexander Borysenko.

### 4.4 Personal data

- Replace the `critter-hero` example slug in tests with a neutral one (`acme-shop`).
- `plugin.json` author: name only, no email.
- No private hostnames anywhere (already verified for `hacon-dev-server` and `grillex`).

## 5. `.gitignore` additions

```
docs/superpowers/
.superpowers/
.claude/
.claude-memory/
CLAUDE.md
graphify-out/
.serena/
```

In the private repo the already-tracked `docs/superpowers/` files are removed from the index with
`git rm --cached`, so they stay on disk. The archive keeps them in history.

## 6. Testing

- Full `npm test`, `npm run typecheck` and `npm run build:plugin`. The plugin bundle test must pass,
  so the committed `plugin/dist` must be fresh.
- Guard and redaction tests per §2.1.
- A repo-wide check: `git grep -i pidb` returns nothing outside `docs/superpowers` (ignored) and the
  CHANGELOG/migration notes.
- Docker: build the image and run a compose smoke test locally, using the new volume and env names.

## 7. Migration runbook (prod + machines)

Written as a project doc in the Blindkey server itself (`runbooks/blindkey-migration`). It is not
published. Outline:

1. Take a backup with the old stack: `pidb-server backup`. Copy it off the host.
2. Stop the old stack (`docker compose -p pidb down`) without removing the volume.
3. Create volume `blindkey_blindkey-data` and copy `pidb_pidb-data` into it with a throwaway
   container. Rename `pidb.sqlite` to `blindkey.sqlite`. With the server stopped there are no
   `-wal`/`-shm` files left behind. If any exist, abort and investigate.
4. Rename `docker/.env` keys `PIDB_*` → `BLINDKEY_*`. The master-key secret file is unchanged.
5. Build and start the new stack. Check `/health`, log in (cookie reset is expected), and confirm the projects and secrets are listed.
6. Keep the old volume until step 9 passes, then remove it.
7. On each machine: uninstall plugin `pidb@pidb`, add marketplace `blindkey` (new repo), install
   `blindkey@blindkey`, run `blindkey connect`. Remove `~/.config/pidb` and the `pidb` keychain entries.
8. Revoke all `pidb_…` tokens in the UI. They no longer parse anyway.
9. Run one real agent session: bind a repo, run a `secret exec`, check the audit row.
10. Update stored project docs that mention `pidb` commands or `PIDB_<KEY>` vars. Use the search tool to find them.
11. Optional: move the domain to `blindkey.<domain>`. This is ops only, the code does not change.

The authenticator app keeps its old "pidb" label. The codes stay valid because the TOTP secret is unchanged.

## 8. Publication

1. Run `gitleaks detect --no-git` over the working tree as it will be published. Also review the
   `git ls-files` list by hand.
2. Create the new repo with `gh repo create AlexanderBorysenko/blindkey --public`. The user confirms
   this step explicitly at the time, because it can't be undone.
3. Fresh history: export the tree with `git archive`, then in a new directory make one commit
   "Initial public release" and push.
4. Locally, switch `origin` to `blindkey`. Keep the old remote as `archive`.
5. On GitHub: description, topics (`secrets-management`, `mcp`, `claude-code`, `ai-agents`,
   `self-hosted`), enable private vulnerability reporting, archive `projects-info-db`.

## 9. Out of scope

- npm publishing and a hosted demo.
- UI redesign and screenshots.
- Legacy `pidb` compatibility.
- CI (GitHub Actions). Worth adding after release, as a follow-up.
