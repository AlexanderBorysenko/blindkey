# Deploy Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every open follow-up so pidb v1 can be deployed and used: admin password change, audit hygiene, UI polish, safer key/backup ops, deployment config.

**Architecture:** Small additions to the existing Fastify/Eta/better-sqlite3 server and its `pidb-server` commander CLI; no new dependencies, no migrations.

**Tech Stack:** TypeScript strict ESM (NodeNext, `.js` import suffixes), Fastify 5, Eta, htmx, better-sqlite3, argon2id, vitest (`app.inject`, `makeTestApp()` in `packages/server/test/helpers.ts`).

**Spec:** `docs/superpowers/specs/2026-09-27-deploy-readiness-design.md` — read the section named in your task; exact strings live there.

## Global Constraints
- Run `npm run build` before `npx vitest run` (tests import built workspace packages). Full suite must stay green; baseline 480 tests.
- `npm run typecheck` must exit 0.
- No inline scripts, event handlers or `style=` attributes in any `.eta` (CSP `script-src 'self'; style-src 'self'`). Client behaviour goes in `packages/server/src/ui/public/app.js`.
- Every UI POST: `assertCsrf(ctx, req)`; settings POSTs rate limited `{ config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }`. Rate limits are per app instance: tests that need many requests spread them across `makeTestApp()` instances.
- Read form fields with `str(body(req), '<name>')` (never trust type).
- Audit rows via `writeAudit(ctx.db, {...})`; never put passwords or codes in `meta`.
- Match surrounding style: comment density, naming, existing view markup (copy structure from `settings-2fa.eta`).
- Never kill processes you did not start (a pidb server of the user's may run on :8080).
- Commit per task with conventional messages ending in `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus
1. Password change with 2FA on but `code` field missing/empty → must be rejected as wrong factor (400), never skipped.
2. Password change while the 2FA lock is active → 429 before verifying the password (no password oracle during lock).
3. `passwd` on a DB with no admin → `error: no admin user — run init first`, exit 1.
4. `rotate-key` with the wrong current key but all rows already on the current version → must fail (probe), not report `rewrapped 0`.
5. Backup into a directory holding a stale `.tmp` from a crashed run → stale file removed, new backup valid, prune count unaffected.

---

### Task 1: UI polish (spec §3)

**Files:**
- Modify: `packages/server/src/ui/public/app.js` (strip `done`), `packages/server/src/repos/nav.ts` (active token count), `packages/server/src/ui/index.ts` (no-store for all UI HTML)
- Test: `packages/server/test/ui.hardening.test.ts` or a new `packages/server/test/ui.polish.test.ts`; `packages/server/test/ui.appjs.test.ts`

- [ ] Nav count: `SELECT COUNT(*) FROM api_tokens WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)` with `Date.now()`. Test: create one active, one revoked, one expired (insert with past `expires_at` directly or via repo) → nav shows `1` in the API tokens count.
- [ ] no-store: in the `onSend` hook, every UI response whose path does not start with `/assets/` gets `cache-control: no-store` (replace the path list; keep the comment accurate). Tests: `/p/<slug>?tab=secrets`, `/`, `/login` carry `no-store`; `/assets/app.css` does not.
- [ ] app.js: on load, if `location.search` has `done`, remove only that param and `history.replaceState(history.state, '', <path + remaining query + hash>)`. Test in `ui.appjs.test.ts` following its existing pattern (static content / jsdom-free assertions as the file already does).
- [ ] Build, full suite, typecheck, commit `fix(ui): count only active tokens, no-store every page, drop ?done= after showing it`.

### Task 2: Admin password change (spec §1)

**Files:**
- Create: `packages/server/src/services/password.ts` (`validateNewPassword`, `changePassword`), `packages/server/src/ui/routes/password.ts`, `packages/server/src/ui/views/settings-password.eta`
- Modify: `packages/server/src/repos/admin.ts` (`setAdminPasswordHash(db, id, hash)`, `deleteAllSessions(db, adminId): number`), `packages/server/src/repos/twofactor.ts` if a `deleteChallengesFor(db, adminId)` helper is needed, `packages/server/src/ui/index.ts` (register), `packages/server/src/ui/views/partials/nav.eta` (link, `aria-current` when `it.path === '/settings/password'`), `packages/server/src/ops.ts` (`runPasswordReset(db, password): Promise<{ username: string; sessions: number }>`), `packages/server/src/cli.ts` (`passwd` command), `README.md` (Admin UI: "Changing the password" + shell recovery line)
- Test: `packages/server/test/ui.password.test.ts`, `packages/server/test/ops.test.ts`

**Interfaces:**
- Produces: `validateNewPassword(pw: string): string | null`; `changePassword(ctx, actor, input: { current: string; next: string; confirm: string; code: string }, keepSessionId: string): Promise<{ ok: true; sessionsRevoked: number } | { ok: false; status: 400 | 429; error: string }>`; `runPasswordReset(db, password)`.
- Consumes: `verifyPassword`, `hashPassword` (`crypto/passwords.ts`), `isTotpEnabled`, `isSecondFactorLocked`, `verifySecondFactor` (`services/twofactor.ts`), `factorLockedMessage` (`ui/routes/auth.ts`), `resetFactorFailures` (`repos/twofactor.ts`), `deleteOtherSessions` (`repos/admin.ts`), `uiSessionId`, `adminActor`, `requireAdmin` (`ui/session.ts`).

Tests (UI, each on a fresh app where rate limits matter):
1. GET without 2FA: form has `current`, `next`, `confirm`, no `code` input; with 2FA on: `code` input present.
2. Wrong current → 400 `Current password or code is incorrect.`; audit `auth.password_change_failed`; hash unchanged.
3. 2FA on, correct password, empty code → 400 same message (Review Focus 1).
4. 2FA on, admin locked (drive 10 failures via `recordFactorFailure` or wrong codes) → 429 even with the correct password (Review Focus 2).
5. Mismatched confirm → 400 `New passwords do not match.`; 11-char → 400 `Password must be at least 12 characters.`; same as current → 400 `New password must differ from the current one.`
6. Success (with 2FA: valid TOTP) → 303 to `/settings/password?done=saved`; old password no longer logs in, new one does; another pre-existing session is gone, the current one still works; audit `auth.password_changed` with `sessions_revoked`; audit meta never contains the passwords.
7. Missing CSRF → rejected like other settings POSTs.
Tests (ops):
8. `runPasswordReset` changes the hash, deletes all sessions, clears a 2FA lock (`factorLockedUntil` → null), writes `auth.password_reset`; returns username and session count.
9. No admin → throws `no admin user — run init first` (Review Focus 3); too-short password → throws the validator message.

- [ ] Write tests, implement, build, full suite, typecheck, commit `feat(server): change the admin password from the UI and the shell`.

### Task 3: Audit hygiene (spec §2)

**Files:**
- Modify: `packages/server/src/ui/routes/auth.ts` (POST /login: `auth.password_ok` via ui), `packages/server/src/services/admin.ts` (`exchangePassword`: `auth.password_ok` via api, before lock and factor checks), `packages/server/src/http/auth.ts` (throttle `auth.token_expired`), `packages/server/src/ui/routes/twofactor.ts` (comment `spec §2.5` → `spec §2.3`), `docs/superpowers/specs/2026-09-27-security-hardening-design.md` (one line under §2.4/§2.5 pointing at the new `auth.password_ok` event)
- Test: `packages/server/test/ui.twofactor.test.ts`, `packages/server/test/auth.totp.api.test.ts`, `packages/server/test/tokens.ttl.test.ts`

Tests:
1. UI login with 2FA on, correct password → one `auth.password_ok` row `{via:'ui'}`; wrong password → none; 2FA off → none.
2. API `/api/v1/auth/token` with 2FA on: no totp → `password_ok {via:'api'}` + 401 `totp_required`; while locked → `password_ok` still written + 429.
3. Expired token used 3× → exactly one `auth.token_expired` row, all three responses 401 `token_expired`. Throttle state is per `registerAuth` instance; inject time if needed (e.g. a `now` parameter) rather than sleeping.

- [ ] Write tests, implement, build, full suite, typecheck, commit `feat(server): audit known-password logins and throttle expired-token rows`.

### Task 4: Key and backup operations (spec §4)

**Files:**
- Modify: `packages/server/src/repos/secrets.ts` (probe in `rewrapAllSecrets`; export a `keyVersionReport(db, ring)` or put it in ops), `packages/server/src/repos/twofactor.ts` (probe in `rewrapTotpSecrets`), `packages/server/src/ops.ts` (`runKeyVersions(db, ring): { lines: string[]; ok: boolean }`, `runBackup` temp+verify+rename+stale cleanup), `packages/server/src/cli.ts` (`key-versions` command, exit 1 when not ok), `README.md` (rotation step that uses `node -e ... console.table(...)` → `docker compose run --rm --no-deps server key-versions`, keep the surrounding instructions consistent: N is the version shown; after restore suggest `key-versions`; backups section mentions the integrity check)
- Test: `packages/server/test/ops.test.ts`, `packages/server/test/repos.secrets.test.ts`, `packages/server/test/repos.twofactor.test.ts`

Tests:
1. Probe: DB with secrets sealed under key A (version 2), ring current version 2 but key B → `runRotateKey` throws the spec message; rows unchanged (Review Focus 4). Same for a 2FA secret.
2. Happy rotation still works and is idempotent (existing tests stay green).
3. `runKeyVersions`: empty DB → `['no encrypted rows']`, ok; mixed v1/v2 with both keys → `secrets v1: n rows, ok` etc.; missing previous key → `no key configured`, ok false; wrong key → `WRONG KEY (k of n fail)`, ok false.
4. `runBackup`: result file passes `PRAGMA integrity_check`; no `.tmp` left; stale `pidb-2020-01-01T00-00-00.sqlite.tmp` pre-seeded in dir is removed and does not count toward `keep` (Review Focus 5); if integrity check fails (inject via an optional `verify` hook parameter or by stubbing) the temp file is deleted and the error is thrown, no final file.

- [ ] Write tests, implement, build, full suite, typecheck, commit `feat(server): probe keys before rotating, add key-versions, verify backups before keeping them`.

### Task 5: Deployment config and docs (spec §5, §6)

**Files:**
- Modify: `docker/Caddyfile`, `.dockerignore`, `docker/docker-compose.yml`, `packages/server/src/http/app.ts` (redaction paths), `README.md`
- Test: `packages/server/test/logging.test.ts` (MCP body redaction)

- [ ] Caddyfile: inside the site block add `header Strict-Transport-Security "max-age=31536000"`.
- [ ] `.dockerignore`: add `**/*.sqlite`, `**/*.sqlite-wal`, `**/*.sqlite-shm`, `**/.env`, `**/coverage`, `**/.DS_Store`, `**/*.log` (keep existing lines that are still needed; remove root-only duplicates they supersede).
- [ ] compose: remove the `x-image` anchor; `server` keeps `build:` + `image: pidb-server:local`; `backup` gets `image: pidb-server:local` and `pull_policy: never`. Keep every other key identical.
- [ ] Redaction: add the MCP paths from spec §5. Test: a logger-stream test (follow `logging.test.ts`) that logs a request object whose `body.params.arguments` has `value`/`fields`/`password` and asserts `[Redacted]`.
- [ ] README: lockout line in "Two-factor authentication" (10 wrong codes in a row lock code entry for 15 minutes; `pidb-server 2fa reset` or `pidb-server passwd` clears it); HSTS note in Deployment; make sure Environment/Scripts sections list `passwd` and `key-versions`. Do not touch rotation runbook text beyond what Task 4 changed.
- [ ] Build, full suite, typecheck, commit `chore(deploy): HSTS, single image build, broader dockerignore, MCP log redaction`.
