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
 * Algorithm (fix round 1 — the prior "hold back a risky suffix" heuristic leaked complete matches
 * that overlapped the held-back tail, e.g. one pattern's suffix coinciding with a longer, unrelated
 * pattern's prefix): `push` scans `held + decoded` strictly left to right, one position at a time.
 * At each position, before committing to anything, it asks "could a pattern *longer than what's
 * currently available* still be forming here?" — i.e. is the entire remaining buffer a prefix of
 * some pattern too long to fully fit yet. If so (and this isn't the final flush), the scan stops and
 * holds everything from this position onward for the next `push`/`flush`: committing to a shorter,
 * already-complete match here could otherwise pre-empt a longer match that the next chunk would have
 * completed (longest-match-wins must hold identically whether the text arrives in one chunk or many).
 * Otherwise the position is fully resolved: the longest pattern that *fully fits* in the buffer and
 * matches here (patterns are tried longest-first) is redacted and the scan jumps past it; if nothing
 * matches, the character is emitted literally and the scan advances by one. `flush()` runs the same
 * scan as `isFinal`, skipping the "could still be forming" check entirely — nothing more is ever
 * coming, so every remaining character is resolved one way or the other.
 */
export function createRedactor(values: string[]): Redactor {
  const patterns = Array.from(new Set(values.filter((v) => v.length >= MIN_VALUE_LEN).flatMap(encodedForms))).sort(
    (a, b) => b.length - a.length,
  );

  const decoder = new StringDecoder('utf8');
  let held = '';

  /**
   * Scans `buffer` left to right and returns the redacted-and-safe-to-emit prefix plus whatever must
   * still be held back. When `isFinal` (flush), the whole buffer is treated as safe to resolve, since
   * no more data is ever coming.
   */
  function scan(buffer: string, isFinal: boolean): { output: string; remainder: string } {
    const n = buffer.length;
    if (patterns.length === 0) return { output: buffer, remainder: '' };
    let out = '';
    let literalStart = 0;
    let i = 0;
    while (i < n) {
      const remaining = n - i;
      if (!isFinal) {
        // A pattern longer than what's currently available, whose prefix matches the entire
        // remaining buffer, might still complete once more data arrives — this position (and
        // everything after it) is not yet resolvable.
        const tail = buffer.slice(i, n);
        const stillForming = patterns.some((p) => p.length > remaining && p.startsWith(tail));
        if (stillForming) break;
      }
      let matchLen = 0;
      for (const p of patterns) {
        if (p.length <= remaining && buffer.startsWith(p, i)) {
          matchLen = p.length;
          break; // patterns are longest-first, so the first fit is the longest match here
        }
      }
      if (matchLen > 0) {
        out += buffer.slice(literalStart, i) + REDACTED;
        i += matchLen;
        literalStart = i;
        continue;
      }
      i += 1;
    }
    out += buffer.slice(literalStart, i);
    return { output: out, remainder: buffer.slice(i) };
  }

  return {
    push(chunk) {
      const decoded = typeof chunk === 'string' ? chunk : decoder.write(chunk);
      const { output, remainder } = scan(held + decoded, false);
      held = remainder;
      return output;
    },
    flush() {
      const { output } = scan(held + decoder.end(), true);
      held = '';
      return output;
    },
  };
}
