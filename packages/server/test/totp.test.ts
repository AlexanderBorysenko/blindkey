import { describe, it, expect } from 'vitest';
import {
  base32Decode, base32Encode, generateRecoveryCode, generateTotpSecret, hotp, normalizeRecoveryCode,
  otpauthUri, stepAt, verifyTotp,
} from '../src/auth/totp.js';

const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');

describe('totp', () => {
  it('matches the RFC 6238 SHA-1 vectors truncated to 6 digits', () => {
    const vectors: [number, string][] = [
      [59, '287082'], [1111111109, '081804'], [1111111111, '050471'],
      [1234567890, '005924'], [2000000000, '279037'], [20000000000, '353130'],
    ];
    for (const [seconds, code] of vectors) expect(hotp(RFC_SECRET, stepAt(seconds * 1000))).toBe(code);
  });

  it('round-trips base32 without padding', () => {
    const secret = generateTotpSecret();
    expect(secret.length).toBe(20);
    const b32 = base32Encode(secret);
    expect(b32).toMatch(/^[A-Z2-7]+$/);
    expect(base32Decode(b32).equals(secret)).toBe(true);
    expect(base32Decode(b32.toLowerCase().replace(/(.{4})/g, '$1 ')).equals(secret)).toBe(true);
  });

  it('accepts the previous, current and next step and rejects further ones', () => {
    const now = 1_700_000_000_000;
    const s = stepAt(now);
    for (const d of [-1, 0, 1]) expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, s + d), 0, now)).toBe(s + d);
    for (const d of [-2, 2]) expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, s + d), 0, now)).toBeNull();
    expect(verifyTotp(RFC_SECRET, '12345', 0, now)).toBeNull();
    expect(verifyTotp(RFC_SECRET, 'abcdef', 0, now)).toBeNull();
  });

  it('rejects a step at or below last_used_step (replay)', () => {
    const now = 1_700_000_000_000;
    const s = stepAt(now);
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, s), s, now)).toBeNull();
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, s), s - 1, now)).toBe(s);
  });

  it('builds an otpauth URI', () => {
    expect(otpauthUri('alex', RFC_SECRET)).toBe(
      `otpauth://totp/blindkey:alex?secret=${base32Encode(RFC_SECRET)}&issuer=Blindkey&algorithm=SHA1&digits=6&period=30`,
    );
  });
});

describe('recovery codes', () => {
  it('generates xxxxx-xxxxx from the unambiguous alphabet', () => {
    for (let i = 0; i < 50; i++) expect(generateRecoveryCode()).toMatch(/^[a-hjkmnp-z2-9]{5}-[a-hjkmnp-z2-9]{5}$/);
  });

  it('normalizes case, spaces and a missing dash', () => {
    expect(normalizeRecoveryCode('ABCDE-FGHJK')).toBe('abcde-fghjk');
    expect(normalizeRecoveryCode(' abcde fghjk ')).toBe('abcde-fghjk');
    expect(normalizeRecoveryCode('abcdefghjk')).toBe('abcde-fghjk');
    expect(normalizeRecoveryCode('abcde-fghj1')).toBeNull(); // '1' is not in the alphabet
    expect(normalizeRecoveryCode('123456')).toBeNull();
  });
});
