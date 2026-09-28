import { StringDecoder } from 'node:string_decoder';

/** Streaming secret-value redactor (spec §2.3 "exec redaction"). */
export interface Redactor {
  /** Feed a chunk of child output; returns the portion that is now safe to emit. */
  push(chunk: Buffer | string): string;
  /** Call once the stream has ended: emits whatever was held back for boundary-safety. */
  flush(): string;
}

export const REDACTED = '[pidb:redacted]';

/** Values shorter than this are never redacted (too likely to cause false positives, spec §2.3). */
const MIN_VALUE_LEN = 4;

/**
 * Every encoded form a plain value might show up as in child output: the raw value itself, plus its
 * base64, base64url (no padding — Node's `base64url` encoding never pads), `encodeURIComponent`, and
 * JSON-escaped forms, when those differ from the raw value (an all-alphanumeric value's base64 form
 * usually differs, but a value that's already URL-safe might not have a distinct `encodeURIComponent`
 * form, so only add it when it does).
 */
function encodedForms(value: string): string[] {
  const buf = Buffer.from(value, 'utf8');
  const forms = new Set<string>([value, buf.toString('base64'), buf.toString('base64url'), encodeURIComponent(value)]);
  const jsonEscaped = JSON.stringify(value).slice(1, -1);
  forms.add(jsonEscaped);
  return Array.from(forms).filter((f) => f.length > 0);
}

/**
 * Builds a redactor over `values` (secret field values about to be substituted into a child
 * process's environment or files, spec §2.3). Longest-pattern-first replacement (Review Focus 4)
 * ensures a longer match (e.g. the raw value) is redacted before a shorter one that might otherwise
 * match leftover fragments; works on decoded text (via `StringDecoder`) so a multibyte UTF-8
 * character split across a chunk boundary is never corrupted.
 *
 * `push` only ever holds back a *suffix of the currently available text that is itself a proper
 * prefix of some pattern* — i.e. text that might still turn into a match once more data arrives —
 * rather than a blind fixed-length tail. A complete match whose last character happens to be the
 * very last character seen so far is still a complete match (nothing more is needed to confirm it)
 * and is redacted immediately; only a genuinely incomplete, still-growing prefix is deferred to the
 * next `push`/`flush`.
 */
export function createRedactor(values: string[]): Redactor {
  const patterns = Array.from(new Set(values.filter((v) => v.length >= MIN_VALUE_LEN).flatMap(encodedForms))).sort(
    (a, b) => b.length - a.length,
  );
  const maxPatternLength = patterns.reduce((max, p) => Math.max(max, p.length), 0);

  const decoder = new StringDecoder('utf8');
  let held = '';

  function redact(text: string): string {
    let out = text;
    for (const pattern of patterns) out = out.split(pattern).join(REDACTED);
    return out;
  }

  /** Longest suffix of `text` that is a proper prefix of some pattern (a partial match still in progress). */
  function riskyTailLength(text: string): number {
    const upper = Math.min(text.length, maxPatternLength - 1);
    for (let len = upper; len > 0; len--) {
      const suffix = text.slice(text.length - len);
      if (patterns.some((p) => p.startsWith(suffix))) return len;
    }
    return 0;
  }

  return {
    push(chunk) {
      const decoded = typeof chunk === 'string' ? chunk : decoder.write(chunk);
      if (patterns.length === 0) return decoded; // nothing to ever match or hold back
      const text = held + decoded;
      const risky = riskyTailLength(text);
      const safeLength = text.length - risky;
      held = text.slice(safeLength);
      return redact(text.slice(0, safeLength));
    },
    flush() {
      const text = held + decoder.end();
      held = '';
      return redact(text);
    },
  };
}
