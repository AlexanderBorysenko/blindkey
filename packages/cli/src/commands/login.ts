import { hostname } from 'node:os';
import { PidbClient } from '../client.js';
import { normalizeUrl, saveConfig } from '../config.js';
import { CliError } from '../errors.js';
import type { CommandResult } from '../output.js';
import { prompt as defaultPrompt, promptHidden as defaultPromptHidden } from '../prompt.js';

export interface LoginOptions {
  username?: string;
  name?: string;
}

export interface LoginIo {
  prompt: (question: string) => Promise<string>;
  promptHidden: (question: string) => Promise<string>;
}

interface AuthTokenResponse {
  token: string;
  id: number;
  name: string;
}

export async function runLogin(
  rawUrl: string,
  opts: LoginOptions,
  env: NodeJS.ProcessEnv = process.env,
  io: LoginIo = { prompt: defaultPrompt, promptHidden: defaultPromptHidden },
): Promise<CommandResult> {
  const url = normalizeUrl(rawUrl);
  const username = opts.username ?? (await io.prompt('Admin username: '));
  const password = await io.promptHidden('Admin password: ');
  if (!username || !password) throw new CliError('username and password are required');
  const name = opts.name ?? `cli-${hostname()}`;

  // No token yet: the /auth/token route is public, and PidbClient omits the
  // Authorization header for an empty token.
  const client = new PidbClient({ url, token: '' });
  const res = await client.json<AuthTokenResponse>('POST', '/api/v1/auth/token', {
    body: { username, password, name },
  });
  const path = saveConfig({ url, token: res.token }, env);
  return {
    json: { url, token_id: res.id, token_name: res.name, config: path },
    text: `logged in to ${url}; admin token "${res.name}" (id ${res.id}) saved to ${path}`,
  };
}
