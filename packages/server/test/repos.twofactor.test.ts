import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { openDb } from '../src/db/connection.js';
import { createAdmin } from '../src/repos/admin.js';
import {
  getTotp, openTotpSecret, savePendingTotp, enableTotp, claimTotpStep, deleteTwoFactor,
  replaceRecoveryCodes, listUnusedRecoveryCodes, markRecoveryCodeUsed,
  createChallenge, getChallenge, claimChallengeAttempt, deleteChallenge, purgeExpiredChallenges,
  rewrapTotpSecrets,
} from '../src/repos/twofactor.js';
import type { KeyRing } from '../src/config.js';

function setup() {
  const db = openDb(':memory:');
  const ring: KeyRing = { current: 1, keys: new Map([[1, randomBytes(32)]]) };
  const admin = createAdmin(db, 'alex', 'hash');
  return { db, ring, admin };
}

describe('twofactor repo', () => {
  it('savePendingTotp then getTotp: enabled_at is null, openTotpSecret round-trips the secret', () => {
    const { db, ring, admin } = setup();
    const secret = randomBytes(20);
    savePendingTotp(db, ring, admin.id, secret);
    const row = getTotp(db, admin.id);
    expect(row).not.toBeNull();
    expect(row!.enabled_at).toBeNull();
    expect(openTotpSecret(ring, row!).equals(secret)).toBe(true);
  });

  it('enableTotp sets enabled_at and last_used_step', () => {
    const { db, ring, admin } = setup();
    savePendingTotp(db, ring, admin.id, randomBytes(20));
    enableTotp(db, admin.id, 42, 1_000);
    const row = getTotp(db, admin.id);
    expect(row!.enabled_at).toBe(1_000);
    expect(row!.last_used_step).toBe(42);
  });

  it('claimTotpStep is atomic and rejects replay', () => {
    const { db, ring, admin } = setup();
    savePendingTotp(db, ring, admin.id, randomBytes(20));
    enableTotp(db, admin.id, 0);
    expect(claimTotpStep(db, admin.id, 5)).toBe(true);
    expect(claimTotpStep(db, admin.id, 5)).toBe(false);
    expect(claimTotpStep(db, admin.id, 4)).toBe(false);
    expect(claimTotpStep(db, admin.id, 6)).toBe(true);
  });

  it('recovery codes: replace, list unused, mark used (single use)', () => {
    const { db, admin } = setup();
    replaceRecoveryCodes(db, admin.id, ['hash1', 'hash2']);
    const unused = listUnusedRecoveryCodes(db, admin.id);
    expect(unused.length).toBe(2);
    expect(markRecoveryCodeUsed(db, unused[0]!.id)).toBe(true);
    expect(markRecoveryCodeUsed(db, unused[0]!.id)).toBe(false);
    expect(listUnusedRecoveryCodes(db, admin.id).length).toBe(1);
  });

  it('challenges: create, expire, claim attempts, purge', () => {
    const { db, admin } = setup();
    const now = 10_000;
    const id = createChallenge(db, admin.id, 1000, '127.0.0.1', 'ua');
    // createChallenge uses now() internally (Date.now()), so we exercise getChallenge relative
    // to its own created_at + ttl by reading the row directly for the assertion below.
    const row = db.prepare(`SELECT expires_at FROM login_challenges WHERE id = ?`).get(id) as { expires_at: number };
    expect(getChallenge(db, id, row.expires_at - 1)).not.toBeNull();
    expect(getChallenge(db, id, row.expires_at + 1)).toBeNull();
    expect(claimChallengeAttempt(db, id, 3, row.expires_at - 1)).toBe(1);
    expect(claimChallengeAttempt(db, id, 3, row.expires_at - 1)).toBe(2);
    expect(claimChallengeAttempt(db, id, 3, row.expires_at - 1)).toBe(3);
    expect(claimChallengeAttempt(db, id, 3, row.expires_at - 1)).toBeNull(); // exhausted
    expect(getChallenge(db, id, row.expires_at - 1)?.attempts).toBe(3);
    expect(claimChallengeAttempt(db, id, 5, row.expires_at + 1)).toBeNull(); // expired
    expect(claimChallengeAttempt(db, 'no-such-challenge', 5, row.expires_at - 1)).toBeNull();
    expect(purgeExpiredChallenges(db, row.expires_at + 1)).toBe(1);
    void now;
  });

  it('deleteChallenge removes a single challenge', () => {
    const { db, admin } = setup();
    const id = createChallenge(db, admin.id, 1000, '127.0.0.1', 'ua');
    deleteChallenge(db, id);
    expect(getChallenge(db, id)).toBeNull();
  });

  it('rewrapTotpSecrets rewraps rows on an old key version and is idempotent', () => {
    const db = openDb(':memory:');
    const k1 = randomBytes(32);
    const k2 = randomBytes(32);
    const ring1: KeyRing = { current: 1, keys: new Map([[1, k1]]) };
    const admin = createAdmin(db, 'alex', 'hash');
    const secret = randomBytes(20);
    savePendingTotp(db, ring1, admin.id, secret);

    const ring2: KeyRing = { current: 2, keys: new Map([[1, k1], [2, k2]]) };
    expect(rewrapTotpSecrets(db, ring2)).toBe(1);
    const row = getTotp(db, admin.id)!;
    expect(row.key_version).toBe(2);
    const ringOnlyK2: KeyRing = { current: 2, keys: new Map([[2, k2]]) };
    expect(openTotpSecret(ringOnlyK2, row).equals(secret)).toBe(true);

    expect(rewrapTotpSecrets(db, ring2)).toBe(0);
  });

  it('deleteTwoFactor removes totp, recovery and challenge rows for that admin', () => {
    const { db, ring, admin } = setup();
    savePendingTotp(db, ring, admin.id, randomBytes(20));
    replaceRecoveryCodes(db, admin.id, ['h1']);
    createChallenge(db, admin.id, 1000, '127.0.0.1', 'ua');

    deleteTwoFactor(db, admin.id);

    expect(getTotp(db, admin.id)).toBeNull();
    expect(listUnusedRecoveryCodes(db, admin.id)).toEqual([]);
    expect(db.prepare(`SELECT COUNT(*) AS c FROM login_challenges WHERE admin_id = ?`).get(admin.id)).toEqual({ c: 0 });
  });
});
