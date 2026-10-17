import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { runInNewContext } from 'node:vm';
import { makeTestApp, type TestCtx } from './helpers.js';

// Executes the served app.js against a tiny fake DOM: only what the copy-text action touches.
class FakeElement {
  constructor(
    public tagName: string,
    public textContent: string,
    private attrs: Record<string, string> = {},
    private items: FakeElement[] = [],
  ) {}
  getAttribute(name: string): string | null { return this.attrs[name] ?? null; }
  closest(sel: string): FakeElement | null { return sel === '[data-action]' && 'data-action' in this.attrs ? this : null; }
  querySelectorAll(sel: string): FakeElement[] { return sel === 'li' ? this.items : []; }
}

let t: TestCtx;
let source = '';
beforeAll(async () => {
  t = await makeTestApp();
  source = (await t.app.inject({ method: 'GET', url: '/assets/app.js' })).body;
});
afterAll(async () => {
  await t.app.close();
});

async function copyFrom(target: FakeElement): Promise<string> {
  const listeners: Record<string, (e: unknown) => void> = {};
  const copied: string[] = [];
  const document = {
    addEventListener: (type: string, fn: (e: unknown) => void) => { listeners[type] = fn; },
    getElementById: (id: string) => (id === 'target' ? target : null),
  };
  const navigator = { clipboard: { writeText: (s: string) => { copied.push(s); return Promise.resolve(); } } };
  const location = { search: '', pathname: '/', hash: '' };
  const history = { state: null, replaceState: () => {} };
  runInNewContext(source, { document, navigator, location, history, URLSearchParams, Element: FakeElement, WeakMap, setTimeout: () => 0 });
  const btn = new FakeElement('BUTTON', 'Copy', { 'data-action': 'copy-text', 'data-copy-target': 'target' });
  listeners.click!({ target: btn });
  expect(copied).toHaveLength(1);
  return copied[0]!;
}

describe('app.js strips ?done= on load', () => {
  function run(url: string): Array<{ state: unknown; url: string }> {
    const loc = new URL(url);
    const location = { search: loc.search, pathname: loc.pathname, hash: loc.hash };
    const replaced: Array<{ state: unknown; url: string }> = [];
    const history = {
      state: { some: 1 },
      replaceState: (state: unknown, _title: string, next: string) => { replaced.push({ state, url: next }); },
    };
    const document = { addEventListener: () => {} };
    runInNewContext(source, { document, location, history, URLSearchParams, navigator: {}, Element: FakeElement, WeakMap, setTimeout: () => 0 });
    return replaced;
  }

  it('removes only the done param, keeping other params and the hash', () => {
    const replaced = run('http://x/p/acme?tab=secrets&done=saved#frag');
    expect(replaced).toEqual([{ state: { some: 1 }, url: '/p/acme?tab=secrets#frag' }]);
  });

  it('collapses to a bare path when done was the only param', () => {
    const replaced = run('http://x/tokens?done=revoked');
    expect(replaced).toEqual([{ state: { some: 1 }, url: '/tokens' }]);
  });

  it('leaves the URL alone when there is no done param', () => {
    expect(run('http://x/tokens?tab=secrets')).toHaveLength(0);
    expect(run('http://x/tokens')).toHaveLength(0);
  });
});

describe('app.js copy-text', () => {
  it('copies a list (OL/UL) as its items, one per line', async () => {
    const items = ['abcde-fghjk', 'mnpqr-stuvw'].map((c) => new FakeElement('LI', c));
    expect(await copyFrom(new FakeElement('OL', 'abcde-fghjkmnpqr-stuvw', {}, items))).toBe('abcde-fghjk\nmnpqr-stuvw');
    expect(await copyFrom(new FakeElement('UL', 'abcde-fghjkmnpqr-stuvw', {}, items))).toBe('abcde-fghjk\nmnpqr-stuvw');
  });

  it('copies any other element as its textContent', async () => {
    expect(await copyFrom(new FakeElement('CODE', 'ABCD EFGH'))).toBe('ABCD EFGH');
  });
});
