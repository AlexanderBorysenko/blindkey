import { randomBytes } from 'node:crypto';
import type { Db } from '../db/connection.js';
import type { KeyRing } from '../config.js';
import { open, seal } from '../crypto/envelope.js';
import { CryptoError } from '../errors.js';
import { keyVersionReport, probeCurrentVersion, type KeyVersionStatus } from './keyversions.js';
import { now } from './util.js';

export type { KeyVersionStatus };

export interface TotpRow {
  admin_id: number;
  secret_enc: Buffer;
  key_version: number;
  enabled_at: number | null;
  last_used_step: number;
  created_at: number;
}

const aad = (adminId: number) => `totp:${adminId}`;

function keyFor(ring: KeyRing, version: number): Buffer {
  const key = ring.keys.get(version);
  if (!key) throw new CryptoError(`no master key for version ${version}`);
  return key;
}

export function getTotp(db: Db, adminId: number): TotpRow | null {
  return (db.prepare(`SELECT admin_id, secret_enc, key_version, enabled_at, last_used_step, created_at FROM admin_totp WHERE admin_id = ?`).get(adminId) as TotpRow | undefined) ?? null;
}

export function sealTotpSecret(ring: KeyRing, adminId: number, secret: Buffer): { enc: Buffer; version: number } {
  return { enc: seal(keyFor(ring, ring.current), secret, aad(adminId)), version: ring.current };
}

export function openTotpSecret(ring: KeyRing, row: TotpRow): Buffer {
  return open(keyFor(ring, row.key_version), row.secret_enc, aad(row.admin_id));
}

/** Starts (or restarts) enrollment: the row stays inactive until enableTotp. */
export function savePendingTotp(db: Db, ring: KeyRing, adminId: number, secret: Buffer): void {
  const { enc, version } = sealTotpSecret(ring, adminId, secret);
  db.prepare(
    `INSERT INTO admin_totp (admin_id, secret_enc, key_version, enabled_at, last_used_step, created_at) VALUES (?, ?, ?, NULL, 0, ?)
     ON CONFLICT(admin_id) DO UPDATE SET secret_enc = excluded.secret_enc, key_version = excluded.key_version, enabled_at = NULL, last_used_step = 0, created_at = excluded.created_at`,
  ).run(adminId, enc, version, now());
}

export function enableTotp(db: Db, adminId: number, step: number, ts: number = now()): void {
  db.prepare(`UPDATE admin_totp SET enabled_at = ?, last_used_step = ? WHERE admin_id = ?`).run(ts, step, adminId);
}

export function claimTotpStep(db: Db, adminId: number, step: number): boolean {
  return db.prepare(`UPDATE admin_totp SET last_used_step = ? WHERE admin_id = ? AND last_used_step < ?`).run(step, adminId, step).changes > 0;
}

/** Epoch ms until which the admin's second factor is locked, or null when it is not locked. */
export function factorLockedUntil(db: Db, adminId: number, nowTs: number = now()): number | null {
  const r = db.prepare(`SELECT locked_until FROM admin_totp WHERE admin_id = ?`).get(adminId) as { locked_until: number | null } | undefined;
  return r?.locked_until != null && r.locked_until > nowTs ? r.locked_until : null;
}

/**
 * Atomically counts one failed second-factor attempt. When the count reaches `max`, locks
 * the factor until `nowTs + lockMs` and resets the count to 0.
 */
export function recordFactorFailure(db: Db, adminId: number, max: number, lockMs: number, nowTs: number = now()): { locked: boolean; until: number | null } {
  const until = nowTs + lockMs;
  const r = db.prepare(
    `UPDATE admin_totp SET
       failed_count = CASE WHEN failed_count + 1 >= ? THEN 0 ELSE failed_count + 1 END,
       locked_until = CASE WHEN failed_count + 1 >= ? THEN ? ELSE locked_until END
     WHERE admin_id = ?
     RETURNING failed_count, locked_until`,
  ).get(max, max, until, adminId) as { failed_count: number; locked_until: number | null } | undefined;
  if (!r) return { locked: false, until: null };
  const locked = r.failed_count === 0 && r.locked_until === until;
  return { locked, until: locked ? until : null };
}

/** Clears the failure counter AND any active lock — a full reset, not just the counter. */
export function resetFactorFailures(db: Db, adminId: number): void {
  db.prepare(`UPDATE admin_totp SET failed_count = 0, locked_until = NULL WHERE admin_id = ?`).run(adminId);
}

export function deleteTwoFactor(db: Db, adminId: number): void {
  db.transaction(() => {
    db.prepare(`DELETE FROM admin_totp WHERE admin_id = ?`).run(adminId);
    db.prepare(`DELETE FROM recovery_codes WHERE admin_id = ?`).run(adminId);
    db.prepare(`DELETE FROM login_challenges WHERE admin_id = ?`).run(adminId);
  })();
}

export function replaceRecoveryCodes(db: Db, adminId: number, hashes: string[]): void {
  const ins = db.prepare(`INSERT INTO recovery_codes (admin_id, code_hash, used_at, created_at) VALUES (?, ?, NULL, ?)`);
  db.transaction(() => {
    db.prepare(`DELETE FROM recovery_codes WHERE admin_id = ?`).run(adminId);
    const ts = now();
    for (const h of hashes) ins.run(adminId, h, ts);
  })();
}

export function listUnusedRecoveryCodes(db: Db, adminId: number): { id: number; code_hash: string }[] {
  return db.prepare(`SELECT id, code_hash FROM recovery_codes WHERE admin_id = ? AND used_at IS NULL ORDER BY id`).all(adminId) as { id: number; code_hash: string }[];
}

export function markRecoveryCodeUsed(db: Db, id: number, ts: number = now()): boolean {
  return db.prepare(`UPDATE recovery_codes SET used_at = ? WHERE id = ? AND used_at IS NULL`).run(ts, id).changes > 0;
}

export interface ChallengeRow {
  id: string;
  admin_id: number;
  expires_at: number;
  attempts: number;
}

export function createChallenge(db: Db, adminId: number, ttlMs: number, ip: string, ua: string): string {
  const id = randomBytes(32).toString('hex');
  const ts = now();
  db.prepare(`INSERT INTO login_challenges (id, admin_id, expires_at, attempts, created_at, ip, user_agent) VALUES (?, ?, ?, 0, ?, ?, ?)`).run(id, adminId, ts + ttlMs, ts, ip, ua);
  return id;
}

export function getChallenge(db: Db, id: string, nowTs: number = now()): ChallengeRow | null {
  const r = db.prepare(`SELECT id, admin_id, expires_at, attempts FROM login_challenges WHERE id = ?`).get(id) as ChallengeRow | undefined;
  if (!r || r.expires_at <= nowTs) return null;
  return r;
}

/**
 * Atomically claims one attempt on a live challenge. Returns the new attempt count, or null
 * when the challenge is missing, expired, or already has `max` attempts.
 */
export function claimChallengeAttempt(db: Db, id: string, max: number, nowTs: number = now()): number | null {
  const r = db.prepare(
    `UPDATE login_challenges SET attempts = attempts + 1 WHERE id = ? AND attempts < ? AND expires_at > ? RETURNING attempts`,
  ).get(id, max, nowTs) as { attempts: number } | undefined;
  return r?.attempts ?? null;
}

export function deleteChallenge(db: Db, id: string): void {
  db.prepare(`DELETE FROM login_challenges WHERE id = ?`).run(id);
}

/** Deletes every pending login challenge for the admin (shell password reset). Returns how many were deleted. */
export function deleteChallengesFor(db: Db, adminId: number): number {
  return db.prepare(`DELETE FROM login_challenges WHERE admin_id = ?`).run(adminId).changes;
}

export function purgeExpiredChallenges(db: Db, nowTs: number = now()): number {
  return db.prepare(`DELETE FROM login_challenges WHERE expires_at <= ?`).run(nowTs).changes;
}

export function rewrapTotpSecrets(db: Db, ring: KeyRing): number {
  const currentRows = db.prepare(`SELECT admin_id, secret_enc, key_version, enabled_at, last_used_step, created_at FROM admin_totp WHERE key_version = ?`).all(ring.current) as TotpRow[];
  probeCurrentVersion(currentRows, ring, (row) => openTotpSecret(ring, row), (row) => `2FA secret of admin ${row.admin_id}`);
  const rows = db.prepare(`SELECT admin_id, secret_enc, key_version, enabled_at, last_used_step, created_at FROM admin_totp WHERE key_version != ?`).all(ring.current) as TotpRow[];
  const upd = db.prepare(`UPDATE admin_totp SET secret_enc = ?, key_version = ? WHERE admin_id = ?`);
  return db.transaction(() => {
    for (const row of rows) {
      const { enc, version } = sealTotpSecret(ring, row.admin_id, openTotpSecret(ring, row));
      upd.run(enc, version, row.admin_id);
    }
    return rows.length;
  })();
}

/** One status per key_version present in `admin_totp`, for `blindkey-server key-versions` (spec §4). */
export function totpKeyVersionReport(db: Db, ring: KeyRing): KeyVersionStatus[] {
  const rows = db.prepare(`SELECT admin_id, secret_enc, key_version, enabled_at, last_used_step, created_at FROM admin_totp ORDER BY key_version`).all() as TotpRow[];
  return keyVersionReport(rows, (row) => row.key_version, ring, (row, key) => open(key, row.secret_enc, aad(row.admin_id)));
}
