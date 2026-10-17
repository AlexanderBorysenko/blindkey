import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const TOKEN_RE = /^bk_([A-Za-z0-9_-]{8})_[A-Za-z0-9_-]{43}$/;

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function generateToken(): { token: string; prefix: string; hash: string } {
  const prefix = randomBytes(6).toString('base64url');
  const secret = randomBytes(32).toString('base64url');
  const token = `bk_${prefix}_${secret}`;
  return { token, prefix, hash: hashToken(token) };
}

export function parseTokenPrefix(token: string): string | null {
  const m = TOKEN_RE.exec(token);
  return m ? (m[1] ?? null) : null;
}

export function hashesEqual(aHex: string, bHex: string): boolean {
  const a = Buffer.from(aHex, 'hex');
  const b = Buffer.from(bHex, 'hex');
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}
