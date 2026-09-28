// PostToolUse redaction (spec §3.2): a second, independent redaction pass over *whatever a tool
// actually printed* — unlike `agent/redact.ts`'s streaming `Redactor` (which only knows about the
// specific secret values a `pidb secret exec` run substituted), this one has no knowledge of any
// particular secret's value. It instead pattern-matches things that *look like* pidb tokens, PEM
// private keys, AWS-style access key ids, or a `KEY=value` line whose key name looks sensitive —
// catching cases the exec redactor can't (e.g. Claude printing a pidb token it was never supposed to
// have, or `cat`ing a `.env`-shaped file). It never fetches or otherwise learns a real secret value.
export const REDACTED = '[pidb:redacted]';

const PIDB_TOKEN_RE = /pidb_[A-Za-z0-9_-]{20,}/g;
// Non-greedy body so two adjacent PEM blocks don't get swallowed into a single match.
const PEM_BLOCK_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
const AKIA_RE = /AKIA[0-9A-Z]{16}/g;
const SENSITIVE_KEY_NAME_RE = /(PASS(WORD)?|SECRET|TOKEN|API_?KEY|PRIVATE)/i;
// dotenv/shell style only (Fix round 1 Minor #7): an uppercase `KEY=value` with no spaces around `=`,
// optionally `export`-prefixed. This deliberately does NOT match `MAX_TOKENS = 4096` (spaced `=`) or
// `api_key = os.environ[...]` (lowercase key, spaced `=`) — neither looks like a real credential
// assignment, and flagging every lowercase/spaced `x = y` in arbitrary tool output (source code,
// config files, ...) would be far noisier than useful. Group 3 (the value) is what gets replaced, so
// the key name itself (useful context, never sensitive on its own) survives in the output.
const KEY_VALUE_LINE_RE = /^([ \t]*(?:export\s+)?)([A-Z][A-Z0-9_]*)=(.*)$/gm;

/**
 * Redacts pidb tokens, PEM private key blocks, AWS-style `AKIA...` access key ids, and `KEY=value`
 * lines whose key looks like a password/secret/token/api key/private-key field (spec §3.2). Pure and
 * total over any string input — never throws.
 */
export function redactOutput(text: string): string {
  let out = text.replace(PEM_BLOCK_RE, REDACTED);
  out = out.replace(PIDB_TOKEN_RE, REDACTED);
  out = out.replace(AKIA_RE, REDACTED);
  out = out.replace(KEY_VALUE_LINE_RE, (whole: string, prefix: string, key: string, value: string) => {
    if (!SENSITIVE_KEY_NAME_RE.test(key)) return whole;
    if (value.length === 0) return whole; // nothing to redact, and avoids a pointless [pidb:redacted] on e.g. `FOO_SECRET=`
    return `${prefix}${key}=${REDACTED}`;
  });
  return out;
}

/**
 * Applies `redactOutput` to a PostToolUse `tool_response` of unknown shape (spec/task-8 brief:
 * "handle string or {stdout, stderr, ...} shapes defensively") — a plain string is redacted as-is; an
 * object gets every *string-valued* top-level property redacted independently (covers Bash's
 * `{stdout, stderr, ...}` shape without assuming exactly those two keys, and without touching
 * non-string fields like an `interrupted` boolean). Anything else (array, number, null, undefined) is
 * left untouched. `changed` is false whenever nothing was actually rewritten, so the dispatcher can
 * skip emitting `updatedToolOutput` entirely in that case, per the brief.
 */
export function redactToolResponse(toolResponse: unknown): { changed: boolean; value: unknown } {
  if (typeof toolResponse === 'string') {
    const value = redactOutput(toolResponse);
    return { changed: value !== toolResponse, value };
  }
  if (toolResponse && typeof toolResponse === 'object' && !Array.isArray(toolResponse)) {
    const obj = toolResponse as Record<string, unknown>;
    const out: Record<string, unknown> = { ...obj };
    let changed = false;
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value !== 'string') continue;
      const redacted = redactOutput(value);
      if (redacted !== value) {
        changed = true;
        out[key] = redacted;
      }
    }
    return { changed, value: out };
  }
  return { changed: false, value: toolResponse };
}
