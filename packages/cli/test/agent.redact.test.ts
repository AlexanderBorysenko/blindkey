import { describe, it, expect } from 'vitest';
import { createRedactor, REDACTED } from '../src/agent/redact.js';

describe('createRedactor', () => {
  it('redacts a value that arrives in a single chunk', () => {
    const r = createRedactor(['hunter2hunter2']);
    expect(r.push('secret is hunter2hunter2 done') + r.flush()).toBe(`secret is ${REDACTED} done`);
  });

  it('leaves values shorter than 4 characters untouched', () => {
    const r = createRedactor(['ab', 'x', '']);
    expect(r.push('ab x  ok') + r.flush()).toBe('ab x  ok');
  });

  it('redacts every occurrence, not just the first', () => {
    const r = createRedactor(['s3cr3t']);
    expect(r.push('s3cr3t and again s3cr3t') + r.flush()).toBe(`${REDACTED} and again ${REDACTED}`);
  });

  it('redacts the base64 form', () => {
    const value = 'hunter2hunter2';
    const encoded = Buffer.from(value, 'utf8').toString('base64');
    const r = createRedactor([value]);
    expect(r.push(`b64=${encoded}`) + r.flush()).toBe(`b64=${REDACTED}`);
  });

  it('redacts the base64url (no padding) form', () => {
    const value = 'a value that needs padding!!';
    const encoded = Buffer.from(value, 'utf8').toString('base64url');
    expect(encoded).not.toContain('=');
    const r = createRedactor([value]);
    expect(r.push(`x=${encoded}`) + r.flush()).toBe(`x=${REDACTED}`);
  });

  it('redacts the encodeURIComponent form', () => {
    const value = 'p@ss word/slash';
    const encoded = encodeURIComponent(value);
    expect(encoded).not.toBe(value);
    const r = createRedactor([value]);
    expect(r.push(`url?token=${encoded}`) + r.flush()).toBe(`url?token=${REDACTED}`);
  });

  it('redacts the JSON-escaped form', () => {
    const value = 'line1\nline2\ttabbed"quoted"';
    const jsonEscaped = JSON.stringify(value).slice(1, -1);
    expect(jsonEscaped).not.toBe(value);
    const r = createRedactor([value]);
    expect(r.push(`{"key":"${jsonEscaped}"}`) + r.flush()).toBe(`{"key":"${REDACTED}"}`);
  });

  it('redacts a value straddling two chunks (chunk-boundary safety)', () => {
    const value = 'hunter2hunter2';
    const r = createRedactor([value]);
    const text = `before ${value} after`;
    const splitAt = text.indexOf(value) + 5; // split mid-way through the value itself
    let out = r.push(text.slice(0, splitAt));
    out += r.push(text.slice(splitAt));
    out += r.flush();
    expect(out).toBe(`before ${REDACTED} after`);
    expect(out).not.toContain(value);
  });

  it('redacts a value straddling many small chunks, one character at a time', () => {
    const value = 'hunter2hunter2';
    const r = createRedactor([value]);
    const text = `xx${value}yy`;
    let out = '';
    for (const ch of text) out += r.push(ch);
    out += r.flush();
    expect(out).toBe(`xx${REDACTED}yy`);
  });

  it('never emits a false positive split across chunks for a value that never actually appears', () => {
    const r = createRedactor(['hunter2hunter2']);
    let out = r.push('hunter2');
    out += r.push('nope-different-tail');
    out += r.flush();
    expect(out).toBe('hunter2nope-different-tail');
  });

  it('redacts overlapping/longest-first: a longer value that contains a shorter one', () => {
    const r = createRedactor(['abcdefgh', 'abcd']);
    const out = r.push('abcdefgh and abcd alone') + r.flush();
    expect(out).toBe(`${REDACTED} and ${REDACTED} alone`);
  });

  it('handles a multibyte UTF-8 character split across a chunk boundary without corruption', () => {
    const value = 'hunter2hunter2';
    const r = createRedactor([value]);
    const emoji = '🔒'; // 4-byte UTF-8 sequence
    const buf = Buffer.from(`pw=${value} ${emoji} end`, 'utf8');
    // Split the buffer in the middle of the emoji's byte sequence.
    const emojiStart = buf.indexOf(Buffer.from(emoji, 'utf8'));
    const splitAt = emojiStart + 2;
    let out = r.push(buf.subarray(0, splitAt));
    out += r.push(buf.subarray(splitAt));
    out += r.flush();
    expect(out).toBe(`pw=${REDACTED} ${emoji} end`);
  });

  it('redacts across several separate secret values at once', () => {
    const r = createRedactor(['hunter2hunter2', 'anotherSecretValue']);
    const out = r.push('a=hunter2hunter2 b=anotherSecretValue') + r.flush();
    expect(out).toBe(`a=${REDACTED} b=${REDACTED}`);
  });

  it('flush() emits whatever was held back even if push() was never called with a full match', () => {
    const r = createRedactor(['hunter2hunter2']);
    const out = r.push('tail-only-hunt') + r.flush();
    expect(out).toBe('tail-only-hunt');
  });
});

describe('createRedactor: fix round 1 repros (complete match overlapping the held-back tail)', () => {
  it('repro 1: a complete match followed by a partial-lookalike tail, split across chunks', () => {
    const r = createRedactor(['hunter2hunter2']);
    const out = r.push('hunter2hunter2hunt') + r.push('zzz\n') + r.flush();
    expect(out).not.toContain('hunter2hunter2');
  });

  it('repro 2: a shorter, complete match whose trailing characters coincide with a longer, unrelated pattern\'s prefix', () => {
    const r = createRedactor(['longsecretAAAA', 'AAAAB-other-value-xyz']);
    const out = r.push('pw=longsecretAAAAB') + r.push(' end\n') + r.flush();
    expect(out).not.toContain('longsecretAAAA');
  });

  it('repro 3: a base64 form landing exactly at the end of a chunk is still caught', () => {
    const value = 'hunter2hunter2';
    const encoded = Buffer.from(value, 'utf8').toString('base64');
    const r = createRedactor([value]);
    const out = r.push(`b64=${encoded}`) + r.push('') + r.flush();
    expect(out).not.toContain(value);
    expect(out).not.toContain(encoded);
    expect(out).toBe(`b64=${REDACTED}`);
  });
});

describe('createRedactor: property test (chunked === one-shot, never leaks a pattern)', () => {
  // Deterministic PRNG (mulberry32) so failures are always reproducible from the fixed seed alone.
  function mulberry32(seed: number): () => number {
    let s = seed;
    return () => {
      s |= 0;
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  function randInt(rng: () => number, maxExclusive: number): number {
    return Math.floor(rng() * maxExclusive);
  }
  function randString(rng: () => number, minLen: number, maxLen: number): string {
    const len = minLen + randInt(rng, maxLen - minLen + 1);
    let s = '';
    for (let i = 0; i < len; i++) s += ALPHABET[randInt(rng, ALPHABET.length)];
    return s;
  }
  function encForms(v: string): string[] {
    return [v, Buffer.from(v, 'utf8').toString('base64'), Buffer.from(v, 'utf8').toString('base64url'), encodeURIComponent(v)].filter(
      (f) => f.length > 0,
    );
  }
  function redactOnce(values: string[], text: string): string {
    const r = createRedactor(values);
    return r.push(text) + r.flush();
  }
  function redactChunked(values: string[], text: string, rng: () => number): string {
    const r = createRedactor(values);
    let out = '';
    let pos = 0;
    while (pos < text.length) {
      const chunkLen = 1 + randInt(rng, 4); // includes 1-char chunks
      const chunk = text.slice(pos, pos + chunkLen);
      pos += chunk.length;
      out += r.push(chunk);
    }
    out += r.flush();
    return out;
  }

  it('2000 random cases: chunked output equals one-shot output, and no pattern survives', () => {
    const rng = mulberry32(0xc0ffee);
    for (let iter = 0; iter < 2000; iter++) {
      const numValues = 1 + randInt(rng, 3);
      const values: string[] = [];
      for (let v = 0; v < numValues; v++) values.push(randString(rng, 4, 14));
      // Occasionally make one value overlap/self-overlap another (the class of bug fix round 1 fixed).
      if (values.length > 1 && rng() < 0.4) {
        const base = values[0]!;
        values[1] = base.slice(0, Math.max(4, base.length - 2)) + randString(rng, 1, 4);
      }
      if (rng() < 0.2) values.push(values[0]!.slice(0, Math.max(4, Math.floor(values[0]!.length / 2))) + randString(rng, 1, 4));

      let text = '';
      const segments = 3 + randInt(rng, 6);
      for (let s = 0; s < segments; s++) {
        text += randString(rng, 0, 6);
        if (rng() < 0.65) {
          const v = values[randInt(rng, values.length)]!;
          const forms = encForms(v);
          text += forms[randInt(rng, forms.length)]!;
        }
        text += randString(rng, 0, 6);
      }

      const oneShot = redactOnce(values, text);
      const chunked = redactChunked(values, text, rng);

      expect(chunked, `iteration ${iter}: values=${JSON.stringify(values)} text=${JSON.stringify(text)}`).toBe(oneShot);
      for (const v of values) {
        if (v.length < 4) continue;
        for (const f of encForms(v)) {
          expect(oneShot.includes(f), `iteration ${iter}: leaked ${JSON.stringify(f)} from value ${JSON.stringify(v)}`).toBe(false);
        }
      }
    }
  });
});
