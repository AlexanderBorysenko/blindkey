# pidb Claude Code Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Claude Code plugin (in this repo) that gives Claude a safe, stable pidb context: browser device-flow login, scoped agent token in the OS credential store, MCP bridge, agent-mode CLI that injects secrets only by substitution with output redaction, and guard/redact/session-start hooks — plus the server features it needs.

**Architecture:** Server gains agent scopes, a secret-use endpoint, a device flow and new MCP tools. All plugin code lives in `packages/cli/src/agent/` (tested by vitest) and is bundled by esbuild into `plugin/dist/{pidb,mcp,hook}.mjs`; `plugin/` holds manifest, shims, hooks.json, skill, commands; the repo root holds `.claude-plugin/marketplace.json`.

**Tech Stack:** TypeScript strict ESM (NodeNext, `.js` suffixes), Fastify 5, Eta, better-sqlite3, zod 4, commander, `@modelcontextprotocol/sdk` (already a server dep), `@napi-rs/keyring` (new, runtime-installed for the plugin), esbuild (new dev dep), vitest.

**Spec:** `docs/superpowers/specs/2026-09-28-claude-plugin-design.md` — every task names the sections it implements; exact strings, codes and shapes live there.

## Global Constraints
- `npm run build` before `npx vitest run`; full suite green (baseline 527); `npm run typecheck` exit 0.
- No inline scripts/handlers/styles in `.eta` (strict CSP); UI behaviour goes in `packages/server/src/ui/public/app.js`.
- UI POSTs: `assertCsrf`, rate limit `{ max: 10, timeWindow: '1 minute' }`; form fields via `str(body(req), ...)`. Rate limits are per app instance — spread tests across `makeTestApp()` instances.
- Audit via `writeAudit`; never put secret values, tokens, device codes or passwords in meta or logs.
- An agent token can never carry `admin`, `secrets:reveal` or `secrets:write` (enforced server-side in connect start and approve).
- Cross-platform (macOS + Windows): no bash-only code in the plugin; use `node:path`, never hard-coded `/`; spawn without `shell: true` except the Windows browser-open `cmd /c start`.
- The plugin must never print or return a token or a secret value.
- Match surrounding style; conventional commits ending with a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Never kill processes you did not start (the user's pidb server runs on :8080). Do not run `claude plugin install` (controller does manual verification).

## Review Focus
1. Agent token calling `GET .../fields` or a sensitive `GET .../fields/:key` → 403 even though it has `secrets:use`.
2. `secrets:meta-write` PATCH that flips a field from non-sensitive to sensitive (or sets a value on a sensitive key) → 403.
3. Device poll after approval called twice (race/replay) → exactly one token issued; second call 400 `invalid_request`.
4. exec redaction when a value straddles two output chunks, and when the child prints the value base64-encoded.
5. Guard on PowerShell/cmd syntax (`$env:PIDB_PASSWORD`, `echo %PIDB_PASSWORD%`, `Get-ChildItem env:`) inside `pidb secret exec ... -- powershell -c ...`.

---

### Task 1: Agent scopes, token kind, projects:write, secrets:meta-write (spec §1.1)
**Files:** `packages/shared/src/schemas.ts` (SCOPES, AGENT_SCOPES), `packages/server/src/db/migrations.ts` (migration 4: `kind` column only — connect_requests comes in Task 3 as migration 5), `packages/server/src/repos/tokens.ts` (`kind` in row/create), `packages/server/src/auth/principal.ts` (+`agent`), `packages/server/src/http/auth.ts` (set `agent` from row.kind), `packages/server/src/services/projects.ts` + `http/routes/projects.ts` (PATCH with projects:write), `packages/server/src/services/secrets.ts` + `http/routes/secrets.ts` (meta-write rules), `packages/server/src/ui/views/tokens.eta` + `ui/routes/admin.ts` (agent pill, new scopes offered), tests in `packages/server/test/` (new `scopes.agent.test.ts`), `packages/shared/test/schemas.test.ts`.
- [ ] Tests first: projects:write can PATCH summary/tags/status/name of an accessible project, not slug, not another project, not create/delete; secrets:meta-write matrix per §1.1 incl. Review Focus 2; DELETE needs secrets:write; tokens page shows `agent` pill for kind agent; migration adds column with default `'user'`.
- [ ] Implement, build, full suite, typecheck, commit `feat(server): agent token kind and projects:write / secrets:meta-write scopes`.

### Task 2: Secret use endpoint (spec §1.2)
**Files:** `packages/server/src/services/secrets.ts` (`useSecretFor(ctx, actor, projectSlug|null, name, purpose, fields?)`), `packages/server/src/http/routes/secrets.ts` (POST `.../:name/use` for project and global bases), `packages/shared/src/schemas.ts` (`secretUseSchema`), tests `packages/server/test/secrets.use.test.ts`.
- [ ] Tests: secrets:use → 200 values + one `secret.used` audit row with meta `{purpose, fields, agent}` and no values; `fields` filter; unknown field → 404; no scope → 403; reveal endpoints still 403 for a secrets:use-only token (Review Focus 1); secrets:reveal token may call use too.
- [ ] Implement, build, suite, typecheck, commit `feat(server): secret use endpoint for substitution-only access`.

### Task 3: Device flow (spec §1.3)
**Files:** `packages/server/src/db/migrations.ts` (migration 5 `connect_requests`), new `packages/server/src/repos/connect.ts`, new `packages/server/src/services/connect.ts`, new `packages/server/src/http/routes/connect.ts` (start/poll, `config.public`), new `packages/server/src/ui/routes/connect.ts` + `ui/views/connect.eta`, `packages/server/src/ui/routes/auth.ts` + `ui/session.ts` (login preserves safe `next` for `/connect...` through password and 2FA steps), `ui/index.ts`/`http/app.ts` registration, `packages/shared/src/schemas.ts` (connectStartSchema, connectPollSchema), tests `packages/server/test/connect.test.ts`, `packages/server/test/ui.connect.test.ts`.
- [ ] Tests: start validates scopes ⊆ AGENT_SCOPES (admin/reveal/write → 400); codes format; poll states pending/denied/expired/unknown; approve (CSRF, ≥1 scope, ≥1 project, cannot add non-agent scope via tampered form) then poll issues token with kind agent, approved scopes/projects/expiry, revokes older same-name agent tokens, deletes request; replay → 400 (Review Focus 3); deny → 403 then row gone; anonymous `/connect?code=` → login → after login (and after 2FA) lands back on `/connect?code=...`; `next` pointing off-site or to other paths is ignored; audit rows present, none contains device_code or token.
- [ ] Implement, build, suite, typecheck, commit `feat(server): browser device flow for agent tokens`.

### Task 4: Prefilled secret form and new MCP tools (spec §1.4, §1.5)
**Files:** `packages/server/src/ui/routes/secrets.ts` + `ui/views/secret-edit.eta` (prefill from query), `packages/server/src/http/mcp.ts` (update_project, upsert_secret_meta, secret_request_link, instructions text), tests `packages/server/test/ui.secret-prefill.test.ts`, `packages/server/test/http.mcp.test.ts`.
- [ ] Tests: prefill renders name/description/tags/keys with sensitivity (`!` = non-sensitive), ignores any `value*` params, creates nothing on GET; MCP tools respect scopes, `secret_request_link` URL uses the request origin (trust-proxy aware) and encodes params; tools/list still has no reveal/use tool.
- [ ] Implement, build, suite, typecheck, commit `feat(server): prefilled secret links and agent MCP tools`.

### Task 5: Agent core — data dir, profiles, bindings, keyring store, agent-mode CLI gating (spec §2.1 data-dir resolution, §2.2, §2.3 minus connect/exec)
**Files:** new `packages/cli/src/agent/{datadir,state,tokenstore,context}.ts`, new `packages/cli/src/agent/cli.ts` (agent entry: builds the commander program in agent mode; reuses existing command modules), `packages/cli/src/cli.ts` (factor program building so both entries share it; disabled commands in agent mode), `packages/cli/package.json` (`@napi-rs/keyring` as optionalDependency for dev/tests), tests `packages/cli/test/agent.*.test.ts`.
- Interfaces: `resolveDataDir(env, selfPath): string`; `loadProfiles/saveProfiles`, `loadBindings/saveBindings`, `repoKey(cwd): string` (git top-level via `git rev-parse --show-toplevel`, fallback cwd; normalized per §2.2); `interface TokenStore { get(profile): Promise<string|null>; set(profile, token): Promise<void>; delete(profile): Promise<void> }`, `keyringStore(dataDir)` (loads `@napi-rs/keyring` via createRequire from `<dataDir>/package.json`, falls back to normal resolution for dev; missing → CliError "no OS credential store available — run a Claude Code session so the plugin installs its dependencies"), `memoryStore()` for tests; `resolveAgentConfig({cwd, env, store}) → {profile, url, token, project|null}`.
- [ ] Tests: data-dir derivation from a cache path (posix and win32 path samples via `path.win32`), atomic JSON writes, repoKey normalization, profile add/use/remove, bind/unbind/status output, disabled commands exit 2 with the spec message, PIDB_URL/PIDB_TOKEN ignored in agent mode.
- [ ] Implement, build, suite, typecheck, commit `feat(cli): agent mode core — profiles, bindings, OS credential store`.

### Task 6: connect, substitution-only secrets, exec redaction (spec §2.3)
**Files:** new `packages/cli/src/agent/{connect,redact,browser}.ts`, `packages/cli/src/commands/exec.ts` + `files.ts` (use endpoint in agent mode; redaction; written.json), tests `packages/cli/test/agent.connect.test.ts`, `agent.redact.test.ts`, `agent.exec.test.ts` (against `makeServer()`).
- Interfaces: `createRedactor(values: string[]): { push(chunk: Buffer|string): string; flush(): string }`; `openBrowser(url, platform)` returns the spawn args (testable) and spawns detached, ignoring errors.
- [ ] Tests: redactor across chunk boundaries, base64/base64url/URL/JSON-escaped forms, short values (<4) untouched, overlapping values (Review Focus 4); connect happy path (approve via service in test), denied, expired, stores token in memoryStore, never prints it; exec in agent mode hits `/use` with purpose exec, output redacted, exit code preserved; write/env record paths and refuse the data dir.
- [ ] Implement, build, suite, typecheck, commit `feat(cli): agent connect flow and redacted substitution-only secret use`.

### Task 7: MCP bridge (spec §2.4)
**Files:** new `packages/cli/src/agent/bridge.ts` (stdio server using `@modelcontextprotocol/sdk` Server + Client with StreamableHTTPClientTransport), `packages/cli/package.json` (add `@modelcontextprotocol/sdk` dependency, same version as server), tests `packages/cli/test/agent.bridge.test.ts` (in-memory transport pair against a real test server).
- [ ] Tests: tools/list = server tools + pidb_status/pidb_bind/pidb_profiles; tools/call forwards with bearer; 401 token_expired → tool error with connect hint; not connected → tool error with hint; output never contains the token.
- [ ] Implement, build, suite, typecheck, commit `feat(cli): stdio MCP bridge for the Claude plugin`.

### Task 8: Hooks — guard, redact, session-start (spec §3.1–§3.3)
**Files:** new `packages/cli/src/agent/hooks/{guard,redact,session-start,index}.ts` (pure decision functions + stdin/stdout JSON dispatcher), tests `packages/cli/test/agent.hooks.*.test.ts`.
- Interfaces: `guardDecision(input: HookInput, ctx: {dataDir, written: string[], serverUrls: string[], home, platform}) → {deny: false} | {deny: true, reason: string}`; `redactOutput(text) → string`; `sessionContext(ctx) → string`. Dispatcher reads hook JSON from stdin, writes the documented JSON (`hookSpecificOutput` with `permissionDecision`/`updatedToolOutput`/`additionalContext`), never throws (errors → allow + stderr note).
- [ ] Table tests covering every rule in §3.1 for bash/zsh, PowerShell and cmd syntaxes (Review Focus 5), plus allowed look-alikes (`pidb secret exec acme DB -- npm test`, `cat README.md`, `echo hello`); redact patterns; session context for connected/unbound/not-connected/server-down (≤4 KB).
- [ ] Implement, build, suite, typecheck, commit `feat(cli): plugin hooks — command guard, output redaction, session context`.

### Task 9: Plugin packaging, skill, commands, docs (spec §2.1, §3.4, §3.5, §4)
**Files:** `.claude-plugin/marketplace.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.mcp.json`, `plugin/bin/pidb`, `plugin/bin/pidb.cmd`, `plugin/hooks/hooks.json`, `plugin/package.json`, `plugin/skills/pidb/SKILL.md`, `plugin/commands/{connect,server,bind,status}.md`, `scripts/build-plugin.mjs` (esbuild; root `package.json` script `build:plugin`, esbuild devDependency), `plugin/dist/*.mjs` (generated, committed), `.gitattributes` (`plugin/bin/pidb text eol=lf`, `*.cmd eol=crlf`), `README.md` (section "Claude Code plugin": install on macOS/Windows, update/reinstall, first-use flow, security model and its limits), test `packages/cli/test/plugin.bundle.test.ts`.
- [ ] session-start ensures deps: if `<data>/node_modules/@napi-rs/keyring` missing, copy `plugin/package.json` to data dir and `npm install --omit=dev --no-audit --no-fund` there (Windows: `npm.cmd`), bounded by the hook timeout; hooks.json uses exec form `node` + args with `${CLAUDE_PLUGIN_ROOT}/dist/hook.mjs`.
- [ ] Bundle test: after `npm run build:plugin`, `node plugin/dist/pidb.mjs --help` lists agent commands only; `node plugin/dist/hook.mjs guard` with a sample deny input prints a deny decision; `plugin/dist/mcp.mjs` answers `initialize` + `tools/list` over stdio (spawned) with pidb_status present; manifest JSON files parse and reference existing paths.
- [ ] Build, suite, typecheck, commit `feat(plugin): pidb Claude Code plugin — manifest, shims, skill, commands, bundles`.
