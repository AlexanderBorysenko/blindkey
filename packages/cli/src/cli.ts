#!/usr/bin/env node
import { Command } from 'commander';
import { PidbClient } from './client.js';
import { loadConfig } from './config.js';
import { CliError } from './errors.js';
import { emit } from './output.js';
import { runLogin } from './commands/login.js';

export function clientFrom(env: NodeJS.ProcessEnv = process.env): PidbClient {
  return new PidbClient(loadConfig(env));
}

export function buildProgram(): Command {
  const program = new Command()
    .name('pidb')
    .description('Projects Info DB client')
    .showHelpAfterError();

  program
    .command('login')
    .argument('<url>', 'server base url, e.g. https://pidb.example.com')
    .option('--username <username>', 'admin username (prompts when omitted)')
    .option('--name <name>', 'token name (default: cli-<hostname>)')
    .description('Exchange admin credentials for an API token and save it')
    .action(async (url: string, opts: { username?: string; name?: string }) => {
      emit(await runLogin(url, opts), false);
    });

  return program;
}

export function exitCodeOf(err: unknown): number {
  return err instanceof CliError ? err.exitCode : 1;
}

export async function main(argv: string[] = process.argv): Promise<void> {
  try {
    await buildProgram().parseAsync(argv);
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(exitCodeOf(err));
  }
}

// Run only when this module is the entry point, so tests can import it freely.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
