import { describe, it, expect } from 'vitest';
import { guardDecision, type GuardContext, type HookInput } from '../src/agent/hooks/guard.js';

const posixCtx: GuardContext = {
  dataDir: '/home/alex/.claude/plugins/data/pidb-pidb',
  written: ['/home/alex/project/.pidb/db.env'],
  serverUrls: ['https://pidb.example.com', 'http://127.0.0.1:8080'],
  home: '/home/alex',
  platform: 'linux',
};

const win32Ctx: GuardContext = {
  dataDir: 'C:\\Users\\alex\\AppData\\Roaming\\Claude\\plugins\\data\\pidb-pidb',
  written: ['C:\\Users\\alex\\project\\.pidb\\db.env'],
  serverUrls: ['https://pidb.example.com'],
  home: 'C:\\Users\\alex',
  platform: 'win32',
};

function bash(command: string, ctx: GuardContext = posixCtx, cwd = '/home/alex/project'): HookInput {
  return { hook_event_name: 'PreToolUse', cwd, tool_name: 'Bash', tool_input: { command } };
}

function tool(name: string, input: Record<string, unknown>, ctx: GuardContext = posixCtx, cwd = '/home/alex/project'): HookInput {
  return { hook_event_name: 'PreToolUse', cwd, tool_name: name, tool_input: input };
}

function expectAllow(input: HookInput, ctx: GuardContext = posixCtx): void {
  expect(guardDecision(input, ctx)).toEqual({ deny: false });
}

function expectDeny(input: HookInput, ctx: GuardContext = posixCtx): void {
  const d = guardDecision(input, ctx);
  expect(d.deny).toBe(true);
  if (d.deny) expect(d.reason.length).toBeGreaterThan(0);
}

describe('guardDecision — allowed look-alikes (must never deny)', () => {
  it.each([
    ['pidb secret exec acme DB -- npm test'],
    ['cat README.md'],
    ['echo hello'],
  ])('%s', (command) => {
    expectAllow(bash(command));
    expectAllow(bash(command), win32Ctx);
  });
});

describe('guardDecision — rule 1: pidb + disabled subcommand', () => {
  it.each([
    ['pidb secret get acme DB'],
    ['pidb secret get acme DB --print'],
    ['pidb login https://pidb.example.com'],
    ['pidb token list'],
    ['pidb token create --name x --scopes projects:read'],
    ['pidb secret exec acme DB --print -- npm test'],
    ['echo hi && pidb login https://x'],
  ])('denies: %s', (command) => {
    expectDeny(bash(command));
  });

  it.each([['pidb secret exec acme DB -- npm test'], ['pidb secret write acme DB --out /tmp/x'], ['pidb bind acme'], ['pidb status']])(
    'allows: %s',
    (command) => {
      expectAllow(bash(command));
    },
  );

  it('does not deny "token" appearing only inside an unrelated secret name (word-boundary safe)', () => {
    expectAllow(bash('pidb secret exec acme GITHUB_TOKEN -- npm test'));
  });
});

describe('guardDecision — rule 2: pidb secret exec whose child prints the environment', () => {
  it.each([
    // bash/zsh
    ['pidb secret exec acme DB -- echo $PIDB_DB'],
    ['pidb secret exec acme DB -- echo "${PIDB_DB}"'],
    ['pidb secret exec acme DB -- env'],
    ['pidb secret exec acme DB -- printenv'],
    ['pidb secret exec acme DB -- set'],
    ['pidb secret exec acme DB -- export -p'],
    ['pidb secret exec acme DB -- node -e "console.log(process.env)"'],
    ["pidb secret exec acme DB -- python -c \"import os; print(os.environ)\""],
    // cmd.exe
    ['pidb secret exec acme DB -- cmd /c echo %PIDB_DB%'],
    ['pidb secret exec acme DB -- cmd /c set'],
    // PowerShell
    ['pidb secret exec acme DB -- powershell -c "$env:PIDB_DB"'],
    ['pidb secret exec acme DB -- powershell -Command "Get-ChildItem env:"'],
    ['pidb secret exec acme DB -- powershell -c "gci env:"'],
    ['pidb secret exec acme DB -- pwsh -c "dir env:"'],
    ['pidb secret exec acme DB -- pwsh -c "ls env:"'],
  ])('denies: %s', (command) => {
    expectDeny(bash(command));
  });

  it.each([
    ['pidb secret exec acme DB -- npm test'],
    ['pidb secret exec acme DB -- npm run reset'],
    ['pidb secret exec acme DB -- env FOO=bar npm test'],
    ['pidb secret exec acme DB -- set -e'],
    ['pidb secret exec acme DB -- node -e "console.log(1)"'],
  ])('allows: %s', (command) => {
    expectAllow(bash(command));
  });

  it('a bare `env`/`set` outside of `pidb secret exec` is not denied by this rule', () => {
    expectAllow(bash('env'));
    expectAllow(bash('set'));
    expectAllow(bash('printenv'));
  });
});

describe('guardDecision — rule 3: protected paths (Bash, read-tool + path substring)', () => {
  const dataDirFile = '/home/alex/.claude/plugins/data/pidb-pidb/profiles.json';
  const writtenFile = '/home/alex/project/.pidb/db.env';

  it.each([
    ['cat', dataDirFile],
    ['type', writtenFile],
    ['less', dataDirFile],
    ['head', dataDirFile],
    ['tail', dataDirFile],
    ['grep secret', dataDirFile],
    ['sed -n 1p', dataDirFile],
    ['awk 1', dataDirFile],
    ['cp', dataDirFile],
    ['base64', writtenFile],
    ['xxd', dataDirFile],
    ['od -c', dataDirFile],
    ['strings', dataDirFile],
    ['Get-Content', dataDirFile],
  ])('denies "%s %s"', (verb, path) => {
    expectDeny(bash(`${verb} ${path}`));
  });

  it('denies cat of ~/.config/pidb (posix)', () => {
    expectDeny(bash('cat ~/.config/pidb/config.json'));
  });

  it('denies cat of $HOME/.config/pidb', () => {
    expectDeny(bash('cat $HOME/.config/pidb/config.json'));
  });

  it('denies cat of %APPDATA%\\pidb (win32 ctx)', () => {
    expectDeny(bash('type %APPDATA%\\pidb\\config.json', win32Ctx), win32Ctx);
  });

  it('denies cat of $env:APPDATA\\pidb (PowerShell, win32 ctx)', () => {
    expectDeny(bash('Get-Content $env:APPDATA\\pidb\\config.json', win32Ctx), win32Ctx);
  });

  it('win32 path comparison is case-insensitive', () => {
    const upper = win32Ctx.dataDir.toUpperCase() + '\\profiles.json';
    expectDeny(bash(`type ${upper}`, win32Ctx), win32Ctx);
  });

  it('a read tool on an unrelated file is allowed', () => {
    expectAllow(bash('cat README.md'));
    expectAllow(bash('cat /home/alex/project/src/index.ts'));
  });

  it('a protected path mentioned without a read tool is allowed by this rule (no read verb present)', () => {
    expectAllow(bash(`echo ${dataDirFile}`));
  });
});

describe('guardDecision — rule 3: protected paths (Read/Grep/Glob/Edit/Write file_path/path args)', () => {
  it('denies Read of a file inside the plugin data dir', () => {
    expectDeny(tool('Read', { file_path: '/home/alex/.claude/plugins/data/pidb-pidb/profiles.json' }));
  });

  it('denies Edit of a written.json-recorded secret file', () => {
    expectDeny(tool('Edit', { file_path: '/home/alex/project/.pidb/db.env', old_string: 'a', new_string: 'b' }));
  });

  it('denies Write into the data dir', () => {
    expectDeny(tool('Write', { file_path: '/home/alex/.claude/plugins/data/pidb-pidb/x.txt', content: 'x' }));
  });

  it('denies Grep with path set to the data dir', () => {
    expectDeny(tool('Grep', { pattern: 'token', path: '/home/alex/.claude/plugins/data/pidb-pidb' }));
  });

  it('denies Glob with path set to the data dir', () => {
    expectDeny(tool('Glob', { pattern: '**/*.json', path: '/home/alse/.claude/plugins/data/pidb-pidb'.replace('alse', 'alex') }));
  });

  it('allows Read of an unrelated project file', () => {
    expectAllow(tool('Read', { file_path: '/home/alex/project/README.md' }));
  });

  it('resolves a relative file_path against the input cwd before comparing', () => {
    // cwd is /home/alex/project/sub; two levels up is /home/alex, matching posixCtx.dataDir's parent.
    expectDeny(
      tool('Read', { file_path: '../../.claude/plugins/data/pidb-pidb/profiles.json' }, posixCtx, '/home/alex/project/sub'),
    );
  });

  it('denies an mcp__* tool call whose string arg is exactly a protected path', () => {
    expectDeny(tool('mcp__pidb__some_future_tool', { path: '/home/alex/.claude/plugins/data/pidb-pidb/profiles.json' }));
  });

  it('allows an mcp__* tool call with unrelated string args', () => {
    expectAllow(tool('mcp__pidb__pidb_status', {}));
  });
});

describe('guardDecision — rule 4: reading an OS credential store', () => {
  it.each([
    ['security find-generic-password -s pidb -a work -w'],
    ['security find-internet-password -s pidb.example.com'],
    ['cmdkey /list'],
    ['Get-StoredCredential -Target pidb'],
    ['secret-tool lookup service pidb'],
    ['keyring get pidb work'],
  ])('denies: %s', (command) => {
    expectDeny(bash(command));
  });
});

describe('guardDecision — rule 5: direct HTTP against a configured pidb server', () => {
  it.each([
    ['curl https://pidb.example.com/api/v1/projects'],
    ['wget https://pidb.example.com/api/v1/projects'],
    ['Invoke-WebRequest -Uri https://pidb.example.com/api/v1/projects'],
    ['iwr https://pidb.example.com/api/v1/projects'],
    ['irm https://pidb.example.com/api/v1/projects'],
    ['curl http://127.0.0.1:8080/api/v1/projects'],
  ])('denies: %s', (command) => {
    expectDeny(bash(command));
  });

  it('allows curl against an unrelated, unconfigured host', () => {
    expectAllow(bash('curl https://example.com/'));
  });

  it('allows a network tool word appearing only as a substring of another word', () => {
    expectAllow(bash('curlfeather --help'));
  });
});
