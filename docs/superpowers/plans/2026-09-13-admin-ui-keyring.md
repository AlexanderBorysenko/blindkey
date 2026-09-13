# pidb Admin UI "Keyring" Restyle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Replace the Pico-classless look of the server-rendered admin UI with the "Keyring" design (direction A, chosen by the user from the mock artifact): an app shell with a project sidebar, a hand-written token-based stylesheet (light + dark), IBM Plex type, and the UX fixes listed below — without changing any route, form contract, CSRF rule or security behaviour.

**Design reference (approved mock):** https://claude.ai/code/artifact/b5c37193-769d-4219-bbbf-a44ac214539f — direction "A · Keyring". Local copy: none; the tokens and components below are the binding translation of it.

**Architecture:** Still Eta templates + htmx served by Fastify, no build step, no CDN. `@picocss/pico` is removed. `packages/server/src/ui/public/app.css` becomes the whole design system. `layout.eta` renders a sidebar shell whose data comes from `pageContext()` (one SQL query per page). Two small backend additions: a nav query (`repos/nav.ts`) and a per-secret recent-access query (audit log by target).

**Spec:** `docs/superpowers/specs/2026-09-12-projects-info-db-design.md` §11 (UI) stays binding for behaviour. This plan changes presentation only, plus the two read-only queries above.

**Branch:** `feat/admin-ui-keyring` (already created from master at f4ea290).

## Global Constraints

- Node `>=22`, TypeScript `strict` + `noUncheckedIndexedAccess`, ESM — every relative import carries the `.js` extension.
- **ALWAYS run `npm run build` (repo root) before `npx vitest run`.** Several tests exec `dist/`; the UI build step copies `views/` and `public/` into `dist/ui`.
- **No route, form field name, form value encoding, CSRF check, reveal/audit behaviour or cache header changes**, except the `?done=` flash parameter introduced in Task 2 and applied in Tasks 3–6. Secret values still reach the browser only via the reveal endpoint, one field per request.
- **The per-row `sensitive` form value stays positional**: every secret-edit row must submit exactly one `sensitive` value (`1` or `0`), in row order, exactly as `fieldRows()` in `src/ui/routes/secrets.ts` expects.
- **No external hosts.** Fonts, CSS and JS are served from `/assets` (node_modules or `src/ui/public`). The CSP in `src/ui/index.ts` must not be loosened.
- HTML stays auto-escaped. Never render the raw `done` query value; it maps through a fixed whitelist.
- Existing test assertions stay green. These substrings are asserted by tests and must keep appearing where they do today: `<td>doc.write</td>` and `<td>${id}</td>` (audit table cells without attributes), `<th>Prefix</th>` (tokens), `<textarea name="value"` (secret edit: `name` must be the first attribute), `moveRow(this, -1)` / `moveRow(this, 1)`, `function hideField(` (secret page), `onclick="hideField(this)"` and `>Hide</button>` (reveal partial), `aria-current="page"` (projects status filter), `role="alert"` (form errors), `Save anyway`, `shown once`, `name="csrf" value="…"` (tests scrape the CSRF token with `/name="csrf" value="([^"]+)"/`), `<!doctype html>`, `not found`.
- The only test edits allowed without a ruling are: (a) Task 1's skeleton asset assertion, (b) exact `headers.location` assertions that gain a `done` parameter, and (c) new tests each task adds.
- Look: follow the design tokens and components in "Design system" below verbatim (hex values, font stacks, sizes). Component class names listed there are the vocabulary; templates use them rather than inline styles.
- New dependencies go in `packages/server` via `npm i -w @pidb/server <pkg>`; record resolved versions in the report.
- Tests in `packages/server/test/**/*.test.ts`, driven with `app.inject` and `makeTestApp()`; log in with `createAdmin` + `POST /login` as the existing `ui.*.test.ts` files do.
- Conventional Commits. Every commit message ends with the trailer `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`. After committing, run `git log -1 --format=%B` and verify the trailer; amend if wrong.
- If a step cannot be done as written (a library API differs, a test fails in a way this plan does not describe), **STOP and report BLOCKED with the exact output. Do not improvise a different design.**
- Do not end your turn while a background command is running.

## Design system (binding)

### Tokens (`:root` = light; `@media (prefers-color-scheme: dark) { :root { … } }` = dark)

| token | light | dark | role |
|---|---|---|---|
| `--bg` | `#f5f6f8` | `#111418` | page ground (main area) |
| `--side` | `#eceef2` | `#161a20` | sidebar ground, subtle fills (tags, chips, count badges) |
| `--surface` | `#ffffff` | `#1b2028` | tables, panels, inputs, dialogs |
| `--surface-2` | `#fafbfc` | `#20262f` | table header row, code blocks |
| `--ink` | `#1b2230` | `#e4e7ed` | text |
| `--muted` | `#5b6474` | `#99a1ae` | secondary text, labels |
| `--line` | `#dfe2e8` | `#2a303a` | borders, dividers |
| `--accent` | `#3355cc` | `#7d98ff` | primary buttons, links, active tab underline, focus ring |
| `--accent-ink` | `#ffffff` | `#0d1330` | text on accent |
| `--accent-soft` | `#e8edfb` | `#1f2a4a` | row hover, selected nav item hint |
| `--lock` | `#a8650f` | `#e0a44f` | sensitive/locked marks, reveal highlight, `secret.reveal` audit rows |
| `--lock-soft` | `#fbf1e1` | `#33260f` | lock chip ground, revealed row ground |
| `--ok` | `#2f8a57` | `#5cc28a` | status active |
| `--ok-soft` | `#e6f3ec` | `#15301f` | active pill ground |
| `--warn` | `#b7791f` | `#e0b04f` | status paused |
| `--warn-soft` | `#faf0dc` | `#322610` | paused pill ground |
| `--off` | `#8b93a1` | `#7d8594` | status archived, revoked |
| `--danger` | `#c43d32` | `#ff7a6e` | destructive buttons, error alerts |
| `--danger-soft` | `#fbe9e7` | `#3a1a17` | alert ground |
| `--radius` | `8px` | | tables, panels, dialogs |
| `--radius-sm` | `6px` | | buttons, inputs, chips |

Also set `color-scheme: light` in `:root` and `color-scheme: dark` in the dark block; `body { background: var(--bg); color: var(--ink); }`.

### Type

- Sans: `"IBM Plex Sans", system-ui, -apple-system, "Segoe UI", sans-serif` — weights 400, 500, 600.
- Mono: `"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace` — weights 400, 500.
- Base `font-size: 14px; line-height: 1.5`. Scale: page title `h1` 21px/600 letter-spacing -0.01em; `h2` 16px/600; body 14px; small/meta 12.5px; uppercase labels (table headers, sidebar group headings, panel headings) 11px/600, `letter-spacing: 0.06em`, `text-transform: uppercase`, `color: var(--muted)`.
- `code`, `.mono`, keys, slugs, secret names, token prefixes, audit actions: mono 12.5px.
- `font-variant-numeric: tabular-nums` on table cells, counts and times.

### Layout

- `.shell`: CSS grid, `grid-template-columns: 232px minmax(0, 1fr)`, `min-height: 100vh`.
- `.sidebar`: `background: var(--side)`, right border `1px solid var(--line)`, padding `14px 10px`, flex column gap 14px, `position: sticky; top: 0; height: 100vh; overflow-y: auto`.
- `.main`: padding `18px 28px 40px`, flex column gap 16px, `max-width: 1200px`.
- Below `800px`: `.shell` becomes one column; the sidebar is hidden and a `.topbar` shows the brand plus a `<details class="nav-drawer">` whose `<summary>` reads "Menu" and whose content is the same nav (rendered from the same partial). No JS.

### Components (class vocabulary)

- `.btn` — inline-flex, gap 6px, `font: 500 13px` sans, padding `6px 12px`, `border: 1px solid var(--line)`, `background: var(--surface)`, `color: var(--ink)`, `border-radius: var(--radius-sm)`, `cursor: pointer`, no underline. Modifiers: `.primary` (accent ground, accent-ink text, accent border), `.ghost` (transparent border and ground, muted text), `.danger` (danger text; `.danger.solid` = danger ground, white text), `.sm` (padding `3px 9px`, 12px). `button`, `[role=button]` and `input[type=submit]` get `.btn` look by default. `:focus-visible` → `outline: 2px solid var(--accent); outline-offset: 2px` on every interactive element.
- `.pill` + `.status-active|.status-paused|.status-archived` — radius 999px, padding `1px 8px`, 12px/500, a 6px leading dot (`::before`, `currentColor`); colors ok/ok-soft, warn/warn-soft, off/side.
- `.tag` — 12px, padding `1px 7px`, radius 5px, `--side` ground, muted text.
- `.chip` — mono 12px, padding `1px 6px`, radius 5px, `--side` ground, inline-flex gap 4px. `.chip.lock` — lock text, lock-soft ground, preceded by the lock icon.
- `.count` — 11px, padding `0 6px`, radius 999px, `--side` ground, tabular-nums (used in tabs and sidebar).
- `.crumbs` — 12.5px muted, items separated by `/`, current item `--ink` 500.
- `.page-head` — flex, gap 16px, align start; left: `h1`, `.lede` (muted, max-width 62ch), `.meta` (flex wrap gap 6px: pill, tags, "updated …"); right: `.actions` (margin-left auto, flex gap 8px).
- `.tabs` — flex gap 18px, bottom border line; each `a` padding `8px 0`, muted, 2px transparent bottom border, `margin-bottom: -1px`; `a[aria-current="page"]` ink, 500, accent bottom border. Tabs carry a `.count`.
- `.table-wrap` — `overflow-x: auto`, `border: 1px solid var(--line)`, `border-radius: var(--radius)`, `background: var(--surface)`. Tables inside: `width: 100%; border-collapse: collapse`; `th` = uppercase label style on `--surface-2`, padding `8px 14px`, bottom border; `td` padding `10px 14px`, bottom border line, `vertical-align: middle`; last row no border; `tbody tr:hover td { background: var(--accent-soft) }`. Style tables through `.table-wrap table`, `th`, `td` selectors — do **not** put classes or attributes on the `<td>`s the tests assert (`<td>doc.write</td>`).
- `.panel` — surface, line border, radius, padding `12px 14px`, grid gap 10px; `.panel h3` uses the uppercase label style.
- `.kv` — surface + line border + radius; `.kv-row` grid `minmax(140px, 200px) minmax(0, 1fr) auto`, gap 16px, align center, padding `11px 14px`, bottom border; `.kv-row.revealed` → lock-soft ground and `box-shadow: inset 3px 0 0 var(--lock)`.
- `.masked` — mono, muted, `letter-spacing: 0.2em`.
- `.field-value` — mono, `overflow-wrap: anywhere; white-space: pre-wrap`; `.field-value.multiline` keeps `white-space: pre; overflow-x: auto; display: block; max-width: 100%`.
- `.note` — 12.5px muted, flex gap 8px, align center (the "every reveal is audited" line).
- `.empty` — centered block inside a dashed-border (`1px dashed var(--line)`) radius box, padding 28px, muted text, optional `.btn.primary` below.
- `.alert` (`role="alert"`) — danger-soft ground, danger text, radius-sm, padding `8px 12px`. `.alert.warn` — lock-soft ground, lock text (used for the lint findings box).
- `.toast` — fixed bottom-right (16px), surface, line border, radius, shadow `0 8px 30px rgba(0,0,0,.15)`, padding `10px 14px`, ok-colored check icon, 14px; CSS animation fades it out after 4s (`animation: toast-out .3s ease 4s forwards`); `@media (prefers-reduced-motion: reduce)` disables the animation (toast stays).
- `.menu` — a `<details class="menu">` whose `<summary class="btn ghost">⋯</summary>` opens an absolutely positioned surface list (`.menu-list`, right-aligned, min-width 180px, shadow as toast, radius, padding 4px). Items are full-width `.btn.ghost` left-aligned; destructive item `.danger`.
- `dialog.confirm` — surface, line border, radius, padding 20px, max-width 420px, `::backdrop { background: rgb(0 0 0 / .35) }`; contents: `h2`, message `p`, `.actions` row with `Cancel` (`.btn`, `formmethod="dialog"` or `onclick="this.closest('dialog').close()"`) and the destructive submit (`.btn.danger.solid`).
- Forms: `label` is a block, 12.5px/500 ink with 4px gap before its control; `input:not([type=checkbox]):not([type=radio]), select, textarea` → full width, surface ground, line border, radius-sm, padding `7px 10px`, 14px sans (textarea for values/markdown: mono 13px), focus border accent + ring `0 0 0 3px var(--accent-soft)`. `.form-grid` → grid gap 14px, max-width 640px. `.save-bar` → `position: sticky; bottom: 0`, surface ground, top border, padding `10px 0`, flex gap 8px, z-index 5.
- `.sidebar` internals: `.brand` (22px dark square `pi` mark in mono 11px + "pidb" 600), `.side-search` (a real `<form method="get" action="/search">` with a surface input, placeholder "Search", magnifier icon), `.navgroup` with `h4` uppercase label and `a` items (flex gap 8px, padding `5px 8px`, radius-sm, ink, no underline; `a[aria-current="page"]` → surface ground + `box-shadow: 0 0 0 1px var(--line)` + 500), `.dot.status-active|paused|archived` 7px circles (ok/warn/off), archived items muted, `.count` right-aligned; `.side-foot` pinned at the bottom (margin-top auto, top border) with the username label "admin" and a `Log out` ghost button inside the logout form.

### Icons

One inline SVG sprite in `layout.eta` (hidden `<svg width="0" height="0">` with `<symbol>`s, 16×16 viewBox): `i-lock`, `i-search`, `i-copy`, `i-eye`, `i-plus`, `i-check`, `i-menu`. Use as `<svg class="i" aria-hidden="true"><use href="#i-lock"/></svg>`; `.i { width: 13px; height: 13px; flex: none; vertical-align: -2px }`. Path data:

- lock: `M5 7V5a3 3 0 1 1 6 0v2h.5A1.5 1.5 0 0 1 13 8.5v5A1.5 1.5 0 0 1 11.5 15h-7A1.5 1.5 0 0 1 3 13.5v-5A1.5 1.5 0 0 1 4.5 7H5Zm1.5 0h3V5a1.5 1.5 0 0 0-3 0v2Z` (fill currentColor)
- search: `M7 12.5A5.5 5.5 0 1 0 7 1.5a5.5 5.5 0 0 0 0 11ZM11 11l3.5 3.5` (stroke currentColor 1.6, fill none)
- copy: `M5.5 5.5h8v8h-8zM2.5 10.5v-8h8` (stroke 1.4, fill none)
- eye: `M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5Z` (stroke 1.4, fill none) plus `<circle cx="8" cy="8" r="2" fill="currentColor"/>`
- plus: `M8 3v10M3 8h10` (stroke 1.6)
- check: `M3 8.5l3 3 7-7` (stroke 1.8, fill none)
- menu: `M2 4h12M2 8h12M2 12h12` (stroke 1.6)

### Copy rules

Buttons say what happens: "New secret", "New document", "Edit project", "Delete project…", "Reveal", "Copy", "Hide", "Save", "Create token", "Revoke". Times show `fmt.ago(ms)` in a `<time datetime="ISO" title="ISO">` element. Empty states say what is missing and offer the create action ("No secrets yet." + "New secret").

---

## Task 1: Foundation — fonts, drop Pico, design-system stylesheet

**Files:**
- Modify: `packages/server/package.json` (via npm), `packages/server/src/ui/index.ts`, `packages/server/src/ui/public/app.css` (full rewrite), `packages/server/test/ui.skeleton.test.ts`

**Steps:**

- [ ] 1. `npm i -w @pidb/server @fontsource/ibm-plex-sans @fontsource/ibm-plex-mono` and `npm uninstall -w @pidb/server @picocss/pico`. Confirm nothing else imports Pico (`grep -rn pico packages/ docker/ README.md`); report any hit outside `src/ui/index.ts`, `views/layout.eta` and `test/ui.skeleton.test.ts` as a concern (docs mentioning Pico may be updated to say "custom stylesheet").
- [ ] 2. In `src/ui/index.ts`, replace the Pico root with font serving. The two fontsource packages both contain `files/` and `*.css` with the same file names, so they cannot share one static root. Register two extra `@fastify/static` instances with `decorateReply: false`, same `cacheControl`/`maxAge`/`setHeaders` as the existing one:
  - prefix `/assets/fonts/plex-sans/` → root `join(dirname(require.resolve('@fontsource/ibm-plex-sans/package.json')), 'files')`
  - prefix `/assets/fonts/plex-mono/` → root `join(dirname(require.resolve('@fontsource/ibm-plex-mono/package.json')), 'files')`
  Keep `PUBLIC_DIR` and htmx on `/assets/`. Update the comment ("htmx and the Plex fonts ship inside their packages …"). If `require.resolve('…/package.json')` is blocked by the package's `exports` map, STOP and report BLOCKED with the error.
- [ ] 3. Rewrite `src/ui/public/app.css` as the design system from "Design system" above: `@font-face` rules for IBM Plex Sans 400/500/600 and IBM Plex Mono 400/500, latin subset, `font-display: swap`, `src: url('/assets/fonts/plex-sans/ibm-plex-sans-latin-400-normal.woff2') format('woff2')` (verify the exact file names exist in the installed `files/` directories and use them); a small reset (`box-sizing: border-box`, body margin 0, `img { max-width: 100% }`); tokens (light + dark); base element styles (body, headings, `a` = accent no underline / underline on hover, `p`, `code`, `pre`, `hr`, `small`, tables, forms, buttons, `details`/`summary`, `dialog`, `article` = panel look); every component listed; the shell/sidebar/topbar/nav-drawer layout with the 800px breakpoint; the `.editor` two-column grid (1fr 1fr, gap 16px, one column below 800px) and `.preview` (surface, line border, radius, padding 12px, overflow-x auto) kept for the document editor; `.findings` list styling (lock-colored left border 3px, padding-left 12px). Keep class names `.masked`, `.field-value`, `.multiline`, `.table-scroll`, `.field-rows`, `.row-buttons`, `.row-actions`, `.tabs`, `.editor`, `.preview`, `.findings` defined because current templates use them until later tasks replace them.
- [ ] 4. Update `test/ui.skeleton.test.ts` "serves … from /assets": drop the Pico request; assert `/assets/app.css` 200 with `text/css`, `/assets/htmx.min.js` 200, and one font file per family (`/assets/fonts/plex-sans/<a 400 latin woff2 you referenced>` and `/assets/fonts/plex-mono/<…>`) 200 with content-type containing `font/woff2`. Add an assertion that `app.css` body contains `--accent: #3355cc` and `prefers-color-scheme: dark`. Rename the test to "serves the stylesheet, fonts and htmx from /assets".
- [ ] 5. `layout.eta`: remove the `pico.min.css` `<link>` only (the shell rewrite is Task 2). Add `<meta name="color-scheme" content="light dark">` and remove `data-theme="light"` from `<html>`.
- [ ] 6. `npm run build && npx vitest run` — all green. Commit `feat(ui): replace Pico with the Keyring design-system stylesheet and Plex fonts`.

## Task 2: App shell — sidebar layout, nav data, time helpers, flash toast

**Files:**
- Create: `packages/server/src/repos/nav.ts`, `packages/server/src/ui/format.ts`, `packages/server/src/ui/views/partials/nav.eta`, `packages/server/test/ui.shell.test.ts`, `packages/server/test/ui.format.test.ts`
- Modify: `packages/server/src/ui/forms.ts` (`pageContext`), `packages/server/src/ui/render.ts`, `packages/server/src/ui/views/layout.eta`

**Steps:**

- [ ] 1. `src/repos/nav.ts`:
  ```ts
  export interface NavProject { slug: string; name: string; status: 'active' | 'paused' | 'archived'; docs: number; secrets: number }
  export interface NavData { projects: NavProject[]; globalDocs: number; globalSecrets: number; tokens: number }
  export function loadNav(db: Db): NavData
  ```
  One statement per figure is fine (at most 4 prepared statements; no N+1). Projects ordered by status (`active`, `paused`, `archived`) then `slug`. Counts use correlated `COUNT(*)` subqueries on `documents`/`secrets` by `project_id`; global counts are rows with `project_id IS NULL`; `tokens` counts `api_tokens` with `revoked_at IS NULL` (verify column names in `src/db/migrations.ts`).
- [ ] 2. `src/ui/format.ts`:
  ```ts
  export function iso(ms: number): string          // new Date(ms).toISOString().slice(0, 19) + 'Z'
  export function ago(ms: number, now = Date.now()): string
  ```
  `ago`: `< 60 s` → "just now"; `< 60 min` → "N min ago"; `< 24 h` → "N h ago"; `< 7 d` → "N d ago"; otherwise a short date `"Aug 28"` for the current UTC year, `"Aug 28, 2025"` for other years (English month abbreviations, UTC). Future timestamps (`ms > now`) → "in N min/h/d" using the same buckets, and the "just now" bucket for < 60 s. Also export `FLASH_MESSAGES = { created: 'Created', saved: 'Saved', deleted: 'Deleted', revoked: 'Token revoked' } as const` and `flashFor(raw: unknown): string | null` (returns the whitelisted message or null).
- [ ] 3. `render.ts`: `renderPage` and `renderPartial` pass `fmt: { ago, iso }` into every template's data (`{ ...data, fmt }`), so templates call `it.fmt.ago(x)`.
- [ ] 4. `forms.ts` `pageContext(ctx, req, title)` additionally returns `nav: NavData` (from `loadNav(ctx.db)`), `path` (the request path without query), `activeSlug` (decoded `:slug` when the path starts with `/p/<slug>`, else `null`) and `flash` (`flashFor(query.done)`). Update `PageContext` accordingly; `nav` is no longer the literal `true`. The layout must still render correctly for pages that pass **no** page context (login: `nav: false`; error pages from `src/http/app.ts`: only `title`, `code`, `message`): no sidebar, no toast, no crash on `it.nav` being `undefined`/`false`.
- [ ] 5. `views/partials/nav.eta` renders the sidebar contents (brand link to `/`, search form, Projects group with `.dot` status + slug + `.count` of secrets and `aria-current="page"` on the active project, Global group `Documents`/`Secrets` with counts, Admin group `API tokens` (count) / `Audit log`, `aria-current="page"` when `path` matches, then `.side-foot` with the logout form carrying the CSRF hidden input and a `Log out` button). An empty project list shows a muted "No projects yet" line.
- [ ] 6. `layout.eta` rewrite: `<!doctype html>`, `lang="en"`, charset/viewport/color-scheme meta, `<title><%= it.title %> · pidb</title>`, `app.css` link, htmx script (defer), icon sprite. When `it.nav` is an object: `<div class="shell"><aside class="sidebar">nav partial</aside><div class="topbar">brand + <details class="nav-drawer"><summary class="btn ghost">Menu</summary>nav partial</details></div><main class="main">body</main></div>` and, when `it.flash`, `<div class="toast" role="status"><svg …i-check/> <%= it.flash %></div>`. Otherwise `<main class="main main-bare">body</main>` (centered, max-width 960px, padding-block 48px). Ensure the CSRF hidden input appears **once in the nav partial per render of the partial** — tests take the first `name="csrf" value="…"` match, and all instances carry the same token, so rendering the partial twice (sidebar + drawer) is fine.
- [ ] 7. Tests. `test/ui.format.test.ts`: `iso`; each `ago` bucket at exact boundaries (59 s → "just now", 60 s → "1 min ago", 59 min, 60 min → "1 h ago", 23 h, 24 h → "1 d ago", 6 d, 7 d → short date, other-year date, a future value); `flashFor('saved')` → "Saved", `flashFor('<script>')` → null, `flashFor(['saved'])` → null. `test/ui.shell.test.ts` (log in as in `ui.projects.test.ts`): (a) `/` renders `class="sidebar"`, a link `href="/p/acme"` inside the sidebar and a secret count for a project that has 2 secrets (assert on a unique marker such as `data-count="2"` placed on the `.count` span — add that attribute); (b) on `/p/acme` the sidebar link for acme has `aria-current="page"` and on `/` it does not (slice the sidebar HTML between `<aside class="sidebar">` and `</aside>` before asserting); (c) `/?done=saved` shows `class="toast"` and `Saved`; `/?done=%3Cscript%3E` has no toast and does not contain `<script>` from the query; (d) `GET /login` (anonymous) renders no `class="sidebar"`; (e) an unknown path renders the 404 page without a sidebar and without throwing. For each of (a)–(c), break the feature deliberately once (e.g. remove `aria-current`) and confirm the assertion fails; note it in the report, then restore.
- [ ] 8. `npm run build && npx vitest run` — all green. Commit `feat(ui): add the sidebar app shell, nav counts, relative times and flash toast`.

## Task 3: Projects list, project page, search, global documents list

**Files:**
- Modify: `views/projects.eta`, `views/project.eta`, `views/partials/tabs.eta`, `views/search.eta`, `views/documents.eta`, `src/ui/routes/projects.ts` (redirect locations only), `test/ui.projects.test.ts`, `test/ui.project-page.test.ts` (location assertions only), plus new assertions in those files.

**Steps:**

- [ ] 1. `projects.eta`: `.page-head` with `h1` "Projects" and `.actions` holding a `New project` primary button that opens `<dialog class="confirm" id="new-project">` containing the existing create form (same fields and names, `.form-grid`); when `it.error` is set, render the error `role="alert"` inside the dialog and open it on load (`<dialog … open>` is acceptable; prefer calling `showModal()` from a tiny inline script guarded by `if (!dlg.open)`). Status filter as a row of links styled like `.tabs` (keep `aria-current="page"` logic exactly: `all` link current when `it.status === ''`, add that). Table in `.table-wrap`: Project (slug mono link + name muted below), Status (`.pill status-*`), Tags (`.tag`s), Updated (`<time>` with `it.fmt.ago`). Archived rows get class `is-archived` (muted text). Empty list → `.empty` "No projects yet." + `New project` button (when filtered: "No <status> projects.").
- [ ] 2. `project.eta`: `.crumbs` (`Projects` link → `/`, then slug); `.page-head`: `h1` name, `.lede` summary, `.meta` pill + tags + "updated …"; `.actions`: `Edit project` button opening `<dialog class="confirm" id="edit-project">` with the existing edit form (same action, names), and a `.menu` with `Delete project…` that opens `<dialog class="confirm" id="delete-project">` containing the existing delete form (keep the CSRF input and action; replace the `onsubmit="return confirm(…)"` with the dialog; message "Delete <slug>, its documents and its secrets? This cannot be undone.").
  Tabs partial: `Documents` / `Secrets`, each with `.count` (counts come from `it.project.documents.length` / `it.project.secrets.length` — pass them into the partial). Keep `aria-current` rendering with `<%~` exactly as today.
  Docs tab: toolbar row (right: `New document` primary with plus icon); table: Document (title link + slug mono muted), Category (`.tag`), Updated (`<time>`). Empty → `.empty` "No documents yet." + `New document`.
  Secrets tab: toolbar row (left: `.note` with lock icon "Locked fields stay hidden until revealed; every reveal is audited."; right: `New secret` primary); table: Name (mono link), Fields (`.chip` per field; sensitive → `.chip.lock` with lock icon and key; non-sensitive with a value → chip shows `key` and the value follows as a muted mono `= value` inside the chip — the non-sensitive value must still appear in the page, test asserts `db.internal`), Description (muted), Updated (`<time>` of `updated_at` if present on the list item, else omit the column — check `PublicSecret` has `updated_at`; it does). Remove the `* sensitive` footnote. Empty → `.empty` "No secrets yet." + `New secret`.
- [ ] 3. `search.eta`: `.page-head` h1 "Search"; a search form (`role="search"`, input `name="q"`, `Search` button) in one row; results grouped under `h2` with a `.count`; each result as a `.table-wrap` table or a list of rows with the scope as a `.tag` (`global` or project slug) and the doc category as `.tag`, snippet muted. No results for a non-empty `q` → `.empty` "Nothing matches “q”." (escaped).
- [ ] 4. `documents.eta` (global docs): same doc table as the project docs tab, `.crumbs` "Global / Documents", `New document` primary, empty state.
- [ ] 5. Redirects in `src/ui/routes/projects.ts`: create → `/p/<slug>?done=created`; update → `/p/<slug>?done=saved`; delete → `/?done=deleted`. Update the three matching `headers.location` assertions (`ui.projects.test.ts:65`, `ui.project-page.test.ts:58`, `ui.project-page.test.ts:82`).
- [ ] 6. New assertions: project page secrets tab renders `class="chip lock"` for `password` and no `*` footnote text `sensitive — value hidden`; tabs show counts (`data-count` attribute on the tab count); the delete form lives inside `<dialog` (`/<dialog[^>]*id="delete-project"[\s\S]*action="\/p\/acme\/delete"/`); an empty project shows "No secrets yet." on the secrets tab; `?status=paused` with no paused projects shows "No paused projects."; search with no hits shows the empty message and escapes `q`.
- [ ] 7. Build + full suite green. Commit `feat(ui): restyle projects, project page, search and global documents`.

## Task 4: Secret page — key/value rows, auto-hiding reveal, recent access panel

**Files:**
- Modify: `src/repos/audit.ts`, `src/services/secrets.ts`, `src/ui/routes/secrets.ts` (GET secret page data only), `views/secret.eta`, `views/partials/revealed.eta`, `views/secrets.eta`, `test/ui.secrets.test.ts`
- Create: `test/ui.secret-access.test.ts`

**Steps:**

- [ ] 1. `repos/audit.ts`: `export function listAuditForTarget(db: Db, targetType: string, targetId: number, limit = 5): AuditRow[]` — `WHERE target_type = ? AND target_id = ? ORDER BY ts DESC, id DESC LIMIT ?` (limit clamped 1–50), same row mapping as `listAudit` (extract the shared row-mapping into a local function rather than duplicating it).
- [ ] 2. `services/secrets.ts`: `export function recentSecretAccessFor(ctx, principal, projectSlug: string | null, name: string, limit = 5): AuditRow[]`. It must enforce the same access checks `getSecretFor` does for that scope (reuse the same resolution helper `getSecretFor` uses — read the file) **and** require the `admin` scope (`assertScope(principal, 'admin')`), because the audit log is admin-only. Unknown secret → `NotFoundError` as `getSecretFor`.
- [ ] 3. Route `GET <base>/:name` passes `access: recentSecretAccessFor(ctx, principal, scope.projectSlug, secret.name)` and `cliRef: scope.projectSlug ? \`${scope.projectSlug}/${secret.name}\` : secret.name` (check `packages/cli` for how a global secret is addressed in `pidb secret env`; use that form and cite the file in the report).
- [ ] 4. `secret.eta`: `.crumbs` (Projects / slug link to `?tab=secrets` / Secrets / name — or Global / Secrets / name); `.page-head`: `h1.mono` name, `.lede` description, `.meta` tags; `.actions`: `Edit` button link and a `.menu` with `Delete secret…` opening `<dialog class="confirm" id="delete-secret">` with the existing delete form. Body: two-column grid (`minmax(0,1fr) 280px`, one column below 1000px): left `.kv` with one `.kv-row` per field — key cell (mono; sensitive keys lock-colored with lock icon), value cell `data-field="<key>"` (sensitive → `.masked` `••••••••••••`; non-sensitive → `.field-value` span as today), action cell (sensitive → the existing htmx reveal form with a `Reveal` `.btn.sm` including the eye icon; non-sensitive → a `Copy` `.btn.sm.ghost` that copies the value). **Change the reveal `hx-target`** to the `.kv-row` action+value pair: simplest compliant structure is `hx-target="closest .kv-row"` with `hx-swap="outerHTML"` and the partial rendering the whole row; the partial then receives `key` and `value` only (plus whatever it already gets) and renders the row with class `kv-row revealed`, the key cell, the value, a countdown `<span class="timer" data-seconds="30">hides in 30 s</span>`, `Copy` and `Hide` buttons. `hideField(btn)` must restore a masked row with a working `Reveal` form: store the original row's HTML on reveal (e.g. before swap via `htmx:beforeSwap` listener keyed by field, or render the masked row template into a `<template id="masked-<key>">` on page load) — choose the `<template>` approach: the secret page renders one `<template data-masked-row="<key>">` per sensitive field containing the masked row markup (with CSRF input), and `hideField(btn)` replaces the revealed row with a clone of that template. A small inline script on the secret page starts a 1-second interval for every `.timer[data-seconds]` present after each `htmx:afterSwap`, updates the text ("hides in N s"), and calls `hideField` on the row's Hide button at 0. Keep `function hideField(` defined on the secret page and `onclick="hideField(this)"` + `>Hide</button>` in the partial. Copy buttons: `navigator.clipboard.writeText(…)` and swap the label to "Copied" for 1.5 s. `respect prefers-reduced-motion` is not relevant (no animation) but the timer must stop if the row is hidden manually.
  Right column: `.panel` with `h3` "Use without revealing" and `<pre><code>pidb secret env <cliRef></code></pre>` (plus `exec` and `write` mentioned in one muted line), then `h3` "Recent access" and a list of up to 5 rows: `<time>` ago, actor (`you` for `actor_type = 'admin'`, `token #<actor_id>` otherwise), action verb (`secret.reveal` → "revealed <field_key>" in lock color; `secret.update` → "edited"; `secret.create` → "created"; `secret.reveal_all` or any other → the raw action in mono). Empty → muted "No access recorded yet." Link "Full audit log" → `/audit`.
  Keep the "Every reveal is written to the audit log" message as a `.note` above the `.kv`.
- [ ] 5. `secrets.eta` (global secrets list): same table styling as the project secrets tab (chips, lock chips, empty state), `.crumbs` "Global / Secrets", `New secret` primary.
- [ ] 6. Tests. Existing `ui.secrets.test.ts` stays green (adjust nothing except if the reveal-partial assertions need the new markup — they must still pass unchanged). New `ui.secret-access.test.ts`: (a) after a reveal of `password`, the secret page's recent-access panel contains `revealed` and `password`, and the page still does **not** contain the secret value; (b) access rows of a *different* secret do not appear (create two secrets, reveal on one, assert the other page shows "No access recorded yet."); (c) `listAuditForTarget` respects limit and order (insert 7 audit rows for one target via `writeAudit`, assert 5 newest ids in order); (d) `recentSecretAccessFor` with a token principal lacking `admin` throws `ForbiddenError` (build a `Principal` literal); (e) the reveal partial contains `class="kv-row revealed"`, `data-seconds="30"`, `>Hide</button>`, `onclick="hideField(this)"`; (f) the secret page contains exactly one `<template data-masked-row="password">` and none for the non-sensitive `host`, and that template contains `name="csrf"` and `/reveal`. Deliberately break (a) and (f) once each to see them fail.
- [ ] 7. Build + full suite green. Commit `feat(ui): secret page with auto-hiding reveal, copy and recent access`.

## Task 5: Secret editor, document view and document editor

**Files:**
- Modify: `views/secret-edit.eta`, `views/document.eta`, `views/document-edit.eta`, `views/partials/preview.eta`, `src/ui/routes/secrets.ts` and `src/ui/routes/documents.ts` (redirect locations only), `test/ui.secret-edit.test.ts`, `test/ui.document-edit.test.ts`, `test/ui.documents.test.ts` (location assertions + new assertions)

**Steps:**

- [ ] 1. `secret-edit.eta`: `.crumbs`; `h1` "New secret" / "Edit secret"; errors as `.alert`. Top `.form-grid`: Name, Description, Tags (hint text "comma separated" as muted small under the input). Fields section `h2` "Fields" + muted hint "Leave a locked value empty to keep the stored one." (edit only). Replace the table with a list `#rows` of `.field-card` elements (surface, line border, radius, padding 10px 12px, grid `minmax(120px, 200px) minmax(0, 1fr) auto`, gap 10px, align start; single column below 700px), one per row, **in this attribute-exact form**: key `<input name="key" value="…" placeholder="password" aria-label="Key" />`; value `<textarea name="value" rows="…" placeholder="…" spellcheck="false" aria-label="Value">…</textarea>` (`name` stays the first attribute); a lock toggle `<button type="button" class="btn sm lock-toggle" aria-pressed="true|false" onclick="toggleLock(this)">` showing the lock icon + "Locked" or "Visible", paired with `<input type="hidden" name="sensitive" value="1|0" />` inside the same card; then the existing move up / move down / remove buttons (keep `moveRow(this, -1)` and `moveRow(this, 1)` in the markup). `toggleLock` flips the hidden input between `1` and `0`, `aria-pressed`, the label and a `is-locked` class on the card (locked cards: lock-colored left inset shadow like `.kv-row.revealed` but 2px). `addRow(key)` builds the same card markup (new rows start Locked unless the key is one of `it.hintKeys`, which start Visible — mirror `defaultSensitive` semantics by rendering the list of non-sensitive keys into the script as JSON via `<%~ JSON.stringify(it.hintKeys) %>` after confirming `hintKeys` are plain identifier strings from `@pidb/shared` `NON_SENSITIVE_KEYS`). `moveRow` works on `.field-card` instead of `tr` (update `closest('tr')` → `closest('.field-card')`). Row helper buttons for hint keys stay (`Add field`, then one `.btn.sm` per hint key). Bottom: `.save-bar` with `Save` primary and a `Cancel` link back to the secret (or scope list when new).
- [ ] 2. `document.eta`: `.crumbs`; `.page-head` h1 title, `.meta` slug mono + category `.tag` + `<time>` updated; `.actions`: `Edit` button + `.menu` with `Delete document…` → `<dialog class="confirm" id="delete-document">` with the existing delete form. Body: two columns (`minmax(0, 1fr) 260px`, one column below 1000px): left `<article class="doc">` with the rendered markdown (typography: max-width 72ch, headings 18/16/14px 600, paragraphs 14.5px/1.65, lists, `code` mono on `--side`, `pre` on `--surface-2` with radius and overflow-x auto, tables with line borders, blockquote with line left border and muted text). Right `.panel` "Referenced secrets" (only when refs exist): each ref as link (mono) + chips for its fields (lock chips for sensitive), then the muted "Values are never shown here…" line.
- [ ] 3. `document-edit.eta`: `.crumbs`; h1; `.alert` for error; lint findings box as `.alert.warn` with heading "This document looks like it contains secret material." and the `.findings` list; `.form-grid` row with Slug (readonly when editing), Title, Category side by side (grid 3 columns ≥ 800px); `.editor` grid with the textarea (mono, `rows="24"`, keep every `hx-*` attribute exactly) and `#preview` whose initial content is `<div class="preview"><em>Preview appears as you type.</em></div>`; `.save-bar` with `Save` primary, `Save anyway` (`.btn.danger`, only when findings exist, same `name="force" value="on"`) and `Cancel` link. `partials/preview.eta`: same structure, findings styled as `.alert.warn` + `.findings`, preview inside `.preview doc`.
- [ ] 4. Redirects: secret create → `…/secrets/<name>?done=created`; secret update → `…/secrets/<name>?done=saved`; secret delete → `<prefix>?tab=secrets&done=deleted` or `/global/secrets?done=deleted`; document save → `…/docs/<slug>?done=saved`; document delete → `<prefix>?done=deleted` or `/global/docs?done=deleted`. Update the matching `headers.location` assertions (`ui.secret-edit.test.ts:56, 242, 263`, `ui.document-edit.test.ts:42`, `ui.documents.test.ts:110`). Every one of these pages already calls `pageContext`, so the toast appears automatically.
- [ ] 5. New assertions in `ui.secret-edit.test.ts`: the edit form renders one `<input type="hidden" name="sensitive" value="1" />` for `password` and `value="0"` for `host`, in field order (regex over the body); each `.field-card` contains exactly one `name="sensitive"`; a POST built from that rendered form (keys + values + sensitive in order, changed `host` value, empty password) still saves and keeps `password` sensitive (reuse the existing round-trip test pattern in the file); `aria-pressed="true"` appears for the locked row. In `ui.documents.test.ts`: the delete form is inside `<dialog`; refs panel shows `class="chip lock"` for a sensitive referenced field.
- [ ] 6. Build + full suite green. Commit `feat(ui): restyle the secret editor and document pages`.

## Task 6: Tokens, audit log, login and error pages

**Files:**
- Modify: `views/tokens.eta`, `views/audit.eta`, `views/login.eta`, `views/error.eta`, `src/ui/routes/admin.ts` (revoke redirect only), `test/ui.tokens.test.ts`, `test/ui.audit.test.ts`, `test/ui.auth.test.ts` (new assertions only)

**Steps:**

- [ ] 1. `tokens.eta`: `.page-head` h1 "API tokens" + `New token` primary opening `<dialog class="confirm" id="new-token">` containing the existing create form (same names; scopes as a checkbox grid of `.chip`-styled labels, projects input with the datalist, expiry days); when `it.error` → `.alert` inside the dialog and the dialog opens on load (same technique as Task 3). When `it.created`: a `.panel` with lock-soft ground above the table, heading "Token created — shown once", the token in `.field-value` mono inside a bordered box with a `Copy` button, and the muted "Copy it now: pidb stores only a hash…" line. Table in `.table-wrap` with headers exactly `ID`, `Name`, `Prefix`, `Scopes`, `Projects`, `Expires`, `Last used`, `State`, `` (keep plain `<th>Prefix</th>`): prefix mono; scopes as `.chip`s; projects as `.tag`s or muted "all"; expires/last used as `<time>` (`it.fmt.ago`; "never" / "—" when null); state as `.pill status-active` "active" or `.pill status-archived` "revoked"; revoked rows class `is-archived`; Revoke as `.btn.sm.danger` inside a form that opens a `dialog.confirm` ("Revoke <name>? Clients using it stop working immediately.") — one dialog per row is acceptable. Empty → `.empty` "No API tokens yet." + `New token`.
- [ ] 2. Revoke redirect → `/tokens?done=revoked`; update `ui.tokens.test.ts:68`.
- [ ] 3. `audit.eta`: `.page-head` h1 "Audit log"; filters as a compact inline toolbar form (`.toolbar`: flex wrap gap 8px, align end; Action input, Actor select, Rows input, `Filter` button, and a ghost `Reset` link to `/audit`); table headers unchanged (`ID`, `When`, `Actor`, `Action`, `Target`, `Field`, `IP`). Cells: keep `<td><%= r.id %></td>` and `<td><%= r.action %></td>` **without attributes** (tests assert `<td>doc.write</td>`); put color-coding on the `<tr>` instead: `class="act-reveal"` for actions ending in `reveal` or `reveal_all` (lock-colored action text + lock-soft row ground via `tr.act-reveal td`), `act-delete` for actions ending in `.delete`/`revoke` (danger-colored action text), `act-auth` for actions starting `auth.` (muted). When: `<time>` with ago text and ISO title. Actor: `admin` or `token #id`. Target mono. Pagination: `Newest` ghost link and `Older →` `.btn.sm`. Empty → `.empty` "No audit entries match these filters."
- [ ] 4. `login.eta`: centered card (surface, line border, radius, padding 28px, max-width 360px, margin 10vh auto): brand mark + "pidb" + muted "Admin sign in"; `.alert` for the error; Username/Password labels and inputs (same names/autocomplete); full-width `Log in` primary button.
- [ ] 5. `error.eta`: centered card like login: big muted code (mono 12.5px uppercase), message, `Back to projects` button link. It renders without page context (see Task 2 step 4).
- [ ] 6. New assertions: tokens page renders `class="pill status-active"` for an active token and `status-archived` for a revoked one; audit page renders `class="act-reveal"` on a row after a reveal while still containing `<td>secret.reveal</td>`; login page contains no `class="sidebar"` and still contains `name="username"`.
- [ ] 7. Build + full suite green. Commit `feat(ui): restyle tokens, audit log, login and error pages`.

## Task 7: Cross-page consistency and README

**Files:**
- Modify: `README.md` (Admin UI section), any template still using Pico-era markup, `src/ui/public/app.css` (dead-rule cleanup)

**Steps:**

- [ ] 1. `grep -rn 'role="button"\|class="secondary\|class="outline\|<article' packages/server/src/ui/views` and convert remaining Pico-era classes to the component vocabulary (`.btn`, `.btn.ghost`, `.panel`). Remove CSS rules for classes no template uses any more (`grep` each class in `views/` before removing; keep `.masked`, `.field-value`, `.multiline`, `.findings`, `.editor`, `.preview`).
- [ ] 2. Start the server locally against a throwaway data dir with a seeded admin, one project with docs and secrets, one global secret, one token (use the existing CLI/`pidb-server` commands documented in README; report the exact commands). `curl` each page (`/`, `/p/<slug>`, `/p/<slug>?tab=secrets`, a secret page, secret edit, a doc page, doc edit, `/global/docs`, `/global/secrets`, `/tokens`, `/audit`, `/search?q=a`, `/login`, a 404) with the session cookie and confirm 200/404 and that each page references `/assets/app.css` and contains no `pico`. Stop the server. This step is evidence only — do not add screenshots to the repo.
- [ ] 3. README "Admin UI" section: replace any mention of Pico with "a small custom stylesheet (IBM Plex, light and dark themes)"; mention the sidebar, per-secret recent access and auto-hiding reveals in one short paragraph.
- [ ] 4. Build + full suite green. Commit `chore(ui): remove Pico-era markup and document the new admin UI`.

## Done criteria

- No `pico` reference remains in `packages/server` (package.json, src, tests) or README.
- Every page renders inside the shell (except login/error), in light and dark via `prefers-color-scheme`.
- Full suite green after `npm run build`; new tests from Tasks 2, 3, 4, 5, 6 present.
- No change to routes, form field names/encoding, CSRF, reveal auditing or cache headers beyond the `?done=` redirects.
