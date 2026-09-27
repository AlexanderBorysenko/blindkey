# pidb Security Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expiring tokens by default, TOTP two-factor authentication for the admin (UI and API/CLI), and a Content Security Policy without `'unsafe-inline'`.

**Architecture:**
- **Token lifetimes** are defaults applied in the service layer (`createTokenFor`, `exchangePassword`), plus an explicit `token_expired` error from the bearer hook.
- **TOTP** is a self-contained `node:crypto` module (`src/auth/totp.ts`), a repo for three new tables (migration 2), and a service (`src/services/twofactor.ts`). The UI login routes, the `/settings/2fa` pages, the `POST /api/v1/auth/token` route and `pidb login` all call that service.
- **CSP:** every inline script, `on*=` handler and `style=` attribute moves into one delegated static file `src/ui/public/app.js`, driven by `data-*` attributes.

**Tech Stack:** Node ≥22, TypeScript strict ESM, Fastify 5, Eta, htmx 2.0.10, better-sqlite3, argon2, zod 4, commander, vitest. One new runtime dependency (`qrcode`) and its types (`@types/qrcode`, dev).

**Spec:** `docs/superpowers/specs/2026-09-27-security-hardening-design.md`. Binding; read it before Task 1. Parent spec `docs/superpowers/specs/2026-09-12-projects-info-db-design.md` §7/§11.

**Branch:** `feat/security-hardening` (already created from `master` @ `abf018b`; spec committed as `f44e10b`).

## Global Constraints

- **Language rules:** TypeScript `strict` + `noUncheckedIndexedAccess`, ESM `NodeNext`. Every relative import carries `.js`.
- **Build before tests:** ALWAYS `npm run build` (repo root) before `npx vitest run`. Several tests exec `dist/`, and the UI build step copies `views/` and `public/` into `dist/ui`.
- **Time units:** epoch **milliseconds** everywhere. `DAY_MS = 86_400_000`.
- **Token lifetimes:**
  - Login tokens: `expires_days` 1–365, default **30**. Login tokens can never be non-expiring.
  - API/UI-created tokens: omitted `expires_at` → **now + 90 days**; explicit `null` → never; a number must be in the future.
- **Expired bearer token:** 401 with error code **`token_expired`**, message `token expired`. Audit action `auth.token_expired`. It does **not** count toward `FailureLimiter`.
- **TOTP parameters:** RFC 6238, HMAC-SHA-1, 6 digits, 30 s period, window ±1, a step is accepted only if `> last_used_step`. The secret is 20 random bytes, base32 without padding. Sealed with `seal(masterKey, secret, 'totp:<admin_id>')`, and its `key_version` is stored.
- **Recovery codes:** 10 per set, format `xxxxx-xxxxx`, alphabet `abcdefghjkmnpqrstuvwxyz23456789`, argon2id via the existing `hashPassword`, single use.
- **Login challenge:**
  - table `login_challenges`, TTL **5 min**, max **5** attempts;
  - cookie `pidb_2fa`: httpOnly, SameSite=Lax, path `/login`, max-age 300, `secure` as for the session cookie;
  - `POST /login/2fa` rate limit 10/min.
- **API 2FA errors:**
  - enabled 2FA and no `totp` → 401 **`totp_required`** / `two-factor code required`, with no audit row;
  - wrong `totp` → 401 `unauthorized` / `invalid credentials`, audit `auth.totp_failed`.
- **Audit actions (exact):** `auth.token_expired`, `auth.totp_enrolled`, `auth.totp_disabled`, `auth.recovery_regenerated`, `auth.totp_failed`, `auth.recovery_used`, `auth.totp_reset`. A successful login's `auth.login` meta gains `second_factor: 'totp' | 'recovery'` when used.
- **CSP (exact header value):**
  `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`
- **Inline code:** no view may render `<script>` without `src`, any `on<event>=` attribute, or any `style=` attribute.
- **`no-store` paths:** everything under `/settings/2fa` and `/login/2fa`, in addition to today's `/secrets`, `/tokens`, `/audit`.
- **Behaviour preserved:** no change to secret reveal/audit, CSRF (every UI POST except `/login` and `/login/2fa` carries `csrf`), the positional `key`/`value`/`sensitive` form contract of the secret editor, or the cache headers beyond the additions above.
- **`rotate-key` output:** keep the first line exactly `rewrapped <n> secrets to key version <v>` (the README runbook parses it). Print the 2FA count on a second line: `rewrapped <m> 2FA secrets`.
- **Tests:** in `packages/<pkg>/test/**/*.test.ts`, driven via `app.inject` (`makeTestApp()`) or the CLI `makeServer()` fixture. Page-content assertions are scoped to the `<main`…`</main>` segment (the sidebar contains project links, counts and a CSRF form).
- **Commits:** Conventional Commits. Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; verify with `git log -1 --format=%B` and amend if wrong.
- **Never** start a server on a port something else uses, and never kill a process the task did not start.
- If a step cannot be done as written, **STOP and report BLOCKED** with the exact output. Do not improvise a different design.

## Review Focus

1. **Recovery code typed in capitals, with spaces, or without the dash** → accepted, since normalization is case/space/dash-insensitive. Pinned in Task 4 (`normalizeRecoveryCode`) and Task 6 (UI login).
2. **An enrollment that was started but never confirmed** must not demand a code at login and must not count as "enabled" (banner stays). Pinned in Task 5 (API) and Task 6 (UI).
3. **The `pidb_2fa` cookie replayed after a successful second step** → rejected (the challenge is deleted). Pinned in Task 6.
4. **The same 6-digit code used twice within its 30 s step** (for example two quick logins) → the second is rejected. Pinned in Task 4 (unit) and Task 5 (API).
5. **API token `expires_at` in the past** → 400 `validation`, not a dead-on-arrival token. Pinned in Task 1.

---

## Task 1: Token lifetimes on the server

**Files:**
- Modify: `packages/shared/src/schemas.ts:106-119`
- Modify: `packages/shared/test/schemas.test.ts:74-81`
- Modify: `packages/server/src/repos/tokens.ts`
- Modify: `packages/server/src/http/auth.ts`
- Modify: `packages/server/src/services/admin.ts`
- Modify: `packages/server/src/http/routes/admin.ts`
- Modify: `packages/server/src/ui/routes/admin.ts:28-68`
- Modify: `packages/server/src/ui/views/tokens.eta`
- Test: `packages/server/test/tokens.ttl.test.ts` (create)
- Modify tests: `packages/server/test/ui.tokens.test.ts` (the "empty days → never" case around line 53), `packages/server/test/repos.auth.test.ts` (only if the wrapper changes behaviour; it must not)

**Interfaces:**
- **Produces** `DAY_MS` and the lookup function in `packages/server/src/repos/tokens.ts`:
  ```ts
  export type TokenLookup = { state: 'active'; row: TokenRow } | { state: 'expired'; row: TokenRow } | { state: 'none' };
  export function lookupTokenByValue(db: Db, token: string, nowTs?: number): TokenLookup
  ```
  `findActiveTokenByValue` stays, as a wrapper returning `row | null`.
- **Produces** from `@pidb/shared`:
  - `tokenInputSchema.expires_at`: `number | null | undefined`;
  - `authTokenRequestSchema.expires_days`: `number` (default 30).
- **Produces** from `exchangePassword(...)` on success: `{ token, id, name, expires_at: number }`. Task 5 extends its return type.

- [ ] **Step 1: Write failing tests** in `packages/server/test/tokens.ttl.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeTestApp, auth, type TestCtx } from './helpers.js';
import { createAdmin } from '../src/repos/admin.js';
import { hashPassword } from '../src/crypto/passwords.js';
import { createToken } from '../src/repos/tokens.js';
import { listAudit } from '../src/repos/audit.js';

const DAY = 86_400_000;
let t: TestCtx;
let admin: string;

beforeAll(async () => {
  t = await makeTestApp();
  createAdmin(t.db, 'alex', await hashPassword('pw'));
  admin = t.token(['admin']);
});
afterAll(async () => {
  await t.app.close();
});

const near = (value: number, expected: number) => expect(Math.abs(value - expected)).toBeLessThan(60_000);

describe('login tokens', () => {
  it('expire after 30 days by default', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/v1/auth/token', payload: { username: 'alex', password: 'pw', name: 'cli' } });
    expect(res.statusCode).toBe(201);
    near(res.json().expires_at, Date.now() + 30 * DAY);
  });

  it('accept expires_days between 1 and 365 only', async () => {
    const ok = await t.app.inject({ method: 'POST', url: '/api/v1/auth/token', payload: { username: 'alex', password: 'pw', expires_days: 365 } });
    near(ok.json().expires_at, Date.now() + 365 * DAY);
    for (const bad of [0, 366, 1.5]) {
      const res = await t.app.inject({ method: 'POST', url: '/api/v1/auth/token', payload: { username: 'alex', password: 'pw', expires_days: bad } });
      expect(res.statusCode).toBe(400);
    }
  });
});

describe('created tokens', () => {
  const create = (body: Record<string, unknown>) =>
    t.app.inject({ method: 'POST', url: '/api/v1/tokens', headers: auth(admin), payload: { name: 'x', scopes: ['docs:read'], ...body } });

  it('default to 90 days when expires_at is omitted', async () => {
    const res = await create({});
    expect(res.statusCode).toBe(201);
    near(res.json().expires_at, Date.now() + 90 * DAY);
  });

  it('never expire only with an explicit null', async () => {
    const res = await create({ expires_at: null });
    expect(res.json().expires_at).toBeNull();
  });

  it('reject an expiry in the past', async () => {
    const res = await create({ expires_at: Date.now() - 1000 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation');
  });
});

describe('expired tokens', () => {
  it('get 401 token_expired, are audited, and do not trip the failure limiter', async () => {
    const { token } = createToken(t.db, { name: 'old', scopes: ['projects:read'], projectIds: null, expiresAt: Date.now() - 1 });
    for (let i = 0; i < 25; i++) {
      const res = await t.app.inject({ method: 'GET', url: '/api/v1/projects', headers: auth(token) });
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe('token_expired');
    }
    const valid = await t.app.inject({ method: 'GET', url: '/api/v1/projects', headers: auth(t.token(['projects:read'])) });
    expect(valid.statusCode).toBe(200);
    expect(listAudit(t.db, { action: 'auth.token_expired', limit: 5 }).length).toBeGreaterThan(0);
  });

  it('keeps unknown tokens generic', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/projects', headers: auth('pidb_nope_nope') });
    expect(res.json().error).toBe('unauthorized');
  });
});
```

Add these UI tests to `packages/server/test/ui.tokens.test.ts`. Reuse that file's existing session/`csrf` helpers and its existing "creates a token" test style.

1. Replace the existing "empty days → `expires_at` null" test (around line 53) with **"empty days → about 90 days"**: assert `row.expires_at` is within 60 s of `Date.now() + 90 * DAY`.
2. Add **"Never expires checkbox → null"**: POST with `never: 'on'` and empty `days`, then assert `row.expires_at` is `null`.
3. Add **"non-expiring active tokens are flagged"**: after creating one with `never`, GET `/tokens`. The `<main>` segment must contain `never expires` inside `class="pill status-paused"`.

- [ ] **Step 2: Run and see them fail**

Run: `npm run build && npx vitest run packages/server/test/tokens.ttl.test.ts packages/server/test/ui.tokens.test.ts`
Expected: FAIL. `expires_at` is null by default, and the expired token returns `unauthorized`.

- [ ] **Step 3: Shared schemas** (`packages/shared/src/schemas.ts`):

```ts
export const tokenInputSchema = z.strictObject({
  name: z.string().min(1).max(100),
  scopes: z.array(scopeSchema).min(1),
  projects: z.array(slugSchema).nullable().default(null),
  // Omitted → the server applies its default lifetime; an explicit null means "never expires".
  expires_at: z.number().int().positive().nullable().optional(),
});

export const authTokenRequestSchema = z.strictObject({
  username: z.string().min(1).max(100),
  password: z.string().min(1).max(1000),
  name: z.string().min(1).max(100).default('cli'),
  expires_days: z.number().int().min(1).max(365).default(30),
});
```

Update `packages/shared/test/schemas.test.ts` so the parse of `{ name: 'cc', scopes: ['docs:read'] }` expects `expires_at` to be `undefined`, not `null`. Add one case asserting `expires_at: null` parses to `null`.

- [ ] **Step 4: Token lookup** (`packages/server/src/repos/tokens.ts`). Add below the existing imports:

```ts
export const DAY_MS = 86_400_000;

export type TokenLookup = { state: 'active'; row: TokenRow } | { state: 'expired'; row: TokenRow } | { state: 'none' };

/** A revoked token reads as unknown ('none'); an expired one is reported so clients can say "log in again". */
export function lookupTokenByValue(db: Db, token: string, nowTs: number = now()): TokenLookup {
  const prefix = parseTokenPrefix(token);
  if (!prefix) return { state: 'none' };
  const hash = hashToken(token);
  const candidates = db.prepare(`SELECT ${COLS} FROM api_tokens WHERE prefix = ?`).all(prefix) as RawToken[];
  for (const c of candidates) {
    if (!hashesEqual(c.token_hash, hash)) continue;
    if (c.revoked_at !== null) return { state: 'none' };
    if (c.expires_at !== null && c.expires_at <= nowTs) return { state: 'expired', row: toRow(c) };
    return { state: 'active', row: toRow(c) };
  }
  return { state: 'none' };
}

export function findActiveTokenByValue(db: Db, token: string, nowTs: number = now()): TokenRow | null {
  const r = lookupTokenByValue(db, token, nowTs);
  return r.state === 'active' ? r.row : null;
}
```

Delete the old body of `findActiveTokenByValue`; the wrapper above replaces it.

- [ ] **Step 5: Bearer hook** (`packages/server/src/http/auth.ts`). Replace the block from `const row = findActiveTokenByValue(ctx.db, token);` to the end of the hook with:

```ts
    const found = lookupTokenByValue(ctx.db, token);
    if (found.state === 'expired') {
      // Only a holder of the token value can see this distinction; it does not feed the failure limiter.
      writeAudit(ctx.db, {
        actor_type: 'token',
        actor_id: found.row.id,
        action: 'auth.token_expired',
        ip,
        user_agent: req.headers['user-agent'] ?? '',
        meta: { prefix: found.row.prefix },
      });
      throw new AppError(401, 'token_expired', 'token expired');
    }
    if (found.state === 'none') {
      limiter.record(ip);
      writeAudit(ctx.db, {
        actor_type: 'token',
        actor_id: null,
        action: 'auth.token_failed',
        ip,
        user_agent: req.headers['user-agent'] ?? '',
        meta: { prefix: parseTokenPrefix(token) },
      });
      throw new UnauthorizedError();
    }
    const row = found.row;
    touchToken(ctx.db, row.id);
    req.principal = { kind: 'token', id: row.id, scopes: row.scopes, projectIds: row.project_ids };
```

Change the import to `import { lookupTokenByValue, touchToken } from '../repos/tokens.js';`.

- [ ] **Step 6: Service defaults** (`packages/server/src/services/admin.ts`):
  1. Import `DAY_MS` from `../repos/tokens.js`.
  2. Add `export const DEFAULT_TOKEN_DAYS = 90;`.
  3. In `createTokenFor`, before `createToken(...)`:

```ts
  const nowTs = Date.now();
  const expiresAt = input.expires_at === undefined ? nowTs + DEFAULT_TOKEN_DAYS * DAY_MS : input.expires_at;
  if (expiresAt !== null && expiresAt <= nowTs) {
    throw new ValidationError([{ path: ['expires_at'], message: 'must be in the future' }]);
  }
```

  Then pass `expiresAt` to `createToken`.
  4. In `exchangePassword`, change the return type to `Promise<{ token: string; id: number; name: string; expires_at: number } | null>`, mint with `expiresAt: Date.now() + input.expires_days * DAY_MS`, and return `{ token, id: row.id, name: row.name, expires_at: row.expires_at as number }`.

- [ ] **Step 7: UI token form** (`packages/server/src/ui/routes/admin.ts`, `POST /tokens`). Replace the expiry computation with the following. Keep the existing error-page rendering helper `tokensPage`.

```ts
    const never = bool(b, 'never');
    let expiresAt: number | null | undefined;
    if (never) {
      expiresAt = null;
    } else if (days) {
      const n = Number(days);
      if (!Number.isInteger(n) || n <= 0) {
        return reply.status(400).type('text/html').send(tokensPage(req, { error: 'Expiry must be a whole number of days greater than zero.' }));
      }
      expiresAt = Date.now() + n * DAY_MS;
    } else {
      expiresAt = undefined; // service default (90 days)
    }
```

  - Build the `tokenInputSchema.safeParse` input with `...(expiresAt === undefined ? {} : { expires_at: expiresAt })`.
  - Import `bool` from `../forms.js`, and `DAY_MS` from `../../repos/tokens.js`; remove the local `DAY_MS` constant.
  - Update the comment above the expiry block to describe the new three cases.

- [ ] **Step 8: UI token template** (`packages/server/src/ui/views/tokens.eta`):
  1. In the create dialog, the days input gets `value="90"` and the label `Expires in (days)`.
  2. Directly after it, add:
     ```html
     <label class="check"><input type="checkbox" name="never" /> Never expires</label>
     ```
     If `.check` does not exist in `app.css`, add `label.check { display: flex; gap: 8px; align-items: center; font-weight: 400; }`.
  3. In the table's Expires cell:
     - `t.expires_at === null && t.revoked_at === null` → render `<span class="pill status-paused">never expires</span>`;
     - otherwise keep the current rendering.

- [ ] **Step 9: Run tests**

Run: `npm run build && npx vitest run packages/server/test/tokens.ttl.test.ts packages/server/test/ui.tokens.test.ts packages/server/test/repos.auth.test.ts packages/shared/test/schemas.test.ts`
Expected: PASS. Then run the full suite: `npx vitest run`, all green.

- [ ] **Step 10: Commit**

```bash
git add packages/shared packages/server
git commit -m "feat(auth): expire tokens by default and report expired tokens

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## Task 2: Token lifetimes in the CLI

**Files:**
- Modify: `packages/cli/src/commands/login.ts`
- Modify: `packages/cli/src/commands/tokens.ts`
- Modify: `packages/cli/src/cli.ts` (the `login` and `token create` registrations)
- Modify: `packages/cli/src/client.ts` (`describeError`)
- Tests: `packages/cli/test/login.test.ts`, `packages/cli/test/tokens.test.ts`, `packages/cli/test/errors.test.ts` or `client.test.ts` (whichever already tests `describeError`/`ApiError`)

**Interfaces:**
- **Consumes** (Task 1):
  - `POST /api/v1/auth/token` accepts `expires_days` and returns `expires_at`;
  - `POST /api/v1/tokens` treats an omitted `expires_at` as 90 days and `null` as never;
  - 401 `{ error: 'token_expired' }`.
- **Produces:**
  - `LoginOptions` gains `expires?: string` (days, as typed);
  - `TokenCreateOptions` gains `expiry?: boolean`, which commander sets to `false` for `--no-expiry`;
  - `parseExpires` returns `number | undefined`.

- [ ] **Step 1: Failing tests.**
  - **`login.test.ts`:**
    - `runLogin(s.url, { expires: '7' }, env(), io(...))` → the newest `api_tokens` row's `expires_at` is within 60 s of `Date.now() + 7 * 86_400_000`, and `result.text` contains `expires`.
    - `{ expires: '0' }` and `{ expires: '400' }` reject with a `CliError` whose message contains `--expires`, and no request is made. Assert the token count in `s.db` is unchanged.
    - With no `expires`, `expires_at` is about 30 days.
  - **`tokens.test.ts`:**
    1. `parseExpires(undefined, now)` is `undefined`. This replaces the old `toBeNull` expectation.
    2. `runTokenCreate(client, { name, scopes: 'docs:read' })` → the created `expires_at` is about 90 days.
    3. `runTokenCreate(client, { name, scopes: 'docs:read', expiry: false })` → `expires_at` is `null`.
    4. `{ expires: '90d', expiry: false }` → `CliError` mentioning `--no-expiry`.
  - **Errors:** `new ApiError(401, { error: 'token_expired', message: 'token expired' })` has a message containing ``token expired — run `pidb login <url>` again`` and `exitCode` 3.
- [ ] **Step 2: Run to see failures.** `npm run build && npx vitest run packages/cli/test/login.test.ts packages/cli/test/tokens.test.ts packages/cli/test/errors.test.ts packages/cli/test/client.test.ts`
- [ ] **Step 3: Implement.**

`tokens.ts`:

```ts
export interface TokenCreateOptions {
  name: string;
  scopes: string;
  projects?: string;
  expires?: string;
  /** commander sets this to false for --no-expiry */
  expiry?: boolean;
}

export function parseExpires(raw: string | undefined, now: number = Date.now()): number | undefined {
  if (raw === undefined) return undefined;
  const m = /^(\d+)([dhm])$/.exec(raw.trim());
  const unit = m ? UNITS[m[2] as string] : undefined;
  if (!m || unit === undefined) throw new CliError(`invalid --expires "${raw}" — use 90d, 12h or 30m`);
  return now + Number.parseInt(m[1] as string, 10) * unit;
}
```

In `runTokenCreate`:

```ts
  if (opts.expiry === false && opts.expires !== undefined) {
    throw new CliError('use either --expires or --no-expiry, not both');
  }
  const expires_at = opts.expiry === false ? null : parseExpires(opts.expires);
  const body: Record<string, unknown> = { name: opts.name, scopes, projects };
  if (expires_at !== undefined) body.expires_at = expires_at; // omitted → server default (90 days)
  const created = await client.json<PublicToken & { token: string }>('POST', '/api/v1/tokens', { body });
```

`login.ts`:
- Add `expires?: string` to `LoginOptions`.
- Before any prompt:

```ts
  let expires_days = 30;
  if (opts.expires !== undefined) {
    if (!/^\d+$/.test(opts.expires.trim())) throw new CliError(`invalid --expires "${opts.expires}" — a number of days from 1 to 365`);
    expires_days = Number.parseInt(opts.expires.trim(), 10);
    if (expires_days < 1 || expires_days > 365) throw new CliError(`invalid --expires "${opts.expires}" — a number of days from 1 to 365`);
  }
```

- Send `expires_days` in the body. `AuthTokenResponse` gains `expires_at: number`.
- Append `, expires ${new Date(res.expires_at).toISOString().slice(0, 10)}` to `text`, and add `expires_at` to `json`.

`cli.ts`:
- `login` gains `.option('--expires <days>', 'token lifetime in days, 1-365 (default: 30)')`, passed through in `opts`.
- `token create` gains `.option('--no-expiry', 'create a token that never expires')`. The action's `opts` type adds `expiry?: boolean`.

`client.ts` `describeError`, first line of the function:

```ts
  if (status === 401 && body.error === 'token_expired') return 'token expired — run `pidb login <url>` again';
```

- [ ] **Step 4: Run tests** (same command). PASS, then run the full suite.
- [ ] **Step 5: Commit** `feat(cli): login token lifetime, --no-expiry and an expired-token hint`, with the trailer.

## Task 3: Strict CSP — move inline code to `/assets/app.js`

**Files:**
- Create: `packages/server/src/ui/public/app.js`
- Modify: `packages/server/src/ui/index.ts` (CSP array)
- Modify: `packages/server/src/ui/public/app.css` (`.sprite`, plus any class that replaces a `style=`)
- Modify views:
  - `layout.eta`, `projects.eta`, `project.eta`, `secret.eta`, `document.eta`, `tokens.eta`, `secret-edit.eta`;
  - `partials/revealed.eta`, `partials/masked-row.eta` (if it contains handlers);
  - any other view the grep in Step 3 finds.
- Create test: `packages/server/test/ui.csp.test.ts`
- Modify tests:
  - `packages/server/test/ui.hardening.test.ts`
  - `ui.secrets.test.ts`: `function hideField(`, `onclick="hideField(this)"`
  - `ui.secret-edit.test.ts`: `moveRow(this, ±1)` and the hint-keys `<` escape test
  - `ui.secret-access.test.ts`: the (g)/(h) source-text assertions
  - `ui.document-edit.test.ts` / `ui.documents.test.ts`: add the Markdown regression tests

**Interfaces:**
- **Produces the markup contract.** Tasks 5 and 6 use it for every new view:
  - `data-open-dialog="<dialog id>"` opens a dialog;
  - `data-close-dialog` on a button inside a `<dialog>` closes it;
  - `data-open-on-load` on a `<dialog>` opens it once the page loads;
  - `data-action="copy-field" | "hide-field" | "copy-new-token" | "toggle-lock" | "move-up" | "move-down" | "remove-row" | "add-row"` (the last with `data-key="<key>"`);
  - `data-copy-target="<element id>"` with `data-action="copy-text"` copies that element's text (used by Task 6 for the TOTP secret and recovery codes);
  - `.timer[data-seconds]` is the reveal auto-hide countdown;
  - `#rows[data-hint-keys]` carries a JSON array of non-sensitive keys.
- **Produces** the CSP string in Global Constraints.

- [ ] **Step 1: Failing tests.** Create `packages/server/test/ui.csp.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeTestApp, type TestCtx } from './helpers.js';
import { createAdmin } from '../src/repos/admin.js';
import { hashPassword } from '../src/crypto/passwords.js';
import { createSecret } from '../src/repos/secrets.js';
import { upsertDocument } from '../src/repos/documents.js';
import { getProjectBySlug } from '../src/repos/projects.js';

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

let t: TestCtx;
let session: string;
let csrf: string;
const cookies = () => ({ pidb_session: session });
const get = (url: string) => t.app.inject({ method: 'GET', url, cookies: cookies() });
const post = (url: string, payload: Record<string, unknown>) => t.app.inject({ method: 'POST', url, cookies: cookies(), payload });

export function assertNoInlineCode(html: string, label: string): void {
  expect(html, `${label}: inline <script>`).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
  expect(html, `${label}: on* handler`).not.toMatch(/\son[a-z]+\s*=/i);
  expect(html, `${label}: style attribute`).not.toMatch(/\sstyle\s*=/i);
  expect(html, `${label}: <style> element`).not.toMatch(/<style[\s>]/i);
}

beforeAll(async () => {
  t = await makeTestApp();
  createAdmin(t.db, 'alex', await hashPassword('pw'));
  session = (await t.app.inject({ method: 'POST', url: '/login', payload: { username: 'alex', password: 'pw' } }))
    .cookies.find((c) => c.name === 'pidb_session')!.value;
  t.project('acme');
  const acme = getProjectBySlug(t.db, 'acme')!.id;
  createSecret(t.db, t.ring, { projectId: acme, name: 'DB', description: '', tags: [], fields: [{ key: 'host', value: 'db' }, { key: 'password', value: 'hunter2hunter2' }] });
  upsertDocument(t.db, { projectId: acme, slug: 'deploy', title: 'Deploy', category: 'deploy', body_md: '# Deploy\n\nRun the steps.' });
  // Hostile Markdown lives in its own doc: its escaped source would otherwise appear in the editor's
  // textarea and in search snippets, where text like " onerror=" is harmless but trips the regexes.
  upsertDocument(t.db, {
    projectId: acme,
    slug: 'evil',
    title: 'Evil',
    category: 'notes',
    body_md: '# Evil\n\n<script>alert(1)</script><img src=x onerror=alert(1)><a href="javascript:alert(1)">x</a><p style="color:red">s</p>',
  });
  csrf = /name="csrf" value="([^"]+)"/.exec((await get('/')).body)![1]!;
});
afterAll(async () => {
  await t.app.close();
});

describe('strict CSP', () => {
  it('sends the exact policy', async () => {
    const res = await get('/');
    expect(res.headers['content-security-policy']).toBe(CSP);
  });

  it('serves app.js with the delegated handlers', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/assets/app.js' });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['content-type'])).toMatch(/javascript/);
    for (const name of ['data-open-dialog', 'data-close-dialog', 'data-open-on-load', 'copy-field', 'hide-field', 'copy-new-token', 'toggle-lock', 'move-up', 'move-down', 'remove-row', 'add-row', 'copy-text', 'htmx.process', 'htmx:afterSwap']) {
      expect(res.body).toContain(name);
    }
  });

  it('renders no inline code on any page', async () => {
    const pages = ['/', '/p/acme', '/p/acme?tab=secrets', '/p/acme/secrets/DB', '/p/acme/secrets/DB/edit', '/p/acme/secrets/new',
      '/p/acme/docs/deploy', '/p/acme/docs/deploy/edit', '/p/acme/docs/new/edit', '/global/docs', '/global/secrets', '/tokens', '/audit', '/search?q=deploy', '/no-such-page'];
    for (const url of pages) assertNoInlineCode((await get(url)).body, url);
    assertNoInlineCode((await t.app.inject({ method: 'GET', url: '/login' })).body, '/login');
    // Validation-error renders that auto-open a dialog
    assertNoInlineCode((await post('/projects', { csrf, slug: 'Bad Slug', name: '' })).body, 'projects error');
    assertNoInlineCode((await post('/tokens', { csrf, name: '' })).body, 'tokens error');
    // One-time token panel
    assertNoInlineCode((await post('/tokens', { csrf, name: 'ci', scopes: 'docs:read' })).body, 'token created');
    // htmx partials
    assertNoInlineCode((await post('/p/acme/secrets/DB/reveal', { csrf, key: 'password' })).body, 'reveal partial');
    assertNoInlineCode((await post('/preview', { csrf, body_md: '<p style="x" onclick="y">z</p>', scope: '/p/acme' })).body, 'preview');
  });

  it('strips script, handlers, styles and javascript: links from rendered Markdown', async () => {
    const main = (await get('/p/acme/docs/evil')).body.split('<main')[1]!.split('</main>')[0]!;
    expect(main).not.toContain('alert(1)</script>');
    expect(main).not.toMatch(/onerror/i);
    expect(main).not.toMatch(/javascript:/i);
    expect(main).not.toMatch(/style=/i);
  });
});
```

In `ui.hardening.test.ts`, add `expect(csp).not.toContain('unsafe-inline');` to the first test.

- [ ] **Step 2: Run to see failures.** `npm run build && npx vitest run packages/server/test/ui.csp.test.ts packages/server/test/ui.hardening.test.ts`. They fail: the header still has `unsafe-inline`, `app.js` returns 404, and inline code is found.

- [ ] **Step 3: Create `packages/server/src/ui/public/app.js`** with exactly this behaviour. It is a port of today's inline scripts in `secret.eta`, `secret-edit.eta`, `tokens.eta` and `projects.eta`; read them before deleting them.

```js
// pidb admin UI behaviour. Loaded with `defer` after htmx; every handler is delegated from
// `document`, so markup swapped in by htmx (reveal partial, preview) needs no re-binding.
// The CSP forbids inline scripts, handlers and style attributes: all behaviour lives here.
(function () {
  'use strict';

  var timers = new WeakMap();

  function flashCopied(btn) {
    var original = btn.textContent;
    btn.textContent = 'Copied';
    setTimeout(function () { btn.textContent = original; }, 1500);
  }

  function copyText(text, btn) {
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText(text).then(function () { flashCopied(btn); });
  }

  function stopTimer(row) {
    var timerEl = row.querySelector('.timer[data-seconds]');
    if (timerEl && timers.has(timerEl)) {
      clearInterval(timers.get(timerEl));
      timers.delete(timerEl);
    }
  }

  // Re-masks a revealed row. Revealing again is a new audited request. The field key never
  // flows through string-built HTML: the template is found with CSS.escape.
  function hideField(btn) {
    var row = btn.closest('.kv-row');
    if (!row) return;
    stopTimer(row);
    var key = row.getAttribute('data-field-row') || '';
    var tmpl = document.querySelector('template[data-masked-row="' + CSS.escape(key) + '"]');
    if (tmpl && tmpl.content.firstElementChild) {
      var clone = tmpl.content.firstElementChild.cloneNode(true);
      row.replaceWith(clone);
      // A clone from a <template> was never processed by htmx; without this the restored
      // Reveal form would do a full-page POST instead of swapping the row.
      if (window.htmx && typeof window.htmx.process === 'function') window.htmx.process(clone);
    } else {
      row.remove();
    }
  }

  function startTimers(root) {
    root.querySelectorAll('.timer[data-seconds]').forEach(function (el) {
      if (timers.has(el)) return;
      var row = el.closest('.kv-row');
      var seconds = parseInt(el.getAttribute('data-seconds'), 10) || 0;
      var id = setInterval(function () {
        seconds -= 1;
        if (seconds <= 0) {
          clearInterval(id);
          timers.delete(el);
          var hideBtn = row ? row.querySelector('[data-action="hide-field"]') : null;
          if (hideBtn) hideField(hideBtn);
        } else {
          el.textContent = 'hides in ' + seconds + ' s';
        }
      }, 1000);
      timers.set(el, id);
    });
  }

  function lockLabel(btn, locked) {
    btn.innerHTML = '<svg class="i" aria-hidden="true"><use href="#i-lock"/></svg> ' + (locked ? 'Locked' : 'Visible');
  }

  function toggleLock(btn) {
    var card = btn.closest('.field-card');
    if (!card) return;
    var hidden = card.querySelector('input[name="sensitive"]');
    var locked = hidden.value !== '1';
    hidden.value = locked ? '1' : '0';
    btn.setAttribute('aria-pressed', locked ? 'true' : 'false');
    card.classList.toggle('is-locked', locked);
    lockLabel(btn, locked);
  }

  function hintKeys() {
    var rows = document.getElementById('rows');
    try {
      var parsed = JSON.parse((rows && rows.getAttribute('data-hint-keys')) || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }

  function smallButton(action, label, text) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn sm ghost';
    b.title = label;
    b.setAttribute('aria-label', label);
    b.setAttribute('data-action', action);
    b.textContent = text;
    return b;
  }

  // Keys are set via .value, never concatenated into HTML.
  function addRow(key) {
    var rows = document.getElementById('rows');
    if (!rows) return;
    var locked = hintKeys().indexOf(key) === -1;

    var card = document.createElement('div');
    card.className = 'field-card' + (locked ? ' is-locked' : '');

    var keyInput = document.createElement('input');
    keyInput.name = 'key';
    keyInput.value = key;
    keyInput.placeholder = 'password';
    keyInput.setAttribute('aria-label', 'Key');
    card.appendChild(keyInput);

    var valueArea = document.createElement('textarea');
    valueArea.name = 'value';
    valueArea.rows = 1;
    valueArea.spellcheck = false;
    valueArea.setAttribute('aria-label', 'Value');
    card.appendChild(valueArea);

    var controls = document.createElement('div');
    controls.className = 'field-controls';

    var lockBtn = document.createElement('button');
    lockBtn.type = 'button';
    lockBtn.className = 'btn sm lock-toggle';
    lockBtn.setAttribute('aria-pressed', locked ? 'true' : 'false');
    lockBtn.setAttribute('data-action', 'toggle-lock');
    lockLabel(lockBtn, locked);
    controls.appendChild(lockBtn);

    var sensitiveInput = document.createElement('input');
    sensitiveInput.type = 'hidden';
    sensitiveInput.name = 'sensitive';
    sensitiveInput.value = locked ? '1' : '0';
    controls.appendChild(sensitiveInput);

    var rowButtons = document.createElement('div');
    rowButtons.className = 'row-buttons';
    rowButtons.appendChild(smallButton('move-up', 'Move up', '↑'));
    rowButtons.appendChild(smallButton('move-down', 'Move down', '↓'));
    rowButtons.appendChild(smallButton('remove-row', 'Remove', '✕'));
    controls.appendChild(rowButtons);

    card.appendChild(controls);
    rows.appendChild(card);
  }

  // Rows are submitted positionally, so moving the .field-card is all a reorder needs.
  function moveRow(btn, dir) {
    var card = btn.closest('.field-card');
    if (!card) return;
    var sibling = dir < 0 ? card.previousElementSibling : card.nextElementSibling;
    if (!sibling) return;
    if (dir < 0) card.parentNode.insertBefore(card, sibling);
    else card.parentNode.insertBefore(sibling, card);
    btn.focus();
  }

  var actions = {
    'copy-field': function (btn) {
      var row = btn.closest('.kv-row');
      var valueEl = row ? row.querySelector('.field-value') : null;
      if (valueEl) copyText(valueEl.textContent, btn);
    },
    'hide-field': hideField,
    'copy-new-token': function (btn) {
      var el = document.getElementById('new-token-value');
      if (el) copyText(el.textContent, btn);
    },
    'copy-text': function (btn) {
      var el = document.getElementById(btn.getAttribute('data-copy-target') || '');
      if (el) copyText(el.textContent, btn);
    },
    'toggle-lock': toggleLock,
    'move-up': function (btn) { moveRow(btn, -1); },
    'move-down': function (btn) { moveRow(btn, 1); },
    'remove-row': function (btn) {
      var card = btn.closest('.field-card');
      if (card) card.remove();
    },
    'add-row': function (btn) { addRow(btn.getAttribute('data-key') || ''); }
  };

  document.addEventListener('click', function (e) {
    var target = e.target instanceof Element ? e.target : null;
    if (!target) return;
    var opener = target.closest('[data-open-dialog]');
    if (opener) {
      var dlg = document.getElementById(opener.getAttribute('data-open-dialog') || '');
      if (dlg && !dlg.open) dlg.showModal();
      return;
    }
    var closer = target.closest('[data-close-dialog]');
    if (closer) {
      var parent = closer.closest('dialog');
      if (parent) parent.close();
      return;
    }
    var el = target.closest('[data-action]');
    if (!el) return;
    var fn = actions[el.getAttribute('data-action') || ''];
    if (fn) fn(el);
  });

  document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('dialog[data-open-on-load]').forEach(function (d) {
      if (!d.open) d.showModal();
    });
    startTimers(document);
  });

  document.addEventListener('htmx:afterSwap', function () { startTimers(document); });
})();
```

- [ ] **Step 4: Convert every view.** First run `grep -rnE "<script|on[a-z]+=|style=\"" packages/server/src/ui/views` and convert every hit with this mapping:

| today | becomes |
|---|---|
| `onclick="document.getElementById('X').showModal()"` | `data-open-dialog="X"` |
| `onclick="this.closest('dialog').close()"` | `data-close-dialog` |
| inline `<script>` auto-opening `new-project` (projects.eta) / `new-token` (tokens.eta) | delete the script; the `<dialog>` gets `<%~ it.error ? ' data-open-on-load' : '' %>` inside its opening tag |
| `onclick="copyField(this)"` (secret.eta, partials/revealed.eta) | `data-action="copy-field"` |
| `data-hide onclick="hideField(this)"` (partials/revealed.eta) | `data-action="hide-field"` |
| `onclick="copyNewToken(this)"` (tokens.eta) + its `<script>` | `data-action="copy-new-token"`; delete the script |
| secret-edit `onclick="toggleLock(this)"` | `data-action="toggle-lock"` |
| `onclick="moveRow(this, -1)"` / `(this, 1)` | `data-action="move-up"` / `data-action="move-down"` |
| `onclick="this.closest('.field-card').remove()"` | `data-action="remove-row"` |
| `onclick="addRow('')"` / `onclick="addRow('<%= k %>')"` | `data-action="add-row" data-key=""` / `data-action="add-row" data-key="<%= k %>"` |
| secret-edit `<script>` block (hintKeys, toggleLock, addRow, moveRow) | delete it; `#rows` gets `data-hint-keys="<%= JSON.stringify(it.hintKeys) %>"` (Eta's `<%=` HTML-escapes the quotes) |
| secret.eta `<script>` block (timers, hideField, copyField) | delete it |
| `layout.eta` `<svg width="0" height="0" style="position: absolute" aria-hidden="true">` | `<svg class="sprite" width="0" height="0" aria-hidden="true">`, plus CSS `.sprite { position: absolute; width: 0; height: 0; overflow: hidden; }` |

In `layout.eta` `<head>`, after the htmx script:

```html
    <meta name="htmx-config" content='{"includeIndicatorStyles":false,"allowEval":false,"allowScriptTags":false}' />
    <script src="/assets/app.js" defer></script>
```

The `htmx-config` meta must come **before** `htmx.min.js` executes. Both scripts are `defer`, so placing the meta anywhere in `<head>` works. Put it directly above the htmx `<script>` tag.

In `packages/server/src/ui/index.ts`, set the `CSP` array to:

```ts
  const CSP = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "object-src 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join('; ');
```

Update the comment above it to say inline scripts, handlers and styles are forbidden and that behaviour lives in `/assets/app.js`.

- [ ] **Step 5: Rewrite the coupled tests.** Each keeps its intent:
  - `ui.secrets.test.ts`:
    - `function hideField(` → the secret page contains `src="/assets/app.js"`;
    - `onclick="hideField(this)"` → the reveal partial contains `data-action="hide-field"`;
    - keep `>Hide</button>`.
  - `ui.secret-edit.test.ts`:
    - `moveRow(this, -1)` / `moveRow(this, 1)` → `data-action="move-up"` / `data-action="move-down"`;
    - the hint-keys escape test → render with `hintKeys: ['a</script>b']` and assert the output contains `data-hint-keys="[&quot;a&lt;/script&gt;b&quot;]"` and not `a</script>b`.
  - `ui.secret-access.test.ts` (g)/(h): assert that `/assets/app.js` contains `htmx.process(clone)` and `querySelector('.field-value')` instead of looking in the page source.
- [ ] **Step 6: Run.** `npm run build && npx vitest run packages/server/test/ui.csp.test.ts packages/server/test/ui.hardening.test.ts packages/server/test/ui.secrets.test.ts packages/server/test/ui.secret-edit.test.ts packages/server/test/ui.secret-access.test.ts`, then the full suite. All PASS.
- [ ] **Step 7: Manual behaviour check** (evidence only; no screenshots in the repo).
  1. Start the server on a free port with a throwaway data dir and key (see README Quick start). Before starting, check the port is free with `lsof -iTCP:<port> -sTCP:LISTEN`, and use `PIDB_PORT` to pick a free one.
  2. Load `/p/<slug>/secrets/<name>` with `curl` and confirm the page references `/assets/app.js` and the policy header is present.
  3. Stop only the server you started.
- [ ] **Step 8: Commit** `feat(ui): enforce a CSP without unsafe-inline by moving behaviour to app.js`, with the trailer.

## Task 4: TOTP core — algorithm, storage, key rotation, shell reset

**Files:**
- Create: `packages/server/src/auth/totp.ts`
- Create: `packages/server/src/repos/twofactor.ts`
- Modify: `packages/server/src/db/migrations.ts` (append migration 2)
- Modify: `packages/server/src/repos/admin.ts` (add `getAdminById`)
- Modify: `packages/server/src/ops.ts` (`runRotateKey`, new `runTotpReset`)
- Modify: `packages/server/src/cli.ts` (`rotate-key` output, new `2fa reset`)
- Modify: `packages/server/src/index.ts` (export `runTotpReset`)
- Test: `packages/server/test/totp.test.ts` (create)
- Test: `packages/server/test/repos.twofactor.test.ts` (create)
- Test: `packages/server/test/ops.test.ts` (update)

**Interfaces:**
- **Produces** from `src/auth/totp.ts`:
  ```ts
  export const TOTP_PERIOD_S = 30;
  export function base32Encode(buf: Buffer): string
  export function base32Decode(s: string): Buffer
  export function generateTotpSecret(): Buffer                 // 20 random bytes
  export function hotp(secret: Buffer, counter: number): string // 6 digits
  export function stepAt(ms: number): number
  export function verifyTotp(secret: Buffer, code: string, lastUsedStep: number, nowMs?: number): number | null // accepted step
  export function otpauthUri(username: string, secret: Buffer): string
  export function generateRecoveryCode(): string               // 'xxxxx-xxxxx'
  export function normalizeRecoveryCode(input: string): string | null
  ```
- **Produces** from `src/repos/twofactor.ts`:
  ```ts
  export interface TotpRow { admin_id: number; secret_enc: Buffer; key_version: number; enabled_at: number | null; last_used_step: number; created_at: number }
  export function getTotp(db: Db, adminId: number): TotpRow | null
  export function sealTotpSecret(ring: KeyRing, adminId: number, secret: Buffer): { enc: Buffer; version: number }
  export function openTotpSecret(ring: KeyRing, row: TotpRow): Buffer
  export function savePendingTotp(db: Db, ring: KeyRing, adminId: number, secret: Buffer): void
  export function enableTotp(db: Db, adminId: number, step: number, ts?: number): void
  export function claimTotpStep(db: Db, adminId: number, step: number): boolean // atomic: true only if step > last_used_step
  export function deleteTwoFactor(db: Db, adminId: number): void               // admin_totp + recovery_codes + login_challenges
  export function replaceRecoveryCodes(db: Db, adminId: number, hashes: string[]): void
  export function listUnusedRecoveryCodes(db: Db, adminId: number): { id: number; code_hash: string }[]
  export function markRecoveryCodeUsed(db: Db, id: number, ts?: number): boolean
  export interface ChallengeRow { id: string; admin_id: number; expires_at: number; attempts: number }
  export function createChallenge(db: Db, adminId: number, ttlMs: number, ip: string, ua: string): string
  export function getChallenge(db: Db, id: string, nowTs?: number): ChallengeRow | null // null when missing or expired
  export function bumpChallengeAttempts(db: Db, id: string): number                    // returns the new count
  export function deleteChallenge(db: Db, id: string): void
  export function purgeExpiredChallenges(db: Db, nowTs?: number): number
  export function rewrapTotpSecrets(db: Db, ring: KeyRing): number
  ```
- **Produces** from `src/repos/admin.ts`: `export function getAdminById(db: Db, id: number): AdminRow | null`.
- **Produces** from `src/ops.ts`:
  - `runRotateKey(db, ring): { secrets: number; totp: number }` (the return type changes);
  - `runTotpReset(db): string`, which returns the username and throws `Error('no admin user — run init first')` when there is no admin.

- [ ] **Step 1: Failing unit tests** in `packages/server/test/totp.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  base32Decode, base32Encode, generateRecoveryCode, generateTotpSecret, hotp, normalizeRecoveryCode,
  otpauthUri, stepAt, verifyTotp,
} from '../src/auth/totp.js';

const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');

describe('totp', () => {
  it('matches the RFC 6238 SHA-1 vectors truncated to 6 digits', () => {
    const vectors: [number, string][] = [
      [59, '287082'], [1111111109, '081804'], [1111111111, '050471'],
      [1234567890, '005924'], [2000000000, '279037'], [20000000000, '353130'],
    ];
    for (const [seconds, code] of vectors) expect(hotp(RFC_SECRET, stepAt(seconds * 1000))).toBe(code);
  });

  it('round-trips base32 without padding', () => {
    const secret = generateTotpSecret();
    expect(secret.length).toBe(20);
    const b32 = base32Encode(secret);
    expect(b32).toMatch(/^[A-Z2-7]+$/);
    expect(base32Decode(b32).equals(secret)).toBe(true);
    expect(base32Decode(b32.toLowerCase().replace(/(.{4})/g, '$1 ')).equals(secret)).toBe(true);
  });

  it('accepts the previous, current and next step and rejects further ones', () => {
    const now = 1_700_000_000_000;
    const s = stepAt(now);
    for (const d of [-1, 0, 1]) expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, s + d), 0, now)).toBe(s + d);
    for (const d of [-2, 2]) expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, s + d), 0, now)).toBeNull();
    expect(verifyTotp(RFC_SECRET, '12345', 0, now)).toBeNull();
    expect(verifyTotp(RFC_SECRET, 'abcdef', 0, now)).toBeNull();
  });

  it('rejects a step at or below last_used_step (replay)', () => {
    const now = 1_700_000_000_000;
    const s = stepAt(now);
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, s), s, now)).toBeNull();
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, s), s - 1, now)).toBe(s);
  });

  it('builds an otpauth URI', () => {
    expect(otpauthUri('alex', RFC_SECRET)).toBe(
      `otpauth://totp/pidb:alex?secret=${base32Encode(RFC_SECRET)}&issuer=pidb&algorithm=SHA1&digits=6&period=30`,
    );
  });
});

describe('recovery codes', () => {
  it('generates xxxxx-xxxxx from the unambiguous alphabet', () => {
    for (let i = 0; i < 50; i++) expect(generateRecoveryCode()).toMatch(/^[a-hjkmnp-z2-9]{5}-[a-hjkmnp-z2-9]{5}$/);
  });

  it('normalizes case, spaces and a missing dash', () => {
    expect(normalizeRecoveryCode('ABCDE-FGHJK')).toBe('abcde-fghjk');
    expect(normalizeRecoveryCode(' abcde fghjk ')).toBe('abcde-fghjk');
    expect(normalizeRecoveryCode('abcdefghjk')).toBe('abcde-fghjk');
    expect(normalizeRecoveryCode('abcde-fghj1')).toBeNull(); // '1' is not in the alphabet
    expect(normalizeRecoveryCode('123456')).toBeNull();
  });
});
```

`packages/server/test/repos.twofactor.test.ts`. Use `openDb(':memory:')` and a `KeyRing` with `randomBytes(32)`, as `test/helpers.ts` does, and create an admin via `createAdmin`. Cover:
1. `savePendingTotp` then `getTotp` → `enabled_at` is null, and `openTotpSecret` returns the same bytes.
2. `enableTotp` sets `enabled_at`/`last_used_step`.
3. `claimTotpStep(db, id, s)` → true once, false for the same `s` and for `s - 1`, true for `s + 1`.
4. `replaceRecoveryCodes` with 2 hashes → `listUnusedRecoveryCodes` length 2 → `markRecoveryCodeUsed` → true, then false for the same id → length 1.
5. Challenges:
   - `createChallenge` with ttl 1000;
   - `getChallenge` at `now` → row; at `now + 2000` → null;
   - `bumpChallengeAttempts` returns 1, then 2;
   - `purgeExpiredChallenges(db, now + 2000)` → 1.
6. `rewrapTotpSecrets`: seal under ring v1 = `{current:1, keys:{1:k1}}`, rewrap with ring v2 = `{current:2, keys:{1:k1, 2:k2}}` → returns 1. `getTotp().key_version` is 2, and `openTotpSecret(ringWithOnlyK2, row)` returns the original secret. A second rewrap returns 0.
7. `deleteTwoFactor` removes the totp, recovery and challenge rows for that admin.

`ops.test.ts`:
- Change `expect(runRotateKey(db, ring2)).toBe(1)` to `expect(runRotateKey(db, ring2)).toEqual({ secrets: 1, totp: 0 })`.
- Add a `runTotpReset` test: with an admin and a pending TOTP row, it returns the username, leaves no `admin_totp` row, and writes an audit row with action `auth.totp_reset` and `meta.via === 'shell'`. On an empty DB it throws `/no admin user/`.

- [ ] **Step 2: Run to see failures.** `npm run build && npx vitest run packages/server/test/totp.test.ts packages/server/test/repos.twofactor.test.ts packages/server/test/ops.test.ts`

- [ ] **Step 3: Implement `src/auth/totp.ts`:**

```ts
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const TOTP_PERIOD_S = 30;
const DIGITS = 6;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[\s=]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('invalid base32');
    value = ((value << 5) | idx) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(): Buffer {
  return randomBytes(20);
}

export function hotp(secret: Buffer, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', secret).update(msg).digest();
  const off = h[h.length - 1]! & 0x0f;
  const bin = ((h[off]! & 0x7f) << 24) | (h[off + 1]! << 16) | (h[off + 2]! << 8) | h[off + 3]!;
  return String(bin % 10 ** DIGITS).padStart(DIGITS, '0');
}

export function stepAt(ms: number): number {
  return Math.floor(ms / 1000 / TOTP_PERIOD_S);
}

/** Returns the accepted step (so the caller can store it as last_used_step) or null. */
export function verifyTotp(secret: Buffer, code: string, lastUsedStep: number, nowMs: number = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const current = stepAt(nowMs);
  for (const step of [current - 1, current, current + 1]) {
    if (step <= lastUsedStep) continue;
    if (timingSafeEqual(Buffer.from(hotp(secret, step)), Buffer.from(code))) return step;
  }
  return null;
}

export function otpauthUri(username: string, secret: Buffer): string {
  const label = `pidb:${encodeURIComponent(username)}`;
  return `otpauth://totp/${label}?secret=${base32Encode(secret)}&issuer=pidb&algorithm=SHA1&digits=${DIGITS}&period=${TOTP_PERIOD_S}`;
}

export function generateRecoveryCode(): string {
  const chars: string[] = [];
  while (chars.length < 10) {
    for (const b of randomBytes(16)) {
      // 248 = 8 * 31: reject the tail so every character is equally likely.
      if (b < 248 && chars.length < 10) chars.push(RECOVERY_ALPHABET[b % 31]!);
    }
  }
  return `${chars.slice(0, 5).join('')}-${chars.slice(5).join('')}`;
}

export function normalizeRecoveryCode(input: string): string | null {
  const s = input.toLowerCase().replace(/[\s-]/g, '');
  if (!/^[a-hjkmnp-z2-9]{10}$/.test(s)) return null;
  return `${s.slice(0, 5)}-${s.slice(5)}`;
}
```

- [ ] **Step 4: Migration 2** (append to `MIGRATIONS` in `src/db/migrations.ts`):

```ts
  {
    id: 2,
    sql: `
CREATE TABLE admin_totp (
  admin_id INTEGER PRIMARY KEY REFERENCES admin(id) ON DELETE CASCADE,
  secret_enc BLOB NOT NULL,
  key_version INTEGER NOT NULL,
  enabled_at INTEGER,
  last_used_step INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE recovery_codes (
  id INTEGER PRIMARY KEY,
  admin_id INTEGER NOT NULL REFERENCES admin(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX recovery_codes_admin ON recovery_codes(admin_id);
CREATE TABLE login_challenges (
  id TEXT PRIMARY KEY,
  admin_id INTEGER NOT NULL REFERENCES admin(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  ip TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT ''
);
`,
  },
```

- [ ] **Step 5: Implement `src/repos/twofactor.ts`:**

```ts
import { randomBytes } from 'node:crypto';
import type { Db } from '../db/connection.js';
import type { KeyRing } from '../config.js';
import { open, seal } from '../crypto/envelope.js';
import { CryptoError } from '../errors.js';
import { now } from './util.js';

export interface TotpRow {
  admin_id: number;
  secret_enc: Buffer;
  key_version: number;
  enabled_at: number | null;
  last_used_step: number;
  created_at: number;
}

const aad = (adminId: number) => `totp:${adminId}`;

function keyFor(ring: KeyRing, version: number): Buffer {
  const key = ring.keys.get(version);
  if (!key) throw new CryptoError(`no master key for version ${version}`);
  return key;
}

export function getTotp(db: Db, adminId: number): TotpRow | null {
  return (db.prepare(`SELECT admin_id, secret_enc, key_version, enabled_at, last_used_step, created_at FROM admin_totp WHERE admin_id = ?`).get(adminId) as TotpRow | undefined) ?? null;
}

export function sealTotpSecret(ring: KeyRing, adminId: number, secret: Buffer): { enc: Buffer; version: number } {
  return { enc: seal(keyFor(ring, ring.current), secret, aad(adminId)), version: ring.current };
}

export function openTotpSecret(ring: KeyRing, row: TotpRow): Buffer {
  return open(keyFor(ring, row.key_version), row.secret_enc, aad(row.admin_id));
}

/** Starts (or restarts) enrollment: the row stays inactive until enableTotp. */
export function savePendingTotp(db: Db, ring: KeyRing, adminId: number, secret: Buffer): void {
  const { enc, version } = sealTotpSecret(ring, adminId, secret);
  db.prepare(
    `INSERT INTO admin_totp (admin_id, secret_enc, key_version, enabled_at, last_used_step, created_at) VALUES (?, ?, ?, NULL, 0, ?)
     ON CONFLICT(admin_id) DO UPDATE SET secret_enc = excluded.secret_enc, key_version = excluded.key_version, enabled_at = NULL, last_used_step = 0, created_at = excluded.created_at`,
  ).run(adminId, enc, version, now());
}

export function enableTotp(db: Db, adminId: number, step: number, ts: number = now()): void {
  db.prepare(`UPDATE admin_totp SET enabled_at = ?, last_used_step = ? WHERE admin_id = ?`).run(ts, step, adminId);
}

export function claimTotpStep(db: Db, adminId: number, step: number): boolean {
  return db.prepare(`UPDATE admin_totp SET last_used_step = ? WHERE admin_id = ? AND last_used_step < ?`).run(step, adminId, step).changes > 0;
}

export function deleteTwoFactor(db: Db, adminId: number): void {
  db.transaction(() => {
    db.prepare(`DELETE FROM admin_totp WHERE admin_id = ?`).run(adminId);
    db.prepare(`DELETE FROM recovery_codes WHERE admin_id = ?`).run(adminId);
    db.prepare(`DELETE FROM login_challenges WHERE admin_id = ?`).run(adminId);
  })();
}

export function replaceRecoveryCodes(db: Db, adminId: number, hashes: string[]): void {
  const ins = db.prepare(`INSERT INTO recovery_codes (admin_id, code_hash, used_at, created_at) VALUES (?, ?, NULL, ?)`);
  db.transaction(() => {
    db.prepare(`DELETE FROM recovery_codes WHERE admin_id = ?`).run(adminId);
    const ts = now();
    for (const h of hashes) ins.run(adminId, h, ts);
  })();
}

export function listUnusedRecoveryCodes(db: Db, adminId: number): { id: number; code_hash: string }[] {
  return db.prepare(`SELECT id, code_hash FROM recovery_codes WHERE admin_id = ? AND used_at IS NULL ORDER BY id`).all(adminId) as { id: number; code_hash: string }[];
}

export function markRecoveryCodeUsed(db: Db, id: number, ts: number = now()): boolean {
  return db.prepare(`UPDATE recovery_codes SET used_at = ? WHERE id = ? AND used_at IS NULL`).run(ts, id).changes > 0;
}

export interface ChallengeRow {
  id: string;
  admin_id: number;
  expires_at: number;
  attempts: number;
}

export function createChallenge(db: Db, adminId: number, ttlMs: number, ip: string, ua: string): string {
  const id = randomBytes(32).toString('hex');
  const ts = now();
  db.prepare(`INSERT INTO login_challenges (id, admin_id, expires_at, attempts, created_at, ip, user_agent) VALUES (?, ?, ?, 0, ?, ?, ?)`).run(id, adminId, ts + ttlMs, ts, ip, ua);
  return id;
}

export function getChallenge(db: Db, id: string, nowTs: number = now()): ChallengeRow | null {
  const r = db.prepare(`SELECT id, admin_id, expires_at, attempts FROM login_challenges WHERE id = ?`).get(id) as ChallengeRow | undefined;
  if (!r || r.expires_at <= nowTs) return null;
  return r;
}

export function bumpChallengeAttempts(db: Db, id: string): number {
  db.prepare(`UPDATE login_challenges SET attempts = attempts + 1 WHERE id = ?`).run(id);
  const r = db.prepare(`SELECT attempts FROM login_challenges WHERE id = ?`).get(id) as { attempts: number } | undefined;
  return r?.attempts ?? 0;
}

export function deleteChallenge(db: Db, id: string): void {
  db.prepare(`DELETE FROM login_challenges WHERE id = ?`).run(id);
}

export function purgeExpiredChallenges(db: Db, nowTs: number = now()): number {
  return db.prepare(`DELETE FROM login_challenges WHERE expires_at <= ?`).run(nowTs).changes;
}

export function rewrapTotpSecrets(db: Db, ring: KeyRing): number {
  const rows = db.prepare(`SELECT admin_id, secret_enc, key_version, enabled_at, last_used_step, created_at FROM admin_totp WHERE key_version != ?`).all(ring.current) as TotpRow[];
  const upd = db.prepare(`UPDATE admin_totp SET secret_enc = ?, key_version = ? WHERE admin_id = ?`);
  return db.transaction(() => {
    for (const row of rows) {
      const { enc, version } = sealTotpSecret(ring, row.admin_id, openTotpSecret(ring, row));
      upd.run(enc, version, row.admin_id);
    }
    return rows.length;
  })();
}
```

`src/repos/admin.ts`:

```ts
export function getAdminById(db: Db, id: number): AdminRow | null {
  return (db.prepare(`SELECT id, username, password_hash, created_at FROM admin WHERE id = ?`).get(id) as AdminRow | undefined) ?? null;
}
```

- [ ] **Step 6: Ops and CLI.** In `src/ops.ts`:

```ts
export function runRotateKey(db: Db, ring: KeyRing): { secrets: number; totp: number } {
  // One transaction per table: a failure in either leaves that table on the old key version,
  // and rotate-key is safe to run again (rows already on the current version are skipped).
  return { secrets: rewrapAllSecrets(db, ring), totp: rewrapTotpSecrets(db, ring) };
}

export function runTotpReset(db: Db): string {
  const admin = getAdmin(db);
  if (!admin) throw new Error('no admin user — run init first');
  deleteTwoFactor(db, admin.id);
  writeAudit(db, { actor_type: 'admin', actor_id: admin.id, action: 'auth.totp_reset', meta: { via: 'shell' } });
  return admin.username;
}
```

(Import `rewrapTotpSecrets` and `deleteTwoFactor` from `./repos/twofactor.js`, and `writeAudit` from `./repos/audit.js`.)

In `src/cli.ts`:
- `rotate-key` action:
  ```ts
  const r = runRotateKey(db, config.keyRing);
  console.log(`rewrapped ${r.secrets} secrets to key version ${config.keyRing.current}`);
  console.log(`rewrapped ${r.totp} 2FA secrets`);
  ```
- Add:

```ts
const twoFactor = program.command('2fa').description('Two-factor authentication (shell-only recovery)');
twoFactor
  .command('reset')
  .description('Turn off two-factor authentication for the admin (emergency recovery)')
  .action(() => {
    try {
      const config = loadConfig();
      const db = openDb(config.dbPath);
      console.log(`two-factor disabled for ${runTotpReset(db)}`);
      db.close();
    } catch (err) {
      fatal(err);
    }
  });
```

Export `runTotpReset` from `src/index.ts` next to the other ops.

- [ ] **Step 7: Run tests.** Same command as Step 2, then the full suite: PASS.
- [ ] **Step 8: Commit** `feat(auth): TOTP core, 2FA storage, key rotation and shell reset`, with the trailer.

## Task 5: 2FA service, API token exchange and `pidb login`

**Files:**
- Create: `packages/server/src/services/twofactor.ts`
- Modify: `packages/shared/src/schemas.ts` (`authTokenRequestSchema.totp`)
- Modify: `packages/server/src/services/admin.ts` (`exchangePassword`)
- Modify: `packages/server/src/http/routes/admin.ts` (`POST /api/v1/auth/token`)
- Modify: `packages/cli/src/commands/login.ts`
- Test: `packages/server/test/twofactor.service.test.ts` (create)
- Test: `packages/server/test/auth.totp.api.test.ts` (create)
- Test: `packages/cli/test/login.test.ts` (extend)

**Interfaces:**
- **Consumes** (Task 4): the `src/auth/totp.ts` and `src/repos/twofactor.ts` exports, and `getAdminById`.
- **Produces** from `src/services/twofactor.ts`:
  ```ts
  export const CHALLENGE_TTL_MS = 300_000;
  export const MAX_CHALLENGE_ATTEMPTS = 5;
  export const RECOVERY_CODE_COUNT = 10;
  export type SecondFactor = 'totp' | 'recovery';
  export function isTotpEnabled(ctx: AppContext, adminId: number): boolean
  export function startEnrollment(ctx: AppContext, adminId: number): void                // throws ConflictError if already enabled
  export function pendingEnrollment(ctx: AppContext, adminId: number, username: string): { secret: string; uri: string } | null // base32 secret
  export function confirmEnrollment(ctx: AppContext, actor: Actor, code: string): Promise<string[] | null> // recovery codes, or null for a wrong code
  export function verifySecondFactor(ctx: AppContext, adminId: number, input: string): Promise<SecondFactor | null>
  export function regenerateRecoveryCodes(ctx: AppContext, actor: Actor): Promise<string[]>
  export function disableTwoFactor(ctx: AppContext, actor: Actor): void
  export function countUnusedRecoveryCodes(ctx: AppContext, adminId: number): number
  ```
  `actor.principal.id` is the admin id for every `Actor`-taking function.
- **Produces:**
  - `exchangePassword` result: `{ ok: true; token: string; id: number; name: string; expires_at: number } | { ok: false; reason: 'invalid' | 'totp_required' }`;
  - `authTokenRequestSchema.totp?: string` (1–32 chars).

- [ ] **Step 1: Failing tests.**

`twofactor.service.test.ts`. Use `makeTestApp()`, `createAdmin`, and the actor `{ principal: { kind: 'admin', id, scopes: ['admin'], projectIds: null }, ip: '1.1.1.1', userAgent: 't' }`. Compute codes from the stored secret with `openTotpSecret(t.ring, getTotp(t.db, id)!)` and `hotp(secret, stepAt(Date.now()) + d)`. Cover:
1. `isTotpEnabled` is false before, false after `startEnrollment` only (**Review Focus 2**), and true after `confirmEnrollment` with a correct code.
2. `confirmEnrollment` with a wrong code → `null`, still disabled. With a correct code → 10 codes matching `/^[a-hjkmnp-z2-9]{5}-[a-hjkmnp-z2-9]{5}$/`, and the audit has `auth.totp_enrolled`.
3. `startEnrollment` when already enabled throws `ConflictError`.
4. `verifySecondFactor`:
   - the code for step `+1` → `'totp'`;
   - the same code again → `null` (**Review Focus 4**);
   - a recovery code in uppercase without the dash → `'recovery'` (**Review Focus 1**), then the same code → `null`.
   The service writes no audit rows for this; callers do (asserted in the API and UI tests).
5. `regenerateRecoveryCodes` → 10 new codes; old codes no longer verify; audit `auth.recovery_regenerated`.
6. `disableTwoFactor` → `isTotpEnabled` false, `getTotp` null; audit `auth.totp_disabled`.

`auth.totp.api.test.ts` (`POST /api/v1/auth/token`):
1. Enrollment only started, not confirmed → password alone mints a token, 201 (**Review Focus 2**).
2. Enabled, no `totp` → 401 `{ error: 'totp_required' }`; no `auth.login_failed` or `auth.totp_failed` audit row was added by that request.
3. Wrong `totp: '000000'` → 401 `unauthorized`, plus an `auth.totp_failed` audit row.
4. Correct `totp` → 201, and the `auth.login` meta has `second_factor: 'totp'`.
5. The same code again, immediately → 401 (**Review Focus 4**).
6. A recovery code → 201 with `second_factor: 'recovery'`.
7. A wrong password with a correct code → 401 `unauthorized`, with `auth.login_failed` (the password is checked first).

`packages/cli/test/login.test.ts`: a new `describe('with 2FA')` on a separate admin. Enroll it through the repos/service against `s.db` and `s.ring`: `startEnrollment` + `confirmEnrollment` with the code from `hotp(openTotpSecret(s.ring, getTotp(s.db, id)!), stepAt(Date.now()))`. Then:
- **Prompts on `totp_required`:** `runLogin` with `io.promptHidden` returning the password on the first call and a fresh code for step `+1` on the second call → the token is saved. Assert `promptHidden` was called with `'2FA code: '`.
- **Empty code:** `promptHidden` returns `''` for the code → `CliError` with exit code 3, and no config file is written.

- [ ] **Step 2: Run to see failures.** `npm run build && npx vitest run packages/server/test/twofactor.service.test.ts packages/server/test/auth.totp.api.test.ts packages/cli/test/login.test.ts`

- [ ] **Step 3: Implement `src/services/twofactor.ts`:**

```ts
import type { AppContext } from '../http/context.js';
import type { Actor } from '../auth/principal.js';
import { ConflictError } from '../errors.js';
import { hashPassword, verifyPassword } from '../crypto/passwords.js';
import {
  base32Encode, generateRecoveryCode, generateTotpSecret, normalizeRecoveryCode, otpauthUri, verifyTotp,
} from '../auth/totp.js';
import {
  claimTotpStep, deleteTwoFactor, enableTotp, getTotp, listUnusedRecoveryCodes, markRecoveryCodeUsed,
  openTotpSecret, replaceRecoveryCodes, savePendingTotp,
} from '../repos/twofactor.js';
import { auditAs } from './common.js';

export const CHALLENGE_TTL_MS = 300_000;
export const MAX_CHALLENGE_ATTEMPTS = 5;
export const RECOVERY_CODE_COUNT = 10;
export type SecondFactor = 'totp' | 'recovery';

export function isTotpEnabled(ctx: AppContext, adminId: number): boolean {
  return getTotp(ctx.db, adminId)?.enabled_at != null;
}

export function startEnrollment(ctx: AppContext, adminId: number): void {
  if (isTotpEnabled(ctx, adminId)) throw new ConflictError('two-factor authentication is already on');
  savePendingTotp(ctx.db, ctx.ring, adminId, generateTotpSecret());
}

export function pendingEnrollment(ctx: AppContext, adminId: number, username: string): { secret: string; uri: string } | null {
  const row = getTotp(ctx.db, adminId);
  if (!row || row.enabled_at !== null) return null;
  const secret = openTotpSecret(ctx.ring, row);
  return { secret: base32Encode(secret), uri: otpauthUri(username, secret) };
}

async function newRecoveryCodes(ctx: AppContext, adminId: number): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => generateRecoveryCode());
  replaceRecoveryCodes(ctx.db, adminId, await Promise.all(codes.map((c) => hashPassword(c))));
  return codes;
}

export async function confirmEnrollment(ctx: AppContext, actor: Actor, code: string): Promise<string[] | null> {
  const adminId = actor.principal.id;
  const row = getTotp(ctx.db, adminId);
  if (!row || row.enabled_at !== null) return null;
  const step = verifyTotp(openTotpSecret(ctx.ring, row), code.trim(), row.last_used_step);
  if (step === null) {
    auditAs(ctx, actor, { action: 'auth.totp_failed', meta: { during: 'enrollment' } });
    return null;
  }
  enableTotp(ctx.db, adminId, step);
  const codes = await newRecoveryCodes(ctx, adminId);
  auditAs(ctx, actor, { action: 'auth.totp_enrolled' });
  return codes;
}

/**
 * Accepts a 6-digit TOTP code or a recovery code (case/space/dash-insensitive).
 * Records the used step / marks the recovery code used. Returns which factor matched.
 * Callers write the audit rows (they know the request's ip and user agent).
 */
export async function verifySecondFactor(ctx: AppContext, adminId: number, input: string): Promise<SecondFactor | null> {
  const row = getTotp(ctx.db, adminId);
  if (!row || row.enabled_at === null) return null;
  const trimmed = input.trim();
  if (/^\d{6}$/.test(trimmed)) {
    const step = verifyTotp(openTotpSecret(ctx.ring, row), trimmed, row.last_used_step);
    return step !== null && claimTotpStep(ctx.db, adminId, step) ? 'totp' : null;
  }
  const normalized = normalizeRecoveryCode(trimmed);
  if (!normalized) return null;
  for (const rc of listUnusedRecoveryCodes(ctx.db, adminId)) {
    if (await verifyPassword(rc.code_hash, normalized)) {
      return markRecoveryCodeUsed(ctx.db, rc.id) ? 'recovery' : null;
    }
  }
  return null;
}

export async function regenerateRecoveryCodes(ctx: AppContext, actor: Actor): Promise<string[]> {
  const codes = await newRecoveryCodes(ctx, actor.principal.id);
  auditAs(ctx, actor, { action: 'auth.recovery_regenerated' });
  return codes;
}

export function disableTwoFactor(ctx: AppContext, actor: Actor): void {
  deleteTwoFactor(ctx.db, actor.principal.id);
  auditAs(ctx, actor, { action: 'auth.totp_disabled' });
}

export function countUnusedRecoveryCodes(ctx: AppContext, adminId: number): number {
  return listUnusedRecoveryCodes(ctx.db, adminId).length;
}
```

Before using `auditAs`, check its signature in `src/services/common.ts`. If it requires `target_type`, pass `target_type: 'admin', target_id: actor.principal.id`.

**`verifySecondFactor` does not audit.** Callers audit:
- a failure → `auth.totp_failed`;
- a success via a recovery code → also `auth.recovery_used`.

`auth.recovery_used` is asserted in `auth.totp.api.test.ts` item 6 and in the Task 6 UI test, never on the bare service.

- [ ] **Step 4: Schema, service, route.**
  - **Schema:** `authTokenRequestSchema` gains `totp: z.string().min(1).max(32).optional()`.
  - **`exchangePassword`** (`services/admin.ts`), rewritten:

```ts
export type ExchangeResult =
  | { ok: true; token: string; id: number; name: string; expires_at: number }
  | { ok: false; reason: 'invalid' | 'totp_required' };

export async function exchangePassword(ctx: AppContext, input: AuthTokenRequest, ip: string, userAgent: string): Promise<ExchangeResult> {
  const admin = getAdminByUsername(ctx.db, input.username);
  const ok = admin ? await verifyPassword(admin.password_hash, input.password) : false;
  if (!admin || !ok) {
    writeAudit(ctx.db, { actor_type: 'admin', actor_id: admin?.id ?? null, action: 'auth.login_failed', ip, user_agent: userAgent, meta: { username: input.username } });
    return { ok: false, reason: 'invalid' };
  }
  let secondFactor: SecondFactor | undefined;
  if (isTotpEnabled(ctx, admin.id)) {
    if (input.totp === undefined) return { ok: false, reason: 'totp_required' };
    const used = await verifySecondFactor(ctx, admin.id, input.totp);
    if (!used) {
      writeAudit(ctx.db, { actor_type: 'admin', actor_id: admin.id, action: 'auth.totp_failed', ip, user_agent: userAgent, meta: { via: 'api' } });
      return { ok: false, reason: 'invalid' };
    }
    if (used === 'recovery') writeAudit(ctx.db, { actor_type: 'admin', actor_id: admin.id, action: 'auth.recovery_used', ip, user_agent: userAgent, meta: { via: 'api' } });
    secondFactor = used;
  }
  const { token, row } = createToken(ctx.db, { name: input.name, scopes: ['admin'], projectIds: null, expiresAt: Date.now() + input.expires_days * DAY_MS });
  writeAudit(ctx.db, {
    actor_type: 'admin', actor_id: admin.id, action: 'auth.login', target_type: 'token', target_id: row.id, ip, user_agent: userAgent,
    meta: { name: row.name, ...(secondFactor ? { second_factor: secondFactor } : {}) },
  });
  return { ok: true, token, id: row.id, name: row.name, expires_at: row.expires_at as number };
}
```

  - **Route** (`http/routes/admin.ts`, `POST /api/v1/auth/token`):

```ts
      const result = await exchangePassword(ctx, input, req.ip, req.headers['user-agent'] ?? '');
      if (!result.ok) {
        if (result.reason === 'totp_required') throw new AppError(401, 'totp_required', 'two-factor code required');
        throw new UnauthorizedError('invalid credentials');
      }
      const { ok: _ok, ...body } = result;
      return reply.status(201).send(body);
```

    Import `AppError` from `../../errors.js`.

  - **CLI `runLogin`** (`packages/cli/src/commands/login.ts`), after building `body`:

```ts
  let res: AuthTokenResponse;
  try {
    res = await client.json<AuthTokenResponse>('POST', '/api/v1/auth/token', { body });
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 401 && err.body.error === 'totp_required')) throw err;
    const totp = await io.promptHidden('2FA code: ');
    if (!totp) throw new CliError('a two-factor code is required', EXIT_AUTH);
    res = await client.json<AuthTokenResponse>('POST', '/api/v1/auth/token', { body: { ...body, totp } });
  }
```

    Import `ApiError` from `../client.js` and `EXIT_AUTH` from `../errors.js`.

- [ ] **Step 5: Run tests** (Step 2 command), then the full suite: PASS.
- [ ] **Step 6: Commit** `feat(auth): require a second factor to mint admin tokens when 2FA is on`, with the trailer.

## Task 6: 2FA in the admin UI — login step, settings page, banner

**Files:**
- Create: `packages/server/src/ui/routes/twofactor.ts`
- Create: `packages/server/src/ui/views/login-2fa.eta`
- Create: `packages/server/src/ui/views/settings-2fa.eta`
- Modify:
  - `packages/server/src/ui/routes/auth.ts` (`POST /login` branch, `GET`/`POST /login/2fa`)
  - `packages/server/src/ui/session.ts` (guard allows `/login/2fa`; `CHALLENGE_COOKIE`)
  - `packages/server/src/ui/index.ts` (register the new routes; `no-store` for `/settings/2fa*` and `/login/2fa`)
  - `packages/server/src/ui/forms.ts` (`pageContext` adds `totpEnabled`)
  - `packages/server/src/ui/views/layout.eta` (banner)
  - `packages/server/src/ui/views/partials/nav.eta` ("Two-factor" link)
  - `packages/server/src/ui/public/app.css` (QR, codes list, secret text)
  - `packages/server/package.json` (npm)
- Test: `packages/server/test/ui.twofactor.test.ts` (create)
- Modify: `packages/server/test/ui.csp.test.ts` (extend the page list)

**Interfaces:**
- **Consumes:**
  - the `services/twofactor.ts` exports (Task 5);
  - `createChallenge`/`getChallenge`/`bumpChallengeAttempts`/`deleteChallenge`/`purgeExpiredChallenges` and `getAdminById` (Task 4);
  - the Task 3 markup contract (`data-open-dialog`, `data-close-dialog`, `data-action="copy-text"` + `data-copy-target`).
- **Produces:**
  - `PageContext.totpEnabled: boolean`;
  - the cookie constant `CHALLENGE_COOKIE = 'pidb_2fa'` in `ui/session.ts`.

- [ ] **Step 1: Install QR code support.** `npm i -w @pidb/server qrcode` and `npm i -D -w @pidb/server @types/qrcode`. Record the resolved versions in the report.

- [ ] **Step 2: Failing tests** in `packages/server/test/ui.twofactor.test.ts`. Set up `makeTestApp()`, `createAdmin('alex','pw')`, and the helpers:
  - `login()`: `POST /login`;
  - `main(body)`: the `<main`…`</main>` slice;
  - `codeFor(d)`: `hotp(openTotpSecret(t.ring, getTotp(t.db, 1)!), stepAt(Date.now()) + d)`.

  Cases, in order, sharing state:
  1. **Before enrollment:**
     - `POST /login` gives a session directly (302 `/`, `pidb_session` cookie).
     - `/` shows the banner: `<main` contains `Two-factor authentication is off`, and `href="/settings/2fa"`.
     - The sidebar contains `href="/settings/2fa"`.
  2. **Settings page:**
     - `GET /settings/2fa` shows `Set up two-factor`, with `cache-control` containing `no-store`.
     - `POST /settings/2fa/start` with csrf → 200. The body contains `<img` with `src="data:image/svg+xml;base64,`, the base32 secret (matching `/[A-Z2-7]{4}( [A-Z2-7]{1,4})+/`) and a `name="code"` input.
     - `POST /settings/2fa/start` without csrf → 403.
  3. **Pending enrollment** (**Review Focus 2**): the banner is still shown, and a fresh `POST /login` still yields a session with no challenge.
  4. **Confirm:**
     - A wrong code → 200, `Invalid code`, still pending.
     - The right code `codeFor(0)` → 200. `<main` contains exactly 10 codes matching `/[a-hjkmnp-z2-9]{5}-[a-hjkmnp-z2-9]{5}/g`, with `cache-control` `no-store`.
     - `GET /settings/2fa` → `Enabled since`, `10 unused recovery codes`, and no banner on `/`.
  5. **Login with 2FA:**
     - `POST /login` → 302 to `/login/2fa`. There is **no** `pidb_session` cookie, and there is a `pidb_2fa` cookie with `path=/login` and `httpOnly`.
     - `GET /login/2fa` with that cookie → 200 with `name="code"` and `autocomplete="one-time-code"`.
     - `POST /login/2fa` with `code: codeFor(1)` → 302 `/` with a `pidb_session` cookie; the audit's latest `auth.login` meta has `second_factor: 'totp'`.
  6. **Challenge replay** (**Review Focus 3**): `POST /login/2fa` again with the **same** `pidb_2fa` cookie and any code → 302 to `/login` with no session.
  7. **Recovery code** (**Review Focus 1**):
     - A new challenge, then POST the first recovery code from case 4 in uppercase without the dash → a session, plus an `auth.recovery_used` audit row.
     - The same code on another challenge → `Invalid code`.
  8. **Attempt limit:** a new challenge and 5 wrong codes. Responses 1–4 are 401 and re-render `Invalid code`. The 5th is 401 with the login page containing `Too many attempts`; the `pidb_2fa` cookie is cleared and the challenge row is gone.
  9. **Expired challenge:** create a challenge with `createChallenge(t.db, 1, -1, '', '')`, then `GET /login/2fa` with that cookie → 302 `/login`.
  10. **Regenerate:**
      - Wrong password → error `Invalid password or code.`, and codes unchanged.
      - Right password plus a fresh code → 10 new codes; old recovery codes no longer work.
  11. **Disable:** right password plus a fresh code → `Set up two-factor` shown, the banner is back, and login needs no second step.
  12. **Anonymous access:** `GET /login/2fa` without any cookie → 302 `/login`, and `GET /settings/2fa` without a session → 302 `/login`.

  Extend `ui.csp.test.ts` `renders no inline code on any page` with: `/settings/2fa` (off), the `POST /settings/2fa/start` response, the recovery-codes page after confirm, and `/login/2fa` with a live challenge. Enroll a **second test app instance**, or do these checks last in that file and turn 2FA off afterwards, so the other pages in that file keep a plain login.

- [ ] **Step 3: Run to see failures.** `npm run build && npx vitest run packages/server/test/ui.twofactor.test.ts packages/server/test/ui.csp.test.ts`

- [ ] **Step 4: Session/guard/headers.**
  - **`ui/session.ts`:**
    - Add `export const CHALLENGE_COOKIE = 'pidb_2fa';` and `export const CHALLENGE_TTL_S = 300;`.
    - In `registerUiGuard`, change the allow-list line to `if (path === '/login' || path === '/login/2fa' || path.startsWith('/assets/')) return;`.
    - Add the helpers:
      ```ts
      export function setChallengeCookie(reply: FastifyReply, id: string, secure: boolean): void {
        reply.setCookie(CHALLENGE_COOKIE, id, { path: '/login', httpOnly: true, sameSite: 'lax', secure, maxAge: CHALLENGE_TTL_S });
      }
      export function clearChallengeCookie(reply: FastifyReply): void {
        reply.clearCookie(CHALLENGE_COOKIE, { path: '/login' });
      }
      ```
  - **`ui/index.ts` onSend:** add `|| path.startsWith('/settings/2fa') || path === '/login/2fa'` to the `no-store` condition. Register `registerTwoFactorRoutes(app, ctx)` after `registerAdminRoutes`.
  - **`ui/forms.ts`:** `PageContext` gains `totpEnabled: boolean`. In `pageContext`:
    ```ts
    totpEnabled: req.principal?.kind === 'admin' ? isTotpEnabled(ctx, req.principal.id) : true,
    ```
    (The fallback `true` means "no banner" on pages without an admin.)

- [ ] **Step 5: Login routes** (`ui/routes/auth.ts`). In `POST /login`, after the password check succeeds:

```ts
      if (isTotpEnabled(ctx, admin.id)) {
        const challenge = createChallenge(ctx.db, admin.id, CHALLENGE_TTL_MS, req.ip, ua);
        setChallengeCookie(reply, challenge, isSecure(req));
        return reply.redirect('/login/2fa', 302);
      }
```

This goes before `createSession`. The rest stays as is: session creation, `auth.login` audit, redirect.

Add:

```ts
  const challengeFrom = (req: FastifyRequest) => {
    const raw = req.cookies?.[CHALLENGE_COOKIE];
    return typeof raw === 'string' && raw ? getChallenge(ctx.db, raw) : null;
  };
  const codePage = (reply: FastifyReply, status: number, error: string | null) =>
    reply.status(status).type('text/html').send(renderPage('login-2fa', { title: 'Two-factor code', nav: false, error }));

  app.get('/login/2fa', { config: { public: true } }, async (req, reply) => {
    purgeExpiredChallenges(ctx.db);
    if (!challengeFrom(req)) {
      clearChallengeCookie(reply);
      return reply.redirect('/login', 302);
    }
    return codePage(reply, 200, null);
  });

  app.post<{ Body: { code?: string } }>(
    '/login/2fa',
    { config: { public: true, rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const challenge = challengeFrom(req);
      const ua = req.headers['user-agent'] ?? '';
      if (!challenge) {
        clearChallengeCookie(reply);
        return reply.redirect('/login', 302);
      }
      const used = await verifySecondFactor(ctx, challenge.admin_id, req.body?.code ?? '');
      if (!used) {
        writeAudit(ctx.db, { actor_type: 'admin', actor_id: challenge.admin_id, action: 'auth.totp_failed', ip: req.ip, user_agent: ua, meta: { via: 'ui' } });
        if (bumpChallengeAttempts(ctx.db, challenge.id) >= MAX_CHALLENGE_ATTEMPTS) {
          deleteChallenge(ctx.db, challenge.id);
          clearChallengeCookie(reply);
          return loginPage(reply, 401, 'Too many attempts — log in again.');
        }
        return codePage(reply, 401, 'Invalid code.');
      }
      deleteChallenge(ctx.db, challenge.id);
      clearChallengeCookie(reply);
      if (used === 'recovery') writeAudit(ctx.db, { actor_type: 'admin', actor_id: challenge.admin_id, action: 'auth.recovery_used', ip: req.ip, user_agent: ua, meta: { via: 'ui' } });
      const id = createSession(ctx.db, challenge.admin_id, SESSION_TTL_MS, req.ip, ua);
      writeAudit(ctx.db, { actor_type: 'admin', actor_id: challenge.admin_id, action: 'auth.login', ip: req.ip, user_agent: ua, meta: { via: 'ui', second_factor: used } });
      setSessionCookie(reply, id, isSecure(req));
      return reply.redirect('/', 302);
    },
  );
```

The 5th wrong attempt renders the login page (401) with "Too many attempts — log in again." instead of redirecting, so the message is visible (Step 2 case 8 expects exactly this).

- [ ] **Step 6: Settings routes** (`ui/routes/twofactor.ts`):

```ts
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import QRCode from 'qrcode';
import type { AppContext } from '../../http/context.js';
import { getAdminById } from '../../repos/admin.js';
import { getTotp } from '../../repos/twofactor.js';
import { verifyPassword } from '../../crypto/passwords.js';
import {
  confirmEnrollment, countUnusedRecoveryCodes, disableTwoFactor, isTotpEnabled, pendingEnrollment,
  regenerateRecoveryCodes, startEnrollment, verifySecondFactor,
} from '../../services/twofactor.js';
import { writeAudit } from '../../repos/audit.js';
import { adminActor, requireAdmin } from '../session.js';
import { assertCsrf } from '../csrf.js';
import { body, pageContext, str } from '../forms.js';
import { renderPage } from '../render.js';

type View =
  | { state: 'off' }
  | { state: 'setup'; secret: string; qr: string }
  | { state: 'codes'; codes: string[] }
  | { state: 'on'; enabledAt: number; unused: number };

export function registerTwoFactorRoutes(app: FastifyInstance, ctx: AppContext): void {
  const adminOf = (req: FastifyRequest) => {
    const principal = requireAdmin(req);
    const admin = getAdminById(ctx.db, principal.id);
    if (!admin) throw new Error('admin not found');
    return admin;
  };

  async function currentView(req: FastifyRequest): Promise<View> {
    const admin = adminOf(req);
    const row = getTotp(ctx.db, admin.id);
    if (row?.enabled_at != null) return { state: 'on', enabledAt: row.enabled_at, unused: countUnusedRecoveryCodes(ctx, admin.id) };
    const pending = pendingEnrollment(ctx, admin.id, admin.username);
    if (!pending) return { state: 'off' };
    const svg = await QRCode.toString(pending.uri, { type: 'svg', margin: 1 });
    return { state: 'setup', secret: pending.secret.replace(/(.{4})(?=.)/g, '$1 '), qr: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}` };
  }

  const page = (req: FastifyRequest, reply: FastifyReply, view: View, error: string | null, status = 200) =>
    reply.status(status).type('text/html').send(renderPage('settings-2fa', { ...pageContext(ctx, req, 'Two-factor'), view, error }));

  app.get('/settings/2fa', async (req, reply) => page(req, reply, await currentView(req), null));

  app.post('/settings/2fa/start', async (req, reply) => {
    assertCsrf(ctx, req);
    startEnrollment(ctx, adminOf(req).id);
    return page(req, reply, await currentView(req), null);
  });

  app.post('/settings/2fa/confirm', async (req, reply) => {
    assertCsrf(ctx, req);
    const codes = await confirmEnrollment(ctx, adminActor(req), str(body(req), 'code'));
    if (!codes) return page(req, reply, await currentView(req), 'Invalid code.', 400);
    return page(req, reply, { state: 'codes', codes }, null);
  });

  // Both destructive actions re-authenticate with the password AND a fresh code.
  async function reauth(req: FastifyRequest): Promise<boolean> {
    const admin = adminOf(req);
    const b = body(req);
    const passwordOk = await verifyPassword(admin.password_hash, str(b, 'password'));
    const factor = passwordOk ? await verifySecondFactor(ctx, admin.id, str(b, 'code')) : null;
    if (!passwordOk || !factor) {
      writeAudit(ctx.db, { actor_type: 'admin', actor_id: admin.id, action: 'auth.totp_failed', ip: req.ip, user_agent: req.headers['user-agent'] ?? '', meta: { via: 'settings' } });
      return false;
    }
    return true;
  }

  app.post('/settings/2fa/recovery', async (req, reply) => {
    assertCsrf(ctx, req);
    if (!isTotpEnabled(ctx, adminOf(req).id)) return reply.redirect('/settings/2fa', 302);
    if (!(await reauth(req))) return page(req, reply, await currentView(req), 'Invalid password or code.', 400);
    return page(req, reply, { state: 'codes', codes: await regenerateRecoveryCodes(ctx, adminActor(req)) }, null);
  });

  app.post('/settings/2fa/disable', async (req, reply) => {
    assertCsrf(ctx, req);
    if (!isTotpEnabled(ctx, adminOf(req).id)) return reply.redirect('/settings/2fa', 302);
    if (!(await reauth(req))) return page(req, reply, await currentView(req), 'Invalid password or code.', 400);
    disableTwoFactor(ctx, adminActor(req));
    return reply.redirect('/settings/2fa?done=saved', 302);
  });
}
```

If `qrcode`'s default import does not type-check under `NodeNext`, use `import * as QRCode from 'qrcode'` and report which one worked. If neither works, STOP and report BLOCKED with the compiler output.

- [ ] **Step 7: Views.** Use only the Task 3 markup contract: no inline script, handler or style.

`views/login-2fa.eta`. Mirror `login.eta`'s card markup; read it first and reuse its classes.

```html
<div class="login-card">
  <div class="brand"><span class="mark">pi</span><span>pidb</span></div>
  <h1>Two-factor code</h1>
  <p class="note">Enter the 6-digit code from your authenticator app, or one of your recovery codes.</p>
  <% if (it.error) { %><p class="alert" role="alert"><%= it.error %></p><% } %>
  <form method="post" action="/login/2fa" class="form-grid">
    <label for="code">Code</label>
    <input id="code" name="code" inputmode="text" autocomplete="one-time-code" autofocus required />
    <button class="btn primary" type="submit">Verify</button>
  </form>
  <p><a href="/login">Start over</a></p>
</div>
```

`views/settings-2fa.eta`:
- `.page-head` with `h1` "Two-factor authentication" and `.lede` "Protects the admin UI and the creation of admin API tokens."
- `.alert role="alert"` when `it.error`.
- Then, by `it.view.state`:
  - **`off`:** a `.panel` explaining the setting and a form `POST /settings/2fa/start` (csrf) with the `Set up two-factor` primary button.
  - **`setup`:**
    - `<img class="qr" src="<%= it.view.qr %>" alt="QR code for your authenticator app" width="200" height="200" />`;
    - `<code id="totp-secret" class="mono secret-text"><%= it.view.secret %></code>` followed by a `data-action="copy-text" data-copy-target="totp-secret"` Copy button;
    - a form `POST /settings/2fa/confirm` (csrf, `name="code"`, `autocomplete="one-time-code"`, `inputmode="numeric"`) with a `Turn on` primary button;
    - a secondary form `POST /settings/2fa/start` with a "Start over" ghost button.
  - **`codes`:**
    - `h2` "Recovery codes" and `.alert.warn` "Save these now. Each code works once and they will not be shown again.";
    - `<ol id="recovery-codes" class="codes mono">` with one `<li>` per code;
    - a `data-action="copy-text" data-copy-target="recovery-codes"` Copy button;
    - a link "Done" → `/settings/2fa`.
  - **`on`:**
    - "Enabled since" plus `<time datetime="<%= it.fmt.iso(it.view.enabledAt) %>"><%= it.fmt.ago(it.view.enabledAt) %></time>`;
    - `<%= it.view.unused %> unused recovery codes`;
    - two `.panel`s, each a form with `password` (type `password`, `autocomplete="current-password"`) and `code` fields plus the CSRF input:
      - "Regenerate recovery codes" → `POST /settings/2fa/recovery`;
      - "Turn off two-factor" → `POST /settings/2fa/disable`, button `.btn danger solid`.

CSS in `app.css`: `.qr { width: 200px; height: 200px; background: #fff; padding: 8px; border-radius: var(--radius-sm); }` (white background so the QR code scans in dark mode), `.secret-text { letter-spacing: .06em; }`, and `.codes { columns: 2; padding-left: 20px; font-variant-numeric: tabular-nums; }`.

`layout.eta`: inside `<main class="main">`, before `<%~ it.body %>`:

```html
        <% if (it.totpEnabled === false) { %>
        <div class="alert warn" role="status">Two-factor authentication is off. <a href="/settings/2fa">Set it up →</a></div>
        <% } %>
```

`partials/nav.eta`: in the Admin group, after Audit log:

```html
  <a href="/settings/2fa" <%~ it.path.startsWith('/settings/2fa') ? 'aria-current="page"' : '' %>>
    <span>Two-factor</span>
  </a>
```

- [ ] **Step 8: Run tests** (Step 3 command), then the full suite: PASS. Existing UI tests log in with a password only and never enroll, so they must stay green unchanged. If any existing assertion breaks because of the banner text, STOP and report BLOCKED.
- [ ] **Step 9: Commit** `feat(ui): two-factor login step, settings page and enrollment banner`, with the trailer.

## Task 7: Documentation

**Files:**
- Modify: `README.md` (CLI section, Admin UI section, Deployment "Rotating the master key", a new "Two-factor authentication" subsection under Admin UI, Environment unchanged)

- [ ] **Step 1: README edits.**
  - **CLI section:**
    - `pidb login <url> [--expires <days>]`: login tokens last 30 days by default, 365 at most; a code is prompted when 2FA is on.
    - `pidb token create`: 90 days by default, `--expires 90d|12h|30m`, `--no-expiry` for a token that never expires.
    - After expiry, commands print "token expired — run `pidb login <url>` again".
  - **Admin UI:**
    - The new token form defaults to 90 days, with a "Never expires" checkbox.
    - Non-expiring tokens are flagged.
    - Add a "Two-factor authentication" subsection covering:
      - enrollment at `/settings/2fa` (QR code or text secret, 10 one-time recovery codes);
      - login asks for a code after the password;
      - `pidb login` prompts for it;
      - regenerating codes or turning 2FA off needs the password plus a code;
      - emergency reset from a shell: `pidb-server 2fa reset` (Docker: `docker compose run --rm --no-deps server 2fa reset`).
    - A CSP line: the UI runs under `script-src 'self'; style-src 'self'` with no inline code, and all behaviour is in `/assets/app.js`.
  - **Rotating the master key:** `rotate-key` now prints a second line, `rewrapped <m> 2FA secrets`. The first line and its interpretation are unchanged.
- [ ] **Step 2: Verify.**
  - `grep -n "unsafe-inline" README.md` returns nothing;
  - `grep -n "2fa reset" README.md` shows the new section;
  - build and the full suite are green.
- [ ] **Step 3: Commit** `docs: document token lifetimes, two-factor authentication and the strict CSP`, with the trailer.

## Done criteria

- Every spec section (1.1–1.3, 2.1–2.6, 3.1–3.3, 4, 5) is implemented and tested.
- `npm run build && npx vitest run` is green, and `npm run typecheck` exits 0.
- `grep -rnE "<script(?![^>]*src)|on[a-z]+=|style=\"" packages/server/src/ui/views` finds nothing (checked by `ui.csp.test.ts`).
- The first `rotate-key` output line is unchanged.
