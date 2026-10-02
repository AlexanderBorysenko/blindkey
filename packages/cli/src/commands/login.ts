import { hostname } from 'node:os';
import { ApiError, BlindkeyClient } from '../client.js';
import { normalizeUrl, saveConfig } from '../config.js';
import { CliError, EXIT_AUTH } from '../errors.js';
import type { CommandResult } from '../output.js';
import { prompt as defaultPrompt, promptHidden as defaultPromptHidden } from '../prompt.js';

export interface LoginOptions {
  username?: string;
  name?: string;
  expires?: string;
}

export interface LoginIo {
  prompt: (question: string) => Promise<string>;
  promptHidden: (question: string) => Promise<string>;
}

interface AuthTokenResponse {
  token: string;
  id: number;
  name: string;
  expires_at: number;
}

export async function runLogin(
  rawUrl: string,
  opts: LoginOptions,
  env: NodeJS.ProcessEnv = process.env,
  io: LoginIo = { prompt: defaultPrompt, promptHidden: defaultPromptHidden },
): Promise<CommandResult> {
  const url = normalizeUrl(rawUrl);

  let expires_days = 30;
  if (opts.expires !== undefined) {
    if (!/^\d+$/.test(opts.expires.trim())) throw new CliError(`invalid --expires "${opts.expires}" — a number of days from 1 to 365`);
    expires_days = Number.parseInt(opts.expires.trim(), 10);
    if (expires_days < 1 || expires_days > 365) throw new CliError(`invalid --expires "${opts.expires}" — a number of days from 1 to 365`);
  }

  const username = opts.username ?? (await io.prompt('Admin username: '));
  const password = await io.promptHidden('Admin password: ');
  if (!username || !password) throw new CliError('username and password are required');
  const name = opts.name ?? `cli-${hostname()}`;

  // No token yet: the /auth/token route is public, and BlindkeyClient omits the
  // Authorization header for an empty token.
  const client = new BlindkeyClient({ url, token: '' });
  const body = { username, password, name, expires_days };
  let res: AuthTokenResponse;
  try {
    res = await client.json<AuthTokenResponse>('POST', '/api/v1/auth/token', { body });
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 401 && err.body.error === 'totp_required')) throw err;
    const totp = await io.promptHidden('2FA code: ');
    if (!totp) throw new CliError('a two-factor code is required', EXIT_AUTH);
    res = await client.json<AuthTokenResponse>('POST', '/api/v1/auth/token', { body: { ...body, totp } });
  }
  const path = saveConfig({ url, token: res.token }, env);
  return {
    json: { url, token_id: res.id, token_name: res.name, config: path, expires_at: res.expires_at },
    text: `logged in to ${url}; admin token "${res.name}" (id ${res.id}) saved to ${path}, expires ${new Date(res.expires_at).toISOString().slice(0, 10)}`,
  };
}
