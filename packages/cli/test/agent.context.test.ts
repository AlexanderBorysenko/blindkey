import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAgentConfig } from '../src/agent/context.js';
import { saveBindings, saveProfiles } from '../src/agent/state.js';
import { memoryStore } from '../src/agent/tokenstore.js';
import { CliError } from '../src/errors.js';

let dataDir: string;
const cwd = '/repo/acme';

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'blindkey-agent-ctx-'));
});

describe('resolveAgentConfig', () => {
  it('errors when no profile is configured at all', async () => {
    const store = memoryStore();
    await expect(resolveAgentConfig({ cwd, store, dataDir })).rejects.toMatchObject({
      message: expect.stringMatching(/no server configured.*blindkey profile add/),
      exitCode: 3,
    });
  });

  it('uses the default profile when the repo has no binding', async () => {
    saveProfiles(dataDir, { default: 'work', profiles: { work: { url: 'https://work.example.com' } } });
    const store = memoryStore({ work: 'bk_work_token' });
    const cfg = await resolveAgentConfig({ cwd, store, dataDir });
    expect(cfg).toEqual({ profile: 'work', url: 'https://work.example.com', token: 'bk_work_token', project: null });
  });

  it("prefers the repo's bound profile over the default profile", async () => {
    saveProfiles(dataDir, {
      default: 'work',
      profiles: { work: { url: 'https://work.example.com' }, side: { url: 'https://side.example.com' } },
    });
    saveBindings(dataDir, { [cwd]: { profile: 'side', project: 'acme' } });
    const store = memoryStore({ work: 'bk_work_token', side: 'bk_side_token' });
    const cfg = await resolveAgentConfig({ cwd, store, dataDir });
    expect(cfg).toEqual({ profile: 'side', url: 'https://side.example.com', token: 'bk_side_token', project: 'acme' });
  });

  it('errors when not connected (profile configured but no token in the store)', async () => {
    saveProfiles(dataDir, { default: 'work', profiles: { work: { url: 'https://work.example.com' } } });
    const store = memoryStore();
    await expect(resolveAgentConfig({ cwd, store, dataDir })).rejects.toMatchObject({
      message: expect.stringMatching(/not connected.*blindkey connect/),
      exitCode: 3,
    });
  });

  it('ignores BLINDKEY_URL / BLINDKEY_TOKEN entirely', async () => {
    saveProfiles(dataDir, { default: 'work', profiles: { work: { url: 'https://work.example.com' } } });
    const store = memoryStore({ work: 'bk_work_token' });
    const cfg = await resolveAgentConfig({
      cwd,
      store,
      dataDir,
      env: { BLINDKEY_URL: 'https://should-be-ignored.example.com', BLINDKEY_TOKEN: 'bk_should_be_ignored' },
    });
    expect(cfg.url).toBe('https://work.example.com');
    expect(cfg.token).toBe('bk_work_token');
  });

  it('errors when the binding points at a profile that no longer exists', async () => {
    saveProfiles(dataDir, { default: null, profiles: {} });
    saveBindings(dataDir, { [cwd]: { profile: 'gone', project: 'acme' } });
    const store = memoryStore();
    await expect(resolveAgentConfig({ cwd, store, dataDir })).rejects.toBeInstanceOf(CliError);
  });
});
