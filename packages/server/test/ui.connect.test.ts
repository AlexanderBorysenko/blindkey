import { describe, it, expect } from 'vitest';
import { makeTestApp, sessionFor } from './helpers.js';
import { createAdmin } from '../src/repos/admin.js';
import { hashPassword } from '../src/crypto/passwords.js';

function main(html: string): string {
  return html.split('<main')[1]?.split('</main>')[0] ?? html;
}

async function startConnect(t: Awaited<ReturnType<typeof makeTestApp>>, body: Record<string, unknown> = { name: 'x', scopes: ['projects:read'] }) {
  const res = await t.app.inject({ method: 'POST', url: '/api/v1/connect/start', payload: body });
  return res.json() as { user_code: string; device_code: string };
}

describe('ui connect: GET /connect requires an admin session and preserves next through login', () => {
  it('anonymous GET /connect?code=... redirects to /login?next=<same path+query>', async () => {
    const t = await makeTestApp();
    const { user_code: userCode } = await startConnect(t);
    const res = await t.app.inject({ method: 'GET', url: `/connect?code=${userCode}` });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`/login?next=${encodeURIComponent(`/connect?code=${userCode}`)}`);
  });

  it('GET /login with that next renders it as a hidden field', async () => {
    const t = await makeTestApp();
    const { user_code: userCode } = await startConnect(t);
    const next = `/connect?code=${userCode}`;
    const res = await t.app.inject({ method: 'GET', url: `/login?next=${encodeURIComponent(next)}` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(`name="next" value="${next}"`);
  });

  it('logging in with that next (through the mandatory 2FA step) lands back on /connect?code=...', async () => {
    const t = await makeTestApp();
    createAdmin(t.db, 'alex', await hashPassword('pw'));
    const totp = t.enroll('alex');
    const { user_code: userCode } = await startConnect(t);
    const next = `/connect?code=${userCode}`;
    const res = await t.app.inject({ method: 'POST', url: '/login', payload: { username: 'alex', password: 'pw', next } });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`/login/2fa?next=${encodeURIComponent(next)}`);
    const challengeCookie = res.cookies.find((c) => c.name === 'blindkey_2fa')!.value;
    const finish = await t.app.inject({ method: 'POST', url: '/login/2fa', cookies: { blindkey_2fa: challengeCookie }, payload: { code: totp.code(), next } });
    expect(finish.statusCode).toBe(302);
    expect(finish.headers.location).toBe(next);
    const session = finish.cookies.find((c) => c.name === 'blindkey_session')!.value;
    const page = await t.app.inject({ method: 'GET', url: next, cookies: { blindkey_session: session } });
    expect(page.statusCode).toBe(200);
    expect(main(page.body)).toContain('Connect an agent');
  });

  it('a next pointing off-site or to another path is ignored: login carries no next to the 2FA step', async () => {
    const t = await makeTestApp();
    createAdmin(t.db, 'alex', await hashPassword('pw'));
    t.enroll('alex');
    for (const bad of [
      'https://evil.example.com/connect',
      '//evil.example.com',
      '/\\evil',
      '/tokens',
      '/connectXevil',
      '/connect?code=A\x7f', // DEL — printable-ASCII check must reject it, not 500 on the redirect
      '/connect?code=Aÿ', // above 0xff
    ]) {
      const res = await t.app.inject({ method: 'POST', url: '/login', payload: { username: 'alex', password: 'pw', next: bad } });
      expect(res.statusCode, bad).toBe(302);
      // 2FA is mandatory, so the password step always goes to the challenge; an unsafe next must not be carried along.
      expect(res.headers.location, bad).toBe('/login/2fa');
    }
  });

  it('with 2FA on, next survives through the /login/2fa challenge and back', async () => {
    const t = await makeTestApp();
    createAdmin(t.db, 'alex', await hashPassword('pw'));
    const totp = t.enroll('alex');

    const { user_code: userCode } = await startConnect(t);
    const next = `/connect?code=${userCode}`;

    const loginRes = await t.app.inject({ method: 'POST', url: '/login', payload: { username: 'alex', password: 'pw', next } });
    expect(loginRes.statusCode).toBe(302);
    expect(loginRes.headers.location).toBe(`/login/2fa?next=${encodeURIComponent(next)}`);
    const challengeCookie = loginRes.cookies.find((c) => c.name === 'blindkey_2fa')!.value;

    const getChallenge = await t.app.inject({ method: 'GET', url: `/login/2fa?next=${encodeURIComponent(next)}`, cookies: { blindkey_2fa: challengeCookie } });
    expect(getChallenge.body).toContain(`name="next" value="${next}"`);

    const code = totp.code(1);
    const finish = await t.app.inject({ method: 'POST', url: '/login/2fa', cookies: { blindkey_2fa: challengeCookie }, payload: { code, next } });
    expect(finish.statusCode).toBe(302);
    expect(finish.headers.location).toBe(next);
  });
});

describe('ui connect: the approve page', () => {
  it('unknown, expired or already-decided codes render an error page instead of the form', async () => {
    const t = await makeTestApp();
    createAdmin(t.db, 'alex', await hashPassword('pw'));
    t.enroll('alex');
    const session = sessionFor(t.db, 'alex');

    const res = await t.app.inject({ method: 'GET', url: '/connect?code=ZZZZ-ZZZZ', cookies: { blindkey_session: session } });
    expect(res.statusCode).toBe(200);
    expect(main(res.body)).toContain('invalid, expired, or already used');
  });

  it('only offers AGENT_SCOPES checkboxes (never admin/secrets:reveal/secrets:write), and pre-checks the requested ones', async () => {
    const t = await makeTestApp();
    createAdmin(t.db, 'alex', await hashPassword('pw'));
    t.enroll('alex');
    t.project('alpha');
    t.project('beta');
    const session = sessionFor(t.db, 'alex');

    const { user_code: userCode } = await startConnect(t, { name: 'claude', scopes: ['projects:read', 'docs:read'], projects: ['alpha', 'ghost'] });
    const res = await t.app.inject({ method: 'GET', url: `/connect?code=${userCode}`, cookies: { blindkey_session: session } });
    const body = main(res.body);

    for (const scope of ['admin', 'secrets:reveal', 'secrets:write']) {
      expect(body).not.toContain(`value="${scope}"`);
    }
    expect(body).toContain('value="projects:read" checked');
    expect(body).toContain('value="docs:read" checked');
    expect(body).toContain('value="alpha" checked');
    expect(body).not.toContain('value="beta" checked');
    expect(body).toContain('ghost');
    expect(body).toContain('(unknown)');
  });

  it('requires an admin session (redirects anonymous requests to /login)', async () => {
    const t = await makeTestApp();
    const res = await t.app.inject({ method: 'GET', url: '/connect?code=ZZZZ-ZZZZ' });
    expect(res.statusCode).toBe(302);
  });

  it('shows the user_code with a confirmation hint, and the request age', async () => {
    const t = await makeTestApp();
    createAdmin(t.db, 'alex', await hashPassword('pw'));
    t.enroll('alex');
    const session = sessionFor(t.db, 'alex');
    const { user_code: userCode } = await startConnect(t);

    const res = await t.app.inject({ method: 'GET', url: `/connect?code=${userCode}`, cookies: { blindkey_session: session } });
    const body = main(res.body);
    expect(body).toContain(userCode);
    expect(body).toContain('confirm it matches the code in your terminal');
    expect(body).toMatch(/just now|ago/);
  });

  it('an empty requested-projects list says "pick at least one" rather than "all-project scope"', async () => {
    const t = await makeTestApp();
    createAdmin(t.db, 'alex', await hashPassword('pw'));
    t.enroll('alex');
    const session = sessionFor(t.db, 'alex');
    const { user_code: userCode } = await startConnect(t, { name: 'x', scopes: ['projects:read'], projects: [] });

    const res = await t.app.inject({ method: 'GET', url: `/connect?code=${userCode}`, cookies: { blindkey_session: session } });
    const body = main(res.body);
    expect(body).toContain('none requested — pick at least one');
    expect(body).not.toContain('all-project scope');
  });
});

describe('ui connect: approve/deny outcomes', () => {
  async function loginAndStart(t: Awaited<ReturnType<typeof makeTestApp>>) {
    createAdmin(t.db, 'alex', await hashPassword('pw'));
    t.enroll('alex');
    t.project('alpha');
    const session = sessionFor(t.db, 'alex');
    const page = await t.app.inject({ method: 'GET', url: '/', cookies: { blindkey_session: session } });
    const csrf = /name="csrf" value="([^"]+)"/.exec(page.body)![1]!;
    const { user_code: userCode } = await startConnect(t, { name: 'claude', scopes: ['projects:read'], projects: ['alpha'] });
    return { session, csrf, userCode };
  }

  it('approve redirects to /tokens?done=approved and the tokens page shows the flash', async () => {
    const t = await makeTestApp();
    const { session, csrf, userCode } = await loginAndStart(t);
    const res = await t.app.inject({
      method: 'POST',
      url: '/connect/approve',
      cookies: { blindkey_session: session },
      payload: { csrf, code: userCode, scopes: ['projects:read'], projects: ['alpha'], expires_days: '90' },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/tokens?done=approved');
    const tokens = await t.app.inject({ method: 'GET', url: res.headers.location as string, cookies: { blindkey_session: session } });
    // The flash toast is rendered by the layout outside <main> (spec: same mechanism as
    // done=saved/revoked elsewhere), so it's checked against the full body, not the main() slice.
    expect(tokens.body).toContain('class="toast"');
    expect(tokens.body).toContain('Approved');
  });

  it('deny redirects to /tokens?done=denied and the tokens page shows the flash', async () => {
    const t = await makeTestApp();
    const { session, csrf, userCode } = await loginAndStart(t);
    const res = await t.app.inject({
      method: 'POST',
      url: '/connect/deny',
      cookies: { blindkey_session: session },
      payload: { csrf, code: userCode },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/tokens?done=denied');
    const tokens = await t.app.inject({ method: 'GET', url: res.headers.location as string, cookies: { blindkey_session: session } });
    expect(tokens.body).toContain('class="toast"');
    expect(tokens.body).toContain('Denied');
  });

  it('on a validation error, the re-rendered form keeps what the approver ticked, not the original request', async () => {
    const t = await makeTestApp();
    createAdmin(t.db, 'alex', await hashPassword('pw'));
    t.enroll('alex');
    t.project('alpha');
    t.project('beta');
    const session = sessionFor(t.db, 'alex');
    const page = await t.app.inject({ method: 'GET', url: '/', cookies: { blindkey_session: session } });
    const csrf = /name="csrf" value="([^"]+)"/.exec(page.body)![1]!;
    // Requested only projects:read/alpha, but the approver ticks docs:read/beta and drops all
    // projects (triggering the "at least one project" validation error).
    const { user_code: userCode } = await startConnect(t, { name: 'claude', scopes: ['projects:read'], projects: ['alpha'] });

    const res = await t.app.inject({
      method: 'POST',
      url: '/connect/approve',
      cookies: { blindkey_session: session },
      payload: { csrf, code: userCode, scopes: ['docs:read'], projects: [], expires_days: '30' },
    });
    expect(res.statusCode).toBe(400);
    const body = main(res.body);
    expect(body).toContain('value="docs:read" checked');
    expect(body).not.toContain('value="projects:read" checked');
    expect(body).toContain('value="30"');
  });
});
