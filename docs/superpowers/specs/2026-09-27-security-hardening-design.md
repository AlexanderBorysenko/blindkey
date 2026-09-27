# pidb Security Hardening — Design

**Status:** approved by Alex on 2026-09-13 (brainstorming; decisions recorded then), written up 2026-09-27 after the Keyring restyle merged.
**Parent spec:** `docs/superpowers/specs/2026-09-12-projects-info-db-design.md` (§7 auth, §11 UI). Where this document contradicts it, this document wins.
**Branch:** `feat/security-hardening` from `master` @ `abf018b`.

## Why

A security review on 2026-09-13 found that the parts most exposed on a public host are authentication and browser hardening:

- `pidb login` mints an **admin token that never expires** and stores it in `~/.config/pidb/config.json`.
- Tokens created in the UI/API default to **never expiring** (an empty expiry means "never").
- The admin account is protected by **a password only**, for both the UI and `POST /api/v1/auth/token`. A leaked password is full admin access, including a new admin API token.
- The admin UI CSP allows `'unsafe-inline'` for scripts and styles. The UI renders user-controlled Markdown (sanitized), secret names and keys. `unsafe-inline` removes the second line of defence if an escaping bug ever slips through.

Out of scope here (deferred by decision): host hardening, backup separation, and the agent plugin (sub-project B).

## 1. Token lifetimes

### 1.1 Login tokens (`POST /api/v1/auth/token`, used by `pidb login`)

- The request gains an optional `expires_days`: an integer from 1 to 365, default **30**. Login tokens can no longer be non-expiring.
- The response gains `expires_at` (epoch ms).
- `pidb login <url> [--expires <days>]` sends `expires_days`. The CLI validates the range locally, prints the expiry date, and stores the token as today.

### 1.2 Tokens created in the UI / API (`POST /api/v1/tokens`)

- `expires_at` becomes tri-state in `tokenInputSchema`:
  - **omitted** → the server sets `now + 90 days`;
  - an integer → that expiry (must be in the future);
  - an explicit `null` → never expires.
- The shared schema changes from `.nullable().default(null)` to `.nullable().optional()`. The default is applied in `createTokenFor`, so every caller gets it.
- **UI** (`/tokens`, new-token dialog):
  - "Expires in (days)" is pre-filled with `90`.
  - A new checkbox "Never expires" (`name="never"`) is the only way to get `null`.
  - Empty days without the checkbox → 90.
  - A non-positive or non-integer value → the existing validation error.
- **CLI** `pidb token create`:
  - no `--expires` → omit `expires_at`, so the server default of 90 d applies;
  - `--expires 90d|12h|30m` → as today;
  - new `--no-expiry` → sends `null`. `--expires` and `--no-expiry` together → CliError.
- **Visibility.** In the UI token table, a non-expiring active token shows a warn-colored `.pill status-paused` "never expires" in the Expires column. `pidb token list` prints `never` as today.

### 1.3 Expired tokens

- The bearer hook distinguishes an expired token from an unknown one. A token whose hash matches but whose `expires_at <= now` gets **401 `token_expired`** ("token expired"), not `unauthorized`. This reveals nothing to someone who does not already hold the token value.
- Revoked tokens stay generic `unauthorized`.
- Failed-attempt accounting (`FailureLimiter`, `auth.token_failed` audit) is unchanged for unknown tokens. Expired tokens audit `auth.token_expired` and **do not** count toward the limiter, so a stale CI token cannot lock an IP out.
- **CLI:** an `ApiError` with status 401 and `error === 'token_expired'` prints `token expired — run \`pidb login <url>\` again` and exits `EXIT_AUTH` (3).

Existing rows keep their `expires_at`, including `NULL`. No data migration is needed; the UI highlight (1.2) makes the old never-expiring tokens visible so the admin can revoke them.

## 2. Two-factor authentication (TOTP)

### 2.1 Algorithm

- RFC 6238 TOTP: HMAC-SHA-1, 6 digits, 30 s period, verification window ±1 step. Implemented with `node:crypto` in `src/auth/totp.ts` (about 40 lines) and tested against the RFC 6238 appendix B vectors (SHA-1 seed `12345678901234567890`) truncated to 6 digits.
- Secret: 20 random bytes, shown as RFC 4648 base32 without padding.
- `otpauth://totp/pidb:<username>?secret=<b32>&issuer=pidb&algorithm=SHA1&digits=6&period=30`.
- **Replay protection:** a code is accepted only if its step is **greater than** `admin_totp.last_used_step`; on success `last_used_step` is set to that step.

### 2.2 Data (migration 2)

```sql
CREATE TABLE admin_totp (
  admin_id INTEGER PRIMARY KEY REFERENCES admin(id) ON DELETE CASCADE,
  secret_enc BLOB NOT NULL,          -- seal(masterKey[key_version], secret, 'totp:<admin_id>')
  key_version INTEGER NOT NULL,
  enabled_at INTEGER,                -- NULL = enrollment started, not confirmed
  last_used_step INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE recovery_codes (
  id INTEGER PRIMARY KEY,
  admin_id INTEGER NOT NULL REFERENCES admin(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,           -- argon2id (same params as passwords)
  used_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE login_challenges (
  id TEXT PRIMARY KEY,               -- 32 random bytes, hex
  admin_id INTEGER NOT NULL REFERENCES admin(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,       -- created_at + 5 min
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  ip TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT ''
);
```

- **Recovery codes:** 10 codes of the form `xxxxx-xxxxx` from the alphabet `abcdefghjkmnpqrstuvwxyz23456789`, each hashed with argon2id. They are shown **once**, on a `no-store` page. Using one sets `used_at`, and it never works again.
- **`rotate-key`** (`runRotateKey`) also rewraps `admin_totp.secret_enc` for rows whose `key_version != current`: open with the old key and the same AAD, seal with the current key. Both rewraps run in one transaction, so it is all or nothing. The CLI prints two lines: `rewrapped N secrets to key version V` (unchanged), then `rewrapped M 2FA secrets`.

### 2.3 Enrollment and management (UI)

A new page **`/settings/2fa`** is linked in the sidebar Admin group as "Two-factor". Its state depends on the `admin_totp` row:

- **No row, or not yet enabled:** a "Set up two-factor" button (`POST /settings/2fa/start`) creates or replaces the pending row. The page then shows the QR code (an SVG data URI from the `qrcode` package; CSP `img-src data:` already allows it), the base32 secret as text (grouped by 4), and a confirm form (`POST /settings/2fa/confirm`, 6-digit code).
  - A correct code sets `enabled_at`, generates 10 recovery codes, and renders them once with "Save these now" copy.
  - A wrong code re-renders with an error.
- **Enabled:** shows "Enabled since <date>" and the number of unused recovery codes. Two actions each require the **current password + a fresh second factor** (a TOTP code **or** an unused recovery code — a recovery code is accepted so an admin who lost the authenticator can still regenerate codes or turn 2FA off):
  - "Regenerate recovery codes" (`POST /settings/2fa/recovery`): replaces all codes and shows the new ones once.
  - "Turn off two-factor" (`POST /settings/2fa/disable`): deletes `admin_totp` and `recovery_codes` for the admin.
- **Until enrolled:** every admin page shows a warn-colored `.alert.warn` banner at the top of `<main>`: "Two-factor authentication is off. Set it up →" (link to `/settings/2fa`). The banner is rendered from a `pageContext` field `totpEnabled: boolean`.
- **Audit actions:** `auth.totp_enrolled`, `auth.totp_disabled`, `auth.recovery_regenerated`, `auth.totp_failed`, `auth.recovery_used`, `auth.totp_reset`.
- All `/settings/2fa*` responses are `cache-control: no-store`. All POSTs require CSRF.

### 2.4 UI login flow

`POST /login` behaves as follows:

1. **Username and password wrong:** unchanged (401, `auth.login_failed`).
2. **Correct, no 2FA enabled:** unchanged. A session is created and the response redirects to `/`.
3. **Correct, 2FA enabled:**
   - Create a `login_challenges` row.
   - Set cookie `pidb_2fa=<id>`: httpOnly, SameSite=Lax, path `/login`, max-age 300, Secure as for the session.
   - Redirect to `/login/2fa`. **No session yet.**

`GET /login/2fa` is public. It renders a single input `name="code"` (autocomplete `one-time-code`) and accepts either a 6-digit TOTP code or a recovery code. A missing or expired challenge redirects to `/login`.

`POST /login/2fa` is public and rate-limited to 10/min per IP.

- **Valid code:** create the session, delete the challenge, clear `pidb_2fa`, audit `auth.login` with `meta.via = 'ui'` and `meta.second_factor = 'totp' | 'recovery'`, redirect to `/`.
- **Invalid code:**
  - Increment `attempts` and audit `auth.totp_failed`.
  - At 5 attempts, delete the challenge, clear `pidb_2fa`, and render the login page with status 401 and the message "Too many attempts — log in again." (rendered, not redirected, so the message is visible).
  - Otherwise re-render with "Invalid code."

A malformed code (a non-string `code` field) is treated as a wrong code.

Expired challenges are purged opportunistically, like sessions.

The UI guard (`registerUiGuard`) must allow `/login/2fa` anonymously, exactly like `/login`.

### 2.5 API / CLI login

`authTokenRequestSchema` gains an optional `totp`: a string of up to 32 characters (a 6-digit code or a recovery code).

- **Admin with 2FA enabled and no `totp`:** 401 `totp_required` ("two-factor code required"). No audit row, because the password was correct and this is a normal step.
- **Wrong `totp`:** 401 `unauthorized` ("invalid credentials") and audit `auth.totp_failed`. The existing 5/min route limit applies.
- **Correct:** the token is minted as in §1.1, and the `auth.login` meta records `second_factor`.

**CLI `pidb login`:**
1. POST without `totp`.
2. On `ApiError` 401 `totp_required`, prompt `2FA code: ` (hidden input) and POST again with `totp`.
3. Non-interactive stdin works as for the password.

The MCP endpoint and bearer-token requests are unaffected: 2FA gates **minting** admin tokens, not using them.

### 2.6 Emergency reset

`pidb-server 2fa reset` (shell only, like `init`):
- Deletes `admin_totp`, `recovery_codes` and `login_challenges` for the admin.
- Writes audit `auth.totp_reset` (`actor_type 'admin'`, `actor_id` = the admin's id, `meta.via = 'shell'`).
- Prints `two-factor disabled for <username>`.
- If no admin exists, it prints an error and exits 1.

## 3. Content Security Policy without `unsafe-inline`

### 3.1 Policy

```
default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:;
object-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'
```

The policy has no `unsafe-inline` and no `unsafe-eval`. `font-src`/`connect-src` fall back to `default-src 'self'`.

### 3.2 Moving inline code out

- Every inline `<script>` block, every `on*=` attribute and every `style="…"` attribute in `packages/server/src/ui/views/**` is removed.
- Behaviour moves into one static file, **`src/ui/public/app.js`**, loaded with `<script src="/assets/app.js" defer>` after htmx. It uses **event delegation on `document`** (`click` / `change` / `htmx:afterSwap` listeners), so htmx-swapped fragments (reveal partial, preview) work without re-binding.
- Hooks are declared with `data-*` attributes:

  | attribute | behaviour (was) |
  |---|---|
  | `data-open-dialog="<id>"` | `document.getElementById(id).showModal()` (inline onclick) |
  | `data-close-dialog` | `this.closest('dialog').close()` |
  | `data-open-on-load` on a `<dialog>` | open on DOMContentLoaded (was the inline auto-open script after a validation error) |
  | `data-action="copy-field"` | copy the row's `.field-value` text, label → "Copied" for 1.5 s |
  | `data-action="hide-field"` | re-mask a revealed row from its `<template data-masked-row>` and `htmx.process` the clone |
  | `data-action="copy-new-token"` | copy the one-time token text |
  | `data-action="toggle-lock"` / `move-up` / `move-down` / `remove-row` / `add-row` (`data-key`) | secret editor rows |
  | `.timer[data-seconds]` | reveal auto-hide countdown (started on load and on `htmx:afterSwap`) |

- **Secret editor hint keys:** passed as an escaped `data-hint-keys='[…]'` attribute on `#rows`, parsed with `JSON.parse`. No inline JSON script.
- **SVG sprite:** `style="position:absolute"` becomes a CSS class.
- **htmx:** `<meta name="htmx-config" content='{"includeIndicatorStyles":false,"allowEval":false,"allowScriptTags":false}'>`. Otherwise htmx injects a `<style>` element (blocked by `style-src 'self'`); the other two flags harden swaps.
- **Behaviour parity is a requirement**, not a nice-to-have:
  - reveal → auto-hide after 30 s → reveal again;
  - Copy / Copied;
  - lock toggle and the positional `sensitive` inputs;
  - add / move / remove rows;
  - all dialogs, including the ones that auto-open after a validation error;
  - the one-time token copy;
  - the document live preview.

### 3.3 Markdown

Already sanitized by `sanitize-html` (verified 2026-09-13). Add regression tests only:
- `<script>`, `on*` attributes, `style` attributes and `javascript:` links are stripped from rendered documents and from `/preview`.

## 4. Tests (acceptance)

- **TOTP unit:** RFC 6238 vectors (6-digit truncation), ±1 window, replay rejected (same step twice), base32 round-trip.
- **Token TTL:**
  - `auth/token` default 30 d, `expires_days` bounds (0 and 366 rejected);
  - `/api/v1/tokens` omitted → about 90 d, explicit null → null;
  - UI empty days → about 90 d, "Never expires" → null;
  - expired token → 401 `token_expired`, and it does not trip the limiter;
  - CLI `--no-expiry` / default / conflict;
  - CLI expired-token message.
- **2FA UI:**
  - enrollment start → confirm (wrong code rejected, right code enables, 10 codes shown once, page `no-store`);
  - login with 2FA → no session cookie after the password step, `pidb_2fa` cookie set, correct code → session;
  - recovery code works once;
  - 5 wrong attempts kill the challenge;
  - expired challenge → `/login`;
  - disable and regenerate require password + code;
  - the banner shows until enrolled.
- **2FA API/CLI:** `totp_required`, wrong code, correct code, recovery code; CLI prompts on `totp_required` (injected IO).
- **rotate-key:** a TOTP secret sealed under key v1 still verifies after rotating to v2.
- **2fa reset:** command removes the rows and writes the audit row.
- **CSP:**
  - response header equals the policy in §3.1;
  - no view renders `<script>` without `src`, any ` on[a-z]+=` attribute, or ` style="`: a test renders every page (projects, project both tabs, secret, secret edit, new secret, doc, doc edit, tokens incl. the one-time panel, audit, search, login, login/2fa, settings/2fa in each state, error) and asserts with regexes;
  - `app.js` is served with `text/javascript` and contains the handler names above.
- **Existing tests** coupled to inline JS (`onclick="hideField(this)"`, `function hideField(`, `moveRow(this, …)`, the `htmx.process(` source assertion, `ui.tokens.test.ts:53` "empty days → never") are **rewritten** to the new mechanism. Each keeps its intent.

## 5. Docs

README:
- `pidb login --expires`, token defaults (30 d login, 90 d created, explicit never);
- 2FA setup, recovery codes, `pidb-server 2fa reset`;
- the CSP line in the Admin UI section;
- `rotate-key` now also rewraps 2FA secrets.
