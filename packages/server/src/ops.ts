import { mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { openDb, type Db } from './db/connection.js';
import type { KeyRing, Config } from './config.js';
import { createAdmin, getAdmin } from './repos/admin.js';
import { getDocument, upsertDocument } from './repos/documents.js';
import { rewrapAllSecrets } from './repos/secrets.js';
import { hashPassword } from './crypto/passwords.js';
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

export function runRotateKey(db: Db, ring: KeyRing): number {
  return rewrapAllSecrets(db, ring);
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
  const app = await buildApp({ db, ring: config.keyRing, logLevel: config.logLevel, trustProxy: true });
  app.addHook('onClose', async () => {
    db.close();
  });
  await app.listen({ port: config.port, host: config.host });
  return app;
}
