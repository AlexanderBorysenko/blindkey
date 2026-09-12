import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLogin } from '../src/commands/login.js';
import { configPath } from '../src/config.js';
import { CliError } from '../src/errors.js';
import { makeServer, type ServerFixture } from './helpers.js';

let s: ServerFixture;
let home: string;
const env = () => ({ PIDB_CONFIG_HOME: home }) as NodeJS.ProcessEnv;
const io = (password: string, username = 'alex') => ({
  prompt: async () => username,
  promptHidden: async () => password,
});

beforeAll(async () => {
  s = await makeServer();
  await s.admin('alex', 'correct horse battery');
});
afterAll(async () => {
  await s.close();
});
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'pidb-login-'));
});

describe('runLogin', () => {
  it('exchanges credentials for a token and saves a 0600 config', async () => {
    const result = await runLogin(`${s.url}/`, { name: 'cli-test' }, env(), io('correct horse battery'));
    const saved = JSON.parse(readFileSync(configPath(env()), 'utf8')) as { url: string; token: string };
    expect(saved.url).toBe(s.url);
    expect(saved.token).toMatch(/^pidb_/);
    expect(statSync(configPath(env())).mode & 0o777).toBe(0o600);
    expect(result.text).toContain(s.url);
    expect(result.text).toContain('cli-test');
    expect(result.text).not.toContain(saved.token);
    expect(JSON.stringify(result.json)).not.toContain(saved.token);
  });

  it('defaults the token name to cli-<hostname>', async () => {
    await runLogin(s.url, {}, env(), io('correct horse battery'));
    const token = (JSON.parse(readFileSync(configPath(env()), 'utf8')) as { token: string }).token;
    const rows = s.db.prepare('SELECT name FROM api_tokens ORDER BY id DESC LIMIT 1').all() as { name: string }[];
    expect(rows[0]!.name).toMatch(/^cli-/);
    expect(token).toMatch(/^pidb_/);
  });

  it('exits 3 on bad credentials and writes no config', async () => {
    const err = await runLogin(s.url, {}, env(), io('wrong')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(3);
    expect(() => readFileSync(configPath(env()), 'utf8')).toThrow();
  });

  it('takes the username from --username without prompting', async () => {
    const io2 = {
      prompt: async () => {
        throw new Error('should not prompt for a username');
      },
      promptHidden: async () => 'correct horse battery',
    };
    await expect(runLogin(s.url, { username: 'alex' }, env(), io2)).resolves.toBeTruthy();
  });
});
