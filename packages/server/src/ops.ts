import { mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { openDb, type Db } from './db/connection.js';
import type { KeyRing, Config } from './config.js';
import { createAdmin, deleteAllSessions, getAdmin, setAdminPasswordHash } from './repos/admin.js';
import { getDocument, upsertDocument } from './repos/documents.js';
import { rewrapAllSecrets } from './repos/secrets.js';
import { deleteChallengesFor, deleteTwoFactor, resetFactorFailures, rewrapTotpSecrets } from './repos/twofactor.js';
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

export function runBackup(db: Db, dir: string, keep = 14, now: Date = new Date()): string {
  mkdirSync(dir, { recursive: true });
  const stamp = now.toISOString().replace(/\.\d{3}Z$/, '').replace(/:/g, '-');
  const file = join(dir, `pidb-${stamp}.sqlite`);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
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
