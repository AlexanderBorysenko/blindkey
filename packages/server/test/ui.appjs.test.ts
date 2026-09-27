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
  runInNewContext(source, { document, navigator, Element: FakeElement, WeakMap, setTimeout: () => 0 });
  const btn = new FakeElement('BUTTON', 'Copy', { 'data-action': 'copy-text', 'data-copy-target': 'target' });
  listeners.click!({ target: btn });
  expect(copied).toHaveLength(1);
  return copied[0]!;
}

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
