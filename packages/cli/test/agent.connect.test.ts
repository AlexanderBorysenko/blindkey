import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENT_SCOPES } from '@pidb/shared';
import { runConnect } from '../src/agent/connect.js';
import { loadProfiles, saveBindings, saveProfiles } from '../src/agent/state.js';
import { memoryStore, type TokenStore } from '../src/agent/tokenstore.js';
import { CliError } from '../src/errors.js';
import { getConnectRequestByUserCode, approveConnectRequest, denyConnectRequest } from '../../server/src/repos/connect.js';
import { getProjectBySlug } from '../../server/src/repos/projects.js';
import { makeServer, type ServerFixture } from './helpers.js';

let s: ServerFixture;
let dataDir: string;
let store: TokenStore;

// A fresh server per test (spec/global.md: rate limits are per app instance) — `/connect/poll` is
// hit repeatedly by the loop below, and several tests in this file share the same real endpoints.
beforeEach(async () => {
  s = await makeServer();
  s.project('acme');
  s.project('beta');
  dataDir = mkdtempSync(join(tmpdir(), 'pidb-agent-connect-'));
  store = memoryStore();
});
afterEach(async () => {
  await s.close();
});

/**
 * Fake clock paired with a *small but real* sleep: the loop under test polls a real, rate-limited
 * HTTP endpoint, so a purely instant `sleep` would spin it into a tight loop hammering that endpoint
 * far faster than any real 3-second interval ever would. A few milliseconds of real delay per tick
 * keeps each test's total real poll count tiny while the fake clock still advances by the full
 * requested amount, so `now()`/deadline logic behaves as if real time had actually passed.
 */
function fakeClock(realDelayMs = 5) {
  let clock = 0;
  return {
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
      await new Promise<void>((resolve) => setTimeout(resolve, realDelayMs));
    },
  };
}

function fakeOut() {
  const lines: string[] = [];
  return { write: (chunk: unknown) => lines.push(String(chunk)), lines };
}

function userCodeFrom(line: string): string {
  const url = line.split(' ')[1]!;
  return new URL(url).searchParams.get('code')!;
}

function approveByLine(line: string, scopes: string[], projects: string[], expiresDays = 90): void {
  const row = getConnectRequestByUserCode(s.db, userCodeFrom(line));
  if (!row) throw new Error(`no connect request for ${line}`);
  const projectIds = projects.map((slug) => getProjectBySlug(s.db, slug)!.id);
  approveConnectRequest(s.db, row.id, { scopes: scopes as never, projectIds, expiresDays });
}

function denyByLine(line: string): void {
  const row = getConnectRequestByUserCode(s.db, userCodeFrom(line));
  if (!row) throw new Error(`no connect request for ${line}`);
  denyConnectRequest(s.db, row.id);
}

/** Waits until `runConnect` has actually printed its "Open ... approve code ..." line. */
async function waitForLine(out: ReturnType<typeof fakeOut>): Promise<string> {
  for (let i = 0; i < 100 && out.lines.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
  if (out.lines.length === 0) throw new Error('runConnect never printed the verification line');
  return out.lines[0]!;
}

describe('runConnect: happy path', () => {
  it('starts a request with all AGENT_SCOPES, prints the code, and stores the token on approval', async () => {
    saveProfiles(dataDir, { default: 'work', profiles: { work: { url: s.url } } });
    const { now, sleep } = fakeClock();
    const out = fakeOut();
    let capturedUrl = '';

    const connectPromise = runConnect(
      {},
      {
        cwd: dataDir,
        store,
        dataDir,
        now,
        sleep,
        out,
        openBrowserImpl: (url) => {
          capturedUrl = url;
          return { cmd: 'open', args: [url] };
        },
      },
    );

    const line = await waitForLine(out);
    expect(line).toMatch(/^Open .* and approve code /);
    expect(capturedUrl).toContain('/connect?code=');
    approveByLine(line, ['projects:read', 'docs:read'], ['acme', 'beta']);

    const result = await connectPromise;

    expect(await store.get('work')).toMatch(/^pidb_/);
    expect(JSON.stringify(result.json)).not.toMatch(/pidb_/);
    expect(result.text).not.toMatch(/pidb_/);
    expect(result.json).toMatchObject({ profile: 'work', scopes: ['projects:read', 'docs:read'], projects: ['acme', 'beta'] });

    const profiles = loadProfiles(dataDir);
    expect(profiles.profiles.work).toMatchObject({ url: s.url, projects: ['acme', 'beta'] });
    expect(typeof profiles.profiles.work!.expires_at).toBe('number');
  });

  it('requests all AGENT_SCOPES regardless of what was previously known', async () => {
    saveProfiles(dataDir, { default: 'work', profiles: { work: { url: s.url } } });
    const { now, sleep } = fakeClock();
    const out = fakeOut();
    const connectPromise = runConnect(
      {},
      { cwd: dataDir, store, dataDir, now, sleep, out, openBrowserImpl: (url) => ({ cmd: 'open', args: [url] }) },
    );
    const line = await waitForLine(out);
    const row = getConnectRequestByUserCode(s.db, userCodeFrom(line))!;
    expect(row.scopes.sort()).toEqual([...AGENT_SCOPES].sort());
    approveConnectRequest(s.db, row.id, {
      scopes: ['projects:read'] as never,
      projectIds: [getProjectBySlug(s.db, 'acme')!.id],
      expiresDays: 90,
    });
    await connectPromise;
  });

  it('includes the bound project for cwd in the requested projects', async () => {
    saveProfiles(dataDir, { default: 'work', profiles: { work: { url: s.url } } });
    saveBindings(dataDir, { [dataDir]: { profile: 'work', project: 'acme' } });
    const { now, sleep } = fakeClock();
    const out = fakeOut();
    const connectPromise = runConnect(
      {},
      { cwd: dataDir, store, dataDir, now, sleep, out, openBrowserImpl: (url) => ({ cmd: 'open', args: [url] }) },
    );
    const line = await waitForLine(out);
    const row = getConnectRequestByUserCode(s.db, userCodeFrom(line))!;
    expect(row.projects).toEqual(['acme']);
    approveConnectRequest(s.db, row.id, { scopes: ['projects:read'] as never, projectIds: [getProjectBySlug(s.db, 'acme')!.id], expiresDays: 90 });
    await connectPromise;
  });

  it('creates a new profile with --profile/--url when none exists yet', async () => {
    const { now, sleep } = fakeClock();
    const out = fakeOut();
    const connectPromise = runConnect(
      { profile: 'fresh', url: s.url },
      { cwd: dataDir, store, dataDir, now, sleep, out, openBrowserImpl: (url) => ({ cmd: 'open', args: [url] }) },
    );
    const line = await waitForLine(out);
    approveByLine(line, ['projects:read'], ['acme']);
    await connectPromise;
    expect(loadProfiles(dataDir).default).toBe('fresh');
    expect(await store.get('fresh')).toMatch(/^pidb_/);
  });

  it('never prints the token to the injected out stream', async () => {
    saveProfiles(dataDir, { default: 'work', profiles: { work: { url: s.url } } });
    const { now, sleep } = fakeClock();
    const out = fakeOut();
    const connectPromise = runConnect(
      {},
      { cwd: dataDir, store, dataDir, now, sleep, out, openBrowserImpl: (url) => ({ cmd: 'open', args: [url] }) },
    );
    const line = await waitForLine(out);
    approveByLine(line, ['projects:read'], ['acme']);
    await connectPromise;
    const token = await store.get('work');
    expect(out.lines.join('')).not.toContain(token);
  });
});

describe('runConnect: denied / expired / not configured', () => {
  it('denied → throws, no token stored', async () => {
    saveProfiles(dataDir, { default: 'work', profiles: { work: { url: s.url } } });
    const { now, sleep } = fakeClock();
    const out = fakeOut();
    const connectPromise = runConnect(
      {},
      { cwd: dataDir, store, dataDir, now, sleep, out, openBrowserImpl: (url) => ({ cmd: 'open', args: [url] }) },
    );
    const line = await waitForLine(out);
    denyByLine(line);
    await expect(connectPromise).rejects.toMatchObject({ message: expect.stringMatching(/denied/) });
    expect(await store.get('work')).toBeNull();
  });

  it('expired (server row expires) → throws, no token stored', async () => {
    saveProfiles(dataDir, { default: 'work', profiles: { work: { url: s.url } } });
    const { now, sleep } = fakeClock();
    const out = fakeOut();
    const connectPromise = runConnect(
      {},
      { cwd: dataDir, store, dataDir, now, sleep, out, openBrowserImpl: (url) => ({ cmd: 'open', args: [url] }) },
    );
    const line = await waitForLine(out);
    s.db.prepare(`UPDATE connect_requests SET expires_at = ? WHERE user_code = ?`).run(Date.now() - 1000, userCodeFrom(line));
    await expect(connectPromise).rejects.toMatchObject({ message: expect.stringMatching(/expired/) });
    expect(await store.get('work')).toBeNull();
  });

  it('no profile configured at all and no --profile/--url → CliError pointing at profile add', async () => {
    await expect(runConnect({}, { cwd: dataDir, store, dataDir })).rejects.toMatchObject({
      message: expect.stringMatching(/no server configured.*pidb profile add/),
    });
  });

  it('--profile names an unknown profile with no --url → CliError', async () => {
    await expect(runConnect({ profile: 'ghost' }, { cwd: dataDir, store, dataDir })).rejects.toBeInstanceOf(CliError);
  });

  it('gives up once the server-reported expiry passes, never having stored a token', async () => {
    saveProfiles(dataDir, { default: 'work', profiles: { work: { url: s.url } } });
    // A synthetic fetch, never touching the real (rate-limited) server: this test is only about the
    // give-up bookkeeping (deadline = min(10 minutes, the server's own expires_in)), not about
    // exercising hundreds of real HTTP round-trips against a live rate limiter.
    let pollCalls = 0;
    const fetchImpl = (async (url: string | URL) => {
      const href = String(url);
      if (href.endsWith('/connect/start')) {
        return new Response(
          JSON.stringify({
            device_code: 'dc',
            user_code: 'AAAA-BBBB',
            verification_url: 'https://fake.invalid/connect?code=AAAA-BBBB',
            expires_in: 9,
            interval: 3,
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      }
      pollCalls++;
      return new Response(JSON.stringify({ error: 'authorization_pending' }), {
        status: 428,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const { now, sleep } = fakeClock(0);
    const out = fakeOut();

    const result = runConnect(
      {},
      { cwd: dataDir, store, dataDir, now, sleep, out, fetchImpl, openBrowserImpl: (url) => ({ cmd: 'open', args: [url] }) },
    );
    await expect(result).rejects.toMatchObject({ message: expect.stringMatching(/timed out/) });
    expect(await store.get('work')).toBeNull();
    expect(pollCalls).toBeGreaterThan(0);
    expect(pollCalls).toBeLessThan(10); // bounded by expires_in=9s / interval=3s, not the 10-minute cap
  });
});
