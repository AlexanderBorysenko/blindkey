import { describe, it, expect } from 'vitest';
import { lintForSecrets } from '../src/index.js';

const reasons = (md: string) => lintForSecrets(md).map((f) => f.reason);

describe('lintForSecrets', () => {
  it('flags PEM private keys with the right line number', () => {
    const md = 'intro\n-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----';
    const f = lintForSecrets(md);
    expect(f[0]).toEqual({ line: 2, reason: 'PEM private key block' });
  });
  it('flags well-known key shapes', () => {
    expect(reasons('AKIAIOSFODNN7EXAMPLE')).toContain('AWS access key id');
    expect(reasons('sk_live_4eC39HqLyjWDarjtT1zdp7dc')).toContain('Stripe secret key');
    expect(reasons('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345')).toContain('GitHub token');
    expect(reasons('github_pat_11ABCDEFG0123456789_abcdefghijkl')).toContain('GitHub token');
    expect(reasons('xoxb-1234567890-abcdefghij')).toContain('Slack token');
    expect(reasons('sk-proj-abcdefghijklmnopqrstuvwxyz')).toContain('API secret key (sk-...)');
  });
  it('flags credential assignments with real-looking values', () => {
    expect(reasons('password: Tr0ub4dor&3')).toContain('credential assignment');
    expect(reasons('DB_PASSWORD=hunter2hunter2')).toContain('credential assignment');
    expect(reasons('api_key = "abcd1234efgh"')).toContain('credential assignment');
  });
  it('does not flag placeholders, refs, env vars, or short words', () => {
    expect(reasons('password: {{secret:Staging server}}')).toEqual([]);
    expect(reasons('password: <your-password>')).toEqual([]);
    expect(reasons('password: $PIDB_PASSWORD')).toEqual([]);
    expect(reasons('password: stored')).toEqual([]);
    expect(reasons('The token is rotated monthly.')).toEqual([]);
  });
  it('flags long base64/hex blobs but not git SHA-1 hashes', () => {
    expect(reasons('key: dGhpcyBpcyBhIHZlcnkgbG9uZyBiYXNlNjQgc3RyaW5nIQ==')).toContain('long base64/hex string');
    expect(reasons('commit 9fceb02d0ae598e95dc970b74767f19372d61af8')).toEqual([]);
  });
  it('skips fenced code blocks tagged example', () => {
    const md = '```example\nAKIAIOSFODNN7EXAMPLE\n```\n\n```bash\nAKIAIOSFODNN7EXAMPLE\n```';
    const f = lintForSecrets(md);
    expect(f).toHaveLength(1);
    expect(f[0]?.line).toBe(6);
  });
  it('flags 32-char hex strings', () => {
    expect(reasons('key: abcdef0123456789abcdef0123456789')).toContain('long base64/hex string');
  });
  it('flags 64-char hex strings', () => {
    expect(reasons('key: abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789')).toContain('long base64/hex string');
  });
  it('fails closed on unclosed example fence', () => {
    const md = '```example\nAKIAIOSFODNN7EXAMPLE';
    const f = lintForSecrets(md);
    expect(f).toHaveLength(1);
    expect(f[0]?.line).toBe(2);
  });
  it('never flags secret references but still lints other braces', () => {
    expect(reasons('deploy with {{secret:beta/X}} and {{secret:global/GitHub PAT}}')).toEqual([]);
    expect(reasons('{{oops AKIAIOSFODNN7EXAMPLE}}')).toContain('AWS access key id');
    const f = lintForSecrets('a\n{{secret:X}}\nAKIAIOSFODNN7EXAMPLE');
    expect(f[0]?.line).toBe(3);
  });
});
