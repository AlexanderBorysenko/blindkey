import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeTestApp, type TestCtx } from './helpers.js';
import { createAdmin } from '../src/repos/admin.js';
import { hashPassword } from '../src/crypto/passwords.js';
import { createSecret } from '../src/repos/secrets.js';
import { upsertDocument } from '../src/repos/documents.js';
import { getProjectBySlug } from '../src/repos/projects.js';
import { getTotp, openTotpSecret } from '../src/repos/twofactor.js';
import { hotp, stepAt } from '../src/auth/totp.js';

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

let t: TestCtx;
let session: string;
let csrf: string;
const cookies = () => ({ blindkey_session: session });
const get = (url: string) => t.app.inject({ method: 'GET', url, cookies: cookies() });
const post = (url: string, payload: Record<string, unknown>) => t.app.inject({ method: 'POST', url, cookies: cookies(), payload });

export function assertNoInlineCode(html: string, label: string): void {
  expect(html, `${label}: inline <script>`).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
  expect(html, `${label}: on* handler`).not.toMatch(/\son[a-z]+\s*=/i);
  expect(html, `${label}: style attribute`).not.toMatch(/\sstyle\s*=/i);
  expect(html, `${label}: <style> element`).not.toMatch(/<style[\s>]/i);
}

beforeAll(async () => {
  t = await makeTestApp();
  createAdmin(t.db, 'alex', await hashPassword('pw'));
  session = (await t.app.inject({ method: 'POST', url: '/login', payload: { username: 'alex', password: 'pw' } }))
    .cookies.find((c) => c.name === 'blindkey_session')!.value;
  t.project('acme');
  const acme = getProjectBySlug(t.db, 'acme')!.id;
  createSecret(t.db, t.ring, { projectId: acme, name: 'DB', description: '', tags: [], fields: [{ key: 'host', value: 'db' }, { key: 'password', value: 'hunter2hunter2' }] });
  upsertDocument(t.db, { projectId: acme, slug: 'deploy', title: 'Deploy', category: 'deploy', body_md: '# Deploy\n\nRun the steps.' });
  // Hostile Markdown lives in its own doc: its escaped source would otherwise appear in the editor's
  // textarea and in search snippets, where text like " onerror=" is harmless but trips the regexes.
  upsertDocument(t.db, {
    projectId: acme,
    slug: 'evil',
    title: 'Evil',
    category: 'notes',
    body_md: '# Evil\n\n<script>alert(1)</script><img src=x onerror=alert(1)><a href="javascript:alert(1)">x</a><p style="color:red">s</p>',
  });
  csrf = /name="csrf" value="([^"]+)"/.exec((await get('/')).body)![1]!;
});
afterAll(async () => {
  await t.app.close();
});

describe('strict CSP', () => {
  it('sends the exact policy', async () => {
    const res = await get('/');
    expect(res.headers['content-security-policy']).toBe(CSP);
  });

  it('serves app.js with the delegated handlers', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/assets/app.js' });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['content-type'])).toMatch(/javascript/);
    for (const name of ['data-open-dialog', 'data-close-dialog', 'data-open-on-load', 'copy-field', 'hide-field', 'copy-new-token', 'toggle-lock', 'move-up', 'move-down', 'remove-row', 'add-row', 'copy-text', 'htmx.process', 'htmx:afterSwap']) {
      expect(res.body).toContain(name);
    }
  });

  it('renders no inline code on any page', async () => {
    const pages = ['/', '/p/acme', '/p/acme?tab=secrets', '/p/acme/secrets/DB', '/p/acme/secrets/DB/edit', '/p/acme/secrets/new',
      '/p/acme/docs/deploy', '/p/acme/docs/deploy/edit', '/p/acme/docs/new/edit', '/global/docs', '/global/secrets', '/tokens', '/audit', '/search?q=deploy', '/no-such-page'];
    for (const url of pages) assertNoInlineCode((await get(url)).body, url);
    assertNoInlineCode((await t.app.inject({ method: 'GET', url: '/login' })).body, '/login');
    // Validation-error renders that auto-open a dialog
    assertNoInlineCode((await post('/projects', { csrf, slug: 'Bad Slug', name: '' })).body, 'projects error');
    assertNoInlineCode((await post('/tokens', { csrf, name: '' })).body, 'tokens error');
    // One-time token panel
    assertNoInlineCode((await post('/tokens', { csrf, name: 'ci', scopes: 'docs:read' })).body, 'token created');
    // htmx partials
    assertNoInlineCode((await post('/p/acme/secrets/DB/reveal', { csrf, key: 'password' })).body, 'reveal partial');
    assertNoInlineCode((await post('/preview', { csrf, body_md: '<p style="x" onclick="y">z</p>', scope: '/p/acme' })).body, 'preview');

    // 2FA pages, on a separate app instance so the rest of this file keeps a plain,
    // never-enrolled login (existing UI tests log in with a password only).
    const t2 = await makeTestApp();
    try {
      createAdmin(t2.db, 'bob', await hashPassword('pw'));
      const bobLogin = await t2.app.inject({ method: 'POST', url: '/login', payload: { username: 'bob', password: 'pw' } });
      const bobSession = bobLogin.cookies.find((c) => c.name === 'blindkey_session')!.value;
      const bobCookies = { blindkey_session: bobSession };
      const bobHome = await t2.app.inject({ method: 'GET', url: '/', cookies: bobCookies });
      const bobCsrf = /name="csrf" value="([^"]+)"/.exec(bobHome.body)![1]!;

      assertNoInlineCode((await t2.app.inject({ method: 'GET', url: '/settings/2fa', cookies: bobCookies })).body, '/settings/2fa (off)');

      const startRes = await t2.app.inject({ method: 'POST', url: '/settings/2fa/start', cookies: bobCookies, payload: { csrf: bobCsrf } });
      assertNoInlineCode(startRes.body, 'POST /settings/2fa/start');

      const bobTotp = getTotp(t2.db, 1)!;
      const bobCode = hotp(openTotpSecret(t2.ring, bobTotp), stepAt(Date.now()));
      const confirmRes = await t2.app.inject({
        method: 'POST',
        url: '/settings/2fa/confirm',
        cookies: bobCookies,
        payload: { csrf: bobCsrf, code: bobCode },
      });
      assertNoInlineCode(confirmRes.body, 'recovery codes page');

      const secondLogin = await t2.app.inject({ method: 'POST', url: '/login', payload: { username: 'bob', password: 'pw' } });
      const bobChallenge = secondLogin.cookies.find((c) => c.name === 'blindkey_2fa')!.value;
      const challengeRes = await t2.app.inject({ method: 'GET', url: '/login/2fa', cookies: { blindkey_2fa: bobChallenge } });
      assertNoInlineCode(challengeRes.body, '/login/2fa with a live challenge');

      // The "on" state, and the settings error re-render (wrong password).
      const onRes = await t2.app.inject({ method: 'GET', url: '/settings/2fa', cookies: bobCookies });
      expect(onRes.body).toContain('Enabled since');
      assertNoInlineCode(onRes.body, '/settings/2fa (on)');
      const wrongPw = await t2.app.inject({
        method: 'POST',
        url: '/settings/2fa/recovery',
        cookies: bobCookies,
        payload: { csrf: bobCsrf, password: 'not-the-password', code: '000000' },
      });
      expect(wrongPw.statusCode).toBe(400);
      expect(wrongPw.body).toContain('Invalid password or code.');
      assertNoInlineCode(wrongPw.body, 'settings error re-render');
    } finally {
      await t2.app.close();
    }
  });

  it('strips script, handlers, styles and javascript: links from rendered Markdown', async () => {
    const res = await get('/p/acme/docs/evil');
    expect(res.statusCode).toBe(200);
    const main = res.body.split('<main')[1]!.split('</main>')[0]!;
    const article = main.split('<article class="doc">')[1]!.split('</article>')[0]!;
    expect(article).toContain('<h1>Evil</h1>');
    expect(main).not.toContain('alert(1)</script>');
    expect(main).not.toMatch(/onerror/i);
    expect(main).not.toMatch(/javascript:/i);
    expect(main).not.toMatch(/style=/i);
  });

  it('validation-error renders auto-open the dialog (data-open-on-load); normal renders do not', async () => {
    const dialog = (html: string, id: string) => new RegExp(`<dialog[^>]*id="${id}"[^>]*>`).exec(html)![0];
    expect(dialog((await get('/')).body, 'new-project')).not.toContain('data-open-on-load');
    expect(dialog((await get('/tokens')).body, 'new-token')).not.toContain('data-open-on-load');
    expect(dialog((await post('/projects', { csrf, slug: 'Bad Slug', name: '' })).body, 'new-project')).toContain('data-open-on-load');
    expect(dialog((await post('/tokens', { csrf, name: '' })).body, 'new-token')).toContain('data-open-on-load');
  });
});
