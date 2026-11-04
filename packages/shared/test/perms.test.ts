import { describe, it, expect } from 'vitest';
import { PERMS, expandPerms, normalizePerms, validatePermsForTarget } from '../src/perms.js';

describe('expandPerms', () => {
  it('expands wildcards', () => {
    expect(expandPerms('*')).toEqual([...PERMS]);
    expect(expandPerms('protected.*')).toEqual(['protected.read', 'protected.write']);
    expect(expandPerms('public.*')).toEqual(['public.read', 'public.write']);
    expect(expandPerms('docs.*')).toEqual(['docs.read', 'docs.write']);
  });
  it('passes concrete perms and rejects unknown', () => {
    expect(expandPerms('cli')).toEqual(['cli']);
    expect(expandPerms('nope')).toBeNull();
    expect(expandPerms('protected')).toBeNull();
  });
});

describe('normalizePerms', () => {
  it('sorts, dedupes and never stores *', () => {
    expect(normalizePerms(['docs.write', 'cli', 'cli', 'public.read'])).toEqual(['public.read', 'cli', 'docs.write']);
    expect(normalizePerms('*')).toEqual([...PERMS]);
    expect(normalizePerms(['protected.*', 'protected.read'])).toEqual(['protected.read', 'protected.write']);
    expect(normalizePerms([])).toEqual([]);
  });
  it('throws on unknown perms', () => {
    expect(() => normalizePerms(['public.read', 'admin'])).toThrow(/unknown permission "admin"/);
  });
});

describe('validatePermsForTarget', () => {
  it('allows anything on a project', () => {
    expect(validatePermsForTarget('project', normalizePerms('*'))).toBeNull();
    expect(validatePermsForTarget('project', ['docs.read'])).toBeNull();
  });
  it('secret: no docs perms', () => {
    expect(validatePermsForTarget('secret', normalizePerms('protected.*'))).toBeNull();
    expect(validatePermsForTarget('secret', ['cli'])).toBeNull();
    expect(validatePermsForTarget('secret', normalizePerms('*'))).toMatch(/not valid on a secret/);
    expect(validatePermsForTarget('secret', ['docs.read'])).toMatch(/docs\.read/);
  });
  it('document: only docs perms', () => {
    expect(validatePermsForTarget('document', normalizePerms('docs.*'))).toBeNull();
    expect(validatePermsForTarget('document', ['docs.read'])).toBeNull();
    expect(validatePermsForTarget('document', ['cli'])).toMatch(/not valid on a document/);
    expect(validatePermsForTarget('document', normalizePerms('*'))).toMatch(/not valid on a document/);
  });
  it('rejects an empty set', () => {
    expect(validatePermsForTarget('project', [])).toMatch(/at least one/);
  });
});
