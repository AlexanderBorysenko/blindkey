import { describe, it, expect } from 'vitest';
import { SCOPES, defaultSensitive } from '../src/index.js';

describe('shared smoke', () => {
  it('exports scopes', () => {
    expect(SCOPES).toContain('secrets:reveal');
    expect(SCOPES).toHaveLength(7);
  });
  it('defaultSensitive treats host as non-sensitive and password as sensitive', () => {
    expect(defaultSensitive('host')).toBe(false);
    expect(defaultSensitive('password')).toBe(true);
  });
});
