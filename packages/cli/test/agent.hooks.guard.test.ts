import { describe, it, expect } from 'vitest';
import { guardDecision, type GuardContext, type HookInput } from '../src/agent/hooks/guard.js';
import { globToRegExp } from '../src/agent/hooks/paths.js';

const posixCtx: GuardContext = {
  dataDir: '/home/alex/.claude/plugins/data/blindkey-blindkey',
  written: ['/home/alex/project/.blindkey/db.env'],
  serverUrls: ['https://blindkey.example.com', 'http://127.0.0.1:8080'],
  home: '/home/alex',
  platform: 'linux',
};

const win32Ctx: GuardContext = {
  dataDir: 'C:\\Users\\alex\\AppData\\Roaming\\Claude\\plugins\\data\\blindkey-blindkey',
  written: ['C:\\Users\\alex\\project\\.blindkey\\db.env'],
  serverUrls: ['https://blindkey.example.com'],
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
    ['blindkey secret exec acme DB -- npm test'],
    ['cat README.md'],
    ['echo hello'],
  ])('%s', (command) => {
    expectAllow(bash(command));
    expectAllow(bash(command), win32Ctx);
  });
});

describe('guardDecision — the pre-rebrand pidb name is not the CLI', () => {
  it('does not apply the user-only rule to `pidb login`', () => {
    expectAllow(bash('pidb login https://x'));
  });
  it('still denies the same command under the blindkey name', () => {
    expectDeny(bash('blindkey login https://x'));
  });
});

describe('guardDecision — rule 1: blindkey + disabled subcommand', () => {
  it.each([
    ['blindkey secret get acme DB'],
    ['blindkey secret get acme DB --print'],
    ['blindkey login https://blindkey.example.com'],
    ['blindkey token list'],
    ['blindkey token create --name x --scopes projects:read'],
    ['blindkey secret exec acme DB --print -- npm test'],
    ['echo hi && blindkey login https://x'],
  ])('denies: %s', (command) => {
    expectDeny(bash(command));
  });

  it.each([['blindkey secret exec acme DB -- npm test'], ['blindkey secret write acme DB --out /tmp/x'], ['blindkey bind acme'], ['blindkey status']])(
    'allows: %s',
    (command) => {
      expectAllow(bash(command));
    },
  );

  it('does not deny "token" appearing only inside an unrelated secret name (word-boundary safe)', () => {
    expectAllow(bash('blindkey secret exec acme GITHUB_TOKEN -- npm test'));
  });

  it('allows "blindkey login"/"blindkey token" words that only appear inside a quoted string, not as a real invocation', () => {
    expectAllow(bash('git commit -m "fix blindkey login flow"'));
    expectAllow(bash('blindkey secret exec acme "API token" -- npm test'));
    expectAllow(bash('echo "remember to run blindkey token list later"'));
  });

  it('still denies a real invocation chained after other commands (command-position anchoring)', () => {
    expectDeny(bash('echo hi && blindkey login https://x'));
    expectDeny(bash('true; blindkey token list'));
  });

  describe('Fix round 2 N3 — only blindkey\'s OWN args (before its own first " -- ") are checked', () => {
    it.each([
      ['blindkey secret exec acme DB -- npm run get-data'],
      ['blindkey secret exec acme DB -- curl https://api.example.com/get'],
      ['blindkey secret exec acme DB -- node scripts/get-users.js'],
      ['blindkey secret exec acme "get token" -- npm test'],
      ['blindkey secret exec acme DB -- ./deploy.sh --print-summary'],
    ])('allows: %s', (command) => {
      expectAllow(bash(command));
    });

    it('denies a real invocation on its own line after an unrelated earlier command', () => {
      expectDeny(bash('cd x\nblindkey login'));
    });

    it('denies "npx blindkey login"', () => {
      expectDeny(bash('npx blindkey login'));
    });

    it('denies a parenthesized subshell invocation', () => {
      expectDeny(bash('(blindkey token list)'));
    });

    it('denies a command-substitution invocation', () => {
      expectDeny(bash('echo $(blindkey secret get acme DB)'));
    });
  });
});

describe('guardDecision — rule 2: blindkey secret exec whose child prints the environment (Fix round 1 Important #2)', () => {
  it.each([
    // print-like verbs taking a $BLINDKEY_*/${BLINDKEY_*}/%BLINDKEY_%/$env:BLINDKEY_* reference
    ['blindkey secret exec acme DB -- echo $BLINDKEY_DB'],
    ['blindkey secret exec acme DB -- echo "${BLINDKEY_DB}"'],
    ['blindkey secret exec acme DB -- printf "%s" "$BLINDKEY_DB"'],
    ['blindkey secret exec acme DB -- Write-Host $env:BLINDKEY_DB'],
    ['blindkey secret exec acme DB -- Write-Output $env:BLINDKEY_DB'],
    ['blindkey secret exec acme DB -- cmd /c echo %BLINDKEY_DB%'],
    // bare PowerShell $env:BLINDKEY_X expression statement
    ['blindkey secret exec acme DB -- powershell -c "$env:BLINDKEY_DB"'],
    ['blindkey secret exec acme DB -- pwsh -Command "$env:BLINDKEY_DB"'],
    // env/printenv/export -p/declare -p/typeset/compgen -v as commands
    ['blindkey secret exec acme DB -- env'],
    ['blindkey secret exec acme DB -- printenv'],
    ['blindkey secret exec acme DB -- export -p'],
    ['blindkey secret exec acme DB -- declare -p'],
    ['blindkey secret exec acme DB -- typeset'],
    ['blindkey secret exec acme DB -- compgen -v'],
    // set bare / set | ... / set BLINDKEY...
    ['blindkey secret exec acme DB -- set'],
    ['blindkey secret exec acme DB -- cmd /c set'],
    ['blindkey secret exec acme DB -- set | grep BLINDKEY'],
    ['blindkey secret exec acme DB -- set BLINDKEY_DB'],
    // Get-ChildItem|gci|dir|ls env:
    ['blindkey secret exec acme DB -- powershell -Command "Get-ChildItem env:"'],
    ['blindkey secret exec acme DB -- powershell -c "gci env:"'],
    ['blindkey secret exec acme DB -- pwsh -c "dir env:"'],
    ['blindkey secret exec acme DB -- pwsh -c "ls env:"'],
    // [Environment]::GetEnvironmentVariable
    ['blindkey secret exec acme DB -- powershell -c "[Environment]::GetEnvironmentVariable(\'BLINDKEY_DB\')"'],
    // /proc/self/environ
    ['blindkey secret exec acme DB -- cat /proc/self/environ'],
    ['blindkey secret exec acme DB -- dd if=/proc/self/environ'],
    // process.env/os.environ/ENV[/ENVIRON[ in interpreter inline code
    ['blindkey secret exec acme DB -- node -e "console.log(process.env)"'],
    ['blindkey secret exec acme DB -- node -p "process.env"'],
    ["blindkey secret exec acme DB -- python -c \"import os; print(os.environ)\""],
    ["blindkey secret exec acme DB -- python3 -c \"import os; print(os.environ)\""],
    ["blindkey secret exec acme DB -- python3.11 -c \"import os; print(os.environ)\""],
    ["blindkey secret exec acme DB -- perl -e 'print $ENV{BLINDKEY_DB}'"],
    ["blindkey secret exec acme DB -- ruby -e 'puts ENV[\"BLINDKEY_DB\"]'"],
    ["blindkey secret exec acme DB -- awk 'BEGIN{print ENVIRON[\"BLINDKEY_DB\"]}'"],
  ])('denies: %s', (command) => {
    expectDeny(bash(command));
  });

  it.each([
    ['blindkey secret exec acme DB -- npm test'],
    ['blindkey secret exec acme DB -- npm run reset'],
    ['blindkey secret exec acme DB -- env FOO=bar npm test'],
    ['blindkey secret exec acme DB -- set -e'],
    ['blindkey secret exec acme DB -- set FOO=bar'],
    ['blindkey secret exec acme DB -- node -e "console.log(1)"'],
    // the exact "must ALLOW" examples from the review, each wrapped in a real secret-exec invocation
    ['blindkey secret exec acme DB -- sh -c \'psql "postgres://$BLINDKEY_USER:$BLINDKEY_PASSWORD@db/app"\''],
    ['blindkey secret exec acme DB -- sh -c \'mysql -p"$BLINDKEY_PASSWORD" app\''],
    ['blindkey secret exec acme DB -- sh -c \'curl -u "$BLINDKEY_USER:$BLINDKEY_PASSWORD" https://api\''],
    ['blindkey secret exec staging-env DB -- npm test'],
    ['blindkey secret exec acme DB -- docker compose --env-file .env up'],
    ['blindkey secret exec acme DB -- node --env-file=.env app.js'],
  ])('allows: %s', (command) => {
    expectAllow(bash(command));
  });

  it('a bare `env`/`set` outside of `blindkey secret exec` is not denied by this rule', () => {
    expectAllow(bash('env'));
    expectAllow(bash('set'));
    expectAllow(bash('printenv'));
  });

  it('a docker/node --env flag is never confused with the bare `env` command', () => {
    expectAllow(bash('blindkey secret exec acme DB -- docker run --env DEBUG=1 image'));
  });

  describe('Fix round 2 N2/N3 — segment model over the secret-exec child', () => {
    it.each([
      // env-dump, unwrapped through a shell -c wrapper and/or a pipe segment
      [`sh -c 'env | grep BLINDKEY'`],
      [`bash -c "printenv | sort"`],
      [`sh -c 'set | grep BLINDKEY'`],
      [`sh -c 'export -p'`],
      ['env|grep BLINDKEY'],
      ['printenv|grep BLINDKEY'],
      [`node -pe 'process.env.BLINDKEY_X'`],
      [`python3 -c 'import os;print(os.getenv("BLINDKEY_X"))'`],
      [`bash -c 'set -o posix; set'`],
      ['cat /proc/$$/environ'],
    ])('denies: %s', (child) => {
      expectDeny(bash(`blindkey secret exec acme DB -- ${child}`));
    });

    it.each([
      [`sh -c 'curl -H "Content-Type: application/json" -u "$BLINDKEY_USER:$BLINDKEY_PASSWORD" https://api'`],
      [`sh -c 'psql "postgres://x:$BLINDKEY_PASSWORD@h/db" -c "select 1" && echo ok'`],
      [`sh -c 'cat schema.sql | psql "postgresql://$BLINDKEY_USER:$BLINDKEY_PASSWORD@h/db"'`],
    ])('allows (print verb only on a segment that never references $BLINDKEY_*): %s', (child) => {
      expectAllow(bash(`blindkey secret exec acme DB -- ${child}`));
    });
  });
});

describe('guardDecision — rule 3: protected paths (Bash, read-tool + path substring)', () => {
  const dataDirFile = '/home/alex/.claude/plugins/data/blindkey-blindkey/profiles.json';
  const writtenFile = '/home/alex/project/.blindkey/db.env';

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

  it('denies cat of ~/.config/blindkey (posix)', () => {
    expectDeny(bash('cat ~/.config/blindkey/config.json'));
  });

  it('denies cat of $HOME/.config/blindkey', () => {
    expectDeny(bash('cat $HOME/.config/blindkey/config.json'));
  });

  it('denies cat of $XDG_CONFIG_HOME/blindkey', () => {
    expectDeny(bash('cat $XDG_CONFIG_HOME/blindkey/config.json'));
  });

  it('denies cat of %APPDATA%\\blindkey (win32 ctx)', () => {
    expectDeny(bash('type %APPDATA%\\blindkey\\config.json', win32Ctx), win32Ctx);
  });

  it('denies cat of $env:APPDATA\\blindkey (PowerShell, win32 ctx)', () => {
    expectDeny(bash('Get-Content $env:APPDATA\\blindkey\\config.json', win32Ctx), win32Ctx);
  });

  it('denies cat of %USERPROFILE%\\.config\\blindkey (win32 ctx)', () => {
    expectDeny(bash('type %USERPROFILE%\\.config\\blindkey\\config.json', win32Ctx), win32Ctx);
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
    expectDeny(tool('Read', { file_path: '/home/alex/.claude/plugins/data/blindkey-blindkey/profiles.json' }));
  });

  it('denies Edit of a written.json-recorded secret file', () => {
    expectDeny(tool('Edit', { file_path: '/home/alex/project/.blindkey/db.env', old_string: 'a', new_string: 'b' }));
  });

  it('denies Write into the data dir', () => {
    expectDeny(tool('Write', { file_path: '/home/alex/.claude/plugins/data/blindkey-blindkey/x.txt', content: 'x' }));
  });

  it('denies Grep with path set to the data dir', () => {
    expectDeny(tool('Grep', { pattern: 'token', path: '/home/alex/.claude/plugins/data/blindkey-blindkey' }));
  });

  it('denies Glob with path set to the data dir', () => {
    expectDeny(tool('Glob', { pattern: '**/*.json', path: '/home/alse/.claude/plugins/data/blindkey-blindkey'.replace('alse', 'alex') }));
  });

  it('allows Read of an unrelated project file', () => {
    expectAllow(tool('Read', { file_path: '/home/alex/project/README.md' }));
  });

  it('resolves a relative file_path against the input cwd before comparing', () => {
    // cwd is /home/alex/project/sub; two levels up is /home/alex, matching posixCtx.dataDir's parent.
    expectDeny(
      tool('Read', { file_path: '../../.claude/plugins/data/blindkey-blindkey/profiles.json' }, posixCtx, '/home/alex/project/sub'),
    );
  });

  it('denies an mcp__* tool call whose string arg is exactly a protected path', () => {
    expectDeny(tool('mcp__blindkey__some_future_tool', { path: '/home/alex/.claude/plugins/data/blindkey-blindkey/profiles.json' }));
  });

  it('allows an mcp__* tool call with unrelated string args', () => {
    expectAllow(tool('mcp__blindkey__blindkey_status', {}));
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
          content: 'remember: secrets get substituted into /home/alex/project/.blindkey/db.env',
        }),
      );
    });

    it('allows Grep whose pattern (not path) happens to look path-like', () => {
      // explicit `path` — with none, Grep searches cwd, which (Fix round 4) holds a written file here.
      expectAllow(tool('Grep', { pattern: '/home/alex/.claude/plugins/data/blindkey-blindkey/profiles.json', path: 'src' }));
    });

    it('denies a Glob whose pattern (no explicit `path`) resolves against cwd into the data dir', () => {
      expectDeny(
        tool('Glob', { pattern: '../../.claude/plugins/data/blindkey-blindkey/**' }, posixCtx, '/home/alex/project/sub'),
      );
    });

    it('allows a Glob whose pattern resolves against cwd into an unrelated directory', () => {
      expectAllow(tool('Glob', { pattern: '**/*.ts' }));
    });

    it('an mcp__* tool call is still fully scanned (all string values), unlike a built-in', () => {
      expectDeny(
        tool('mcp__blindkey__some_future_tool', {
          note: 'wrong on purpose',
          target: '/home/alex/.claude/plugins/data/blindkey-blindkey/profiles.json',
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
      expectAllow(tool('mcp__blindkey__some_future_tool', { name: 'env' }, ctx), ctx);
    });

    it("an mcp__* tool's '' / '.' string args are never treated as the effective cwd", () => {
      expectAllow(tool('mcp__blindkey__some_future_tool', { a: '', b: '.' }, ctx), ctx);
    });

    it('an mcp__* tool call never gets the ancestor direction either, even with a path-like arg', () => {
      expectAllow(tool('mcp__blindkey__some_future_tool', { target: '/repo' }, ctx), ctx);
    });
  });
});

describe('guardDecision — rule 4: reading an OS credential store', () => {
  it.each([
    ['security find-generic-password -s blindkey -a work -w'],
    ['security find-internet-password -s blindkey.example.com'],
    ['security dump-keychain'],
    ['cmdkey /list'],
    ['Get-StoredCredential -Target blindkey'],
    ['secret-tool lookup service blindkey'],
    ['secret-tool search service blindkey'],
    ['keyring get blindkey work'],
    ['node -e "require(\'@napi-rs/keyring\')"'],
    ['python -c "import keyring; print(keyring.get_password(\'blindkey\', \'work\'))"'],
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

describe('guardDecision — rule 5: direct HTTP against a configured blindkey server', () => {
  it.each([
    ['curl https://blindkey.example.com/api/v1/projects'],
    ['wget https://blindkey.example.com/api/v1/projects'],
    ['Invoke-WebRequest -Uri https://blindkey.example.com/api/v1/projects'],
    ['iwr https://blindkey.example.com/api/v1/projects'],
    ['irm https://blindkey.example.com/api/v1/projects'],
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

describe('Task 9 carried minors', () => {
  const ctx: GuardContext = { ...posixCtx, written: ['/repo/.env'] };

  it('globToRegExp collapses runs of `*` and repeated `**/` (no catastrophic backtracking)', () => {
    const star = globToRegExp(`/repo/${'*'.repeat(40)}x`, 'linux');
    const t0 = Date.now();
    expect(star.test(`/repo/${'a'.repeat(40)}`)).toBe(false);
    expect(star.test('/repo/ax')).toBe(true);
    const globstar = globToRegExp(`/${'**/'.repeat(30)}y`, 'linux');
    expect(globstar.test(`/${'a/'.repeat(30)}z`)).toBe(false);
    expect(globstar.test('/a/b/y')).toBe(true);
    expect(Date.now() - t0).toBeLessThan(500);
    // A long `*` run from a guarded Bash command stays fast too.
    const t1 = Date.now();
    expectAllow(bash(`ls ${'*'.repeat(60)}.md`, ctx, '/elsewhere'), ctx);
    expect(Date.now() - t1).toBeLessThan(500);
  });

  it('Grep over a directory holding a written file names that file and the way out', () => {
    const d = guardDecision(tool('Grep', { pattern: 'X', path: '/repo' }, ctx), ctx);
    expect(d.deny).toBe(true);
    if (d.deny) {
      expect(d.reason).toContain('/repo/.env');
      expect(d.reason).toMatch(/`path`/);
      expect(d.reason).toMatch(/`glob`/);
      expect(d.reason).toMatch(/`type`/);
    }
    // With a glob excluding it, the same search is allowed.
    expectAllow(tool('Grep', { pattern: 'X', path: '/repo', glob: '*.ts' }, ctx), ctx);
  });

  it('cp onto a written file is denied as an overwrite, not a read', () => {
    const d = guardDecision(bash('cp .env.example .env', ctx, '/repo'), ctx);
    expect(d.deny).toBe(true);
    if (d.deny) expect(d.reason).toMatch(/would overwrite a blindkey-written secret file/);
    // Copying the written file away is still a read.
    const r = guardDecision(bash('cp .env /tmp/leak', ctx, '/repo'), ctx);
    expect(r.deny).toBe(true);
    if (r.deny) expect(r.reason).not.toMatch(/overwrite/);
  });
});

describe('guardDecision — escaping agent mode (F1: BLINDKEY_ALLOW_USER_MODE / CLAUDECODE are user-only)', () => {
  it.each([
    'BLINDKEY_ALLOW_USER_MODE=1 blindkey secret get acme Db',
    'export BLINDKEY_ALLOW_USER_MODE=1; blindkey login https://x',
    'env BLINDKEY_ALLOW_USER_MODE=1 blindkey token list',
    'CLAUDECODE= blindkey secret get acme Db',
    'CLAUDECODE=0 blindkey login https://x',
    'env -u CLAUDECODE blindkey secret get acme Db',
    'env --unset=CLAUDECODE blindkey token list',
    'unset CLAUDECODE; blindkey secret get acme Db',
    '$env:BLINDKEY_ALLOW_USER_MODE=1; blindkey secret get acme Db',
    'Remove-Item env:CLAUDECODE; blindkey secret get acme Db',
    '$env:CLAUDECODE=""; blindkey token list',
  ])('denies %s', (command) => {
    expectDeny(bash(command));
  });

  it('allows ordinary commands that merely mention CLAUDE', () => {
    expectAllow(bash('echo $CLAUDE_PROJECT_DIR'));
    expectAllow(bash('blindkey status'));
  });
});
