import { describe, it, expect } from 'vitest';
import { ago, iso, flashFor } from '../src/ui/format.js';

describe('iso', () => {
  it('formats as an ISO string truncated to seconds with a Z suffix', () => {
    expect(iso(Date.UTC(2026, 7, 28, 12, 0, 0, 500))).toBe('2026-08-28T12:00:00Z');
  });
});

describe('ago', () => {
  const now = Date.UTC(2026, 7, 28, 12, 0, 0);

  it('is "just now" just under a minute', () => {
    expect(ago(now - 59_000, now)).toBe('just now');
  });

  it('is "1 min ago" at exactly 60s', () => {
    expect(ago(now - 60_000, now)).toBe('1 min ago');
  });

  it('is "59 min ago" just under an hour', () => {
    expect(ago(now - 59 * 60_000, now)).toBe('59 min ago');
  });

  it('is "1 h ago" at exactly 60 min', () => {
    expect(ago(now - 60 * 60_000, now)).toBe('1 h ago');
  });

  it('is "23 h ago" just under a day', () => {
    expect(ago(now - 23 * 3_600_000, now)).toBe('23 h ago');
  });

  it('is "1 d ago" at exactly 24h', () => {
    expect(ago(now - 24 * 3_600_000, now)).toBe('1 d ago');
  });

  it('is "6 d ago" just under a week', () => {
    expect(ago(now - 6 * 86_400_000, now)).toBe('6 d ago');
  });

  it('is a short date at exactly 7 days', () => {
    expect(ago(now - 7 * 86_400_000, now)).toBe('Aug 21');
  });

  it('shows the year for dates in a different year than now', () => {
    const then = Date.UTC(2025, 7, 28, 12, 0, 0);
    expect(ago(then, now)).toBe('Aug 28, 2025');
  });

  it('shows a future time in the same buckets, prefixed "in"', () => {
    expect(ago(now + 59_000, now)).toBe('just now');
    expect(ago(now + 60_000, now)).toBe('in 1 min');
    expect(ago(now + 60 * 60_000, now)).toBe('in 1 h');
    expect(ago(now + 24 * 3_600_000, now)).toBe('in 1 d');
  });
});

describe('flashFor', () => {
  it('maps a whitelisted key to its message', () => {
    expect(flashFor('saved')).toBe('Saved');
    expect(flashFor('created')).toBe('Created');
    expect(flashFor('deleted')).toBe('Deleted');
    expect(flashFor('revoked')).toBe('Token revoked');
  });

  it('returns null for an unknown or unsafe value', () => {
    expect(flashFor('<script>')).toBeNull();
    expect(flashFor(['saved'])).toBeNull();
    expect(flashFor(undefined)).toBeNull();
  });
});
