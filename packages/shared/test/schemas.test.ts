import { describe, it, expect } from 'vitest';
import {
  slugSchema,
  projectInputSchema,
  secretInputSchema,
  secretPatchSchema,
  documentInputSchema,
  tokenInputSchema,
  SCOPES,
  AGENT_SCOPES,
  secretLookingKey,
  urlWithPassword,
} from '../src/index.js';

describe('slugSchema', () => {
  it('accepts lowercase slugs', () => {
    expect(slugSchema.safeParse('acme-shop').success).toBe(true);
  });
  it('rejects uppercase, spaces, leading dash', () => {
    for (const bad of ['Acme', 'a b', '-abc', 'abc-', '']) {
      expect(slugSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe('projectInputSchema', () => {
  it('applies defaults', () => {
    const r = projectInputSchema.parse({ slug: 'x', name: 'X' });
    expect(r.status).toBe('active');
    expect(r.tags).toEqual([]);
    expect(r.summary).toBe('');
  });
  it('rejects unknown keys and bad status', () => {
    expect(projectInputSchema.safeParse({ slug: 'x', name: 'X', extra: 1 }).success).toBe(false);
    expect(projectInputSchema.safeParse({ slug: 'x', name: 'X', status: 'dead' }).success).toBe(false);
  });
});

describe('secretInputSchema', () => {
  it('accepts flat string fields', () => {
    const r = secretInputSchema.parse({
      name: 'Staging server',
      fields: [{ key: 'host', value: '1.2.3.4' }, { key: 'password', value: 'p' }],
    });
    expect(r.fields).toHaveLength(2);
    expect(r.description).toBe('');
  });
  it('rejects non-string values, nested objects, duplicate keys, slash in name', () => {
    expect(secretInputSchema.safeParse({ name: 'a', fields: [{ key: 'port', value: 22 }] }).success).toBe(false);
    expect(secretInputSchema.safeParse({ name: 'a', fields: [{ key: 'x', value: { a: 1 } }] }).success).toBe(false);
    expect(
      secretInputSchema.safeParse({ name: 'a', fields: [{ key: 'x', value: '1' }, { key: 'x', value: '2' }] }).success,
    ).toBe(false);
    expect(secretInputSchema.safeParse({ name: 'a/b', fields: [{ key: 'x', value: '1' }] }).success).toBe(false);
  });
  it('rejects empty fields array and bad keys', () => {
    expect(secretInputSchema.safeParse({ name: 'a', fields: [] }).success).toBe(false);
    expect(secretInputSchema.safeParse({ name: 'a', fields: [{ key: 'bad key', value: '1' }] }).success).toBe(false);
  });
});

describe('secretPatchSchema', () => {
  it('accepts partial updates with removeFields', () => {
    const r = secretPatchSchema.parse({ description: 'd', removeFields: ['old'] });
    expect(r.removeFields).toEqual(['old']);
    expect(r.fields).toBeUndefined();
  });
});

describe('documentInputSchema', () => {
  it('defaults force=false and validates category', () => {
    const r = documentInputSchema.parse({ title: 'T', category: 'context', body_md: '# hi' });
    expect(r.force).toBe(false);
    expect(documentInputSchema.safeParse({ title: 'T', category: 'blog', body_md: '' }).success).toBe(false);
  });
});

describe('SCOPES / AGENT_SCOPES', () => {
  it('includes the three new write/use scopes', () => {
    expect(SCOPES).toEqual(expect.arrayContaining(['projects:write', 'secrets:meta-write', 'secrets:use']));
  });
  it('AGENT_SCOPES never carries admin, secrets:reveal or secrets:write', () => {
    for (const s of ['admin', 'secrets:reveal', 'secrets:write']) {
      expect(AGENT_SCOPES).not.toContain(s);
    }
    expect(AGENT_SCOPES).toEqual(['projects:read', 'projects:write', 'projects:create', 'docs:read', 'docs:write', 'secrets:meta', 'secrets:meta-write', 'secrets:use']);
    for (const s of AGENT_SCOPES) expect(SCOPES).toContain(s);
  });
});

describe('tokenInputSchema', () => {
  it('requires at least one valid scope; projects default null', () => {
    const r = tokenInputSchema.parse({ name: 'cc', scopes: ['docs:read'] });
    expect(r.projects).toBeNull();
    expect(r.expires_at).toBeUndefined();
    expect(tokenInputSchema.safeParse({ name: 'cc', scopes: [] }).success).toBe(false);
    expect(tokenInputSchema.safeParse({ name: 'cc', scopes: ['root'] }).success).toBe(false);
  });
  it('an explicit null expires_at parses to null (never expires)', () => {
    const r = tokenInputSchema.parse({ name: 'cc', scopes: ['docs:read'], expires_at: null });
    expect(r.expires_at).toBeNull();
  });
});

describe('secretLookingKey / urlWithPassword', () => {
  it.each(['password', 'db_password', 'PASS', 'pw', 'pwd', 'jwt', 'bearer', 'dsn', 'conn_str', 'apiToken', 'SSH-Key', 'private_key', 'passphrase', 'wp_salt', 'hmac', 'cvv', 'totp'])(
    '%s looks like a credential',
    (k) => expect(secretLookingKey(k)).toBe(true),
  );
  it.each(['host', 'url', 'public_key', 'web_root', 'php_version', 'wp_admin_user', 'site_url', 'author', 'monkey', 'mapping', 'ping', 'database_url'])(
    '%s does not',
    (k) => expect(secretLookingKey(k)).toBe(false),
  );
  it('detects a password in URL userinfo only', () => {
    expect(urlWithPassword('postgres://app:hunter2@db:5432/x')).toBe(true);
    expect(urlWithPassword('https://user@host/path')).toBe(false);
    expect(urlWithPassword('https://host/a:b@c')).toBe(false);
    expect(urlWithPassword('https://easy-renovation.hacon.com.ua')).toBe(false);
  });
});
