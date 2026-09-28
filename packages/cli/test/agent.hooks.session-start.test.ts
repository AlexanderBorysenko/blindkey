import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sessionContext } from '../src/agent/hooks/session-start.js';
import { saveBindings, saveProfiles } from '../src/agent/state.js';
import { memoryStore, type TokenStore } from '../src/agent/tokenstore.js';
import { makeServer, type ServerFixture } from './helpers.js';

let s: ServerFixture;
let dataDir: string;
let store: TokenStore;
const cwd = '/repo/acme';

beforeEach(async () => {
  s = await makeServer();
  dataDir = mkdtempSync(join(tmpdir(), 'pidb-agent-session-start-'));
  store = memoryStore();
});
afterEach(async () => {
  await s.close();
});

const GOLDEN_RULE_SNIPPETS = [
  'Never ask the user to paste a secret or token into chat',
  'pidb secret exec <target>',
  'secret_request_link',
  'write_document',
  'run `pidb connect`',
  'Never use curl against the pidb server',
];

function expectGoldenRules(context: string): void {
  expect(context).toContain('Golden rules:');
  for (const snippet of GOLDEN_RULE_SNIPPETS) expect(context).toContain(snippet);
}

describe('sessionContext — no server configured', () => {
  it('reports no server configured and still includes the golden rules', async () => {
    const context = await sessionContext({ cwd, dataDir, store });
    expect(context).toContain('no server configured');
    expect(context.length).toBeLessThanOrEqual(4096);
    expectGoldenRules(context);
  });
});

describe('sessionContext — not connected (profile exists, no token)', () => {
  it('reports not connected', async () => {
    saveProfiles(dataDir, { default: 'work', profiles: { work: { url: s.url } } });
    const context = await sessionContext({ cwd, dataDir, store });
    expect(context).toContain('profile "work"');
    expect(context).toContain(s.url);
    expect(context).toContain('Not connected');
    expect(context).not.toContain('Bound project');
    expect(context.length).toBeLessThanOrEqual(4096);
    expectGoldenRules(context);
  });
});

describe('sessionContext — connected but repo unbound', () => {
  it('reports connected + unbound, hinting at pidb_bind', async () => {
    saveProfiles(dataDir, { default: 'work', profiles: { work: { url: s.url } } });
    await store.set('work', s.token(['projects:read']));
    const context = await sessionContext({ cwd, dataDir, store });
    expect(context).toContain('Connected.');
    expect(context).toContain('not bound to a pidb project');
    expect(context).toContain('pidb_bind');
    expect(context.length).toBeLessThanOrEqual(4096);
    expectGoldenRules(context);
  });
});

describe('sessionContext — connected and bound: fetches real project detail', () => {
  it('includes summary, tags, documents, and secrets (with sensitive fields marked)', async () => {
    s.project('acme');
    s.doc('acme', 'architecture', '# Architecture');
    s.doc('acme', 'runbook', '# Runbook');
    s.secret('acme', 'Stripe', [
      { key: 'API_KEY', value: 'sk_live_x', sensitive: true },
      { key: 'ACCOUNT_ID', value: '12345', sensitive: false },
    ]);
    saveProfiles(dataDir, { default: 'work', profiles: { work: { url: s.url } } });
    saveBindings(dataDir, { [cwd]: { profile: 'work', project: 'acme' } });
    await store.set('work', s.token(['projects:read', 'docs:read', 'secrets:meta']));

    const context = await sessionContext({ cwd, dataDir, store });

    expect(context).toContain('Bound project: acme');
    expect(context).toContain('architecture — architecture');
    expect(context).toContain('runbook — runbook');
    expect(context).toContain('Stripe (API_KEY*, ACCOUNT_ID)');
    expect(context.length).toBeLessThanOrEqual(4096);
    expectGoldenRules(context);
  });

  it('truncates a long document/secret list with "… N more" and still fits in 4096 chars', async () => {
    s.project('acme');
    for (let i = 0; i < 40; i++) s.doc('acme', `doc-${i}`, `# Doc ${i}`);
    saveProfiles(dataDir, { default: 'work', profiles: { work: { url: s.url } } });
    saveBindings(dataDir, { [cwd]: { profile: 'work', project: 'acme' } });
    await store.set('work', s.token(['projects:read', 'docs:read']));

    const context = await sessionContext({ cwd, dataDir, store });

    expect(context).toMatch(/… \d+ more/);
    expect(context.length).toBeLessThanOrEqual(4096);
    expectGoldenRules(context);
  });

  it('reports a not-found project distinctly from a down server', async () => {
    saveProfiles(dataDir, { default: 'work', profiles: { work: { url: s.url } } });
    saveBindings(dataDir, { [cwd]: { profile: 'work', project: 'does-not-exist' } });
    await store.set('work', s.token(['projects:read']));

    const context = await sessionContext({ cwd, dataDir, store });

    expect(context).toContain('was not found on the server');
    expect(context.length).toBeLessThanOrEqual(4096);
    expectGoldenRules(context);
  });
});

describe('sessionContext — server down / unreachable', () => {
  it('reports a one-line unreachable status instead of throwing, via a rejecting fetchImpl', async () => {
    saveProfiles(dataDir, { default: 'work', profiles: { work: { url: 'http://127.0.0.1:1' } } });
    saveBindings(dataDir, { [cwd]: { profile: 'work', project: 'acme' } });
    await store.set('work', 'fake-token');

    const failingFetch: typeof fetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    const context = await sessionContext({ cwd, dataDir, store, fetchImpl: failingFetch });

    expect(context).toContain('is unreachable right now');
    expect(context.length).toBeLessThanOrEqual(4096);
    expectGoldenRules(context);
  });

  it('respects the timeout and never hangs, via a never-resolving fetchImpl', async () => {
    saveProfiles(dataDir, { default: 'work', profiles: { work: { url: s.url } } });
    saveBindings(dataDir, { [cwd]: { profile: 'work', project: 'acme' } });
    await store.set('work', s.token(['projects:read']));

    const hangingFetch: typeof fetch = () => new Promise(() => {}); // never resolves
    const start = Date.now();
    const context = await sessionContext({ cwd, dataDir, store, fetchImpl: hangingFetch, timeoutMs: 50 });
    expect(Date.now() - start).toBeLessThan(2000);

    expect(context).toContain('is unreachable right now');
    expectGoldenRules(context);
  });

  it('caps a caller-supplied timeoutMs at 4000ms — it can shrink the budget but never grow it (Fix round 2 N5)', async () => {
    saveProfiles(dataDir, { default: 'work', profiles: { work: { url: s.url } } });
    saveBindings(dataDir, { [cwd]: { profile: 'work', project: 'acme' } });
    await store.set('work', s.token(['projects:read']));

    const hangingFetch: typeof fetch = () => new Promise(() => {}); // never resolves
    const start = Date.now();
    // Asking for a 10s budget must still give up at the spec's hard 4s ceiling, not wait the full 10s.
    const context = await sessionContext({ cwd, dataDir, store, fetchImpl: hangingFetch, timeoutMs: 10_000 });
    expect(Date.now() - start).toBeLessThan(4500);

    expect(context).toContain('is unreachable right now');
    expectGoldenRules(context);
  });

  // Fake timers + a settled-flag instead of wall-clock bounds (Task 9 fix round 1): the assertions
  // are about *when, on the budget's own clock,* the call gives up — immune to machine load.
  async function settledFlag<T>(p: Promise<T>): Promise<{ done: () => boolean; value: Promise<T> }> {
    let settled = false;
    const value = p.finally(() => {
      settled = true;
    });
    await Promise.resolve();
    return { done: () => settled, value };
  }

  it('a slow store.get eats into the same shared budget the fetch would otherwise get (Fix round 1 Minor #10)', async () => {
    saveProfiles(dataDir, { default: 'work', profiles: { work: { url: s.url } } });
    saveBindings(dataDir, { [cwd]: { profile: 'work', project: 'acme' } });
    const events: string[] = [];
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const slowStore: TokenStore = {
        get: () => {
          events.push('store.get');
          return new Promise((resolve) => setTimeout(() => resolve('a-token'), 300));
        },
        set: async () => {},
        delete: async () => {},
      };
      const hangingFetch: typeof fetch = () => {
        events.push('fetch');
        return new Promise(() => {}); // never resolves
      };
      const run = await settledFlag(sessionContext({ cwd, dataDir, store: slowStore, fetchImpl: hangingFetch, timeoutMs: 500 }));
      await vi.advanceTimersByTimeAsync(300); // store.get resolves; the fetch starts with 200ms left
      expect(events).toEqual(['store.get', 'fetch']);
      await vi.advanceTimersByTimeAsync(199);
      expect(run.done()).toBe(false);
      // At 500ms total the shared budget is spent. (Separate budgets would wait until 800ms.)
      await vi.advanceTimersByTimeAsync(1);
      expect(run.done()).toBe(true);
      const context = await run.value;
      expect(context).toContain('is unreachable right now');
      expectGoldenRules(context);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a slow/hanging ensureDeps also draws down the same shared budget', async () => {
    saveProfiles(dataDir, { default: 'work', profiles: { work: { url: s.url } } });
    const events: string[] = [];
    const recordingStore: TokenStore = {
      get: async (profile) => {
        events.push('store.get');
        return store.get(profile);
      },
      set: (p, t) => store.set(p, t),
      delete: (p) => store.delete(p),
    };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const run = await settledFlag(
        sessionContext({
          cwd,
          dataDir,
          store: recordingStore,
          timeoutMs: 60,
          ensureDeps: () => {
            events.push('ensureDeps');
            return new Promise(() => {}); // never resolves
          },
        }),
      );
      await vi.advanceTimersByTimeAsync(59);
      expect(run.done()).toBe(false);
      expect(events).toEqual(['ensureDeps']);
      await vi.advanceTimersByTimeAsync(1);
      expect(run.done()).toBe(true);
      expect(events).toEqual(['ensureDeps', 'store.get']);
      expectGoldenRules(await run.value);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('sessionContext — never throws', () => {
  it('falls back to a one-line status when the token store itself throws', async () => {
    const throwingStore: TokenStore = {
      get: () => {
        throw new Error('keychain unavailable');
      },
      set: async () => {},
      delete: async () => {},
    };
    saveProfiles(dataDir, { default: 'work', profiles: { work: { url: s.url } } });
    const context = await sessionContext({ cwd, dataDir, store: throwingStore });
    expect(context).toContain('session context unavailable');
    expect(context).toContain('keychain unavailable');
    expect(context.length).toBeLessThanOrEqual(4096);
    expectGoldenRules(context);
  });

  it('never throws even when ensureDeps rejects', async () => {
    const context = await sessionContext({
      cwd,
      dataDir,
      store,
      ensureDeps: async () => {
        throw new Error('npm install failed');
      },
    });
    expect(context).toContain('no server configured');
    expectGoldenRules(context);
  });

  it('calls ensureDeps when provided, before building context', async () => {
    let called = false;
    await sessionContext({
      cwd,
      dataDir,
      store,
      ensureDeps: () => {
        called = true;
      },
    });
    expect(called).toBe(true);
  });
});
