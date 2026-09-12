import { describe, it, expect } from 'vitest';
import { emit, fmtTime, table, type CommandResult } from '../src/output.js';

describe('table', () => {
  it('pads columns and underlines the header', () => {
    const out = table(['SLUG', 'NAME'], [['acme', 'Acme Inc'], ['x', 'X']]);
    expect(out.split('\n')).toEqual(['SLUG  NAME', '----  --------', 'acme  Acme Inc', 'x     X']);
  });

  it('renders empty and nullish cells without trailing spaces', () => {
    expect(table(['A', 'B'], [['a', null], ['b', undefined]]).split('\n')).toEqual(['A  B', '-  -', 'a', 'b']);
  });

  it('handles zero rows', () => {
    expect(table(['A'], [])).toBe('A\n-');
  });

  it('collapses embedded newlines and tabs to single spaces so rows stay on one line', () => {
    const out = table(['COL1', 'COL2'], [['a\nb', 'x\ty']]);
    expect(out.split('\n')).toEqual(['COL1  COL2', '----  ----', 'a b   x y']);
  });
});

describe('fmtTime', () => {
  it('formats epoch milliseconds as second-precision UTC', () => {
    expect(fmtTime(Date.UTC(2026, 8, 12, 14, 3, 15, 533))).toBe('2026-09-12T14:03:15Z');
  });
  it('renders nothing for null', () => {
    expect(fmtTime(null)).toBe('');
  });
});

describe('emit', () => {
  const capture = () => {
    const chunks: string[] = [];
    return { chunks, out: { write: (c: string) => chunks.push(c) } as unknown as NodeJS.WritableStream };
  };
  const result: CommandResult = { json: { a: 1 }, text: 'a=1' };

  it('writes text by default', () => {
    const { chunks, out } = capture();
    emit(result, false, out);
    expect(chunks.join('')).toBe('a=1\n');
  });

  it('writes pretty JSON with --json', () => {
    const { chunks, out } = capture();
    emit(result, true, out);
    expect(chunks.join('')).toBe('{\n  "a": 1\n}\n');
  });

  it('writes nothing for empty text', () => {
    const { chunks, out } = capture();
    emit({ json: null, text: '' }, false, out);
    expect(chunks.join('')).toBe('');
  });
});
