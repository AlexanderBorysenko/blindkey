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
- Assets (the hand-written `app.css` stylesheet, IBM Plex fonts, htmx) are served from `node_modules`/`src/ui/public` under `/assets` — no CDN, so the UI works offline and under a strict CSP; the UI uses a small hand-written custom stylesheet (IBM Plex, light and dark themes) rather than a CSS framework (`prefers-color-scheme`).
- A project sidebar lists every project by status, plus global docs/secrets, tokens and audit — the same nav collapses to a `Menu` drawer below 800px. Each secret page shows its own recent-access panel (who revealed which field, and when), and a revealed field auto-hides itself after a short countdown.

## Deployment (Docker)

The stack is three services: `server` (this image), `caddy` (automatic TLS, reverse proxy) and `backup` (the same image running a 24-hour backup loop). Everything lives in `docker/`.

### First run

```bash
cd docker
cp .env.example .env            # set PIDB_DOMAIN and PIDB_ACME_EMAIL
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

**Store `secrets/master_key` in your password manager before going further.** It is mounted at `/run/secrets/master_key` and read through `PIDB_MASTER_KEY_FILE`; it is never baked into an image and never included in a backup. Lose it and every stored secret value is unrecoverable.

Create the admin user and the schema, then start the stack:

```bash
docker compose run --rm \
  -e PIDB_ADMIN_USERNAME=alex \
  server init
docker compose up -d
docker compose logs -f server
```

`init` prompts for the admin password with hidden input (it is never echoed and never passed as `-e PIDB_ADMIN_PASSWORD=...`, which would land in shell history and the process list).

Then open `https://$PIDB_DOMAIN/login`. Point the CLI at the same host with `pidb login https://$PIDB_DOMAIN`.

### What each variable does

`docker/.env.example` documents them all. The ones that matter most:

- `PIDB_DOMAIN`, `PIDB_ACME_EMAIL` — Caddy's certificate hostname and ACME contact.
- `PIDB_TRUST_PROXY=true` — **required** behind Caddy. Fastify only reports `https` (and the admin session cookie only gets its `Secure` flag) when it trusts `X-Forwarded-Proto`. The compose file already pins `PIDB_TRUST_PROXY: "true"` for the `server` service, so this `.env` value is informational — it takes effect only if you run the server outside this compose file.
- `PIDB_BACKUP_INTERVAL` (seconds, default 86400) and `PIDB_BACKUP_KEEP` (default 14) — the backup loop.
- `PIDB_LOG_LEVEL` — pino level; logs are JSON on stdout, with credentials and secret-bearing request-body paths redacted.

### Backups and restore

The `backup` service writes `pidb-<timestamp>.sqlite` into the `pidb-data` volume under `/data/backups` every `PIDB_BACKUP_INTERVAL` seconds and prunes to the newest `PIDB_BACKUP_KEEP` copies. A backup is the database only — **it does not contain the master key**, so keep the key somewhere else or the copies are worthless.

Backups live on the same `pidb-data` volume as the database itself, so `docker compose down -v` deletes them along with everything else. Copy them off the host regularly — this needs the stack up:

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
BACKUP=pidb-<timestamp>.sqlite
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
  for f in pidb.sqlite pidb.sqlite-wal pidb.sqlite-shm; do
    if [ -e "$f" ]; then mv "$f" "$aside/"; fi
  done
  cp "backups/$BACKUP" pidb.sqlite.restoring
  mv pidb.sqlite.restoring pidb.sqlite
  echo "restored $BACKUP; the previous database is in /data/$aside"
' && docker compose up -d
```

Nothing is deleted. The current database *and* its `-wal`/`-shm` files move together into a new timestamped `/data/pre-restore-…` directory: after an unclean stop the `-wal` file can hold committed transactions that were never checkpointed, so it is part of the old database and must stay next to it, but it must not stay next to the restored file, where SQLite would replay it. Every run gets its own directory, so running the block twice (or restoring a different backup after a wrong pick) never overwrites an earlier copy. If the block prints `ERROR` or fails part-way, `docker compose up -d` does not run — do not start the stack by hand, because the server silently creates an empty database when `/data/pidb.sqlite` is missing. Fix the name and run the block again, or put *all* the old files back (the `-wal` file too) by naming the directory the block printed:

```bash
ASIDE=pre-restore-<timestamp>
docker compose down && docker compose run --rm --no-deps -e ASIDE="$ASIDE" --entrypoint sh server -c '
  set -eu
  cd /data
  case "$ASIDE" in pre-restore-?*) ;; *) echo "ERROR: set ASIDE to a pre-restore-… directory name" >&2; exit 1 ;; esac
  case "$ASIDE" in */*) echo "ERROR: ASIDE must be a name, not a path" >&2; exit 1 ;; esac
  if [ ! -s "$ASIDE/pidb.sqlite" ]; then
    echo "ERROR: /data/$ASIDE/pidb.sqlite does not exist; nothing changed" >&2
    exit 1
  fi
  rm -f pidb.sqlite.restoring pidb.sqlite pidb.sqlite-wal pidb.sqlite-shm
  mv "$ASIDE"/* .
  rmdir "$ASIDE"
  echo "moved $ASIDE back"
' && docker compose up -d
```

(That removes whatever database is in `/data` now — use it only to undo a restore that failed or restored the wrong backup. Like the swap block, it stops the stack first.)

**Verify before trusting the restore:** log in to the admin UI and reveal one secret field, or from a machine with the CLI run `pidb secret get <target> <name> <field> --print`. A decrypt error here means the backup was wrapped with an older master key version than the one currently loaded — see [Restoring a pre-rotation backup](#restoring-a-pre-rotation-backup). Only once you've confirmed the restore is good, remove the old copy (with the stack up), naming the directory exactly:

```bash
docker compose exec server rm -r "/data/pre-restore-<timestamp>"
```

Every stack start also runs a backup and prunes the oldest by count, so repeated restore attempts push old backups out — copy the ones you care about off the host first.

### Rotating the master key

Rotation rewraps every secret's DEK from the old key to a new one, so it needs the whole stack stopped — a server or backup process running against a live database while the key underneath it changes can wrap new secrets with the wrong version, or read the new key labelled as the old one. Secrets created in that window are lost once the old key is discarded, so don't skip the "stop" step:

```bash
docker compose stop server backup
```

Ask the database which key versions its secrets are wrapped with. This is the source of truth; `docker/.env` is only what you *think* is loaded:

```bash
docker compose run --rm --no-deps --entrypoint node server -e '
  const db = new (require("better-sqlite3"))("/data/pidb.sqlite", { readonly: true });
  console.table(db.prepare("SELECT key_version, count(*) AS secrets FROM secrets GROUP BY key_version").all());
'
```

All rows should show one `key_version`: that number is **N**, and N+1 is the version you are rotating to. It should match the `PIDB_MASTER_KEY_VERSION` line in `docker/.env` (no line means 1). Write down the `secrets` count too. If the table shows more than one version, or a version that disagrees with `.env`, stop and sort that out first — a restored pre-rotation backup is the usual cause, see [the end of this section](#restoring-a-pre-rotation-backup). An empty table means there are no secrets yet, and N is whatever `.env` says.

Put N in your shell for the blocks below. On the first rotation it is `N=1`, on the second `N=2`, and so on — use the number from the table, never one copied from an example. If your SSH session drops, set it again before continuing:

```bash
N=1
```

Read the *current* (old) key and store it in your password manager, labelled "pidb master key version N" — you'll need it as long as any backup wrapped with it still exists:

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

Read the new key back from its installed location and store it in the password manager, labelled "pidb master key version N+1". The command refuses if the key-generation block did not complete or the file still holds the version N key:

```bash
if ! sudo test -f "secrets/master_key.v$N"; then echo "ERROR: no secrets/master_key.v$N, so the key-generation block did not complete" >&2; elif sudo cmp -s secrets/master_key "secrets/master_key.v$N"; then echo "ERROR: secrets/master_key is still the version $N key; do not store it as version N+1" >&2; else sudo cat secrets/master_key; fi
```

Edit `docker/.env` directly (not `echo`/`tee`, which leaves the key in shell history): set the version to N+1 and record the old key — the content of `secrets/master_key.v$N` (`sudo cat` it) — as version N. Write the actual numbers; for a second rotation that is `PIDB_MASTER_KEY_VERSION=3` and `PIDB_MASTER_KEY_PREVIOUS=2:<key>`:

```
PIDB_MASTER_KEY_VERSION=<N+1>
PIDB_MASTER_KEY_PREVIOUS=<N>:<the-key-in-secrets/master_key.vN>
```

(If `PIDB_MASTER_KEY_PREVIOUS` still has entries from an earlier rotation, add this one as another comma-separated `version:key` pair rather than replacing it.)

Now rewrap every secret:

```bash
docker compose run --rm --no-deps server rotate-key
```

`rotate-key` rewraps everything in one transaction: it either rewraps every secret or none. Read what it printed:

- **`rewrapped <count> secrets to key version <N+1>`**, with the count you wrote down: the rotation worked. Go on below.
- **An error** (for example `no master key for version …`, a decrypt error, or a complaint about `PIDB_MASTER_KEY_PREVIOUS`): nothing was rewrapped. Do not start the stack. Compare the `PREVIOUS` entry in `docker/.env` with `sudo cat "secrets/master_key.v$N"`, fix it, and run `rotate-key` again — or roll back as described below.
- **`rewrapped 0 secrets`** although the table showed secrets: this run changed nothing. Do not start the stack yet, and run the version query again. If the rows show the same version as your first query, the numbers are wrong (N was not the version the rows use, or `.env` wasn't bumped): roll back. Only if your first query showed N and the rows now show N+1 did an earlier `rotate-key` run already succeed (for example you are repeating the step after a dropped SSH session) — then the rotation is done: go on below.

To roll back — only while the query shows the same version as your first query, i.e. no `rotate-key` run has rewrapped anything — put the old key back and undo the `.env` edit:

```bash
sudo mv "secrets/master_key.v$N" secrets/master_key
```

then restore the previous `PIDB_MASTER_KEY_VERSION`/`PIDB_MASTER_KEY_PREVIOUS` lines in `docker/.env` and run `docker compose up -d`. You are back where you started. Delete the "version N+1" entry you stored in the password manager — that key was never used, and keeping it means a later attempt leaves you with two different "version N+1" keys.

After a successful rewrap, bring the stack back up and reveal one secret field (admin UI, or `pidb secret get <target> <name> <field> --print`) to confirm the new key works:

```bash
docker compose up -d
```

Then check that the password-manager entry for version N matches `sudo cat "secrets/master_key.v$N"` character for character, and only then delete the on-disk copy with `sudo rm "secrets/master_key.v$N"`.

Once `rotate-key` has succeeded, you *may* also remove the `PIDB_MASTER_KEY_PREVIOUS` line from `docker/.env` and run `docker compose up -d` again so the recreated containers drop it (until then, `docker inspect` and `docker compose config` still show it in plain text). Keep the `PIDB_MASTER_KEY_VERSION` line: without it the server assumes version 1.

**Keep every retired key in the password manager** until no backup wrapped with it exists any more — neither in `/data/backups` (`docker compose exec server ls -l /data/backups`) nor in any copy you've moved off-host. Deleting a retired key while such a backup still exists makes that backup permanently unreadable. Backups are pruned by *count*, not by age: each backup run keeps the newest `PIDB_BACKUP_KEEP` files, and the backup service runs one immediately every time its container starts — so each `docker compose up -d` also pushes the oldest copy out. If backups have been failing, pre-rotation copies can stay around far longer than `PIDB_BACKUP_KEEP` days.

#### Restoring a pre-rotation backup

A backup taken before a rotation is wrapped with the old key version, so after restoring it every reveal fails with a decrypt error until you rewrap it to the current key:

1. Follow [Backups and restore](#backups-and-restore), but leave the trailing ` && docker compose up -d` off the swap block, so neither the server nor the backup service starts on data wrapped with the old key. (If the stack does start, the backup service immediately writes a new backup that is still wrapped with version M — keep key M until that backup is gone too.)
2. Make sure the stack is stopped (`docker compose stop server backup`) and run the version query from the start of this section. The rows show the backup's version, call it **M**; it is lower than your current `PIDB_MASTER_KEY_VERSION`.
3. Edit `docker/.env`: leave `PIDB_MASTER_KEY_VERSION` at the current version and add `M:<the version M key from your password manager>` to `PIDB_MASTER_KEY_PREVIOUS` (comma-separated if the line already has entries).
4. Run `docker compose run --rm --no-deps server rotate-key` and read its output exactly as above: expect `rewrapped <count> secrets to key version <current>`; on an error nothing changed, so fix the `PREVIOUS` entry and try again.
5. `docker compose up -d`, reveal one secret field, then remove the `PREVIOUS` line as above.

### Upgrading

Take a backup first:

```bash
docker compose run --rm -e PIDB_BACKUP_ONCE=1 backup
```

(the `backup` service's entrypoint is the same loop script that runs on a schedule; `PIDB_BACKUP_ONCE=1` makes it run a single backup and exit instead of looping.)

```bash
git pull
docker compose build
docker compose up -d
```

Migrations run on startup, so no separate step is needed.

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
