# pidb Deploy Readiness — Design

Status: approved (controller rulings, 2026-09-27). Closes the follow-ups left by
`2026-09-27-security-hardening-design.md` and the "ship as is" code backlog, so
v1 can be deployed and used.

## 1. Admin password change

There is no way to change the admin password today; `init` is the only writer.
Someone who knows the password can re-lock 2FA every 15 minutes indefinitely.

### 1.1 Password rules (shared by UI, shell, and `init`)
- New password: 12–1024 characters (JS string length). Not equal to the current one (UI only; the shell cannot know it).
- One exported validator: `validateNewPassword(pw: string): string | null` — returns the error message or null.
  Messages: `Password must be at least 12 characters.` / `Password must be at most 1024 characters.`
- `runInit` also applies it, but only when it is actually creating the admin — a rerun against an existing admin is a no-op and must not start rejecting whatever password is passed in. A validation failure throws before `createAdmin` runs (no admin row is created); the CLI prints `error: <message>` and exits 1.

### 1.2 UI: `/settings/password`
- `GET /settings/password` — form: `current` (password), `next` (password), `confirm` (password), and `code` (text, `autocomplete="one-time-code"`) shown only when 2FA is on. Nav: new "Password" link in the Admin group, after "Two-factor".
- `POST /settings/password` — CSRF, rate limit 10/min. Order:
  1. If 2FA is on and the admin is locked → 429 with `factorLockedMessage`.
  2. `next !== confirm` → 400 `New passwords do not match.`; `validateNewPassword` error → 400 with its message; `next === current` → 400 `New password must differ from the current one.`
  3. `current` must verify, and when 2FA is on `code` must pass `verifySecondFactor` (TOTP or recovery). Either wrong → 400 `Current password or code is incorrect.`, audit `auth.password_change_failed` (meta `{via:'ui'}`).
  4. Success: store argon2id hash, delete every OTHER session of the admin (current stays), delete the admin's pending login challenges (`deleteChallengesFor`, same transaction), audit `auth.password_changed` (meta `{via:'ui', sessions_revoked:n}`), redirect `303 /settings/password?done=saved`. When the second factor that verified in step 3 was a recovery code, also audit `auth.recovery_used` (meta `{via:'password_change'}`), mirroring the login flows. The `/settings/2fa` re-auth (`reauth`) does the same for a recovery code, with meta `{via:'settings'}`.
- API tokens are NOT revoked (they are independent credentials, listed on `/tokens`); the page says so in one line.
- Step 2 runs before step 3 (re-auth) because it compares only the submitted fields — no lookup, no oracle — so a typo in `confirm` is rejected without ever spending a TOTP step or a recovery code on step 3's `verifySecondFactor` call.

### 1.3 Shell: `pidb-server passwd`
- Reads the new password from `PIDB_ADMIN_PASSWORD`, else hidden prompt `New admin password: `; when stdin is a TTY, asks again `Repeat new admin password: ` and fails `passwords do not match` on mismatch.
- Applies `validateNewPassword`; error → exit 1 with `error: <message>`.
- Effects (one transaction): new hash; delete ALL sessions of the admin; delete pending login challenges; reset the 2FA failure counter/lock (`resetFactorFailures`); audit `auth.password_reset` meta `{via:'shell'}`.
- Prints `password changed for <username>; signed out <n> sessions`.
- Docker: `docker compose run --rm --no-deps server passwd`.
- 2FA is left as is (use `2fa reset` separately).

## 2. Audit hygiene
- `auth.password_ok` — written whenever the password verifies for an admin who has 2FA on, BEFORE the lock check and the factor check, on both UI `POST /login` (meta `{via:'ui'}`) and `POST /api/v1/auth/token` (meta `{via:'api'}`). It lets the operator see that the password is known even when every code guess fails.
- `auth.token_expired` — at most one row per token per hour (in-memory map keyed by token id in `registerAuth`, entries older than 1 h pruned when the map exceeds 1000 entries). The 401 `token_expired` response is unchanged.

## 3. UI polish
- `?done=` flash no longer repeats on reload: `app.js` strips the `done` query parameter with `history.replaceState` on load (flash stays visible).
- Nav "API tokens" count = active tokens only (not revoked, and `expires_at IS NULL OR expires_at > now`).
- Every UI HTML response (anything `isUiRequest` covers except `/assets/`) gets `cache-control: no-store` (covers `/p/:slug?tab=secrets` and future pages).

## 4. Key and backup operations
- Every ops command except `init` and `start` (`rotate-key`, `key-versions`, `passwd`, `2fa reset`, `backup`) requires an existing database: before `openDb`, the CLI checks `existsSync(config.dbPath)` (one shared helper) and fails `error: no database at <dbPath> — run init first (or check PIDB_DATA_DIR / the restore)`, exit 1, when it is missing — `openDb` itself runs migrations unconditionally and would otherwise silently create it.
- `rotate-key` decrypt probe: before rewrapping, every row already on the current version (secrets DEK and 2FA secret) must decrypt with the current key; otherwise throw `key version <v> does not decrypt secret <id> — PIDB_MASTER_KEY is not the version <v> key` (2FA: `... 2FA secret of admin <id> ...`). Nothing is written (same outer transaction).
- `pidb-server key-versions` — prints one line per `(kind, version)`: `secrets v<v>: <n> rows, <status>` and `2fa v<v>: <n> rows, <status>`, where status is `ok`, `no key configured` or `WRONG KEY (<k> of <n> fail)`. Prints `no encrypted rows` when both tables are empty. Exit 1 if any status is not `ok`. Replaces the inline `node -e` query in the README rotation runbook and is suggested after a restore.
- `runBackup`: `VACUUM INTO` a temp file `pidb-<stamp>.sqlite.tmp`, open it read-only, `PRAGMA integrity_check` must return `ok`, close, then `rename` to the final name. On failure the temp file is deleted and the error propagates (backup-loop logs it). Stale `pidb-*.sqlite.tmp` files in the directory are deleted at the start of each run. Pruning is unchanged (the temp name never matches `BACKUP_RE`).

## 5. Deployment config
- Caddyfile: `header Strict-Transport-Security "max-age=31536000"` (no `includeSubDomains`: the operator's other subdomains are not ours).
- `.dockerignore`: `**/`-prefixed patterns for `*.sqlite`, `*.sqlite-wal`, `*.sqlite-shm`, `.env`, `coverage`, `.DS_Store`, `*.log`.
- `docker-compose.yml`: the image is built once — only `server` has `build:`; `backup` uses `image: pidb-server:local` with `pull_policy: never`.
- Log redaction also covers MCP JSON-RPC bodies: `req.body.params.arguments.value`, `.fields`, `.password`, `.totp`, `.code` and the `body.` equivalents.

## 6. Docs
README: password change (UI + shell), lockout line (10 wrong codes → 15 min; `2fa reset` or `passwd` clears it), `key-versions` in the rotation runbook and after restore, backup integrity check, HSTS note.

## 7. Out of scope (rulings)
- `PIDB_MASTER_KEY_PREVIOUS_FILE` — would rewrite the verified rotation runbook; the runbook already removes the entry after rotation.
- Capping never-expiring tokens minted with an admin bearer — spec-allowed; the admin token is already full trust and `pidb token create --no-expiry` depends on it.
- Linux VPS dry run — needs a VPS; a local Docker smoke run replaces it for now.
