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
