import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLogin } from '../src/commands/login.js';
import { configPath } from '../src/config.js';
import { CliError } from '../src/errors.js';
import { makeServer, type ServerFixture } from './helpers.js';
import { getTotp, openTotpSecret } from '../../server/src/repos/twofactor.js';
import { hotp, stepAt } from '../../server/src/auth/totp.js';

let s: ServerFixture;
let home: string;
const env = () => ({ BLINDKEY_CONFIG_HOME: home }) as NodeJS.ProcessEnv;
// Two-factor is mandatory, so the fixture admin is enrolled and every login asks for a code.
const io = (password: string, username = 'alex') => ({
  prompt: async () => username,
  promptHidden: async (question: string) => (question === '2FA code: ' ? s.loginCode() : password),
});

// A fresh server per test: with the mandatory second factor every login is two /auth/token requests
// (password, then password + code), so one shared server would run into its 5/min rate limit.
beforeEach(async () => {
  s = await makeServer();
  await s.admin('alex', 'correct horse battery');
  home = mkdtempSync(join(tmpdir(), 'blindkey-login-'));
});
afterEach(async () => {
  await s.close();
});

describe('runLogin', () => {
  it('exchanges credentials for a token and saves a 0600 config', async () => {
    const result = await runLogin(`${s.url}/`, { name: 'cli-test' }, env(), io('correct horse battery'));
    const saved = JSON.parse(readFileSync(configPath(env()), 'utf8')) as { url: string; token: string };
    expect(saved.url).toBe(s.url);
    expect(saved.token).toMatch(/^bk_/);
    expect(statSync(configPath(env())).mode & 0o777).toBe(0o600);
    expect(result.text).toContain(s.url);
    expect(result.text).toContain('cli-test');
    expect(result.text).not.toContain(saved.token);
    expect(JSON.stringify(result.json)).not.toContain(saved.token);
  });

  it('defaults the token name to cli-<hostname> and expires_at to about 30 days', async () => {
    const before = Date.now();
    await runLogin(s.url, {}, env(), io('correct horse battery'));
    const token = (JSON.parse(readFileSync(configPath(env()), 'utf8')) as { token: string }).token;
    const rows = s.db.prepare('SELECT name, expires_at FROM api_tokens ORDER BY id DESC LIMIT 1').all() as {
      name: string;
      expires_at: number;
    }[];
    expect(rows[0]!.name).toMatch(/^cli-/);
    expect(token).toMatch(/^bk_/);
    expect(Math.abs(rows[0]!.expires_at - (before + 30 * 86_400_000))).toBeLessThan(60_000);
  });

  it('exits 3 on bad credentials and writes no config', async () => {
    const err = await runLogin(s.url, {}, env(), io('wrong')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(3);
    expect(() => readFileSync(configPath(env()), 'utf8')).toThrow();
  });

  it('says two-factor must be set up first (403 totp_setup_required) for a user who has not enrolled, and writes no config', async () => {
    s.db.prepare('DELETE FROM admin_totp').run();
    const err = await runLogin(s.url, {}, env(), io('correct horse battery')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).message).toContain('two-factor authentication must be set up first');
    expect(() => readFileSync(configPath(env()), 'utf8')).toThrow();
  });

  it('takes the username from --username without prompting', async () => {
    const io2 = {
      prompt: async () => {
        throw new Error('should not prompt for a username');
      },
      promptHidden: async (question: string) => (question === '2FA code: ' ? s.loginCode() : 'correct horse battery'),
    };
    await expect(runLogin(s.url, { username: 'alex' }, env(), io2)).resolves.toBeTruthy();
  });

  it('sends --expires as expires_days and records an expires_at close to the request', async () => {
    const before = Date.now();
    const result = await runLogin(s.url, { expires: '7' }, env(), io('correct horse battery'));
    const rows = s.db.prepare('SELECT expires_at FROM api_tokens ORDER BY id DESC LIMIT 1').all() as { expires_at: number }[];
    expect(Math.abs(rows[0]!.expires_at - (before + 7 * 86_400_000))).toBeLessThan(60_000);
    expect(result.text).toContain('expires');
  });

  it('rejects an out-of-range --expires before making any request', async () => {
    const countBefore = (s.db.prepare('SELECT COUNT(*) AS n FROM api_tokens').get() as { n: number }).n;
    for (const bad of ['0', '400']) {
      const err = await runLogin(s.url, { expires: bad }, env(), io('correct horse battery')).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).message).toContain('--expires');
    }
    const countAfter = (s.db.prepare('SELECT COUNT(*) AS n FROM api_tokens').get() as { n: number }).n;
    expect(countAfter).toBe(countBefore);
  });
});

describe('with 2FA', () => {
  // A separate server/admin: the shared `s` fixture above already spends 5 requests
  // against the 5/min /auth/token rate limit within this test file.
  let s2: ServerFixture;
  let home2: string;
  const env2 = () => ({ BLINDKEY_CONFIG_HOME: home2 }) as NodeJS.ProcessEnv;
  let adminId: number;

  beforeAll(async () => {
    s2 = await makeServer();
    await s2.admin('jo', 'correct horse battery');
    adminId = (s2.db.prepare('SELECT id FROM admin WHERE username = ?').get('jo') as { id: number }).id; // enrolled by the fixture
  });
  afterAll(async () => {
    await s2.close();
  });
  beforeEach(() => {
    home2 = mkdtempSync(join(tmpdir(), 'blindkey-login-2fa-'));
  });

  function codeForNextStep(): string {
    const secret = openTotpSecret(s2.ring, getTotp(s2.db, adminId)!);
    return hotp(secret, stepAt(Date.now()) + 1);
  }

  it('prompts on totp_required and saves the token once the code is accepted', async () => {
    let promptHiddenCalls: string[] = [];
    const code = codeForNextStep();
    const io2 = {
      prompt: async () => 'jo',
      promptHidden: async (question: string) => {
        promptHiddenCalls.push(question);
        return promptHiddenCalls.length === 1 ? 'correct horse battery' : code;
      },
    };
    const result = await runLogin(s2.url, { name: 'cli-2fa' }, env2(), io2);
    const saved = JSON.parse(readFileSync(configPath(env2()), 'utf8')) as { token: string };
    expect(saved.token).toMatch(/^bk_/);
    expect(result.text).toContain('cli-2fa');
    expect(promptHiddenCalls).toEqual(['Admin password: ', '2FA code: ']);
  });

  it('exits 3 on an empty code and writes no config', async () => {
    const io2 = {
      prompt: async () => 'jo',
      promptHidden: async (question: string) => (question === '2FA code: ' ? '' : 'correct horse battery'),
    };
    const err = await runLogin(s2.url, { name: 'cli-2fa-empty' }, env2(), io2).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(3);
    expect(() => readFileSync(configPath(env2()), 'utf8')).toThrow();
  });
});
