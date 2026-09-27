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
import { runSecretGet, runSecretSet, runSecretsList } from './commands/secrets.js';
import { runSecretExec } from './commands/exec.js';
import { runSecretEnv, runSecretWrite } from './commands/files.js';
import { runTokenCreate, runTokenList, runTokenRevoke } from './commands/tokens.js';

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
    .option('--expires <days>', 'token lifetime in days, 1-365 (default: 30)')
    .description('Exchange admin credentials for an API token and save it')
    .action(async (url: string, opts: { username?: string; name?: string; expires?: string }) => {
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

  const secrets = program.command('secrets').description('Secret metadata (never values)');
  secrets
    .command('list', { isDefault: true })
    .argument('[target]', 'project slug or "global"', 'global')
    .option('--json', 'raw JSON output')
    .action(async (target: string, opts: { json?: boolean }) => {
      emit(await runSecretsList(clientFrom(), target), opts.json === true);
    });

  const secret = program.command('secret').description('Consume a single secret');
  secret
    .command('get')
    .argument('<target>', 'project slug or "global"')
    .argument('<name>', 'secret name')
    .argument('<field>', 'field key')
    .option('--print', 'print the value to stdout (refused without this flag)')
    .option('--json', 'raw JSON output')
    .action(async (target: string, name: string, field: string, opts: { print?: boolean; json?: boolean }) => {
      emit(await runSecretGet(clientFrom(), target, name, field, opts), opts.json === true);
    });
  secret
    .command('set')
    .argument('<target>', 'project slug or "global"')
    .argument('<name>', 'secret name')
    .argument('<field>', 'field key')
    .option('--from-file <path>', 'read the value from a file instead of stdin')
    .option('--sensitive', 'mark the field sensitive')
    .option('--non-sensitive', 'mark the field non-sensitive')
    .option('--create', 'create the secret when it does not exist')
    .option('--json', 'raw JSON output')
    .action(
      async (
        target: string,
        name: string,
        field: string,
        opts: { fromFile?: string; sensitive?: boolean; nonSensitive?: boolean; create?: boolean; json?: boolean },
      ) => {
        emit(await runSecretSet(clientFrom(), target, name, field, opts), opts.json === true);
      },
    );
  secret
    .command('write')
    .argument('<target>', 'project slug or "global"')
    .argument('<name>', 'secret name')
    .argument('<field>', 'field key')
    .requiredOption('--out <path>', 'destination file')
    .option('--mode <mode>', 'octal file mode', '600')
    .option('--force', 'overwrite an existing file')
    .option('--json', 'raw JSON output')
    .description('Write one field value to a file (never printed)')
    .action(
      async (target: string, name: string, field: string, opts: { out: string; mode?: string; force?: boolean; json?: boolean }) => {
        emit(await runSecretWrite(clientFrom(), target, name, field, opts), opts.json === true);
      },
    );
  secret
    .command('env')
    .argument('<target>', 'project slug or "global"')
    .argument('<name>', 'secret name')
    .requiredOption('--out <path>', 'destination file')
    .option('--mode <mode>', 'octal file mode', '600')
    .option('--force', 'overwrite an existing file')
    .option('--json', 'raw JSON output')
    .description('Write every field as key=value lines to a file (never printed)')
    .action(async (target: string, name: string, opts: { out: string; mode?: string; force?: boolean; json?: boolean }) => {
      emit(await runSecretEnv(clientFrom(), target, name, opts), opts.json === true);
    });
  secret
    .command('exec')
    .argument('<target>', 'project slug or "global"')
    .argument('<name>', 'secret name')
    .argument('<command...>', 'command to run after --')
    .description('Run a command with the secret fields injected as PIDB_<KEY> environment variables')
    .action(async (target: string, name: string, command: string[]) => {
      process.exitCode = await runSecretExec(clientFrom(), target, name, command);
    });

  const token = program.command('token').description('API tokens (requires an admin token)');
  token
    .command('create')
    .requiredOption('--name <name>', 'token name')
    .requiredOption('--scopes <scopes>', 'comma-separated scopes')
    .option('--projects <slugs>', 'comma-separated project slugs (default: all projects)')
    .option('--expires <duration>', 'expiry such as 90d, 12h, 30m (default: 90d)')
    .option('--no-expiry', 'create a token that never expires')
    .option('--json', 'raw JSON output')
    .action(
      async (opts: { name: string; scopes: string; projects?: string; expires?: string; expiry?: boolean; json?: boolean }) => {
        emit(await runTokenCreate(clientFrom(), opts), opts.json === true);
      },
    );
  token
    .command('list')
    .option('--json', 'raw JSON output')
    .action(async (opts: { json?: boolean }) => {
      emit(await runTokenList(clientFrom()), opts.json === true);
    });
  token
    .command('revoke')
    .argument('<id>')
    .option('--json', 'raw JSON output')
    .action(async (id: string, opts: { json?: boolean }) => {
      emit(await runTokenRevoke(clientFrom(), id), opts.json === true);
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
    // process.exit() can truncate a long console.error write when stderr is a pipe (exactly how
    // the e2e tests invoke the CLI); setting exitCode and returning lets Node flush before exiting.
    process.exitCode = exitCodeOf(err);
    return;
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
