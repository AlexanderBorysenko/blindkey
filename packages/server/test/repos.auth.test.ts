import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db/connection.js';
import { createToken, findActiveTokenByValue, touchToken, listTokens, revokeToken } from '../src/repos/tokens.js';
import { writeAudit, listAudit } from '../src/repos/audit.js';
import { createAdmin, getAdmin, getAdminByUsername, createSession, getSession, deleteSession, purgeExpiredSessions } from '../src/repos/admin.js';
import { ConflictError } from '../src/errors.js';

describe('tokens repo', () => {
  it('creates, finds by value, and hides hash', () => {
    const db = openDb(':memory:');
    const { token, row } = createToken(db, { name: 'cc', scopes: ['docs:read'], projectIds: [1, 2], expiresAt: null });
    expect(token).toMatch(/^pidb_/);
    expect(row).not.toHaveProperty('token_hash');
    expect(row.project_ids).toEqual([1, 2]);
    const found = findActiveTokenByValue(db, token);
    expect(found?.id).toBe(row.id);
    expect(found?.scopes).toEqual(['docs:read']);
    expect(findActiveTokenByValue(db, token.slice(0, -1) + 'x')).toBeNull();
    expect(findActiveTokenByValue(db, 'garbage')).toBeNull();
  });
  it('rejects expired and revoked tokens', () => {
    const db = openDb(':memory:');
    const t1 = createToken(db, { name: 'a', scopes: ['admin'], projectIds: null, expiresAt: 1000 });
    expect(findActiveTokenByValue(db, t1.token, 999)).not.toBeNull();
    expect(findActiveTokenByValue(db, t1.token, 1000)).toBeNull();
    const t2 = createToken(db, { name: 'b', scopes: ['admin'], projectIds: null, expiresAt: null });
    expect(revokeToken(db, t2.row.id)).toBe(true);
    expect(revokeToken(db, t2.row.id)).toBe(false);
    expect(findActiveTokenByValue(db, t2.token)).toBeNull();
    expect(listTokens(db).map((t) => t.name)).toEqual(['a', 'b']);
  });
  it('touches last_used_at', () => {
    const db = openDb(':memory:');
    const { row } = createToken(db, { name: 'a', scopes: ['admin'], projectIds: null, expiresAt: null });
    touchToken(db, row.id, 12345);
    expect(listTokens(db)[0]?.last_used_at).toBe(12345);
  });
});

describe('audit repo', () => {
  it('writes and lists with filters', () => {
    const db = openDb(':memory:');
    writeAudit(db, { actor_type: 'token', actor_id: 1, action: 'secret.reveal', target_type: 'secret', target_id: 5, field_key: 'password', ip: '1.1.1.1', user_agent: 'ua', meta: { x: 1 } }, 100);
    writeAudit(db, { actor_type: 'admin', actor_id: 1, action: 'doc.write' }, 200);
    const all = listAudit(db, {});
    expect(all.map((r) => r.action)).toEqual(['doc.write', 'secret.reveal']);
    expect(all[1]?.meta).toEqual({ x: 1 });
    expect(all[0]?.meta).toBeNull();
    expect(listAudit(db, { action: 'secret.reveal' })).toHaveLength(1);
    expect(listAudit(db, { actorType: 'admin' })).toHaveLength(1);
    expect(listAudit(db, { before: 200 }).map((r) => r.ts)).toEqual([100]);
    expect(listAudit(db, { limit: 1 })).toHaveLength(1);
  });
});

describe('admin repo', () => {
  it('allows exactly one admin', () => {
    const db = openDb(':memory:');
    expect(getAdmin(db)).toBeNull();
    const a = createAdmin(db, 'alex', 'hash');
    expect(getAdminByUsername(db, 'alex')?.id).toBe(a.id);
    expect(() => createAdmin(db, 'other', 'hash')).toThrow(ConflictError);
  });
  it('manages sessions with expiry', () => {
    const db = openDb(':memory:');
    const a = createAdmin(db, 'alex', 'hash');
    const id = createSession(db, a.id, 1000, '1.1.1.1', 'ua');
    expect(id).toHaveLength(64);
    expect(getSession(db, id, Date.now())?.admin_id).toBe(a.id);
    expect(getSession(db, id, Date.now() + 2000)).toBeNull();
    expect(purgeExpiredSessions(db, Date.now() + 2000)).toBe(1);
    expect(deleteSession(db, id)).toBe(false);
  });
});
