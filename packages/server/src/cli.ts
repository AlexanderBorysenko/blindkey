#!/usr/bin/env node
import { Command } from 'commander';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { loadConfig, type Config } from './config.js';
import { openDb, type Db } from './db/connection.js';
import { runBackup, runInit, runKeyVersions, runPasswordReset, runRotateKey, runTotpReset, startServer } from './ops.js';

/**
 * Every ops command except `init`/`start` operates on an existing database — it must never
 * create one as a side effect of a typo'd path or a not-yet-restored volume (F2). `openDb` runs
 * migrations unconditionally, so it would silently create `config.dbPath` if it were missing;
 * this checks first and fails the way the rest of the CLI does.
 */
function openExistingDb(config: Config): Db {
  if (!existsSync(config.dbPath)) {
    throw new Error(`no database at ${config.dbPath} — run init first (or check PIDB_DATA_DIR / the restore)`);
  }
  return openDb(config.dbPath);
}

const CTRL_C = '\u0003';
const BACKSPACE = '\u007f';

async function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

function promptHidden(question: string): Promise<string> {
  stdout.write(question);
  if (!stdin.isTTY) {
    // Do not reuse prompt(): readline enables terminal mode (which echoes
    // input) whenever stdout is a TTY, even if stdin is not — e.g. piped
    // stdin with an interactive stdout would then echo the password.
    const rl = readline.createInterface({ input: stdin, output: stdout, terminal: false });
    return rl.question('').then((answer) => {
      rl.close();
      return answer.trim();
    });
  }
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise<string>((resolve) => {
    let buf = '';
    const onData = (chunk: Buffer) => {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\n' || ch === '\r') {
          stdin.setRawMode(false);
          stdin.off('data', onData);
          stdin.pause();
          stdout.write('\n');
          resolve(buf.trim());
          return;
        }
        if (ch === CTRL_C) {
          stdin.setRawMode(false);
          stdout.write('\n');
          process.exit(130);
        }
        if (ch === BACKSPACE) buf = buf.slice(0, -1);
        else buf += ch;
      }
    };
    stdin.on('data', onData);
  });
}

function fatal(err: unknown): never {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`error: ${msg}`);
  process.exit(1);
}

const program = new Command().name('pidb-server').description('Projects Info DB server');

program
  .command('init')
  .description('Run migrations, create the admin user, seed the guidelines document')
  .action(async () => {
    try {
      const config = loadConfig();
      mkdirSync(config.dataDir, { recursive: true });
      const db = openDb(config.dbPath);
      const username = process.env.PIDB_ADMIN_USERNAME ?? (await prompt('Admin username: '));
      const password = process.env.PIDB_ADMIN_PASSWORD ?? (await promptHidden('Admin password: '));
      if (!username || !password) throw new Error('username and password are required');
      const r = await runInit(db, { username, password });
      console.log(`admin: ${r.adminCreated ? 'created' : 'already exists'}; guidelines: ${r.guidelinesSeeded ? 'seeded' : 'already present'}`);
      db.close();
    } catch (err) {
      fatal(err);
    }
  });

program
  .command('start')
  .description('Start the HTTP server')
  .action(async () => {
    try {
      const config = loadConfig();
      const app = await startServer(config);
      const shutdown = async () => {
        await app.close();
        process.exit(0);
      };
      process.on('SIGTERM', () => void shutdown());
      process.on('SIGINT', () => void shutdown());
    } catch (err) {
      fatal(err);
    }
  });

program
  .command('rotate-key')
  .description('Rewrap all secret DEKs with the current master key version')
  .action(() => {
    try {
      const config = loadConfig();
      const db = openExistingDb(config);
      const r = runRotateKey(db, config.keyRing);
      console.log(`rewrapped ${r.secrets} secrets to key version ${config.keyRing.current}`);
      console.log(`rewrapped ${r.totp} 2FA secrets`);
      db.close();
    } catch (err) {
      fatal(err);
    }
  });

program
  .command('key-versions')
  .description('Show how many rows sit on each master key version, and whether they decrypt')
  .action(() => {
    try {
      const config = loadConfig();
      const db = openExistingDb(config);
      const r = runKeyVersions(db, config.keyRing);
      for (const line of r.lines) console.log(line);
      db.close();
      if (!r.ok) process.exit(1);
    } catch (err) {
      fatal(err);
    }
  });

program
  .command('backup')
  .description('Write a consistent SQLite copy and prune old backups')
  .option('--out <dir>', 'backup directory (default: <dataDir>/backups)')
  .option('--keep <n>', 'number of backups to keep', '14')
  .action((opts: { out?: string; keep: string }) => {
    try {
      const config = loadConfig();
      const db = openExistingDb(config);
      const file = runBackup(db, opts.out ?? join(config.dataDir, 'backups'), Number.parseInt(opts.keep, 10));
      console.log(`backup written: ${file}`);
      db.close();
    } catch (err) {
      fatal(err);
    }
  });

program
  .command('passwd')
  .description('Change the admin password (emergency recovery: signs out every session)')
  .action(async () => {
    try {
      const config = loadConfig();
      const db = openExistingDb(config);
      let password = process.env.PIDB_ADMIN_PASSWORD;
      if (!password) {
        password = await promptHidden('New admin password: ');
        // A second readline on piped (non-TTY) stdin can lose buffered input, so the repeat
        // is only asked for interactively — and only on the prompt path, never with the env var.
        if (stdin.isTTY) {
          const repeat = await promptHidden('Repeat new admin password: ');
          if (repeat !== password) throw new Error('passwords do not match');
        }
      }
      const r = await runPasswordReset(db, password);
      console.log(`password changed for ${r.username}; signed out ${r.sessions} sessions`);
      db.close();
    } catch (err) {
      fatal(err);
    }
  });

const twoFactor = program.command('2fa').description('Two-factor authentication (shell-only recovery)');
twoFactor
  .command('reset')
  .description('Turn off two-factor authentication for the admin (emergency recovery)')
  .action(() => {
    try {
      const config = loadConfig();
      const db = openExistingDb(config);
      console.log(`two-factor disabled for ${runTotpReset(db)}`);
      db.close();
    } catch (err) {
      fatal(err);
    }
  });

program.parseAsync(process.argv).catch(fatal);
