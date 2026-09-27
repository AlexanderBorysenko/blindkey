import { mkdirSync, readdirSync, unlinkSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { openDb, type Db } from './db/connection.js';
import type { KeyRing, Config } from './config.js';
import { createAdmin, deleteAllSessions, getAdmin, setAdminPasswordHash } from './repos/admin.js';
import { getDocument, upsertDocument } from './repos/documents.js';
import { rewrapAllSecrets, secretKeyVersionReport } from './repos/secrets.js';
import { deleteChallengesFor, deleteTwoFactor, resetFactorFailures, rewrapTotpSecrets, totpKeyVersionReport } from './repos/twofactor.js';
import { writeAudit } from './repos/audit.js';
import { hashPassword } from './crypto/passwords.js';
import { validateNewPassword } from './services/password.js';
import { GUIDELINES_MD } from './seed/guidelines.js';
import { buildApp } from './http/app.js';

export async function runInit(db: Db, opts: { username: string; password: string }): Promise<{ adminCreated: boolean; guidelinesSeeded: boolean }> {
  let adminCreated = false;
  if (!getAdmin(db)) {
    createAdmin(db, opts.username, await hashPassword(opts.password));
    adminCreated = true;
  }
  let guidelinesSeeded = false;
  if (!getDocument(db, null, 'guidelines')) {
    upsertDocument(db, { projectId: null, slug: 'guidelines', title: 'Documentation guidelines', category: 'guidelines', body_md: GUIDELINES_MD });
    guidelinesSeeded = true;
  }
  return { adminCreated, guidelinesSeeded };
}

export function runRotateKey(db: Db, ring: KeyRing): { secrets: number; totp: number } {
  // One outer transaction: either every secret and every 2FA secret is rewrapped, or nothing is
  // (the README runbook relies on this). Rows already on the current version are skipped, so it is safe to re-run.
  return db.transaction(() => ({ secrets: rewrapAllSecrets(db, ring), totp: rewrapTotpSecrets(db, ring) }))();
}

/** `pidb-server key-versions` (spec §4): how many rows sit on each key version, and whether they decrypt. */
export function runKeyVersions(db: Db, ring: KeyRing): { lines: string[]; ok: boolean } {
  const secrets = secretKeyVersionReport(db, ring);
  const totp = totpKeyVersionReport(db, ring);
  if (secrets.length === 0 && totp.length === 0) return { lines: ['no encrypted rows'], ok: true };
  const lines: string[] = [];
  let ok = true;
  for (const r of secrets) {
    lines.push(`secrets v${r.version}: ${r.rows} rows, ${r.status}`);
    if (!r.ok) ok = false;
  }
  for (const r of totp) {
    lines.push(`2fa v${r.version}: ${r.rows} rows, ${r.status}`);
    if (!r.ok) ok = false;
  }
  return { lines, ok };
}

export function runTotpReset(db: Db): string {
  const admin = getAdmin(db);
  if (!admin) throw new Error('no admin user — run init first');
  deleteTwoFactor(db, admin.id);
  writeAudit(db, { actor_type: 'admin', actor_id: admin.id, action: 'auth.totp_reset', meta: { via: 'shell' } });
  return admin.username;
}

/**
 * Shell password reset (`pidb-server passwd`, spec §1.3). Unlike the UI's `changePassword`,
 * this cannot know the current password — it is the emergency-recovery path — so it signs out
 * EVERY session (not "every other one"), drops pending login challenges, and clears any 2FA
 * lock. 2FA itself is left as is (use `2fa reset` separately).
 *
 * `hashPassword` is async, so the hash is computed before the transaction opens — better-sqlite3
 * transactions must run synchronously.
 */
export async function runPasswordReset(db: Db, password: string): Promise<{ username: string; sessions: number }> {
  const admin = getAdmin(db);
  if (!admin) throw new Error('no admin user — run init first');
  const error = validateNewPassword(password);
  if (error) throw new Error(error);
  const hash = await hashPassword(password);
  return db.transaction(() => {
    setAdminPasswordHash(db, admin.id, hash);
    const sessions = deleteAllSessions(db, admin.id);
    deleteChallengesFor(db, admin.id);
    resetFactorFailures(db, admin.id);
    writeAudit(db, { actor_type: 'admin', actor_id: admin.id, action: 'auth.password_reset', meta: { via: 'shell' } });
    return { username: admin.username, sessions };
  })();
}

const BACKUP_RE = /^pidb-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.sqlite$/;
const STALE_TMP_RE = /^pidb-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.sqlite\.tmp$/;

/** Real integrity check for a just-written backup (spec §4). Overridable in tests via `runBackup`'s `verify` parameter. */
function verifyBackup(file: string): void {
  const copy = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const result = copy.pragma('integrity_check', { simple: true });
    if (result !== 'ok') throw new Error(`backup integrity check failed: ${result}`);
  } finally {
    copy.close();
  }
}

export function runBackup(db: Db, dir: string, keep = 14, now: Date = new Date(), verify: (file: string) => void = verifyBackup): string {
  mkdirSync(dir, { recursive: true });
  // A crashed prior run can leave a temp file behind; it never matches BACKUP_RE, so it would
  // otherwise sit there forever without counting toward `keep` or getting pruned (Review Focus 5).
  // This could in principle delete a *concurrent* run's still-in-progress temp file, but that run
  // then simply fails at VACUUM INTO or verify (the file it expects is gone) and throws — it never
  // produces or keeps a bad backup, so this is safe even though backups aren't meant to overlap.
  for (const f of readdirSync(dir)) {
    if (STALE_TMP_RE.test(f)) unlinkSync(join(dir, f));
  }
  const stamp = now.toISOString().replace(/\.\d{3}Z$/, '').replace(/:/g, '-');
  const tmp = join(dir, `pidb-${stamp}.sqlite.tmp`);
  const file = join(dir, `pidb-${stamp}.sqlite`);
  try {
    db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    verify(tmp);
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  const existing = readdirSync(dir).filter((f) => BACKUP_RE.test(f)).sort();
  for (const old of existing.slice(0, Math.max(0, existing.length - keep))) unlinkSync(join(dir, old));
  return file;
}

export async function startServer(config: Config): Promise<FastifyInstance> {
  mkdirSync(config.dataDir, { recursive: true });
  const db = openDb(config.dbPath);
  const app = await buildApp({ db, ring: config.keyRing, logLevel: config.logLevel, trustProxy: config.trustProxy });
  app.addHook('onClose', async () => {
    db.close();
  });
  await app.listen({ port: config.port, host: config.host });
  return app;
}
