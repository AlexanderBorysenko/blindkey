# SDD ledger — plan: docs/superpowers/plans/2026-09-12-deployment.md

Branch plan4-deployment (worktree .claude/worktrees/plan4-deployment), base d48b1c1. Spec: docs/superpowers/specs/2026-09-12-projects-info-db-design.md (§12 binding).
Docker daemon: up (24.0.6) at start.

## Pre-flight scan

| rows | produces / consumes | finding |
|---|---|---|
| T1 self | test logs `{req:{body}}`, asserts `[Redacted]` | DEFECT: Fastify's default `req` serializer strips `body` (probe output `"req":{}`), so `[Redacted]` never appears -> test fails with correct code. `{body}` top-level IS redacted (probe verified). See R1 |
| T1 self | test adds route after `buildApp` | OK: buildApp never calls ready(); `config.public` exists in auth.ts |
| T1 self | `loggerStream` on AppContext | OK: context.ts has logLevel/trustProxy only; additive |
| T1 self | test 2 expects 401 on POST /api/v1/secrets w/o token | plausible (auth onRequest); implementation will confirm |
| T2 x T4 | Dockerfile COPYs docker/backup-loop.sh (T4 creates) | ordering conflict. See R2 |
| T2 self | runtime needs Pico/htmx/eta views | OK: htmx.org, @picocss/pico, eta are prod deps; copy-ui-assets.mjs runs in build; server/scripts copied |
| T2 x T3 | image HEALTHCHECK inherited by `backup` service (no server on 8080) | backup container permanently "unhealthy". See R3 |
| T3 x T2 | compose consumes image build + .gitignore docker/.env, docker/secrets/ | OK |
| T3 x T4 | backup entrypoint /app/docker/backup-loop.sh | OK (WORKDIR /app) |
| T4 self | test missing-key message contains PIDB_MASTER_KEY | OK: config.ts:50 'PIDB_MASTER_KEY or PIDB_MASTER_KEY_FILE is required' |
| T4 self | `backup written:` output (T6) | OK cli.ts:131 |
| T5 x CLI | README `pidb login --server URL` | DEFECT: CLI is `pidb login <url>` positional. See R4 |
| T5 x server CLI | PIDB_ADMIN_USERNAME / PIDB_ADMIN_PASSWORD | OK cli.ts:78-79 |
| T6 x all | consumes everything | OK once R1-R4 applied |

## Rulings

Ruling R1: Task 1 probe test logs `req.log.info({ body: req.body }, 'probe')` instead of `{ req: { body } }`; redact list unchanged — the plan's version can never emit `[Redacted]` because Fastify's req serializer drops body (verified by probe script) — cost if wrong: one test line.
Ruling R2: execute Task 4 (backup loop) before Task 2 (Dockerfile); order 1,4,2,3,5,6 — daemon is up, so Task 2 can build the real image without commenting out the COPY line — cost if wrong: none, Task 4 does not depend on Tasks 2/3.
Ruling R3: Task 3 compose `backup` service gets `healthcheck: { disable: true }` — the image HEALTHCHECK probes a server that never runs in that container, so it would sit "unhealthy" forever — cost if wrong: one YAML block.
Ruling R4: Task 5 README uses `pidb login https://$PIDB_DOMAIN` (positional url), not `--server` — packages/cli/src/cli.ts:28-29 — cost if wrong: one README line.

## Progress

Task 1: dispatched (base d48b1c1, implementer sonnet, id a53a2e514ffd07d97)
Task 1: implementer DONE 2d60793, 315 passing — review dispatched
Task 1: review (opus) spec ✅, Needs fixes — 2 Important plan-mandated (tests 2,3 cannot fail)
Ruling R5: Task 1 test 3 (header redaction) logs headers through a child logger with an identity `req` serializer inside a probe route, asserts the marker line, `[Redacted]`, and absence of token/cookie; implementer proves RED by temporarily removing the two header paths — Fastify's req serializer drops headers so the plan's test can never fail — cost if wrong: one test rewritten.
Ruling R6: Task 1 test 2 stays as an auth-reject smoke test but must assert the sink received lines (`incoming request`) before the not.toContain — without it an unwired stream passes — cost if wrong: one assertion.
Task 1: minor (deferred): logging.test.ts beforeAll makeTestApp() unused dead setup (plan-mandated) + import
Task 1: minor (deferred): logging.test.ts openDb(':memory:') handles never closed; app.close not in finally
Task 1: fix round 1 implementer DONE bcf0203 (R5 RED proven) — scoped re-review (sonnet) dispatched
Task 1: fix round 1/5 (2 addressed, 0 open; commits 2d60793..bcf0203)
Task 1: complete (commits d48b1c1..bcf0203, review clean)
Ruling R7: Task 4 "keep" test pre-seeds backups/ with pidb-2020-01-0{1,2,3}T00-00-00.sqlite, runs the script ONCE with KEEP=2, asserts exactly 2 remain (2020-01-03 + the new one) — backup names have 1-second resolution (ops.ts:35) and VACUUM INTO fails on an existing file, so the plan's 3 back-to-back runs each asserting exit 0 would flake — cost if wrong: one test rewritten.
Task 4: dispatched (base bcf0203, implementer sonnet, id a77a8a44cb9667795)
Task 4: implementer DONE 703432c, 318 passing — review dispatched
Task 4: minor (deferred): backup-loop.sh no backoff/cap on repeated failures (per-spec tolerance)
Task 4: minor (deferred): backup-loop.test.ts env boilerplate repeated across 3 tests
Task 4: complete (commits bcf0203..703432c, review clean)
Task 2: dispatched (base 703432c, implementer sonnet, id a0d2879ff6cfc61fa)
Task 2: implementer DONE 669d6d8, image built (244MB), user node, UI assets present — review dispatched
Task 2: minor (deferred): .dockerignore data/*.sqlite*/.env patterns root-only; use **/ prefixes (build-stage layer exposure only, not final image) (plan-mandated)
Task 2: minor (deferred): Dockerfile:6 comment "no musl prebuilds" likely inaccurate (plan-mandated)
Task 2: minor (deferred): Dockerfile:33 copies build-time packages/server/scripts into runtime (plan-mandated)
Task 2: minor (deferred): empty node_modules/@types, @vitest dirs after prune
Task 2: minor (deferred): healthcheck.mjs targets 127.0.0.1 — unhealthy if PIDB_HOST set to non-loopback addr
Task 2: note: locally built image is arm64; deploy host likely amd64 — compose `build:` on host covers it; README (Task 5) should not suggest copying a Mac-built image
Task 2: complete (commits 703432c..669d6d8, review clean)
Task 3: dispatched (base 669d6d8, implementer sonnet, id a3e723b8cc55dd4a9)
Task 3: implementer DONE 8d0cd4a, compose config valid, key grep 0 — review dispatched
Task 3: review (opus) spec ✅, Needs fixes — 2 Important plan-mandated (secret file perms vs uid 1000 on Linux; caddy env_file receives PIDB_MASTER_KEY_PREVIOUS)
Ruling R8: master_key file must be owned by uid 1000 — compose gets a comment beside `secrets.master_key` saying `chown 1000:1000` + `chmod 600`; Task 5 README first-run and rotation steps add `sudo chown 1000:1000 secrets/master_key` before chmod — Compose v2 non-swarm file secrets are bind mounts keeping host owner/mode, container runs as node uid 1000, root-owned 600 file => EACCES crash loop — cost if wrong: an extra harmless chown line.
Ruling R9: `caddy` drops `env_file` and gets `environment: { PIDB_DOMAIN: ${PIDB_DOMAIN}, PIDB_ACME_EMAIL: ${PIDB_ACME_EMAIL} }` (Compose interpolates from docker/.env); `.env.example` comment on PIDB_MASTER_KEY_PREVIOUS says it is key material, only server/backup receive it, and delete it once rotate-key completes. A file-based PREVIOUS key form would be new server code — out of this plan's scope; recorded as known limitation for final review — cost if wrong: caddy missing a var it later needs (none today: Caddyfile reads only those two).
Ruling R10: pin `PIDB_TRUST_PROXY: "true"` in the `server` service `environment:` (keep the .env.example line) — Global Constraint says it MUST be set for server; relying on an operator-edited file can silently drop the Secure cookie flag — cost if wrong: operator can't turn it off without editing compose (never correct behind Caddy anyway).
Task 3: fix round 1 implementer DONE b398633 — scoped re-review (sonnet) dispatched
Task 3: fix round 1/5 (3 addressed, 0 open; commits 8d0cd4a..b398633)
Task 3: complete (commits 669d6d8..b398633, review clean)
Ruling R11: key-file permission order is `chmod 600 secrets/master_key` THEN `sudo chown 1000:1000 secrets/master_key` (compose comment from R8 has them reversed — after chown a non-root operator no longer owns the file and plain chmod fails); key rewrite during rotation uses `sudo tee` since the operator can no longer write the file. Fixed in Task 5 (compose comment line batched with README) — cost if wrong: one comment line.
Task 5: dispatched (base b398633, implementer sonnet, id ae9b744d681edd101)
Task 5: implementer DONE d09d4d0 — review dispatched
Task 5: minor (deferred): README restore snippet has no post-restore verification step
Task 5: minor (deferred): README `docker compose cp server:/data/backups` needs running server container (unstated)
Task 5: complete (commits b398633..d09d4d0, review clean)
Task 6: dispatched (base d09d4d0, verification only, implementer sonnet, id a3d5c2ec77ce32f81)
Task 6: implementer DONE — all 6 steps + 4 extras pass (318 tests, healthy ~35s, key/password absent from logs and backup, down -v clean) — evidence review (sonnet) + final whole-branch review (opus) dispatched
Task 6: minor (deferred): report narrates health polling rather than pasting ps table
Task 6: complete (no commits, evidence review clean)
Final review: dispatched (opus, range d48b1c1..d09d4d0)
Final review: With fixes — 0 Critical, 5 Important (all README runbook, plan-originated): restore leaves stale -wal/-shm + no pre-restore copy; rotation runs against live server (secrets wrapped with old key after rewrap, mislabelled key on restart); retired keys needed for pre-rotation backups; host `node` assumed (empty key file / truncated live key on rotation); admin password on command line. Deferred-minor triage: all SHIP AS IS except Task 5 restore verification = MUST FIX.
Ruling R12: ONE fix wave (sonnet) covering all 5 Important + restore verification + cheap related minors: `chmod 600 .env`; backup before upgrade; `backup` and `caddy` depends_on server `condition: service_healthy` (fixes concurrent-migration race on upgrade); compose comment that `server` must never publish ports (PIDB_TRUST_PROXY=true relies on it); warn `down -v` deletes backups + recommend off-host copy; userns-remap/rootless uid sentence; `docker compose cp` "with the stack up". Key generation switches to `openssl rand -base64 32` under `umask 077`; rotation installs the new key via a temp file checked for 45 bytes and `sudo install -o 1000 -g 1000 -m 600` (supersedes R11's `sudo tee`). Rotation flow stops server+backup first. Restore moves the old db aside and removes -wal/-shm. init drops `-e PIDB_ADMIN_PASSWORD` (hidden prompt). Fix wave must live-run first-run + backup + restore + rotation on a throwaway compose project — those flows were never executed — cost if wrong: README wording rework; no code changes.
Not fixed (SHIP AS IS / follow-up): HSTS header in Caddyfile; MCP JSON-RPC body redaction paths; PIDB_MASTER_KEY_PREVIOUS _FILE form; amd64 Linux dry run (needs a VPS — surfaced to user).
Final fix wave: dispatched (base d09d4d0)
Final fix wave: DONE c352776 — live first-run/backup/restore/rotation/upgrade-backup all pass on throwaway project pidbverify, torn down — scoped re-review dispatched
Final re-review (opus): findings 1-6 + R12 minors ADDRESSED; fix introduced 2 Important + 3 Minor runbook defects.
Ruling R13 (residual, real, load-bearing — surfaced to user, not fixed; no second fix wave): README restore (README.md:163-170) has no set -eu / backup-exists check / refusal when .pre-restore exists — a second restore attempt or a cp typo overwrites the only copy of the original DB (openDb silently creates an empty DB on up -d) — must be fixed before anyone follows the runbook — cost if left: permanent loss of writes newer than the latest backup.
Ruling R14 (residual, real, load-bearing — surfaced to user, not fixed): README rotation hardcodes VERSION=2 / PREVIOUS=1: (README.md:193, :214) — a literal second rotation installs k3 labelled v2, rewrapAllSecrets selects key_version != current and rewraps 0, output looks like success, every secret undecryptable — fix: N+1/N placeholders from current .env + "rewrapped 0 after a real rotation = stop" — cost if left: all secret values lost on the second rotation.
Ruling R15 (residual minors, surfaced): failed 45-byte check/sudo is silent and "store the new key" comes after rm with no read command; bare `umask 077` persists in the operator shell (a later `git pull` → mode-600 root-owned healthcheck.mjs/backup-loop.sh in the image → healthcheck fails → caddy/backup never start via service_healthy) — use a subshell; restore deletes the moved-aside DB's -wal (committed-but-uncheckpointed txns after an unclean stop) and calls them "uncommitted" — move them aside instead.
Out-of-scope (surfaced): rewrapAllSecrets never probes that the current key unwraps current-version rows; each restore's up -d triggers an immediate backup that prunes the oldest (possibly pre-rotation) copy; .env.example PREVIOUS comment doesn't say keep retired key in password manager.
Branch head c352776 controller verification: npm run build + typecheck clean, vitest 43 files / 318 tests passed (exit 0)
Task 6 preflight: `/login` route exists (ui/routes/auth.ts:21); no pre-existing pidb_* volumes or containers on this Docker host, so `docker compose down -v` only removes the test stack's volumes.
Task 3: known limitation: PIDB_MASTER_KEY_PREVIOUS only via env (docker/.env, visible in docker inspect) during rotation — no _FILE form in config.ts
Task 3: minor (deferred): x-image anchor gives build: to both server and backup => double build (cache hit, same tag)
Task 3: minor (deferred): caddy depends_on server without condition: service_healthy (502 at boot)
Task 3: minor (deferred): backup depends_on server without service_healthy — first backup may run before migrations, next good one 24h later
Task 3: minor (deferred): server/backup receive Caddy-only PIDB_DOMAIN/PIDB_ACME_EMAIL via env_file
Task 1: minor (deferred): app.ts `req.body.*.value` path has no `body.*.value` twin; req.body.* paths inert under default serializer
# Global constraints binding every Plan 4 task (verbatim from plan + spec §12)

## Spec §12 Deployment
- `docker/Dockerfile`: multi-stage (build TS → prod image with `node:22-alpine`, non-root user, `/data` volume).
- `docker/docker-compose.yml`: `server` (env from `.env`, `PIDB_MASTER_KEY_FILE=/run/secrets/master_key`) + `caddy` (Caddyfile reverse-proxy with automatic TLS for `PIDB_DOMAIN`). Volumes: `pidb-data`, `caddy-data`.
- Backups: a `backup` compose service (same image) running a shell loop that calls `pidb-server backup` every 24h. Master key is **not** in the backup; Alex stores it separately (password manager).
- Logs: pino JSON to stdout; secret values never logged (redaction paths configured for request bodies on secrets routes).

## Plan Global Constraints
- The image runs as a **non-root** user (`node`, uid 1000, already present in `node:22-alpine`), and `/data` is a declared volume owned by that user.
- **No secret material in the repository, an image layer, or a compose file.** The master key reaches the container only as the Docker secret mounted at `/run/secrets/master_key`, consumed via `PIDB_MASTER_KEY_FILE`. `docker/.env.example` carries placeholders only. `docker/.env` and `docker/secrets/` are git-ignored.
- The backup archive must not contain the master key (spec §12): `pidb-server backup` copies the SQLite file only, and nothing in this plan copies the key anywhere.
- `PIDB_TRUST_PROXY` **must** be set for the `server` service, because Caddy terminates TLS: without it Fastify reports `req.protocol === 'http'` and the admin session cookie ships without the `Secure` flag.
- Logs are pino JSON on stdout and must never contain a secret value (spec §12).
- Node `>=22`, TypeScript `strict` + `noUncheckedIndexedAccess`, ESM (`NodeNext`) — every relative import in a `.ts` file carries the `.js` extension. Code tests live in `packages/server/test/**/*.test.ts` and may write only inside a `mkdtempSync` directory.
- Shell scripts are POSIX `sh` (the runtime image has BusyBox ash, not bash) and must be safe under `set -eu`.
- Conventional Commits; every commit message ends with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
- If a step cannot be completed as written, STOP and report BLOCKED — no improvised redesign.

## Controller rulings (override plan text)
- R1: Task 1 probe test logs `{ body: req.body }` (Fastify's req serializer drops body, so `{ req: { body } }` can never show `[Redacted]`); redact list unchanged.
- R2: task order 1, 4, 2, 3, 5, 6 (backup-loop.sh exists before the Dockerfile COPYs it).
- R3: compose `backup` service sets `healthcheck: { disable: true }` (image HEALTHCHECK probes a server that never runs there).
- R4: README uses `pidb login https://$PIDB_DOMAIN` (url is positional; there is no `--server` flag).
- R5/R6: Task 1 logging tests must be able to fail (header test logs via identity req serializer; auth-reject test asserts `incoming request`).
- R7: Task 4 prune test pre-seeds three dated backups and runs once (1-second filename resolution).
- R8: the master_key file must be owned by uid 1000 (`sudo chown 1000:1000 secrets/master_key` before `chmod 600`) — Compose v2 file secrets are bind mounts keeping host owner/mode; container runs as node uid 1000. Compose comment + README first-run and rotation steps.
- R9: `caddy` gets only `PIDB_DOMAIN`/`PIDB_ACME_EMAIL` via `environment:` interpolation (no `env_file`); `.env.example` marks PIDB_MASTER_KEY_PREVIOUS as key material to delete after rotation. Known limitation: no file-based form for previous keys.
- R10: `server` pins `PIDB_TRUST_PROXY: "true"` in compose `environment:`.
- R11: permission order is `chmod 600 secrets/master_key` THEN `sudo chown 1000:1000 secrets/master_key` (after chown a non-root operator can't chmod); rotation rewrites the key with `... | sudo tee secrets/master_key > /dev/null`. Compose comment corrected in Task 5.
- R12 (final review fix wave, README + compose only, no code): openssl key generation under umask 077; `chmod 600 .env`; init prompts for the password (no `-e PIDB_ADMIN_PASSWORD`); restore = `down`, move old db to `.pre-restore`, remove -wal/-shm, copy backup, `up -d`, verify by revealing a secret; rotation = stop server+backup, read old key, set VERSION/PREVIOUS in .env, new key via temp file + 45-byte check + `sudo install -o 1000 -g 1000 -m 600` (supersedes R11's tee), `rotate-key`, `up -d`; keep retired keys while backups wrapped with them exist; backup before upgrade; `backup`/`caddy` depend on server `service_healthy`; compose comment: server must never publish ports; warn `down -v` deletes backups; userns-remap/rootless uid note.

## Post-merge runbook fix (2026-09-13) — residuals R13–R15 closed

- R16 (supersedes R12's restore and rotation text; README + `.env.example` only, no code):
  - **Restore:** the swap block starts with `down &&`; it rejects an empty, path-like, missing or empty `BACKUP`; it moves `pidb.sqlite` with `-wal`/`-shm` into a fresh `pre-restore-<UTC ts>` directory (nothing is deleted, and re-running never overwrites that directory); it runs `up -d` only if the swap succeeded. A guarded move-back block (also `down &&`) and a quoted `rm -r` cleanup were added.
  - **Rotation, version:** stop `server` + `backup`, then read N from a readonly `SELECT key_version, count(*)` query; the database, not `.env`, is the source of truth. `N=` is set in the shell.
  - **Rotation, key generation:** the block refuses to re-run while `secrets/master_key.vN` exists, and tells "not replaced" apart from "already replaced". It records `old_sum=$(sudo sha256sum secrets/master_key)` (a file argument, not `< file`: the operator shell opens redirects without root), writes the temp key in `secrets/`, checks 45 bytes, and runs `cp -p` of the old key to `.vN` before `install`. On failure it says "unchanged" (and removes `.vN`) or "damaged" (and prints the `mv` back).
  - **Rotation, after install:** the read-back refuses if `.vN` is missing or the new key equals it. `PREVIOUS=N:<.vN>`.
  - **Rotation, `rotate-key` output:** success, error (single transaction, nothing rewrapped) and `rewrapped 0` (done only if the rows moved N→N+1 since the first query, otherwise roll back). Rollback is `mv .vN` back, restore the `.env` lines, and drop the abandoned N+1 password-manager entry. Delete `.vN` only after checking the password-manager copy.
  - **Retention:** pruning is by count, and each container start takes a backup.
  - **Pre-rotation backup restore:** swap without `up -d`, query M, add M to `PREVIOUS`, `rotate-key`.
  - **First run:** `umask 077` runs in a subshell, and the script prints `key OK`/`ERROR`.
- **Verification:** the README blocks were extracted verbatim and live-run on a throwaway compose project (Docker Desktop; sudo/chown stripped): 59/59 checks. They cover every refusal path, restoring twice with the stack up, move-back, two real rotations, a repeated `rotate-key`, a wrong `PREVIOUS`, a wrong N plus rollback, a short key, a failed install, an install that truncated the key, a stale `.vN` copy, a missing `.vN` at read-back, and a pre-rotation restore plus rewrap.
- **Reviews:** 3 opus rounds. Round 1 found 5 Important + 7 Minor. Round 2 found 1 Important, which R12 had already carried and the new move-back block made likely: restoring with the stack up silently loses writes. It also found 5 Minor. Round 3 found 1 Important: `sudo sha256sum < file` fails for any operator whose uid is not 1000 or root. The harness strips sudo, so it cannot see this. Round 3 also found 1 Minor: the read-back passed when `.vN` was missing. Both fixed.
- **Still open:** Linux uid-1000 dry run; an unclean-stop `-wal` actually being moved (clean stops leave none); no integrity check on the chosen backup (the original is kept aside, so this is a verification gap only); the code backlog items from the next-session memory.
