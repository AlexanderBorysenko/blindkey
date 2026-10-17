import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const TOTP_PERIOD_S = 30;
const DIGITS = 6;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[\s=]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('invalid base32');
    value = ((value << 5) | idx) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(): Buffer {
  return randomBytes(20);
}

export function hotp(secret: Buffer, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', secret).update(msg).digest();
  const off = h[h.length - 1]! & 0x0f;
  const bin = ((h[off]! & 0x7f) << 24) | (h[off + 1]! << 16) | (h[off + 2]! << 8) | h[off + 3]!;
  return String(bin % 10 ** DIGITS).padStart(DIGITS, '0');
}

export function stepAt(ms: number): number {
  return Math.floor(ms / 1000 / TOTP_PERIOD_S);
}

/** Returns the accepted step (so the caller can store it as last_used_step) or null. */
export function verifyTotp(secret: Buffer, code: string, lastUsedStep: number, nowMs: number = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const current = stepAt(nowMs);
  for (const step of [current - 1, current, current + 1]) {
    if (step <= lastUsedStep) continue;
    if (timingSafeEqual(Buffer.from(hotp(secret, step)), Buffer.from(code))) return step;
  }
  return null;
}

export function otpauthUri(username: string, secret: Buffer): string {
  const label = `blindkey:${encodeURIComponent(username)}`;
  return `otpauth://totp/${label}?secret=${base32Encode(secret)}&issuer=Blindkey&algorithm=SHA1&digits=${DIGITS}&period=${TOTP_PERIOD_S}`;
}

export function generateRecoveryCode(): string {
  const chars: string[] = [];
  while (chars.length < 10) {
    for (const b of randomBytes(16)) {
      // 248 = 8 * 31: reject the tail so every character is equally likely.
      if (b < 248 && chars.length < 10) chars.push(RECOVERY_ALPHABET[b % 31]!);
    }
  }
  return `${chars.slice(0, 5).join('')}-${chars.slice(5).join('')}`;
}

export function normalizeRecoveryCode(input: string): string | null {
  const s = input.toLowerCase().replace(/[\s-]/g, '');
  if (!/^[a-hjkmnp-z2-9]{10}$/.test(s)) return null;
  return `${s.slice(0, 5)}-${s.slice(5)}`;
}
