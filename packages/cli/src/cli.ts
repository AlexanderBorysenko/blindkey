#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { PidbClient } from './client.js';
import { loadConfig } from './config.js';
import { CliError } from './errors.js';
import { emit } from './output.js';
import { runLogin } from './commands/login.js';
import { runProjectsGet, runProjectsList, runSearch } from './commands/projects.js';
import { resolveDocTarget, runDocsGet, runDocsList, runDocsPut } from './commands/docs.js';

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

  const projects = program.command('projects').description('Projects');
  projects
    .command('list')
    .option('--json', 'raw JSON output')
    .action(async (opts: { json?: boolean }) => {
      emit(await runProjectsList(clientFrom()), opts.json === true);
    });
  projects
    .command('get')
    .argument('<slug>')
    .option('--json', 'raw JSON output')
    .action(async (slug: string, opts: { json?: boolean }) => {
      emit(await runProjectsGet(clientFrom(), slug), opts.json === true);
    });

  program
    .command('search')
    .argument('<query>')
    .option('--json', 'raw JSON output')
    .description('Search projects, documents and secret names (never values)')
    .action(async (query: string, opts: { json?: boolean }) => {
      emit(await runSearch(clientFrom(), query), opts.json === true);
    });

  const docs = program.command('docs').description('Documents (Markdown)');
  docs
    .command('list')
    .argument('[target]', 'project slug or "global"', 'global')
    .option('--json', 'raw JSON output')
    .action(async (target: string, opts: { json?: boolean }) => {
      emit(await runDocsList(clientFrom(), target), opts.json === true);
    });
  docs
    .command('get')
    .argument('<target>', 'project slug, or the document slug for a global document')
    .argument('[doc]', 'document slug')
    .option('--refs', 'resolve {{secret:...}} references')
    .option('--json', 'raw JSON output')
    .action(async (a: string, b: string | undefined, opts: { refs?: boolean; json?: boolean }) => {
      const { target, doc } = resolveDocTarget(a, b);
      emit(await runDocsGet(clientFrom(), target, doc, { refs: opts.refs }), opts.json === true);
    });
  docs
    .command('put')
    .argument('<target>', 'project slug, or the document slug for a global document')
    .argument('[doc]', 'document slug')
    .requiredOption('--file <path>', 'Markdown file to upload')
    .requiredOption('--title <title>', 'document title')
    .requiredOption('--category <category>', 'document category')
    .option('--force', 'save despite lint findings or unresolved refs')
    .option('--json', 'raw JSON output')
    .action(
      async (
        a: string,
        b: string | undefined,
        opts: { file: string; title: string; category: string; force?: boolean; json?: boolean },
      ) => {
        const { target, doc } = resolveDocTarget(a, b);
        emit(await runDocsPut(clientFrom(), target, doc, opts), opts.json === true);
      },
    );

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
// Compares realpaths (not raw argv[1]/import.meta.url strings) because npm
// materializes `bin` entries as symlinks: argv[1] is the symlink path while
// import.meta.url resolves to the target's realpath, so a naive string
// comparison never matches for an installed bin.
function isEntryPoint(): boolean {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    return fileURLToPath(import.meta.url) === realpathSync(arg);
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  void main();
}
