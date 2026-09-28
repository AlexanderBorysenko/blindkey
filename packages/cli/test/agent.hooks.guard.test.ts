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

  it('allows "pidb login"/"pidb token" words that only appear inside a quoted string, not as a real invocation', () => {
    expectAllow(bash('git commit -m "fix pidb login flow"'));
    expectAllow(bash('pidb secret exec acme "API token" -- npm test'));
    expectAllow(bash('echo "remember to run pidb token list later"'));
  });

  it('still denies a real invocation chained after other commands (command-position anchoring)', () => {
    expectDeny(bash('echo hi && pidb login https://x'));
    expectDeny(bash('true; pidb token list'));
  });

  describe('Fix round 2 N3 — only pidb\'s OWN args (before its own first " -- ") are checked', () => {
    it.each([
      ['pidb secret exec acme DB -- npm run get-data'],
      ['pidb secret exec acme DB -- curl https://api.example.com/get'],
      ['pidb secret exec acme DB -- node scripts/get-users.js'],
      ['pidb secret exec acme "get token" -- npm test'],
      ['pidb secret exec acme DB -- ./deploy.sh --print-summary'],
    ])('allows: %s', (command) => {
      expectAllow(bash(command));
    });

    it('denies a real invocation on its own line after an unrelated earlier command', () => {
      expectDeny(bash('cd x\npidb login'));
    });

    it('denies "npx pidb login"', () => {
      expectDeny(bash('npx pidb login'));
    });

    it('denies a parenthesized subshell invocation', () => {
      expectDeny(bash('(pidb token list)'));
    });

    it('denies a command-substitution invocation', () => {
      expectDeny(bash('echo $(pidb secret get acme DB)'));
    });
  });
});

describe('guardDecision — rule 2: pidb secret exec whose child prints the environment (Fix round 1 Important #2)', () => {
  it.each([
    // print-like verbs taking a $PIDB_*/${PIDB_*}/%PIDB_%/$env:PIDB_* reference
    ['pidb secret exec acme DB -- echo $PIDB_DB'],
    ['pidb secret exec acme DB -- echo "${PIDB_DB}"'],
    ['pidb secret exec acme DB -- printf "%s" "$PIDB_DB"'],
    ['pidb secret exec acme DB -- Write-Host $env:PIDB_DB'],
    ['pidb secret exec acme DB -- Write-Output $env:PIDB_DB'],
    ['pidb secret exec acme DB -- cmd /c echo %PIDB_DB%'],
    // bare PowerShell $env:PIDB_X expression statement
    ['pidb secret exec acme DB -- powershell -c "$env:PIDB_DB"'],
    ['pidb secret exec acme DB -- pwsh -Command "$env:PIDB_DB"'],
    // env/printenv/export -p/declare -p/typeset/compgen -v as commands
    ['pidb secret exec acme DB -- env'],
    ['pidb secret exec acme DB -- printenv'],
    ['pidb secret exec acme DB -- export -p'],
    ['pidb secret exec acme DB -- declare -p'],
    ['pidb secret exec acme DB -- typeset'],
    ['pidb secret exec acme DB -- compgen -v'],
    // set bare / set | ... / set PIDB...
    ['pidb secret exec acme DB -- set'],
    ['pidb secret exec acme DB -- cmd /c set'],
    ['pidb secret exec acme DB -- set | grep PIDB'],
    ['pidb secret exec acme DB -- set PIDB_DB'],
    // Get-ChildItem|gci|dir|ls env:
    ['pidb secret exec acme DB -- powershell -Command "Get-ChildItem env:"'],
    ['pidb secret exec acme DB -- powershell -c "gci env:"'],
    ['pidb secret exec acme DB -- pwsh -c "dir env:"'],
    ['pidb secret exec acme DB -- pwsh -c "ls env:"'],
    // [Environment]::GetEnvironmentVariable
    ['pidb secret exec acme DB -- powershell -c "[Environment]::GetEnvironmentVariable(\'PIDB_DB\')"'],
    // /proc/self/environ
    ['pidb secret exec acme DB -- cat /proc/self/environ'],
    ['pidb secret exec acme DB -- dd if=/proc/self/environ'],
    // process.env/os.environ/ENV[/ENVIRON[ in interpreter inline code
    ['pidb secret exec acme DB -- node -e "console.log(process.env)"'],
    ['pidb secret exec acme DB -- node -p "process.env"'],
    ["pidb secret exec acme DB -- python -c \"import os; print(os.environ)\""],
    ["pidb secret exec acme DB -- python3 -c \"import os; print(os.environ)\""],
    ["pidb secret exec acme DB -- python3.11 -c \"import os; print(os.environ)\""],
    ["pidb secret exec acme DB -- perl -e 'print $ENV{PIDB_DB}'"],
    ["pidb secret exec acme DB -- ruby -e 'puts ENV[\"PIDB_DB\"]'"],
    ["pidb secret exec acme DB -- awk 'BEGIN{print ENVIRON[\"PIDB_DB\"]}'"],
  ])('denies: %s', (command) => {
    expectDeny(bash(command));
  });

  it.each([
    ['pidb secret exec acme DB -- npm test'],
    ['pidb secret exec acme DB -- npm run reset'],
    ['pidb secret exec acme DB -- env FOO=bar npm test'],
    ['pidb secret exec acme DB -- set -e'],
    ['pidb secret exec acme DB -- set FOO=bar'],
    ['pidb secret exec acme DB -- node -e "console.log(1)"'],
    // the exact "must ALLOW" examples from the review, each wrapped in a real secret-exec invocation
    ['pidb secret exec acme DB -- sh -c \'psql "postgres://$PIDB_USER:$PIDB_PASSWORD@db/app"\''],
    ['pidb secret exec acme DB -- sh -c \'mysql -p"$PIDB_PASSWORD" app\''],
    ['pidb secret exec acme DB -- sh -c \'curl -u "$PIDB_USER:$PIDB_PASSWORD" https://api\''],
    ['pidb secret exec staging-env DB -- npm test'],
    ['pidb secret exec acme DB -- docker compose --env-file .env up'],
    ['pidb secret exec acme DB -- node --env-file=.env app.js'],
  ])('allows: %s', (command) => {
    expectAllow(bash(command));
  });

  it('a bare `env`/`set` outside of `pidb secret exec` is not denied by this rule', () => {
    expectAllow(bash('env'));
    expectAllow(bash('set'));
    expectAllow(bash('printenv'));
  });

  it('a docker/node --env flag is never confused with the bare `env` command', () => {
    expectAllow(bash('pidb secret exec acme DB -- docker run --env DEBUG=1 image'));
  });

  describe('Fix round 2 N2/N3 — segment model over the secret-exec child', () => {
    it.each([
      // env-dump, unwrapped through a shell -c wrapper and/or a pipe segment
      [`sh -c 'env | grep PIDB'`],
      [`bash -c "printenv | sort"`],
      [`sh -c 'set | grep PIDB'`],
      [`sh -c 'export -p'`],
      ['env|grep PIDB'],
      ['printenv|grep PIDB'],
      [`node -pe 'process.env.PIDB_X'`],
      [`python3 -c 'import os;print(os.getenv("PIDB_X"))'`],
      [`bash -c 'set -o posix; set'`],
      ['cat /proc/$$/environ'],
    ])('denies: %s', (child) => {
      expectDeny(bash(`pidb secret exec acme DB -- ${child}`));
    });

    it.each([
      [`sh -c 'curl -H "Content-Type: application/json" -u "$PIDB_USER:$PIDB_PASSWORD" https://api'`],
      [`sh -c 'psql "postgres://x:$PIDB_PASSWORD@h/db" -c "select 1" && echo ok'`],
      [`sh -c 'cat schema.sql | psql "postgresql://$PIDB_USER:$PIDB_PASSWORD@h/db"'`],
    ])('allows (print verb only on a segment that never references $PIDB_*): %s', (child) => {
      expectAllow(bash(`pidb secret exec acme DB -- ${child}`));
    });
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
    // widened list (Fix round 1 Minor #6)
    ['more', dataDirFile],
    ['bat', dataDirFile],
    ['vim', dataDirFile],
    ['vi', dataDirFile],
    ['nano', dataDirFile],
    ['jq .', dataDirFile],
    ['rg secret', dataDirFile],
    ['source', writtenFile],
    ['tar cf out.tar', dataDirFile],
    ['zip out.zip', dataDirFile],
    ['mv', dataDirFile],
  ])('denies "%s %s"', (verb, path) => {
    expectDeny(bash(`${verb} ${path}`));
  });

  it('denies the POSIX `. file` (dot-source) form', () => {
    // cwd deliberately unrelated to the written file's directory, so this can only be denied because
    // of the second token (the sourced file itself), not an incidental cwd/written-dir overlap.
    expectDeny(bash(`. ${writtenFile}`, posixCtx, '/tmp/somewhere-else'));
  });

  it('denies `git add` on a written file', () => {
    expectDeny(bash(`git add ${writtenFile}`));
  });

  it('denies cat of ~/.config/pidb (posix)', () => {
    expectDeny(bash('cat ~/.config/pidb/config.json'));
  });

  it('denies cat of $HOME/.config/pidb', () => {
    expectDeny(bash('cat $HOME/.config/pidb/config.json'));
  });

  it('denies cat of $XDG_CONFIG_HOME/pidb', () => {
    expectDeny(bash('cat $XDG_CONFIG_HOME/pidb/config.json'));
  });

  it('denies cat of %APPDATA%\\pidb (win32 ctx)', () => {
    expectDeny(bash('type %APPDATA%\\pidb\\config.json', win32Ctx), win32Ctx);
  });

  it('denies cat of $env:APPDATA\\pidb (PowerShell, win32 ctx)', () => {
    expectDeny(bash('Get-Content $env:APPDATA\\pidb\\config.json', win32Ctx), win32Ctx);
  });

  it('denies cat of %USERPROFILE%\\.config\\pidb (win32 ctx)', () => {
    expectDeny(bash('type %USERPROFILE%\\.config\\pidb\\config.json', win32Ctx), win32Ctx);
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

describe('guardDecision — rule 3: cwd-relative resolution + path-segment boundary (Fix round 1 Important #3)', () => {
  const ctx: GuardContext = { ...posixCtx, written: ['/repo/.env'] };
  const cwd = '/repo';

  it.each([['cat .env'], ['head -5 .env'], ['grep X .env'], ['cat ./.env'], ['cat ../repo/.env']])('denies "%s" (resolves against cwd)', (command) => {
    expectDeny(bash(command, ctx, cwd), ctx);
  });

  it('denies a recursive grep/rg over a directory that CONTAINS a written file', () => {
    expectDeny(bash('grep -r DATABASE_URL .', ctx, cwd), ctx);
    expectDeny(bash('rg DATABASE_URL .', ctx, cwd), ctx);
  });

  it('allows "cat .env.example" — a proper path-segment boundary, not a raw string-prefix match', () => {
    expectAllow(bash('cat .env.example', ctx, cwd), ctx);
  });

  it('allows an unrelated relative path', () => {
    expectAllow(bash('cat ./README.md', ctx, cwd), ctx);
    expectAllow(bash('cat ../other-repo/README.md', ctx, cwd), ctx);
  });
});

describe('guardDecision — rule 3: ancestor direction restricted to recursive search only (Fix round 2 N1)', () => {
  const ctx: GuardContext = { ...posixCtx, written: ['/repo/.env'] };
  const cwd = '/repo';

  it('a PLAIN grep (no -r/-R/--recursive) over a directory that merely CONTAINS a written file is allowed', () => {
    expectAllow(bash('grep DATABASE_URL .', ctx, cwd), ctx);
  });

  it.each([['ag DATABASE_URL .'], ['ack DATABASE_URL .'], ['git grep DATABASE_URL .'], ['grep -R DATABASE_URL .'], ['grep --recursive DATABASE_URL .']])(
    'denies a recursive search tool over the ancestor directory: %s',
    (command) => {
      expectDeny(bash(command, ctx, cwd), ctx);
    },
  );

  it('denies `find . -exec grep` piped into a read command over the written file\'s directory', () => {
    expectDeny(bash('find . -type f -exec cat {} \\;', ctx, cwd), ctx);
  });

  it('denies `find . | xargs cat`', () => {
    expectDeny(bash('find . | xargs cat', ctx, cwd), ctx);
  });

  it('a `find` without -exec/xargs is not treated as recursive (no ancestor direction)', () => {
    expectAllow(bash('find . -name "*.ts"', ctx, cwd), ctx);
  });
});

describe('guardDecision — rule 3: cwd/home/root/\'\' tokens never trigger unless recursive (Fix round 2 N4)', () => {
  const ctx: GuardContext = { ...posixCtx, written: ['/repo/.env'] };
  const cwd = '/repo';

  it.each([
    ['curl -s localhost:3000/api | jq .'],
    ['find . -name "*.ts" | head'],
    ['du -sh . | tail -1'],
    ['git add . && git commit'],
    ['sed -i \'\' "s/a/b/" src/x.ts'],
    ['ls .. | head'],
  ])('allows: %s', (command) => {
    expectAllow(bash(command, ctx, cwd), ctx);
  });

  it('BUT `git add` of an explicit written file path still denies', () => {
    expectDeny(bash('git add /repo/.env', ctx, cwd), ctx);
  });

  it('denies `cat .env*` — a glob token whose non-glob prefix matches a written basename in cwd', () => {
    expectDeny(bash('cat .env*', ctx, cwd), ctx);
  });

  it('tracks `cd <dir>` so a later segment resolves against the new effective cwd', () => {
    // written is /repo/.env; cwd starts at /elsewhere, but `cd /repo` before the read makes it reachable.
    expectDeny(bash('cd /repo && cat .env', ctx, '/elsewhere'), ctx);
    expectAllow(bash('cd /elsewhere && cat .env', ctx, '/repo'), ctx);
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

  describe('built-in tools are only checked on their path-designating keys (Fix round 1 Important #5)', () => {
    it('allows Edit of .gitignore whose new_string happens to say ".env"', () => {
      expectAllow(
        tool('Edit', {
          file_path: '/home/alex/project/.gitignore',
          old_string: 'node_modules',
          new_string: 'node_modules\n.env',
        }),
      );
    });

    it('allows Write whose content happens to mention a written.json path', () => {
      expectAllow(
        tool('Write', {
          file_path: '/home/alex/project/NOTES.md',
          content: 'remember: secrets get substituted into /home/alex/project/.pidb/db.env',
        }),
      );
    });

    it('allows Grep whose pattern (not path) happens to look path-like', () => {
      expectAllow(tool('Grep', { pattern: '/home/alex/.claude/plugins/data/pidb-pidb/profiles.json' }));
    });

    it('denies a Glob whose pattern (no explicit `path`) resolves against cwd into the data dir', () => {
      expectDeny(
        tool('Glob', { pattern: '../../.claude/plugins/data/pidb-pidb/**' }, posixCtx, '/home/alex/project/sub'),
      );
    });

    it('allows a Glob whose pattern resolves against cwd into an unrelated directory', () => {
      expectAllow(tool('Glob', { pattern: '**/*.ts' }));
    });

    it('an mcp__* tool call is still fully scanned (all string values), unlike a built-in', () => {
      expectDeny(
        tool('mcp__pidb__some_future_tool', {
          note: 'wrong on purpose',
          target: '/home/alex/.claude/plugins/data/pidb-pidb/profiles.json',
        }),
      );
    });
  });

  describe('Grep gets the ancestor direction; Glob/Read/Edit/Write and mcp__* never do (Fix round 2 N1)', () => {
    const ctx: GuardContext = { ...posixCtx, written: ['/repo/.env'] };

    it('denies a Grep whose `path` is a directory that merely CONTAINS a written file', () => {
      expectDeny(tool('Grep', { pattern: 'X', path: '/repo' }, ctx), ctx);
    });

    it.each([
      ['Glob', { pattern: '*', path: '/repo' }],
      ['Read', { file_path: '/repo' }],
      ['Edit', { file_path: '/repo', old_string: 'a', new_string: 'b' }],
      ['Write', { file_path: '/repo', content: 'x' }],
      ['LS', { path: '/repo' }],
    ])('allows %s whose path is only an ANCESTOR of a written file (not nested inside one)', (name, input) => {
      expectAllow(tool(name, input, ctx), ctx);
    });

    it("an mcp__* tool's non-path-like string (no / or \\, doesn't start with ~) is never treated as a path", () => {
      // "env" happens to be a written-file basename's prefix, but as a bare word (no separator) it
      // isn't path-like at all, so it must never be resolved/compared.
      expectAllow(tool('mcp__pidb__some_future_tool', { name: 'env' }, ctx), ctx);
    });

    it("an mcp__* tool's '' / '.' string args are never treated as the effective cwd", () => {
      expectAllow(tool('mcp__pidb__some_future_tool', { a: '', b: '.' }, ctx), ctx);
    });

    it('an mcp__* tool call never gets the ancestor direction either, even with a path-like arg', () => {
      expectAllow(tool('mcp__pidb__some_future_tool', { target: '/repo' }, ctx), ctx);
    });
  });
});

describe('guardDecision — rule 4: reading an OS credential store', () => {
  it.each([
    ['security find-generic-password -s pidb -a work -w'],
    ['security find-internet-password -s pidb.example.com'],
    ['security dump-keychain'],
    ['cmdkey /list'],
    ['Get-StoredCredential -Target pidb'],
    ['secret-tool lookup service pidb'],
    ['secret-tool search service pidb'],
    ['keyring get pidb work'],
    ['node -e "require(\'@napi-rs/keyring\')"'],
    ['python -c "import keyring; print(keyring.get_password(\'pidb\', \'work\'))"'],
  ])('denies: %s', (command) => {
    expectDeny(bash(command));
  });

  it('a node/python interpreter invocation that never mentions keyring is allowed', () => {
    expectAllow(bash('node -e "console.log(1)"'));
    expectAllow(bash('python -c "print(1)"'));
  });

  it('the word "keyring" appearing outside an interpreter inline-code invocation is not denied by the inline-code check alone', () => {
    expectAllow(bash('echo "ask the user about their keyring app"'));
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

  describe('localhost/127.0.0.1 equivalence and scheme-less host:port (Fix round 1 Minor #6)', () => {
    const ctx: GuardContext = { ...posixCtx, serverUrls: ['http://127.0.0.1:8080'] };

    it('denies curl against localhost:8080 when the configured server is 127.0.0.1:8080', () => {
      expectDeny(bash('curl http://localhost:8080/api/v1/projects', ctx), ctx);
    });

    it('denies curl against ::1:8080 when the configured server is 127.0.0.1:8080', () => {
      expectDeny(bash('curl http://::1:8080/api/v1/projects', ctx), ctx);
    });

    it('denies the correct bracketed IPv6 URL literal form [::1]:8080 (Fix round 2 minor)', () => {
      expectDeny(bash('curl http://[::1]:8080/api/v1/projects', ctx), ctx);
    });

    it('denies a scheme-less mention of host:port', () => {
      expectDeny(bash('curl 127.0.0.1:8080/api/v1/projects', ctx), ctx);
      expectDeny(bash('curl localhost:8080/api/v1/projects', ctx), ctx);
    });

    it('allows a different port on the same host', () => {
      expectAllow(bash('curl http://127.0.0.1:9999/api/v1/projects', ctx), ctx);
    });
  });
});
