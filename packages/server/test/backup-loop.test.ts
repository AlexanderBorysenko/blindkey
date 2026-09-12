import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { openDb } from '../src/db/connection.js';

const repoRoot = resolve(import.meta.dirname, '../../..');
const script = join(repoRoot, 'docker/backup-loop.sh');
const serverCli = join(repoRoot, 'packages/server/dist/cli.js');

describe('backup-loop.sh', () => {
  it('runs one backup into the backup directory and exits 0', () => {
    expect(existsSync(serverCli)).toBe(true); // run `npm run build` first
    const dataDir = mkdtempSync(join(tmpdir(), 'pidb-backup-'));
    const dbPath = join(dataDir, 'pidb.sqlite');
    openDb(dbPath).close(); // create a real, migrated database

    const res = spawnSync('/bin/sh', [script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PIDB_MASTER_KEY: randomBytes(32).toString('base64'),
        PIDB_DATA_DIR: dataDir,
        PIDB_DB_PATH: dbPath,
        PIDB_SERVER_BIN: serverCli,
        PIDB_BACKUP_ONCE: '1',
        PIDB_BACKUP_KEEP: '2',
      },
    });

    expect(res.status).toBe(0);
    const backups = readdirSync(join(dataDir, 'backups'));
    expect(backups.length).toBe(1);
    expect(backups[0]).toMatch(/^pidb-.*\.sqlite$/);
  });

  it('prunes to PIDB_BACKUP_KEEP, dropping the oldest copies', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'pidb-backup-keep-'));
    const dbPath = join(dataDir, 'pidb.sqlite');
    openDb(dbPath).close();
    const backupsDir = join(dataDir, 'backups');
    mkdirSync(backupsDir);
    const seeds = ['pidb-2020-01-01T00-00-00.sqlite', 'pidb-2020-01-02T00-00-00.sqlite', 'pidb-2020-01-03T00-00-00.sqlite'];
    for (const seed of seeds) writeFileSync(join(backupsDir, seed), '');

    const res = spawnSync('/bin/sh', [script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PIDB_MASTER_KEY: randomBytes(32).toString('base64'),
        PIDB_DATA_DIR: dataDir,
        PIDB_DB_PATH: dbPath,
        PIDB_SERVER_BIN: serverCli,
        PIDB_BACKUP_ONCE: '1',
        PIDB_BACKUP_KEEP: '2',
      },
    });

    expect(res.status).toBe(0);
    const backups = readdirSync(backupsDir).sort();
    expect(backups.length).toBe(2);
    expect(backups).toContain('pidb-2020-01-03T00-00-00.sqlite');
    expect(backups).not.toContain('pidb-2020-01-01T00-00-00.sqlite');
    expect(backups).not.toContain('pidb-2020-01-02T00-00-00.sqlite');
    const other = backups.find((f) => f !== 'pidb-2020-01-03T00-00-00.sqlite')!;
    expect(other).toMatch(/^pidb-.*\.sqlite$/);
    expect(seeds).not.toContain(other);
  });

  it('exits non-zero when the master key is missing', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'pidb-backup-nokey-'));
    const env: Record<string, string> = { ...process.env } as Record<string, string>;
    delete env.PIDB_MASTER_KEY;
    delete env.PIDB_MASTER_KEY_FILE;
    const res = spawnSync('/bin/sh', [script], {
      encoding: 'utf8',
      env: { ...env, PIDB_DATA_DIR: dataDir, PIDB_SERVER_BIN: serverCli, PIDB_BACKUP_ONCE: '1' },
    });
    expect(res.status).not.toBe(0);
    expect(`${res.stdout}${res.stderr}`).toContain('PIDB_MASTER_KEY');
  });
});
