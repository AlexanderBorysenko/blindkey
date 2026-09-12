# SDD ledger — plan: docs/superpowers/plans/2026-09-12-core-server.md

Worktree: .claude/worktrees/core-server, branch worktree-core-server, base ed80e61 (master).
Spec: docs/superpowers/specs/2026-09-12-projects-info-db-design.md (read; binding authority).
Helper scripts (CRLF-stripped copies): /private/tmp/claude-501/-Users-Alex-Documents-projects-projects-info-db/86b63353-f442-49d9-9018-019b3ae1232a/scratchpad/sdd/{sdd-workspace,task-brief,review-package}

## Preflight scan

### Pairs sharing a file/interface
| tasks | produces → consumes | finding |
|---|---|---|
| T1 → T2 | schemas.ts constants; T2 appends zod schemas, moves `import { z }` to top | consistent |
| T1 → T3, T4 | index.ts re-exports added | consistent |
| T1 → T9 | `defaultSensitive` | consistent |
| T2 → T9 | SecretInput/SecretPatch (description/tags defaults) | consistent |
| T2 → T13 | `docSlugSchema`, DocumentInput.force default false | consistent |
| T2 → T15 | tokenInputSchema.projects/expires_at null defaults; authTokenRequest.name default 'cli' | consistent |
| T5 → T9, T17 | KeyRing {current, keys} | consistent |
| T6 → T8/T9/T10 | schema columns, COALESCE unique indexes, FTS triggers | consistent (global+project same secret name allowed by COALESCE(...,0)) |
| T7 → T9 | envelope fns, CryptoError(500 decrypt_failed) | consistent |
| T7 → T10 | generateToken prefix 8 / secret 43 base64url chars | consistent |
| T8 → T12 | ProjectRow → publicProject | consistent |
| T9 → T14 | SecretFieldMeta/revealField/revealAllFields; field order via sort (upsert keeps sort) | consistent; test order ['host','password','note','port'] verified |
| T10 → T11 | findActiveTokenByValue/touchToken/writeAudit; listAudit ORDER BY ts DESC, id DESC | consistent; audit-order assertions in T12/T14/T15 rely on id DESC tiebreak — OK |
| T11 → T12–T16 | actorOf/principalOf/parseBody, loadProjectFor/auditAs, error shape `{error, message, ...details}` | consistent with T13 `{error:'unresolved_refs', message:'unresolved_refs', unresolved}` |
| T11 → T15 | rate-limit plugin global:false; route config rateLimit + public:true | consistent |
| T12 → T13, T14, T16 | serialize.ts publicDoc/publicSecret | consistent |
| T3 → T13 | SecretRef {raw, project, global, name}; resolveRefs treats out-of-scope project as unresolved | consistent with T13 test (beta/X unresolved for alpha-scoped token) |
| T4 → T13, T16 | lintForSecrets findings `{line, reason}` | consistent |
| T12–T14 services → T16 | tool wrappers call services; no reveal tool | consistent with spec §9 |
| T8/T9/T10 → T17 | runInit/runRotateKey/runBackup | consistent |
| T17 → T18 | build/typecheck/full suite | consistent |

### Per-task self-consistency
| task | check | finding |
|---|---|---|
| T1 | deps vs later imports (rate-limit, mcp sdk, argon2, better-sqlite3, commander, zod) | consistent; `pino` listed but unused in Plan 1 — harmless |
| T2 | slug regex vs test cases ('', 'abc-', '-abc') | consistent |
| T3 | REF_RE vs malformed test cases | consistent |
| T4 | ASSIGN_RE `\b(password|...)` vs test `DB_PASSWORD=hunter2hunter2` | **DEFECT**: `\b` before `password` cannot match after `_` (both \w). Plan's hint (looksLikeRealValue length) is the wrong diagnosis. See Ruling R1. |
| T4 | git SHA-1 negative, fenced example, sk-proj | consistent |
| T5 | tests vs loadConfig | consistent |
| T6 | FTS external-content triggers vs test | consistent |
| T7 | tests vs code | consistent |
| T8 | `searchDocuments('"unbalanced (')` expects [] — FTS5 phrase `"("` may tokenize empty | uncertain; leave to implementation/review |
| T9 | sort/upsert order vs test | consistent |
| T10 | tests vs code | consistent |
| T11 | not-found handler must run onRequest auth hook; `req.routeOptions.config.public` on 404 route | uncertain (Fastify 5 behavior); leave to implementation/review |
| T12–T15 | audit order assertions, scope/404 assertions | consistent |
| T16 | Fastify hijack + StreamableHTTPServerTransport JSON mode | plausible; plan gives fallback notes |
| T17 | backup filename regex vs stamp; keep pruning | consistent |
| T18 | README only | consistent |

## Rulings
- Ruling R1 (T4): replace leading `\b` in ASSIGN_RE with `(?<![A-Za-z])` so `DB_PASSWORD=...` matches — the plan's own test mandates this case and the plan's regex cannot satisfy it; spec §5 lists `password|...` "followed by = or :" with no word-boundary requirement. Cost if wrong: slightly noisier lint (false positives on suffixes like `mypassword=`), fixable in review.

## Progress
Task 1: complete (commits ed80e61..327a0ed, review clean; ⚠️ commit trailer verified by controller)
Task 2: implemented 327a0ed..0e33dba (agent afe797f4ba53fa9d3), awaiting review
Task 2: complete (commits 327a0ed..0e33dba, review clean)
Task 3: implemented 0e33dba..4e5705d (agent acdcb6285ceb239d6), awaiting review
Task 3: Ruling R2: reviewer (plan-mandated, Important) — parser accepts {{secret:a/b/c}} as project 'a', name 'b/c'. Ruling: keep plan code as is. A name containing '/' can never exist (schema rejects), so resolveRefs (T13) reports it under 'unresolved' → 422 on save, a better signal than silently dropping it as malformed. Cost if wrong: parsed names may contain '/', misleading any consumer that trusts them without lookup — none exists in Plan 1; re-evaluate if Plan 2/3 render refs without resolving.
Task 3: minor (deferred): no test documenting multi-slash ref behaviour ({{secret:a/b/c}})
Task 3: complete (commits 0e33dba..4e5705d, 1 parked via Ruling R2)
Task 4: implemented 4e5705d..499efed (agent a5fa02853c3a25d9f, Ruling R1 applied), awaiting review
Task 4: Ruling R3 (plan-mandated, Important): HEX_RE threshold 48 leaves 32–47-char pure-hex secrets unflagged; spec §5 says ≥32. Ruling: flag pure-hex runs ≥32 chars EXCEPT exactly 40 chars (git SHA-1, the plan's own explicit negative test). Cost if wrong: false positives on 64-hex sha256 digests in deploy docs (override via force or example fence).
Task 4: Ruling R4 (plan-mandated, Important): unclosed ```example fence exempts the rest of the document. Ruling: only a properly closed example fence exempts its lines; an unclosed fence's lines are linted (fail closed). Cost if wrong: a doc whose last block is an intentionally unclosed example fence gets lint findings — acceptable for a security lint.
Task 4: minor (deferred): ruled lookbehind (?<![A-Za-z]) also matches after digits ('1Password: ...' → safe-direction false positive); (?<![A-Za-z0-9]) would be tighter
Task 4: minor (deferred): 4+ backtick fences not tracked by FENCE_RE
Task 4: fix round 1/5 started — findings: hex dead zone (R3), unclosed example fence (R4); FIX_BASE 499efed
Task 4: fix round 1/5 (2 addressed, 0 open — hex dead zone R3, unclosed example fence R4; commits 499efed..7991a4f)
Task 4: complete (commits 4e5705d..7991a4f, review clean after round 1)
Task 5: implemented 7991a4f..377d5d6 (agent aff073dbadea47716), awaiting review
Task 5: Ruling R5 (plan-mandated, Important): loadConfig accepts PIDB_PORT=0 — reject port < 1 alongside the existing > 65535 check. Cost if wrong: none (port 0 is never a valid fixed listen port for a proxied server).
Task 5: Ruling R6 (plan-mandated, Important): duplicate versions in PIDB_MASTER_KEY_PREVIOUS silently overwrite — throw ConfigError on a repeated version. Cost if wrong: an operator who intentionally listed a version twice must dedupe their env; trivial.
Task 5: minor (deferred): unreadable PIDB_MASTER_KEY_FILE throws raw Node error, not ConfigError
Task 5: minor (deferred): Buffer.from(b64,'base64') tolerates invalid chars; length check is the only guard
Task 5: minor (deferred): no tests for PIDB_HOST / PIDB_LOG_LEVEL overrides
Task 5: fix round 1/5 started — findings: port lower bound (R5), duplicate previous versions (R6); FIX_BASE 377d5d6
Task 5: fix round 1/5 (2 addressed, 0 open — port lower bound R5, duplicate previous versions R6; commits 377d5d6..b5d8b42)
Task 5: complete (commits 7991a4f..b5d8b42, review clean after round 1)
Task 6: implemented b5d8b42..102ff24 (agent ad977ee164a4f97db), awaiting review
Task 6: minor (deferred): no plain index on secrets.project_id / documents.project_id (expression UNIQUE index won't serve WHERE project_id = ?)
Task 6: minor (deferred): MIGRATIONS not sorted by id before iteration; COALESCE(project_id,0) assumes no project id 0
Task 6: complete (commits b5d8b42..102ff24, review clean)
Task 7: implemented 102ff24..4f71ad3 (agent acb4bbc5b97c8b7e0), awaiting review
Task 7: Ruling R7 (plan-mandated, Important): open()/seal() build the cipher outside the try, so a wrong-length key (e.g. corrupted dek_wrapped yielding a non-32-byte DEK) throws a raw RangeError → 500 'internal' instead of 500 'decrypt_failed'. Ruling: wrap cipher construction in the same try/catch → CryptoError; add a wrong-length-key test. Cost if wrong: none (only widens the error mapping).
Task 7: minor (deferred): verifyPassword swallows malformed-hash errors as false (fail-closed, but undiagnosable)
Task 7: minor (deferred): parseTokenPrefix 'm[1] ?? null' dead branch
Task 7: fix round 1/5 started — finding: wrong-length key not mapped to CryptoError (R7); FIX_BASE 4f71ad3
Task 7: fix round 1/5 (1 addressed, 0 open — cipher errors → CryptoError R7; commits 4f71ad3..c55e335)
Task 7: complete (commits 102ff24..c55e335, review clean after round 1)
Task 8: implemented c55e335..56d51a8 (agent a903a444169d08b7c), awaiting review
Task 8: minor (deferred): parseJsonArray swallows corrupt JSON as []; inList('') for empty arrays yields invalid SQL if a future caller forgets the guard
Task 8: complete (commits c55e335..56d51a8, review clean)
Task 9: implemented 56d51a8..176302a (agent abef5595b36cea377), awaiting review
Task 9: controller amended commit message trailer (implementer wrote 'Claude Haiku 4.5'); 176302a → 08e52a0, content unchanged
Task 9: minor (deferred): rewrapAllSecrets SELECT outside the transaction (safe single-process); revealField null vs NotFound asymmetry — T14 service maps null → 404
Task 9: complete (commits 56d51a8..08e52a0, review clean)
Task 10: implemented 08e52a0..9ed18dc (agent ad5a4b0d7d8019052), awaiting review
Task 10: Ruling R8 (plan-mandated, Important): listAudit 'before' filters ts < ? so rows sharing a ts at a page boundary become unreachable. Ruling: 'before' becomes an audit-row id cursor (WHERE id < ?); ORDER BY ts DESC, id DESC unchanged. Spec §8 names the param but not its type. Cost if wrong: Plan 2/3 consumers must pass the last row's id, not a timestamp — note for README/CLI.
Task 10: minor (deferred): single-admin invariant enforced only in app code; no composite audit index for filtered listing
Task 10: fix round 1/5 started — finding: audit before-cursor tie loss (R8); FIX_BASE 9ed18dc
Task 10: fix round 1/5 (1 addressed, 0 open — audit id cursor R8; commits 9ed18dc..acefe63)
Task 10: complete (commits 08e52a0..acefe63, review clean after round 1)
Task 11: implemented acefe63..e6c718c (agent a839b2789c0bb288a), awaiting review
Task 11: Ruling R9 (plan-mandated, Important): FailureLimiter.prune() keeps an empty array per IP forever → unbounded Map growth on an internet-facing server. Ruling: delete the key when the pruned list is empty; expose a read-only size getter for the test. Cost if wrong: none.
Task 11: minor (deferred): blocked IP gets 429 even with a valid token (intentional brute-force lockout; comment it)
Task 11: minor (deferred): non-Bearer / missing Authorization attempts are neither audited nor rate-limited
Task 11: minor (deferred): generic 4xx branch of error handler echoes Fastify's raw message as bad_request (malformed JSON body); 401 body carries extra message field
Task 11: fix round 1/5 started — finding: limiter map growth (R9); FIX_BASE e6c718c
Task 11: fix round 1/5 (1 addressed, 0 open — limiter eviction R9, implementer also re-set list in record() to keep recording working; commits e6c718c..70fac03)
Task 11: minor (deferred): limiter eviction is lazy (an IP never touched again stays in the Map); timer sweep not required by ruling
Task 11: complete (commits acefe63..70fac03, review clean after round 1)
Task 12: implemented 70fac03..184f5f3 (agent a20f9100924f14dd0), awaiting review
Task 12: Ruling R10 (plan-mandated, Important per reviewer): serializers add created_at (projects, doc summaries) and created_at/updated_at (secrets) beyond the field lists in spec §8. Ruling: keep — spec lists are minimal shapes, the additions are non-sensitive metadata, ids stay hidden, and Plan 3's UI needs them. Cost if wrong: clients see extra fields; trivially removable in serialize.ts.
Task 12: minor (deferred): admin token with restricted project_ids can POST a project it then cannot read (no self-escalation; product call)
Task 12: minor (deferred): 400 tests do not assert the issues key; delete audit meta lacks cascade counts
Task 12: complete (commits 70fac03..184f5f3, 1 parked via Ruling R10)
Task 13: implemented 184f5f3..767bf7a (agent ab727780e9e64465f) with a self-reported deviation (refs stripped before lint), awaiting review
Task 13: Ruling R11 (Critical, implementer deviation): a {{secret:...}} reference must never be a lint finding, but the service-level regex \{\{[^}]*\}\} blanks ANY braces (bypass) and lives in the wrong layer. Ruling: remove the service preprocessing; inside lintForSecrets (shared) blank only genuine refs (same grammar as parseSecretRefs) with equal-length spaces before scanning each line, so line/column numbering is preserved; unit-test both the ref exemption and a non-ref {{...}} still being linted. Cost if wrong: none — narrows an over-broad exemption.
Task 13: Ruling R12 (plan-mandated, Important): ?resolve=meta returned secret field keys/sensitivity to any docs:read principal. Ruling: include refs only when the principal has secrets:meta (hasScope); otherwise omit the key. Consistent with spec 'sections omitted when scope missing'. Cost if wrong: an agent with docs:read only loses ref hints — it cannot use secrets anyway without a secrets scope.
Task 13: minor (deferred): implementer report claims verbatim while documenting a deviation
Task 13: fix round 1/5 started — findings: ref-strip bypass/layer (R11), resolve=meta scope (R12); FIX_BASE 767bf7a
Task 13: fix round 1/5 (2 addressed, 0 open — shared lint ref exemption R11, resolve=meta gated on secrets:meta R12; commits 767bf7a..3d4fc15)
Task 13: complete (commits 184f5f3..3d4fc15, review clean after round 1)
Task 14: implemented 3d4fc15..19154fb (agent a31fdbbd276e72044), awaiting review
Task 14: minor (deferred): tests assert only .scope on 403, no removeFields PATCH test, no decrypt_failed 500 path test
Task 14: complete (commits 3d4fc15..19154fb, review clean)
Task 15: implemented 19154fb..cbf4802 (agent a1bfe5cabadeb32a4), awaiting review
Task 15: minor (deferred): exchangePassword skips argon2 verify for unknown username (timing enumeration; single admin + 5/min limit); failed-login audit meta stores attempted username; rate-limit 429 surfaces as error 'bad_request' via generic handler (auth.ts uses 'rate_limited'); optInt(...) ?? -1 dead fallback; N+1 listProjects in listTokensFor
Task 15: complete (commits 19154fb..cbf4802, review clean)
Task 16: implemented cbf4802..d24dbc5 (agent a794ddb61e10d8426), awaiting review
Task 16: Ruling R13 (plan-mandated, Important): MCP write_document body_md is unbounded while REST enforces 2_000_000 via documentInputSchema. Ruling: apply the same .max(2_000_000) in mcp.ts. Cost if wrong: none.
Task 16: Ruling R14 (plan-mandated, Important): after reply.hijack(), an exception from server.connect/handleRequest leaves the client connection hanging. Ruling: wrap in try/catch — log, and if headers not sent write a 500 JSON {error:'internal'} and end, else destroy the socket; add .catch(() => {}) to the fire-and-forget close() calls. Cost if wrong: none.
Task 16: minor (deferred): per-tool descriptions do not restate the CLI hint (only server instructions do)
Task 16: fix round 1/5 started — findings: body_md cap (R13), hijack error guard (R14); FIX_BASE d24dbc5
Task 16: fix round 1/5 (2 addressed, 0 open — body_md cap R13, hijack guard R14; commits d24dbc5..ee6512e)
Task 16: minor (deferred): big-body MCP test is confounded by Fastify default bodyLimit (1 MiB) and does not exercise the zod cap
Task 16: minor (deferred, cross-cutting): Fastify default bodyLimit 1 MiB < documentInputSchema body_md max 2_000_000 — REST PUT and MCP write of a 1–2 MB doc get 413 not 400; consider bodyLimit in buildApp (final review to triage)
Task 16: complete (commits cbf4802..ee6512e, review clean after round 1)
Task 17: implemented ee6512e..6cc2379 (agent a3cb51f44eff2fcbc), awaiting review
Task 17: Ruling R15 (plan-mandated, Important): cli fatal() exits 2 for ConfigError but spec §13 says missing master key → exit 1. Ruling: fatal() always exits 1; add a spawn test asserting exit 1 + message mentions PIDB_MASTER_KEY. Cost if wrong: none (spec-mandated).
Task 17: Ruling R16 (plan-mandated, Important): promptHidden Ctrl-C calls process.exit(130) without setRawMode(false). Ruling: restore the terminal (setRawMode(false), newline) before exiting. Cost if wrong: none.
Task 17: minor (deferred): non-TTY promptHidden fallback may echo the password when stdout is a TTY (readline terminal mode); mkdirSync(dataDir) duplicated in init and startServer
Task 17: fix round 1/5 started — findings: exit code (R15), raw-mode restore (R16); FIX_BASE 6cc2379
Task 17: fix round 1/5 (2 addressed, 0 open — exit 1 R15, raw-mode restore R16; commits 6cc2379..30f846f)
Task 17: complete (commits ee6512e..30f846f, review clean after round 1)
Task 18: implemented 30f846f..35f1d25 (agent a3939719280468ec1), awaiting review
Task 18: complete (commits 30f846f..35f1d25, review clean)
ALL TASKS COMPLETE — final whole-branch review next (merge-base ed80e61, head 35f1d25)
FINAL REVIEW (opus, a32720bf6e25e7d13): 1 Critical, 5 Important, minors; agrees with all rulings R1–R16. Must-fix triage: T16 bodyLimit, T11/T15 429 code, T14 decrypt_failed test, T17 prompt echo, T16 confounded MCP test.
Ruling R17 (final, Critical): PIDB_TRUST_PROXY config (default false) replaces hardcoded trustProxy:true in startServer. Cost if wrong: a Caddy deployment that forgets to set it rate-limits per proxy IP (over-counts) — fail-safe.
Ruling R18 (final, Important): bodyLimit 4 MiB in buildApp so the 2 MB body_md cap is reachable; fix confounded MCP test. Cost if wrong: larger request buffers per connection.
Ruling R19 (final, Important): log 5xx AppErrors with details, suppress message on 5xx, thread secret_id into CryptoError details. Cost if wrong: none.
Ruling R20 (final, Important): generic 4xx mapping 429→rate_limited, 413→payload_too_large, 415→unsupported_media_type. Cost if wrong: none.
Ruling R21 (final, Important): revealFieldFor asserts secrets:meta before lookup (no 403/404 oracle). Cost if wrong: none.
Ruling R22 (final, Important): non-TTY promptHidden uses terminal:false. Cost if wrong: none.
Final fix wave started — brief .superpowers/sdd/2026-09-12-core-server/final-fix-brief.md; FIX_BASE 35f1d25
Ruling R21 AMENDED: pre-lookup gate in revealFieldFor is (secrets:meta OR secrets:reveal), else 403 missing_scope secrets:meta; field-level check unchanged. Reason: spec §7 says secrets:reveal alone grants sensitive reads, and the plan's T14 tests use reveal-only tokens; my original wording would have broken Plan 2 'secret exec' tokens. Cost if wrong: none vs. original.
Ruling R17 AMENDED: drop numeric hop-count support for PIDB_TRUST_PROXY — installed Fastify 5.12.4 fails closed on numbers (lib/request.js getTrustProxyFn), so the option would be silently inert. Accepted values: true, false/unset, or an IP/CIDR list string. Cost if wrong: an operator wanting hop-count semantics must list proxy IPs instead.
Final fix wave: amendment round dispatched to a72a2f42ba32d25d4 before scoped re-review
Final fix wave: re-review (opus) — 8/8 addressed, no new Critical/Important; commits 35f1d25..d3c6401 (10)
Final: parked — README error-code list omits unsupported_media_type and bad_request — Ruling: real, deferred to Plan 2 when the CLI pins the contract
Final: parked — invalid PIDB_TRUST_PROXY (e.g. 'yes') throws raw TypeError at boot instead of ConfigError — Ruling: fail-loud/fail-closed is acceptable for v1; wrap in loadConfig later
Final: parked — one corrupted dek_wrapped row makes the secrets list endpoint 500 — Ruling: real, deferred; pre-existing plan behaviour
Final: parked — non-TTY prompt lacks try/finally; I2 log line not asserted by tests (silent logger) — cosmetic/deferred
BRANCH COMPLETE: head d3c6401, 117 tests, build + typecheck clean
