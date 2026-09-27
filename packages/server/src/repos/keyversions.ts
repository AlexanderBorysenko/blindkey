import type { KeyRing } from '../config.js';
import { CryptoError } from '../errors.js';

export interface KeyVersionStatus {
  version: number;
  rows: number;
  status: string;
  ok: boolean;
}

/**
 * Groups `rows` by key version and, for each group, tries `tryDecrypt` against every row with
 * that version's key. `tryDecrypt` should throw `CryptoError` on a bad key and do nothing
 * otherwise. Shared by `secretKeyVersionReport` and `totpKeyVersionReport` for
 * `pidb-server key-versions` (spec §4).
 */
export function keyVersionReport<T>(
  rows: T[],
  versionOf: (row: T) => number,
  ring: KeyRing,
  tryDecrypt: (row: T, key: Buffer) => void,
): KeyVersionStatus[] {
  const byVersion = new Map<number, T[]>();
  for (const row of rows) {
    const v = versionOf(row);
    const group = byVersion.get(v);
    if (group) group.push(row);
    else byVersion.set(v, [row]);
  }
  return [...byVersion.keys()].sort((a, b) => a - b).map((version) => {
    const group = byVersion.get(version)!;
    const key = ring.keys.get(version);
    if (!key) return { version, rows: group.length, status: 'no key configured', ok: false };
    let fails = 0;
    for (const row of group) {
      try {
        tryDecrypt(row, key);
      } catch (e) {
        if (!(e instanceof CryptoError)) throw e;
        fails += 1;
      }
    }
    return fails === 0
      ? { version, rows: group.length, status: 'ok', ok: true }
      : { version, rows: group.length, status: `WRONG KEY (${fails} of ${group.length} fail)`, ok: false };
  });
}

/**
 * Every row already on `ring.current` must decrypt with the current key before any rewrap runs —
 * otherwise a wrong current key with nothing left on an old version would rewrap 0 rows and look
 * like a no-op success (spec §4, Review Focus 4). `tryDecrypt` should throw `CryptoError` on a
 * bad key; `describe` names the row for the error message. Nothing is written here: this only
 * reads and throws, so it is safe to call before opening any write transaction.
 */
export function probeCurrentVersion<T>(rows: T[], ring: KeyRing, tryDecrypt: (row: T) => void, describe: (row: T) => string): void {
  for (const row of rows) {
    try {
      tryDecrypt(row);
    } catch (e) {
      if (!(e instanceof CryptoError)) throw e;
      throw new Error(`key version ${ring.current} does not decrypt ${describe(row)} — PIDB_MASTER_KEY is not the version ${ring.current} key`);
    }
  }
}
