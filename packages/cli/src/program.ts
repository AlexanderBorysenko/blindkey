// Side-effect-free: builds the commander program for both the normal and agent entries, and is the
// only module either entry's bundle should share. Neither `cli.ts` nor `agent/cli.ts` import each
// other — each is a thin, self-executing wrapper around this module — so that esbuild bundling one
// entry (spec §2.1, `dist/pidb.mjs`) never drags in the other entry's `if (isEntryPoint()) void main()`
// top-level side effect (which would otherwise run twice: once for the real entry point, once because
// the bundle also contains the other file's module body sharing the same `import.meta.url`).
import { Command, CommanderError } from 'commander';
import { PidbClient } from './client.js';
import { loadConfig, normalizeUrl } from './config.js';
import { CliError, EXIT_AUTH, EXIT_NOT_FOUND, EXIT_REFUSED } from './errors.js';
import { emit, table } from './output.js';
import { runLogin } from './commands/login.js';
import { runProjectsGet, runProjectsList, runSearch } from './commands/projects.js';
import { resolveDocTarget, runDocsGet, runDocsList, runDocsPut } from './commands/docs.js';
import { runSecretGet, runSecretSet, runSecretsList } from './commands/secrets.js';
import { runSecretExec } from './commands/exec.js';
import { runSecretEnv, runSecretWrite } from './commands/files.js';
import { runTokenCreate, runTokenList, runTokenRevoke } from './commands/tokens.js';
import { resolveDataDir } from './agent/datadir.js';
import { resolveAgentConfig } from './agent/context.js';
import { loadBindings, loadProfiles, repoKey, saveBindings, saveProfiles } from './agent/state.js';
import { keyringStore, type TokenStore } from './agent/tokenstore.js';

export function clientFrom(env: NodeJS.ProcessEnv = process.env): PidbClient {
  return new PidbClient(loadConfig(env));
}

/** Not available to the Claude agent (spec §2.3): `login`, `secret get`, `secret set`, `token *`. */
const AGENT_REFUSED_MESSAGE = 'not available to the Claude agent — ask the user';

export interface ProgramOptions {
  /** Agent mode (spec §2.3) — also entered when `PIDB_AGENT=1` is set in `env`, see `main()`. */
  agent?: boolean;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Overrides the OS credential store (tests must use `memoryStore()`, never the real keychain). */
  store?: TokenStore;
  /** Overrides the derived plugin data dir (tests). */
  dataDir?: string;
}

export function buildProgram(opts: ProgramOptions = {}): Command {
  const agent = opts.agent === true;
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const dataDir = opts.dataDir ?? resolveDataDir(env);
  const store = opts.store ?? keyringStore(dataDir);

  const client = async (): Promise<PidbClient> => {
    if (!agent) return clientFrom(env);
    const cfg = await resolveAgentConfig({ cwd, env, store, dataDir });
    return new PidbClient({ url: cfg.url, token: cfg.token });
  };

  const refuseInAgentMode = (): void => {
    if (agent) throw new CliError(AGENT_REFUSED_MESSAGE, EXIT_REFUSED);
  };

  const program = new Command()
    .name('pidb')
    .description('Projects Info DB client')
    .showHelpAfterError()
    // Throw a CommanderError instead of calling process.exit() — required so tests (and any other
    // in-process caller) never risk killing their own process on a commander-level error (missing
    // argument, unknown command, --help, ...). Must be set before any `.command()` call below: a
    // subcommand only inherits the override that's active on its parent at the moment it's created.
    .exitOverride();

  program
    .command('login', { hidden: agent })
    .argument('<url>', 'server base url, e.g. https://pidb.example.com')
    .option('--username <username>', 'admin username (prompts when omitted)')
    .option('--name <name>', 'token name (default: cli-<hostname>)')
    .option('--expires <days>', 'token lifetime in days, 1-365 (default: 30)')
    .description('Exchange admin credentials for an API token and save it')
    .action(async (url: string, opts: { username?: string; name?: string; expires?: string }) => {
      refuseInAgentMode();
      emit(await runLogin(url, opts), false);
    });
  // Refuse before commander validates `login`'s own arguments/options (spec §2.3): a preSubcommand
  // hook fires before the target subcommand parses anything, so `pidb login` (missing <url>) is
  // refused with the agent message instead of commander's "missing required argument" error.
  program.hook('preSubcommand', (_program, subcommand) => {
    if (subcommand.name() === 'login') refuseInAgentMode();
  });

  const projects = program.command('projects').description('Projects');
  projects
    .command('list')
    .option('--json', 'raw JSON output')
    .action(async (opts: { json?: boolean }) => {
      emit(await runProjectsList(await client()), opts.json === true);
    });
  projects
    .command('get')
    .argument('<slug>')
    .option('--json', 'raw JSON output')
    .action(async (slug: string, opts: { json?: boolean }) => {
      emit(await runProjectsGet(await client(), slug), opts.json === true);
    });

  // Read-only and useful for the agent (spec §2.3 ruling), so available in both modes.
  program
    .command('search')
    .argument('<query>')
    .option('--json', 'raw JSON output')
    .description('Search projects, documents and secret names (never values)')
    .action(async (query: string, opts: { json?: boolean }) => {
      emit(await runSearch(await client(), query), opts.json === true);
    });

  const docs = program.command('docs').description('Documents (Markdown)');
  docs
    .command('list')
    .argument('[target]', 'project slug or "global"', 'global')
    .option('--json', 'raw JSON output')
    .action(async (target: string, opts: { json?: boolean }) => {
      emit(await runDocsList(await client(), target), opts.json === true);
    });
  docs
    .command('get')
    .argument('<target>', 'project slug, or the document slug for a global document')
    .argument('[doc]', 'document slug')
    .option('--refs', 'resolve {{secret:...}} references')
    .option('--json', 'raw JSON output')
    .action(async (a: string, b: string | undefined, opts: { refs?: boolean; json?: boolean }) => {
      const { target, doc } = resolveDocTarget(a, b);
      emit(await runDocsGet(await client(), target, doc, { refs: opts.refs }), opts.json === true);
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
        emit(await runDocsPut(await client(), target, doc, opts), opts.json === true);
      },
    );

  const secrets = program.command('secrets').description('Secret metadata (never values)');
  secrets
    .command('list', { isDefault: true })
    .argument('[target]', 'project slug or "global"', 'global')
    .option('--json', 'raw JSON output')
    .action(async (target: string, opts: { json?: boolean }) => {
      emit(await runSecretsList(await client(), target), opts.json === true);
    });

  const secret = program.command('secret').description('Consume a single secret');
  secret
    .command('get', { hidden: agent })
    .argument('<target>', 'project slug or "global"')
    .argument('<name>', 'secret name')
    .argument('<field>', 'field key')
    .option('--print', 'print the value to stdout (refused without this flag)')
    .option('--json', 'raw JSON output')
    .action(async (target: string, name: string, field: string, opts: { print?: boolean; json?: boolean }) => {
      refuseInAgentMode();
      emit(await runSecretGet(await client(), target, name, field, opts), opts.json === true);
    });
  secret
    .command('set', { hidden: agent })
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
        refuseInAgentMode();
        emit(await runSecretSet(await client(), target, name, field, opts), opts.json === true);
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
        emit(await runSecretWrite(await client(), target, name, field, opts), opts.json === true);
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
      emit(await runSecretEnv(await client(), target, name, opts), opts.json === true);
    });
  secret
    .command('exec')
    .argument('<target>', 'project slug or "global"')
    .argument('<name>', 'secret name')
    .argument('<command...>', 'command to run after --')
    .description('Run a command with the secret fields injected as PIDB_<KEY> environment variables')
    .action(async (target: string, name: string, command: string[]) => {
      process.exitCode = await runSecretExec(await client(), target, name, command);
    });
  // `secret get`/`secret set` are refused before commander parses their own arguments/options.
  secret.hook('preSubcommand', (_secret, subcommand) => {
    if (subcommand.name() === 'get' || subcommand.name() === 'set') refuseInAgentMode();
  });

  const token = program.command('token', { hidden: agent }).description('API tokens (requires an admin token)');
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
        refuseInAgentMode();
        emit(await runTokenCreate(await client(), opts), opts.json === true);
      },
    );
  token
    .command('list')
    .option('--json', 'raw JSON output')
    .action(async (opts: { json?: boolean }) => {
      refuseInAgentMode();
      emit(await runTokenList(await client()), opts.json === true);
    });
  token
    .command('revoke')
    .argument('<id>')
    .option('--json', 'raw JSON output')
    .action(async (id: string, opts: { json?: boolean }) => {
      refuseInAgentMode();
      emit(await runTokenRevoke(await client(), id), opts.json === true);
    });
  // Every `token` subcommand is refused in agent mode — refuse before any of them parse their own args.
  token.hook('preSubcommand', () => {
    refuseInAgentMode();
  });
  // Bare `pidb token` (no subcommand) doesn't dispatch into a child, so the preSubcommand hook above
  // never fires for it — without an action of its own, commander's default for a childless invocation
  // of a command that has subcommands is to display that group's help and exit, which would leak
  // token subcommand names/options into agent-mode output instead of refusing. Only register this in
  // agent mode: in normal mode `token`'s bare-invocation behavior (show help) is unchanged.
  if (agent) {
    token.action(() => {
      refuseInAgentMode();
    });
  }

  if (agent) buildAgentOnlyCommands(program, { cwd, store, dataDir });

  return program;
}

interface AgentOnlyDeps {
  cwd: string;
  store: TokenStore;
  dataDir: string;
}

/**
 * Commands that exist only in agent mode (spec §2.3): `profile`, `bind`/
 * `unbind`, `status`. `connect` is intentionally not registered here (Task 6).
 */
function buildAgentOnlyCommands(program: Command, { cwd, store, dataDir }: AgentOnlyDeps): void {
  const profile = program.command('profile').description('Server profiles');
  profile
    .command('list')
    .option('--json', 'raw JSON output')
    .action((opts: { json?: boolean }) => {
      const profiles = loadProfiles(dataDir);
      const rows = Object.entries(profiles.profiles).map(([name, p]) => [
        name,
        p.url,
        name === profiles.default ? 'yes' : '',
      ]);
      emit({ json: profiles, text: table(['NAME', 'URL', 'DEFAULT'], rows) }, opts.json === true);
    });
  profile
    .command('add')
    .argument('<name>')
    .argument('<url>')
    .action((name: string, url: string) => {
      const profiles = loadProfiles(dataDir);
      if (profiles.profiles[name]) {
        throw new CliError(`profile ${name} exists — use \`pidb profile set-url ${name} <url>\``, EXIT_REFUSED);
      }
      const normalized = normalizeUrl(url);
      profiles.profiles[name] = { url: normalized };
      if (!profiles.default) profiles.default = name;
      saveProfiles(dataDir, profiles);
      emit({ json: { name, url: normalized }, text: `added profile "${name}" (${normalized})` }, false);
    });
  profile
    .command('set-url')
    .argument('<name>')
    .argument('<url>')
    .description("change a profile's server url and clear its stored token")
    .action(async (name: string, url: string) => {
      const profiles = loadProfiles(dataDir);
      if (!profiles.profiles[name]) throw new CliError(`unknown profile "${name}"`, EXIT_NOT_FOUND);
      const normalized = normalizeUrl(url);
      // Clear the token for the *old* url before saving the new one: if this is interrupted midway,
      // the profile is left pointing at its old (now-tokenless) url rather than at a new url that's
      // still holding a token issued for the old server.
      await store.delete(name);
      profiles.profiles[name] = { url: normalized };
      saveProfiles(dataDir, profiles);
      emit(
        {
          json: { name, url: normalized, tokenCleared: true },
          text: `updated profile "${name}" (${normalized})\ntoken cleared — run \`pidb connect --profile ${name}\``,
        },
        false,
      );
    });
  profile
    .command('use')
    .argument('<name>')
    .action((name: string) => {
      const profiles = loadProfiles(dataDir);
      if (!profiles.profiles[name]) throw new CliError(`unknown profile "${name}"`, EXIT_NOT_FOUND);
      profiles.default = name;
      saveProfiles(dataDir, profiles);
      emit({ json: { default: name }, text: `default profile is now "${name}"` }, false);
    });
  profile
    .command('remove')
    .argument('<name>')
    .action(async (name: string) => {
      const profiles = loadProfiles(dataDir);
      if (!profiles.profiles[name]) throw new CliError(`unknown profile "${name}"`, EXIT_NOT_FOUND);
      delete profiles.profiles[name];
      if (profiles.default === name) profiles.default = null;
      saveProfiles(dataDir, profiles);
      await store.delete(name);
      emit({ json: { removed: name }, text: `removed profile "${name}"` }, false);
    });

  program
    .command('bind')
    .argument('<project>', 'project slug to bind this repo to')
    .option('--profile <name>', 'profile to bind (default: the repo\'s current binding, else the default profile)')
    .action((project: string, opts: { profile?: string }) => {
      const profiles = loadProfiles(dataDir);
      const bindings = loadBindings(dataDir);
      const key = repoKey(cwd);
      const profileName = opts.profile ?? bindings[key]?.profile ?? profiles.default;
      if (!profileName || !profiles.profiles[profileName]) {
        throw new CliError('no server configured — run `pidb profile add <name> <url>`', EXIT_AUTH);
      }
      bindings[key] = { profile: profileName, project };
      saveBindings(dataDir, bindings);
      emit(
        { json: bindings[key], text: `bound this repo to project "${project}" on profile "${profileName}"` },
        false,
      );
    });
  program.command('unbind').action(() => {
    const bindings = loadBindings(dataDir);
    const key = repoKey(cwd);
    const had = key in bindings;
    delete bindings[key];
    saveBindings(dataDir, bindings);
    emit({ json: { unbound: had }, text: had ? 'unbound this repo' : 'this repo was not bound' }, false);
  });

  program
    .command('status')
    .option('--json', 'raw JSON output')
    .action(async (opts: { json?: boolean }) => {
      const profiles = loadProfiles(dataDir);
      const bindings = loadBindings(dataDir);
      const binding = bindings[repoKey(cwd)];
      const profileName = binding?.profile ?? profiles.default;
      const resolvedProfile = profileName ? profiles.profiles[profileName] : undefined;
      const url = resolvedProfile?.url ?? null;
      const token = profileName ? await store.get(profileName) : null;
      const connected = token !== null;
      const project = binding?.project ?? null;
      const json = { profile: profileName ?? null, url, project, connected };
      const text = [
        `profile: ${profileName ?? '(none)'}`,
        `url: ${url ?? '(none)'}`,
        `project: ${project ?? '(none)'}`,
        `connected: ${connected ? 'yes' : 'no'}`,
      ].join('\n');
      emit({ json, text }, opts.json === true);
    });
}

/** Maps a thrown error to a process exit code: our own `CliError`s, or commander's own errors (e.g.
 * missing argument, unknown command, `--help`/`--version`) now that `buildProgram` uses `exitOverride()`. */
export function exitCodeOf(err: unknown): number {
  if (err instanceof CliError) return err.exitCode;
  if (err instanceof CommanderError) return err.exitCode;
  return 1;
}
