import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENT_SCOPES } from '@blindkey/shared';
import { buildVerificationUrl, runConnect } from '../src/agent/connect.js';
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
  dataDir = mkdtempSync(join(tmpdir(), 'blindkey-agent-connect-'));
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

    expect(await store.get('work')).toMatch(/^bk_/);
    expect(JSON.stringify(result.json)).not.toMatch(/bk_/);
    expect(result.text).not.toMatch(/bk_/);
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
    expect(await store.get('fresh')).toMatch(/^bk_/);
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
      message: expect.stringMatching(/no server configured.*blindkey profile add/),
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

describe('buildVerificationUrl (F6: built locally, never the server-supplied url)', () => {
  const profileUrl = 'https://good.example.com';
  const code = 'ABCD-EFGH';

  it('builds <profile url>/connect?code=<code>', () => {
    expect(buildVerificationUrl(profileUrl, code)).toBe(`https://good.example.com/connect?code=${code}`);
  });

  it('keeps a profile url path prefix', () => {
    expect(buildVerificationUrl('https://good.example.com/blindkey', code)).toBe(`https://good.example.com/blindkey/connect?code=${code}`);
  });

  it('rejects a malformed user_code (lowercase, no dash, wrong length, smuggled characters)', () => {
    for (const bad of ['abcd-efgh', 'ABCDEFGH', 'ABC-DEFG', 'ABCD-EFGHI', 'AB%44-EFGH', 'ABCD-EFGH&x=1', 'ABCD-EFGH#f', 'ABCD-EF/H', '']) {
      expect(buildVerificationUrl(profileUrl, bad)).toBeNull();
    }
  });

  it('rejects a non-http(s) or unparseable profile url, and userinfo', () => {
    expect(buildVerificationUrl('file:///etc', code)).toBeNull();
    expect(buildVerificationUrl('not a url', code)).toBeNull();
    expect(buildVerificationUrl('https://user:pass@good.example.com', code)).toBeNull();
  });
});

describe('runConnect: verification url validation gates the browser open (Critical 2)', () => {
  it('a tampered server verification_url is ignored: the locally built url is printed and opened instead (F6)', async () => {
    saveProfiles(dataDir, { default: 'work', profiles: { work: { url: s.url } } });
    const { now, sleep } = fakeClock(0);
    const out = fakeOut();
    const openBrowserImpl = vi.fn((_url: string) => ({ cmd: 'open', args: [] }));

    // A fake start response whose verification_url points elsewhere — everything else (poll) is real.
    let started = false;
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      if (href.endsWith('/connect/start')) {
        started = true;
        const real = await fetch(href, init);
        const body = (await real.json()) as { verification_url: string; user_code: string; [k: string]: unknown };
        const tampered = { ...body, verification_url: `https://evil.example.com/phish?code=${body.user_code}` };
        return new Response(JSON.stringify(tampered), { status: 201, headers: { 'content-type': 'application/json' } });
      }
      return fetch(href, init);
    }) as unknown as typeof fetch;

    const connectPromise = runConnect({}, { cwd: dataDir, store, dataDir, now, sleep, out, fetchImpl, openBrowserImpl });
    const line = await waitForLine(out);
    expect(started).toBe(true);
    const code = userCodeFrom(line);
    expect(line).toBe(`Open ${s.url}/connect?code=${code} and approve code ${code}\n`);
    expect(line).not.toContain('evil');
    approveByLine(line, ['projects:read'], ['acme']);

    await connectPromise;
    expect(openBrowserImpl).toHaveBeenCalledTimes(1);
    expect(openBrowserImpl.mock.calls[0]?.[0]).toBe(`${s.url}/connect?code=${code}`);
  });

  it('a malformed user_code: no browser open, a warning is printed', async () => {
    saveProfiles(dataDir, { default: 'work', profiles: { work: { url: 'https://fake.invalid' } } });
    const out = fakeOut();
    const { now, sleep } = fakeClock(0);
    const openBrowserImpl = vi.fn(() => ({ cmd: 'open', args: [] }));
    const fetchImpl = (async (url: string | URL) => {
      if (String(url).endsWith('/connect/start')) {
        return new Response(
          JSON.stringify({ device_code: 'dc', user_code: 'AAAA-BBBB&x=1', verification_url: 'https://fake.invalid/connect', expires_in: 5, interval: 5 }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ error: 'authorization_pending' }), { status: 428 });
    }) as unknown as typeof fetch;
    const settlement = runConnect({}, { cwd: dataDir, store, dataDir, now, sleep, out, fetchImpl, openBrowserImpl }).catch((e: unknown) => e);
    await waitForLine(out);
    await settlement;
    expect(openBrowserImpl).not.toHaveBeenCalled();
    expect(out.lines.some((l) => /warning:.*not opening/.test(l))).toBe(true);
  });

  it('strips control characters from the printed line (terminal escape injection)', async () => {
    saveProfiles(dataDir, { default: 'work', profiles: { work: { url: 'https://fake.invalid' } } });
    const out = fakeOut();
    const { now, sleep } = fakeClock(0);
    const fetchImpl = (async (url: string | URL) => {
      const href = String(url);
      if (href.endsWith('/connect/start')) {
        return new Response(
          JSON.stringify({
            device_code: 'dc',
            user_code: 'AAAA\u001b[31mBBBB', // an embedded ANSI escape / control char
            verification_url: 'https://fake.invalid/connect?code=AAAA\u0007BBBB',
            expires_in: 5,
            interval: 5,
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ error: 'authorization_pending' }), { status: 428 });
    }) as unknown as typeof fetch;

    const connectPromise = runConnect(
      {},
      { cwd: dataDir, store, dataDir, now, sleep, out, fetchImpl, openBrowserImpl: () => ({ cmd: 'open', args: [] }) },
    );
    // Attach a handler immediately (same tick) so Node never sees this as an unhandled rejection,
    // even though the fake clock/instant sleep can settle it before the checks below run.
    const settlement = connectPromise.catch((e: unknown) => e);
    const line = await waitForLine(out);
    // The line's own trailing "\n" is legitimate; check for the specific injected control chars
    // (BEL, ESC) instead of blanket-rejecting every control character (which would also flag "\n").
    expect(line).not.toContain('\u0007');
    expect(line).not.toContain('\u001b');
    expect(line).toContain('AAAA[31mBBBB'); // the code survives, just with the control chars stripped
    const err = await settlement;
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).message).toMatch(/timed out/);
  });
});

describe('runConnect: profile resolution (Important 3, Minor 5)', () => {
  it('with no --profile, uses the repo\'s bound profile over the default profile', async () => {
    saveProfiles(dataDir, {
      default: 'work',
      profiles: { work: { url: s.url }, side: { url: s.url } },
    });
    saveBindings(dataDir, { [dataDir]: { profile: 'side', project: 'acme' } });
    const { now, sleep } = fakeClock();
    const out = fakeOut();
    const connectPromise = runConnect(
      {},
      { cwd: dataDir, store, dataDir, now, sleep, out, openBrowserImpl: (url) => ({ cmd: 'open', args: [url] }) },
    );
    const line = await waitForLine(out);
    approveByLine(line, ['projects:read'], ['acme']);
    await connectPromise;
    expect(await store.get('side')).toMatch(/^bk_/);
    expect(await store.get('work')).toBeNull();
  });

  it('with no --profile and no binding, falls back to the default profile', async () => {
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
    expect(await store.get('work')).toMatch(/^bk_/);
  });

  it('--url differing from an existing profile\'s stored url refuses (exit 2) with a set-url hint', async () => {
    saveProfiles(dataDir, { default: 'work', profiles: { work: { url: 'https://original.example.com' } } });
    await expect(runConnect({ profile: 'work', url: 'https://different.example.com' }, { cwd: dataDir, store, dataDir })).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringMatching(/profile set-url/),
    });
  });

  it('--url without --profile refuses (exit 2)', async () => {
    await expect(runConnect({ url: 'https://example.com' }, { cwd: dataDir, store, dataDir })).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringMatching(/--url requires --profile/),
    });
  });

  it('an unknown --profile with no --url refuses with exit 2 (a config refusal, not an auth failure)', async () => {
    const err = await runConnect({ profile: 'ghost' }, { cwd: dataDir, store, dataDir }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(2);
  });

  it('an unconfigured --profile matching the existing url is accepted (same url, no refusal)', async () => {
    saveProfiles(dataDir, { default: 'work', profiles: { work: { url: s.url } } });
    const { now, sleep } = fakeClock();
    const out = fakeOut();
    const connectPromise = runConnect(
      { profile: 'work', url: s.url },
      { cwd: dataDir, store, dataDir, now, sleep, out, openBrowserImpl: (url) => ({ cmd: 'open', args: [url] }) },
    );
    const line = await waitForLine(out);
    approveByLine(line, ['projects:read'], ['acme']);
    await connectPromise;
    expect(await store.get('work')).toMatch(/^bk_/);
  });
});

describe('runConnect: poll bounds (Important 4)', () => {
  function fakeStartAndPoll(overrides: Partial<{ interval: unknown; expires_in: unknown }>) {
    return (async (url: string | URL) => {
      const href = String(url);
      if (href.endsWith('/connect/start')) {
        return new Response(
          JSON.stringify({
            device_code: 'dc',
            user_code: 'AAAA-BBBB',
            verification_url: 'https://fake.invalid/connect?code=AAAA-BBBB',
            expires_in: 30,
            interval: 3,
            ...overrides,
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ error: 'authorization_pending' }), { status: 428 });
    }) as unknown as typeof fetch;
  }

  it('an invalid/missing interval defaults to 5s', async () => {
    saveProfiles(dataDir, { default: 'work', profiles: { work: { url: 'https://fake.invalid' } } });
    const sleepCalls: number[] = [];
    const now = () => 0; // never reaches the deadline — we only care about the first sleep() call
    let calls = 0;
    const sleep = async (ms: number) => {
      sleepCalls.push(ms);
      calls++;
      if (calls > 2) throw new Error('stop'); // bail out after a couple of iterations
    };
    const out = fakeOut();
    const fetchImpl = fakeStartAndPoll({ interval: -1 });
    await runConnect({}, { cwd: dataDir, store, dataDir, now, sleep, out, fetchImpl, openBrowserImpl: () => ({ cmd: 'open', args: [] }) }).catch(
      () => {},
    );
    expect(sleepCalls[0]).toBe(5000);
  });

  it('an invalid/missing expires_in falls back to the 10-minute cap', async () => {
    saveProfiles(dataDir, { default: 'work', profiles: { work: { url: 'https://fake.invalid' } } });
    let clock = 0;
    const now = () => clock;
    const sleep = async (ms: number) => {
      clock += ms;
    };
    const out = fakeOut();
    let pollCalls = 0;
    const fetchImpl = (async (url: string | URL) => {
      const href = String(url);
      if (href.endsWith('/connect/start')) {
        return new Response(
          JSON.stringify({
            device_code: 'dc',
            user_code: 'AAAA-BBBB',
            verification_url: 'https://fake.invalid/connect?code=AAAA-BBBB',
            expires_in: Number.NaN,
            interval: 60,
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      }
      pollCalls++;
      return new Response(JSON.stringify({ error: 'authorization_pending' }), { status: 428 });
    }) as unknown as typeof fetch;

    await expect(
      runConnect({}, { cwd: dataDir, store, dataDir, now, sleep, out, fetchImpl, openBrowserImpl: () => ({ cmd: 'open', args: [] }) }),
    ).rejects.toMatchObject({ message: expect.stringMatching(/timed out/) });
    // 10 minutes / 60s interval = 10 polls, not fewer (would indicate a too-small fallback) and not
    // unbounded (would indicate no cap at all).
    expect(pollCalls).toBe(10);
  });

  it('a 429 response backs off (interval += 5s) instead of failing', async () => {
    saveProfiles(dataDir, { default: 'work', profiles: { work: { url: 'https://fake.invalid' } } });
    let clock = 0;
    const now = () => clock;
    const sleep = async (ms: number) => {
      clock += ms;
    };
    const out = fakeOut();
    const sleepCalls: number[] = [];
    const sleepTracking = async (ms: number) => {
      sleepCalls.push(ms);
      clock += ms;
    };
    let pollCount = 0;
    const fetchImpl = (async (url: string | URL) => {
      const href = String(url);
      if (href.endsWith('/connect/start')) {
        return new Response(
          JSON.stringify({
            device_code: 'dc',
            user_code: 'AAAA-BBBB',
            verification_url: 'https://fake.invalid/connect?code=AAAA-BBBB',
            expires_in: 600,
            interval: 3,
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      }
      pollCount++;
      if (pollCount <= 2) return new Response(JSON.stringify({ error: 'rate_limited' }), { status: 429 });
      return new Response(
        JSON.stringify({ token: 'bk_x', id: 1, name: 'n', scopes: ['projects:read'], projects: ['acme'], expires_at: Date.now() + 1000 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    await runConnect(
      {},
      { cwd: dataDir, store, dataDir, now, sleep: sleepTracking, out, fetchImpl, openBrowserImpl: () => ({ cmd: 'open', args: [] }) },
    );
    expect(sleepCalls).toEqual([3000, 8000, 13000]); // 3s, then +5s backoff twice: 8s, 13s
  });

  it('a body-level slow_down (regardless of status) also backs off instead of failing', async () => {
    saveProfiles(dataDir, { default: 'work', profiles: { work: { url: 'https://fake.invalid' } } });
    let clock = 0;
    const now = () => clock;
    const sleepCalls: number[] = [];
    const sleep = async (ms: number) => {
      sleepCalls.push(ms);
      clock += ms;
    };
    const out = fakeOut();
    let pollCount = 0;
    const fetchImpl = (async (url: string | URL) => {
      const href = String(url);
      if (href.endsWith('/connect/start')) {
        return new Response(
          JSON.stringify({
            device_code: 'dc',
            user_code: 'AAAA-BBBB',
            verification_url: 'https://fake.invalid/connect?code=AAAA-BBBB',
            expires_in: 600,
            interval: 3,
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      }
      pollCount++;
      if (pollCount === 1) return new Response(JSON.stringify({ error: 'slow_down' }), { status: 400 });
      return new Response(
        JSON.stringify({ token: 'bk_x', id: 1, name: 'n', scopes: ['projects:read'], projects: ['acme'], expires_at: Date.now() + 1000 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    await runConnect({}, { cwd: dataDir, store, dataDir, now, sleep, out, fetchImpl, openBrowserImpl: () => ({ cmd: 'open', args: [] }) });
    expect(sleepCalls).toEqual([3000, 8000]);
  });

  it('every request carries an AbortSignal (network timeout)', async () => {
    saveProfiles(dataDir, { default: 'work', profiles: { work: { url: 'https://fake.invalid' } } });
    const signals: (AbortSignal | undefined)[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      signals.push(init?.signal ?? undefined);
      const href = String(url);
      if (href.endsWith('/connect/start')) {
        return new Response(
          JSON.stringify({
            device_code: 'dc',
            user_code: 'AAAA-BBBB',
            verification_url: 'https://fake.invalid/connect?code=AAAA-BBBB',
            expires_in: 30,
            interval: 3,
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({ token: 'bk_x', id: 1, name: 'n', scopes: ['projects:read'], projects: ['acme'], expires_at: null }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;
    const { now, sleep } = fakeClock(0);
    const out = fakeOut();
    await runConnect({}, { cwd: dataDir, store, dataDir, now, sleep, out, fetchImpl, openBrowserImpl: () => ({ cmd: 'open', args: [] }) });
    expect(signals).toHaveLength(2);
    for (const sig of signals) expect(sig).toBeInstanceOf(AbortSignal);
  });
});

describe('runConnect: profiles.json reload before save (Minor 6)', () => {
  it('does not clobber an unrelated profile added while polling was in flight', async () => {
    saveProfiles(dataDir, { default: 'work', profiles: { work: { url: s.url } } });
    const { now, sleep } = fakeClock();
    const out = fakeOut();
    const connectPromise = runConnect(
      {},
      { cwd: dataDir, store, dataDir, now, sleep, out, openBrowserImpl: (url) => ({ cmd: 'open', args: [url] }) },
    );
    const line = await waitForLine(out);
    // Simulate a concurrent `blindkey profile add other https://other.example.com` completing while
    // this connect is still polling.
    const mid = loadProfiles(dataDir);
    mid.profiles.other = { url: 'https://other.example.com' };
    saveProfiles(dataDir, mid);

    approveByLine(line, ['projects:read'], ['acme']);
    await connectPromise;

    const final = loadProfiles(dataDir);
    expect(final.profiles.other).toEqual({ url: 'https://other.example.com' });
    expect(final.profiles.work).toMatchObject({ url: s.url, projects: ['acme'] });
  });
});

describe('runConnect: expires_at null (Minor 9)', () => {
  it('prints "never" instead of an invalid date, and stores null', async () => {
    saveProfiles(dataDir, { default: 'work', profiles: { work: { url: 'https://fake.invalid' } } });
    const { now, sleep } = fakeClock(0);
    const out = fakeOut();
    const fetchImpl = (async (url: string | URL) => {
      const href = String(url);
      if (href.endsWith('/connect/start')) {
        return new Response(
          JSON.stringify({
            device_code: 'dc',
            user_code: 'AAAA-BBBB',
            verification_url: 'https://fake.invalid/connect?code=AAAA-BBBB',
            expires_in: 30,
            interval: 1,
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({ token: 'bk_x', id: 1, name: 'n', scopes: ['projects:read'], projects: ['acme'], expires_at: null }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const result = await runConnect(
      {},
      { cwd: dataDir, store, dataDir, now, sleep, out, fetchImpl, openBrowserImpl: () => ({ cmd: 'open', args: [] }) },
    );
    expect(result.text).toContain('expires: never');
    expect(result.json).toMatchObject({ expires_at: null });
    expect(loadProfiles(dataDir).profiles.work!.expires_at).toBeNull();
  });
});

describe('runConnect: fix round 2', () => {
  it('a non-string verification_url raises a CliError instead of misbehaving silently (Minor 4)', async () => {
    saveProfiles(dataDir, { default: 'work', profiles: { work: { url: 'https://fake.invalid' } } });
    const { now, sleep } = fakeClock(0);
    const out = fakeOut();
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({ device_code: 'dc', user_code: 'AAAA-BBBB', verification_url: 12345, expires_in: 30, interval: 3 }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch;
    await expect(
      runConnect({}, { cwd: dataDir, store, dataDir, now, sleep, out, fetchImpl, openBrowserImpl: () => ({ cmd: 'open', args: [] }) }),
    ).rejects.toBeInstanceOf(CliError);
  });

  it('a non-string user_code raises a CliError', async () => {
    saveProfiles(dataDir, { default: 'work', profiles: { work: { url: 'https://fake.invalid' } } });
    const { now, sleep } = fakeClock(0);
    const out = fakeOut();
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          device_code: 'dc',
          user_code: null,
          verification_url: 'https://fake.invalid/connect?code=AAAA-BBBB',
          expires_in: 30,
          interval: 3,
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch;
    await expect(
      runConnect({}, { cwd: dataDir, store, dataDir, now, sleep, out, fetchImpl, openBrowserImpl: () => ({ cmd: 'open', args: [] }) }),
    ).rejects.toBeInstanceOf(CliError);
  });

  it('sanitizeForTerminal strips bidi override/isolate/mark characters, not just ASCII controls (Minor 4)', async () => {
    saveProfiles(dataDir, { default: 'work', profiles: { work: { url: 'https://fake.invalid' } } });
    const { now, sleep } = fakeClock(0);
    const out = fakeOut();
    const fetchImpl = (async (url: string | URL) => {
      const href = String(url);
      if (href.endsWith('/connect/start')) {
        return new Response(
          JSON.stringify({
            device_code: 'dc',
            user_code: 'AAAA‮BBBB', // RLO (right-to-left override)
            verification_url: 'https://fake.invalid/connect?code=AAAA⁦BBBB', // LRI
            expires_in: 5,
            interval: 5,
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ error: 'authorization_pending' }), { status: 428 });
    }) as unknown as typeof fetch;

    const connectPromise = runConnect(
      {},
      { cwd: dataDir, store, dataDir, now, sleep, out, fetchImpl, openBrowserImpl: () => ({ cmd: 'open', args: [] }) },
    );
    const settlement = connectPromise.catch((e: unknown) => e);
    const line = await waitForLine(out);
    expect(line).not.toContain('‮');
    expect(line).not.toContain('⁦');
    expect(line).toContain('AAAABBBB');
    const err = await settlement;
    expect(err).toBeInstanceOf(CliError);
  });

  it('opens the canonically-parsed URL (.href), matching the raw string for anything that validates', async () => {
    saveProfiles(dataDir, { default: 'work', profiles: { work: { url: s.url } } });
    const { now, sleep } = fakeClock();
    const out = fakeOut();
    let openedWith = '';
    const connectPromise = runConnect(
      {},
      {
        cwd: dataDir,
        store,
        dataDir,
        now,
        sleep,
        out,
        openBrowserImpl: (u) => {
          openedWith = u;
          return { cmd: 'open', args: [u] };
        },
      },
    );
    const line = await waitForLine(out);
    approveByLine(line, ['projects:read'], ['acme']);
    await connectPromise;
    const printedUrl = line.split(' ')[1]!;
    expect(openedWith).toBe(new URL(printedUrl).href);
  });

  it('poll interval is capped at 60s even after repeated slow_down backoff (Important 2 follow-up)', async () => {
    saveProfiles(dataDir, { default: 'work', profiles: { work: { url: 'https://fake.invalid' } } });
    let clock = 0;
    const now = () => clock;
    const sleepCalls: number[] = [];
    const sleep = async (ms: number) => {
      sleepCalls.push(ms);
      clock += ms;
    };
    const out = fakeOut();
    let pollCount = 0;
    const fetchImpl = (async (url: string | URL) => {
      const href = String(url);
      if (href.endsWith('/connect/start')) {
        return new Response(
          JSON.stringify({
            device_code: 'dc',
            user_code: 'AAAA-BBBB',
            verification_url: 'https://fake.invalid/connect?code=AAAA-BBBB',
            expires_in: 600,
            interval: 55,
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      }
      pollCount++;
      if (pollCount <= 3) return new Response(JSON.stringify({ error: 'rate_limited' }), { status: 429 });
      return new Response(
        JSON.stringify({ token: 'bk_x', id: 1, name: 'n', scopes: ['projects:read'], projects: ['acme'], expires_at: null }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    await runConnect({}, { cwd: dataDir, store, dataDir, now, sleep, out, fetchImpl, openBrowserImpl: () => ({ cmd: 'open', args: [] }) });
    // 55s, then +5s would be 60s (still allowed), then +5s again would be 65s — capped to 60s.
    expect(sleepCalls).toEqual([55000, 60000, 60000, 60000]);
  });

  it('each sleep is capped at the time left before the deadline, never overshooting it', async () => {
    saveProfiles(dataDir, { default: 'work', profiles: { work: { url: 'https://fake.invalid' } } });
    let clock = 0;
    const now = () => clock;
    const sleepCalls: number[] = [];
    const sleep = async (ms: number) => {
      sleepCalls.push(ms);
      clock += ms;
    };
    const out = fakeOut();
    const fetchImpl = (async (url: string | URL) => {
      const href = String(url);
      if (href.endsWith('/connect/start')) {
        return new Response(
          JSON.stringify({
            device_code: 'dc',
            user_code: 'AAAA-BBBB',
            verification_url: 'https://fake.invalid/connect?code=AAAA-BBBB',
            expires_in: 25, // not a clean multiple of interval
            interval: 10,
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ error: 'authorization_pending' }), { status: 428 });
    }) as unknown as typeof fetch;

    await expect(
      runConnect({}, { cwd: dataDir, store, dataDir, now, sleep, out, fetchImpl, openBrowserImpl: () => ({ cmd: 'open', args: [] }) }),
    ).rejects.toMatchObject({ message: expect.stringMatching(/timed out/) });
    // 10s, 10s, then only the remaining 5s — never a 4th sleep, never overshooting 25s.
    expect(sleepCalls).toEqual([10000, 10000, 5000]);
  });
});
