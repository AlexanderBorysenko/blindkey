import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { CryptoError } from '../errors.js';

const NONCE_LEN = 12;
const TAG_LEN = 16;
const DEK_AAD = 'secret-dek';

export function seal(key: Buffer, plaintext: Buffer, aad: string): Buffer {
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ct]);
}

export function open(key: Buffer, blob: Buffer, aad: string): Buffer {
  if (blob.length < NONCE_LEN + TAG_LEN) throw new CryptoError('ciphertext too short');
  const nonce = blob.subarray(0, NONCE_LEN);
  const tag = blob.subarray(NONCE_LEN, NONCE_LEN + TAG_LEN);
  const ct = blob.subarray(NONCE_LEN + TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    throw new CryptoError();
  }
}

export function generateDek(): Buffer {
  return randomBytes(32);
}

export function wrapDek(masterKey: Buffer, dek: Buffer): Buffer {
  return seal(masterKey, dek, DEK_AAD);
}

export function unwrapDek(masterKey: Buffer, wrapped: Buffer): Buffer {
  return open(masterKey, wrapped, DEK_AAD);
}

export function fieldAad(secretId: number, key: string): string {
  return `${secretId}:${key}`;
}

export function encryptField(dek: Buffer, secretId: number, key: string, value: string): Buffer {
  return seal(dek, Buffer.from(value, 'utf8'), fieldAad(secretId, key));
}

export function decryptField(dek: Buffer, secretId: number, key: string, blob: Buffer): string {
  return open(dek, blob, fieldAad(secretId, key)).toString('utf8');
}
