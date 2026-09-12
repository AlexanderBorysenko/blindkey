import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { seal, open, generateDek, wrapDek, unwrapDek, encryptField, decryptField } from '../src/crypto/envelope.js';
import { generateToken, hashToken, parseTokenPrefix, hashesEqual } from '../src/crypto/tokens.js';
import { hashPassword, verifyPassword } from '../src/crypto/passwords.js';
import { CryptoError } from '../src/errors.js';

describe('envelope', () => {
  const master = randomBytes(32);
  it('round-trips a field through DEK wrap/unwrap', () => {
    const dek = generateDek();
    const wrapped = wrapDek(master, dek);
    expect(wrapped.length).toBe(12 + 16 + 32);
    expect(unwrapDek(master, wrapped).equals(dek)).toBe(true);
    const blob = encryptField(dek, 42, 'password', 'hunter2');
    expect(decryptField(dek, 42, 'password', blob)).toBe('hunter2');
  });
  it('fails on wrong AAD (moved ciphertext) and tampering', () => {
    const dek = generateDek();
    const blob = encryptField(dek, 42, 'password', 'hunter2');
    expect(() => decryptField(dek, 42, 'username', blob)).toThrow(CryptoError);
    expect(() => decryptField(dek, 43, 'password', blob)).toThrow(CryptoError);
    const tampered = Buffer.from(blob);
    tampered[tampered.length - 1] ^= 0x01;
    expect(() => decryptField(dek, 42, 'password', tampered)).toThrow(CryptoError);
  });
  it('fails to unwrap with wrong master key', () => {
    const wrapped = wrapDek(master, generateDek());
    expect(() => unwrapDek(randomBytes(32), wrapped)).toThrow(CryptoError);
  });
  it('uses a fresh nonce per seal', () => {
    const a = seal(master, Buffer.from('x'), 'aad');
    const b = seal(master, Buffer.from('x'), 'aad');
    expect(a.equals(b)).toBe(false);
    expect(open(master, a, 'aad').toString()).toBe('x');
  });
  it('handles empty and unicode values', () => {
    const dek = generateDek();
    expect(decryptField(dek, 1, 'k', encryptField(dek, 1, 'k', ''))).toBe('');
    expect(decryptField(dek, 1, 'k', encryptField(dek, 1, 'k', 'пароль ✓'))).toBe('пароль ✓');
  });
});

describe('tokens', () => {
  it('generates pidb_<prefix>_<secret> tokens', () => {
    const t = generateToken();
    expect(t.token).toMatch(/^pidb_[A-Za-z0-9_-]{8}_[A-Za-z0-9_-]{43}$/);
    expect(parseTokenPrefix(t.token)).toBe(t.prefix);
    expect(hashToken(t.token)).toBe(t.hash);
    expect(t.hash).toMatch(/^[0-9a-f]{64}$/);
  });
  it('rejects malformed tokens', () => {
    expect(parseTokenPrefix('nope')).toBeNull();
    expect(parseTokenPrefix('pidb_short_x')).toBeNull();
  });
  it('compares hashes in constant time helper', () => {
    const t = generateToken();
    expect(hashesEqual(t.hash, t.hash)).toBe(true);
    expect(hashesEqual(t.hash, generateToken().hash)).toBe(false);
    expect(hashesEqual(t.hash, 'abc')).toBe(false);
  });
});

describe('passwords', () => {
  it('hashes with argon2id and verifies', async () => {
    const h = await hashPassword('correct horse');
    expect(h.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(h, 'correct horse')).toBe(true);
    expect(await verifyPassword(h, 'wrong')).toBe(false);
  });
});
