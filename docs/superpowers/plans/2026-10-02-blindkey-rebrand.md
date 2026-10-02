# Blindkey Rebrand Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename pidb → Blindkey everywhere in code, add branding (logo, accent, login), public docs (README, SECURITY.md, LICENSE) and ignore agent working materials, so the tree is ready to publish.

**Architecture:** One ordered, scripted find/replace (throwaway script in the scratchpad) does the mechanical 1588-occurrence rename. Targeted hand edits and new tests then cover the security-sensitive spots (guard, redaction, token format) and the branding. Stages B (prod and machine migration) and C (publication) are interactive runbooks. They are NOT part of this plan's automated tasks and each needs the user's go-ahead at the time.

**Tech Stack:** Node 22, TypeScript, Fastify 5, Eta, Pico CSS, vitest, esbuild (plugin bundle), Docker compose.

**Spec:** `docs/superpowers/specs/2026-10-02-blindkey-rebrand-design.md`

## Global Constraints

- One env prefix `BLINDKEY_` for server config, CLI config and injected secret fields (`BLINDKEY_<KEY>`).
- Token format `bk_<8>_<43>`; regex `^bk_([A-Za-z0-9_-]{8})_[A-Za-z0-9_-]{43}$`.
- Names: CLI `blindkey`, server bin `blindkey-server`, packages `@blindkey/{shared,server,cli}`, plugin `blindkey@blindkey` v1.0.0, cookies `blindkey_session`/`blindkey_2fa`, TOTP issuer `Blindkey`, keychain service `blindkey`, config dir `blindkey`, DB default `blindkey.sqlite`, compose project `blindkey`, volume `blindkey-data`, image `blindkey-server:local`.
- No legacy `pidb` compatibility code.
- DB schema, migrations, `{{secret:…}}` syntax and REST paths are unchanged.
- Test count must not drop below the pre-rename count (record it in Task 1).
- Public text is in English. Tagline: "Secrets your AI agents can use but never see."
- MIT, © 2026 Alexander Borysenko. No email in `plugin.json`.

## Review Focus

1. The old command word `pidb` must no longer be treated as the CLI by the guard, and `blindkey <user-only cmd>` must be blocked. Test: Task 3.
2. A secret field named `URL`/`TOKEN`/`AGENT` must still be rejected by `secret exec` as colliding with reserved `BLINDKEY_*` names. Test: Task 3.
3. A `bk_…` token printed in Bash output must be redacted by the PostToolUse hook, and an old `pidb_…` string is just text. Test: Task 3.
4. Reads of `~/.config/blindkey/…` and `%APPDATA%\blindkey\…` must be blocked. Test: Task 3.
5. The new favicon and logo must load under the existing CSP with no inline style or script. Test: Task 4.

---

### Task 1: Branch, ignore agent materials, licence, personal data

**Files:**
- Modify: `.gitignore`
- Create: `LICENSE`
- Modify: `plugin/.claude-plugin/plugin.json` (drop `email`)
- Modify: `packages/shared/test/refs.test.ts`, `packages/shared/test/schemas.test.ts` (`critter-hero` → `acme-shop`)

- [ ] **Step 1:** `git switch -c rebrand/blindkey`. Run `npm test 2>&1 | tail -5` and record the passing test count N (expected about 1574).
- [ ] **Step 2:** Append to `.gitignore`:

```
# agent working materials (never published)
docs/superpowers/
.superpowers/
.claude/
.claude-memory/
CLAUDE.md
graphify-out/
.serena/
```

and run `git rm -r --cached -q docs/superpowers`.
- [ ] **Step 3:** Write `LICENSE` with the standard MIT text, `Copyright (c) 2026 Alexander Borysenko`.
- [ ] **Step 4:** `sed -i '' 's/critter-hero/acme-shop/g; s/Critter/Acme/g' packages/shared/test/refs.test.ts packages/shared/test/schemas.test.ts`, then remove the `"email"` line (and the trailing comma before it) from `plugin/.claude-plugin/plugin.json`.
- [ ] **Step 5:** `npx vitest run packages/shared` → PASS.
- [ ] **Step 6:** Commit with message `chore: MIT licence, ignore agent working materials, neutral test fixtures`.

### Task 2: Mechanical rename

**Files:** about 171 tracked files (everything except `docs/`, `package-lock.json` and `plugin/dist`). Moves: `plugin/bin/pidb` → `plugin/bin/blindkey`, `plugin/bin/pidb.cmd` → `plugin/bin/blindkey.cmd`, `plugin/skills/pidb/` → `plugin/skills/blindkey/`, `plugin/dist/pidb.mjs` → regenerated as `plugin/dist/blindkey.mjs`.

**Interfaces:**
- Produces: all names listed in Global Constraints. `scripts/build-plugin.mjs` `ENTRIES` key becomes `blindkey`.

- [ ] **Step 1:** Write the scratchpad script `rename.mjs`. It runs over `git ls-files` minus `docs/`, `package-lock.json` and `plugin/dist/`, skips binary files, and applies the following rules **in order** to each file:

```js
const RULES = [
  [/pidb_session/g, 'blindkey_session'],
  [/pidb_2fa/g, 'blindkey_2fa'],
  [/pidb_(status|bind|profiles)/g, 'blindkey_$1'],
  [/env:pidb_/gi, 'env:blindkey_'],
  [/pidb_pidb-data/g, 'blindkey_blindkey-data'],
  [/PIDB_/g, 'BLINDKEY_'],
  [/pidb_/g, 'bk_'],                         // remaining: API token prefix (src, tests, redaction)
  [/Projects Info DB/g, 'Blindkey'],
  [/issuer=pidb/g, 'issuer=Blindkey'],
  [/@pidb\//g, '@blindkey/'],
  [/\bPIDB\b/g, 'BLINDKEY'],
  [/\bPidb\b/g, 'Blindkey'],
  [/pidb/g, 'blindkey'],                     // CLI word, dirs, keychain, compose, pidb-server, pidb.sqlite …
];
```

  It prints the changed-file count. Then run `git mv` for the moves above.
- [ ] **Step 2:** Hand-check the token regex. `packages/server/src/crypto/tokens.ts` must now read `const TOKEN_RE = /^bk_([A-Za-z0-9_-]{8})_[A-Za-z0-9_-]{43}$/;` and ``const token = `bk_${prefix}_${secret}`;``. `packages/cli/src/agent/hooks/redact.ts` must read `const BLINDKEY_TOKEN_RE = /bk_[A-Za-z0-9_-]{20,}/g;`. Fix the names by hand if the rules produced something else.
- [ ] **Step 3:** In `plugin/.claude-plugin/plugin.json` set `"version": "1.0.0"`, `"displayName": "Blindkey"` and keywords `["blindkey","secrets","ai-agents","mcp","claude-code"]`. In `plugin/package.json` set `"license": "MIT"`. Rewrite the `.claude-plugin/marketplace.json` description to "Blindkey for Claude Code: secrets your agent can use but never see, plus project docs and memory".
- [ ] **Step 4:** Run `npm install` (it regenerates `package-lock.json` workspace names), then `npm run build && npm run build:plugin && npm run typecheck`. Expected: clean.
- [ ] **Step 5:** Run `npm test`. Fix the fallout with targeted edits, never by deleting tests. Typical fallout: token-length fixtures (`bk_` is 2 chars shorter than `pidb_`), snapshot strings, and help text. Expected: N passing.
- [ ] **Step 6:** `git grep -n -i pidb -- . ':!docs'` → no output.
- [ ] **Step 7:** Commit with message `refactor!: rename pidb to Blindkey across code, plugin and docker`.

### Task 3: Security-sensitive names pinned by tests

**Files:**
- Test: `packages/cli/test/agent.hooks.guard.test.ts`, `packages/cli/test/agent.hooks.redact.test.ts`, `packages/cli/test/exec.test.ts`, `packages/server/test/crypto.test.ts`

Each test below follows the existing helpers in its file. Read the file's top `describe`/helper first and reuse its call shape (e.g. the guard's `decide(...)`/`runGuard(...)` helper and the redact helper). Behaviour to pin:

- [ ] **Step 1 (guard, CLI word):** `blindkey connect` and `blindkey token` (the user-only commands, as listed in the guard's existing user-only test) → deny. `pidb connect` → not denied by the user-only rule. It is now an unknown command.
- [ ] **Step 2 (guard, env dump inside exec):** `blindkey secret exec p "db" -- env` → deny. `blindkey secret exec p "db" -- printenv BLINDKEY_PASSWORD` → deny.
- [ ] **Step 3 (guard, protected dirs):** Read of `<home>/.config/blindkey/config.json` → deny. Read of `<appdata>\blindkey\config.json` (win ctx) → deny. PowerShell bare `$env:blindkey_password` → handled like the old `$env:pidb_*` case.
- [ ] **Step 4 (redact):** Output containing `bk_AbCdEfGh_` plus 43 url-safe chars → redacted. `pidb_x` short text → unchanged.
- [ ] **Step 5 (exec reserved names):** A secret with field `URL` in user mode → rejected, with the error naming `BLINDKEY_URL`. A field `AGENT` in agent mode → rejected (`BLINDKEY_AGENT`).
- [ ] **Step 6 (server token):** `generateToken().token` matches `/^bk_[A-Za-z0-9_-]{8}_[A-Za-z0-9_-]{43}$/`. `parseTokenPrefix('pidb_abcdefgh_' + 'a'.repeat(43))` → `null`.
- [ ] **Step 7:** Run the four files. Any test the rename already covers simply passes. Any that fails reveals a real rename gap; fix the source. Then run `npm test` → ≥ N + new tests.
- [ ] **Step 8:** Commit with message `test: pin guard, redaction, exec and token behaviour to the Blindkey names`.

### Task 4: Visual branding

**Files:**
- Create: `assets/logo.svg`, `assets/logo-wordmark.svg`, `packages/server/src/ui/public/favicon.svg`
- Modify: `packages/server/src/ui/views/layout.eta`, `packages/server/src/ui/views/login.eta`, `packages/server/src/ui/public/app.css`
- Test: `packages/server/test/ui.csp.test.ts`, `packages/server/test/ui.auth.test.ts`

- [ ] **Step 1 (failing tests):** In `ui.csp.test.ts`, `GET /assets/favicon.svg` → 200, `content-type` contains `image/svg+xml`, and the body has no `<script` and no `style=`. In `ui.auth.test.ts`, `GET /login` HTML contains `<link rel="icon" href="/assets/favicon.svg"`, `Blindkey`, and `Secrets your AI agents can use but never see.`
- [ ] **Step 2:** Run them → FAIL.
- [ ] **Step 3:** Mark SVG (24×24 viewBox, `fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"`): a closed-eye arc `M3 12c2.5 3.5 5.5 5 9 5s6.5-1.5 9-5`, three lashes, and a keyhole (`circle cx=12 cy=9 r=2.2` plus `path M11 11h2l.6 4h-3.2z` filled with currentColor). `favicon.svg` is the same mark at a fixed colour `#4f46e5`. `logo-wordmark.svg` is the mark plus `<text>` "Blindkey" in `font-family="IBM Plex Sans, sans-serif" font-weight="600"`, with `fill="currentColor"`.
- [ ] **Step 4:** In `layout.eta` add `<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">`. Make the header brand the inline mark plus "Blindkey". The title is already `· Blindkey` after Task 2. In `login.eta`, put the mark, `<h1>Blindkey</h1>` and `<p class="tagline">Secrets your AI agents can use but never see.</p>` above the form.
- [ ] **Step 5:** In `app.css` override the Pico primary colour for light (`--pico-primary: #4f46e5; --pico-primary-hover: #4338ca; …-background/-underline/-focus` to match) and for dark (`#818cf8` / `#a5b4fc`), using the selectors Pico already uses in this file. Add `.brand svg{width:1.4em;height:1.4em;vertical-align:-.25em}` and `.tagline{color:var(--pico-muted-color)}`.
- [ ] **Step 6:** Run the tests → PASS. Then `npm test` → all pass.
- [ ] **Step 7:** Commit with message `feat(ui): Blindkey logo, favicon, accent colour and branded login`.

### Task 5: README and SECURITY.md

**Files:**
- Modify: `README.md` (rewrite top and security sections, keep the ops sections)
- Create: `SECURITY.md`

- [ ] **Step 1:** README structure per spec §4.1: wordmark `<img src="assets/logo-wordmark.svg" height="48">`, tagline, pitch, Why, How it works (ASCII sequence: agent → MCP (docs + metadata) → `blindkey secret exec` → server `POST …/use` (audited) → child env → redacted output), Features, Security model (encryption at rest; server-enforced boundaries; credentials; web hardening; agent-side defence; Known limits carried over verbatim; threat-model table), then the existing Quick start / CLI / Admin UI / Plugin / Deployment / Environment / Error codes sections with the new names. Remove the "Spec:" line and any private-repo wording. Install instructions clone `https://github.com/AlexanderBorysenko/blindkey.git`. Add a Licence + Status footer.
- [ ] **Step 2:** In `SECURITY.md`: report via GitHub private vulnerability reporting (Security → Report a vulnerability); scope is server, CLI, plugin hooks; out of scope are the documented known limits; link to the README security model.
- [ ] **Step 3:** Check that every env var named in the README exists: `grep -oE 'BLINDKEY_[A-Z_]+' README.md | sort -u` compared against `git grep -ohE 'BLINDKEY_[A-Z_]+' -- packages docker | sort -u`. The README must contain nothing the code lacks.
- [ ] **Step 4:** Commit with message `docs: Blindkey README with security model, SECURITY.md`.

### Task 6: Whole-tree verification

- [ ] **Step 1:** `npm run build && npm run build:plugin && npm run typecheck && npm test` → clean, ≥ N tests.
- [ ] **Step 2:** `git status --porcelain plugin/dist` → empty (the committed bundle is fresh).
- [ ] **Step 3:** If Docker is available (`open -a Docker` if needed), build the image and run a compose smoke test with `BLINDKEY_*` env against a scratch volume: `/health` returns 200 and the login page shows the brand. Afterwards remove the scratch volume. If Docker can't start, record that this step was skipped.
- [ ] **Step 4:** `gitleaks detect --no-git --source .` (`brew install gitleaks` if missing) → no leaks. Check `git ls-files` by hand for anything that is not product.
- [ ] **Step 5:** Final branch review (reviewer agent), then merge into master.

## Stage B/C (interactive, after this plan)

Run spec §7 (migration runbook) and spec §8 (publication) step by step with the user. `gh repo create … --public` and every prod command need explicit confirmation at the time.
