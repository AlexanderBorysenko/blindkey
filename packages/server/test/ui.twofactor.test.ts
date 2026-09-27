import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeTestApp, type TestCtx } from './helpers.js';
import { createAdmin } from '../src/repos/admin.js';
import { hashPassword } from '../src/crypto/passwords.js';
import { getTotp, openTotpSecret, createChallenge, getChallenge } from '../src/repos/twofactor.js';
import { hotp, stepAt } from '../src/auth/totp.js';
import { listAudit } from '../src/repos/audit.js';

let t: TestCtx;
let session = '';
let csrf = '';
let recoveryCodes: string[] = [];
let newRecoveryCodes: string[] = [];

// Counters for R4: how many requests this instance sends to each rate-limited route.
let loginCount = 0;
let login2faCount = 0;

function main(html: string): string {
  return html.split('<main')[1]!.split('</main>')[0]!;
}

async function login(username = 'alex', password = 'pw') {
  loginCount += 1;
  return t.app.inject({ method: 'POST', url: '/login', payload: { username, password } });
}

function login2fa(cookie: string, code: string) {
  login2faCount += 1;
  return t.app.inject({ method: 'POST', url: '/login/2fa', cookies: { pidb_2fa: cookie }, payload: { code } });
}

/** The CSRF token is an HMAC of the session id, so it changes every time `session` is reassigned. */
async function refreshCsrf(): Promise<void> {
  const res = await t.app.inject({ method: 'GET', url: '/', cookies: { pidb_session: session } });
  csrf = /name="csrf" value="([^"]+)"/.exec(res.body)![1]!;
}

/** hotp(secret, stepAt(now) + d): only meaningful for d in {-1, 0, 1}, the verifier's window. */
function codeFor(d: number): string {
  const row = getTotp(t.db, 1)!;
  return hotp(openTotpSecret(t.ring, row), stepAt(Date.now()) + d);
}

beforeAll(async () => {
  t = await makeTestApp();
  createAdmin(t.db, 'alex', await hashPassword('pw'));
});

afterAll(async () => {
  await t.app.close();
  // eslint-disable-next-line no-console
  console.log(`ui.twofactor.test.ts: POST /login x${loginCount}, POST /login/2fa x${login2faCount} (per-instance limit 10/min each)`);
});

describe('ui two-factor', () => {
  it('1. logs in directly with no 2FA enrolled', async () => {
    const res = await login();
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/');
    expect(res.cookies.find((c) => c.name === 'pidb_2fa')).toBeUndefined();
    session = res.cookies.find((c) => c.name === 'pidb_session')!.value;
    expect(session).toBeTruthy();
    await refreshCsrf();
  });

  it('1. shows the enrollment banner on the home page', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/', cookies: { pidb_session: session } });
    const body = main(res.body);
    expect(body).toContain('Two-factor authentication is off');
    expect(body).toContain('href="/settings/2fa"');
  });

  it('1. the sidebar links to /settings/2fa', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/', cookies: { pidb_session: session } });
    const sidebar = res.body.split('<aside')[1]!.split('</aside>')[0]!;
    expect(sidebar).toContain('href="/settings/2fa"');
  });

  it('2. GET /settings/2fa shows Set up two-factor, no-store', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/settings/2fa', cookies: { pidb_session: session } });
    expect(res.statusCode).toBe(200);
    expect(main(res.body)).toContain('Set up two-factor');
    expect(res.headers['cache-control']).toContain('no-store');
  });

  it('2. POST /settings/2fa/start with csrf shows the QR, secret and code input', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/settings/2fa/start', cookies: { pidb_session: session }, payload: { csrf } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<img');
    expect(res.body).toContain('src="data:image/svg+xml;base64,');
    expect(res.body).toMatch(/[A-Z2-7]{4}( [A-Z2-7]{1,4})+/);
    expect(res.body).toContain('name="code"');
  });

  it('2. POST /settings/2fa/start without csrf is rejected', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/settings/2fa/start', cookies: { pidb_session: session }, payload: {} });
    expect(res.statusCode).toBe(403);
  });

  it('3. a pending enrollment still shows the banner and still logs in with no challenge', async () => {
    const home = await t.app.inject({ method: 'GET', url: '/', cookies: { pidb_session: session } });
    expect(main(home.body)).toContain('Two-factor authentication is off');

    const res = await login();
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/');
    expect(res.cookies.find((c) => c.name === 'pidb_2fa')).toBeUndefined();
    session = res.cookies.find((c) => c.name === 'pidb_session')!.value;
    await refreshCsrf();
  });

  it('4. a wrong confirm code is rejected and enrollment stays pending', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/settings/2fa/confirm',
      cookies: { pidb_session: session },
      payload: { csrf, code: '000000' },
    });
    expect(main(res.body)).toContain('Invalid code');
    // Still pending: the settings page still offers setup, not "Enabled since".
    const settings = await t.app.inject({ method: 'GET', url: '/settings/2fa', cookies: { pidb_session: session } });
    expect(main(settings.body)).not.toContain('Enabled since');
  });

  it('4. the right confirm code enables 2FA and shows 10 recovery codes once, no-store', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/settings/2fa/confirm',
      cookies: { pidb_session: session },
      payload: { csrf, code: codeFor(0) },
    });
    expect(res.statusCode).toBe(200);
    const body = main(res.body);
    recoveryCodes = body.match(/[a-hjkmnp-z2-9]{5}-[a-hjkmnp-z2-9]{5}/g) ?? [];
    expect(recoveryCodes).toHaveLength(10);
    expect(res.headers['cache-control']).toContain('no-store');
  });

  it('4. settings now shows Enabled since / unused codes, and the banner is gone', async () => {
    const settings = await t.app.inject({ method: 'GET', url: '/settings/2fa', cookies: { pidb_session: session } });
    expect(main(settings.body)).toContain('Enabled since');
    expect(main(settings.body)).toContain('10 unused recovery codes');
    const home = await t.app.inject({ method: 'GET', url: '/', cookies: { pidb_session: session } });
    expect(main(home.body)).not.toContain('Two-factor authentication is off');
  });

  let challengeCookie = '';

  it('5. POST /login redirects to /login/2fa with a challenge cookie and no session', async () => {
    const res = await login();
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/login/2fa');
    expect(res.cookies.find((c) => c.name === 'pidb_session')).toBeUndefined();
    const chCookie = res.cookies.find((c) => c.name === 'pidb_2fa')!;
    expect(chCookie).toBeTruthy();
    expect(chCookie.path).toBe('/login');
    expect(chCookie.httpOnly).toBe(true);
    challengeCookie = chCookie.value;
  });

  it('5. GET /login/2fa with that cookie shows the code input', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/login/2fa', cookies: { pidb_2fa: challengeCookie } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('name="code"');
    expect(res.body).toContain('autocomplete="one-time-code"');
  });

  it('5. POST /login/2fa with the right code creates a session and audits second_factor totp', async () => {
    const res = await login2fa(challengeCookie, codeFor(1));
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/');
    session = res.cookies.find((c) => c.name === 'pidb_session')!.value;
    expect(session).toBeTruthy();
    const rows = listAudit(t.db, { action: 'auth.login', limit: 1 });
    expect(rows[0]!.meta).toMatchObject({ second_factor: 'totp' });
    await refreshCsrf();
  });

  it('6. replaying the same pidb_2fa cookie after a completed login is rejected', async () => {
    const res = await login2fa(challengeCookie, '123456');
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/login');
    expect(res.cookies.find((c) => c.name === 'pidb_session')).toBeUndefined();
  });

  it('7. a normalized recovery code (uppercase, no dash) logs in and audits recovery_used', async () => {
    const loginRes = await login();
    const ch = loginRes.cookies.find((c) => c.name === 'pidb_2fa')!.value;
    const raw = recoveryCodes[0]!.toUpperCase().replace('-', '');
    const res = await login2fa(ch, raw);
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/');
    session = res.cookies.find((c) => c.name === 'pidb_session')!.value;
    expect(session).toBeTruthy();
    const rows = listAudit(t.db, { action: 'auth.recovery_used', limit: 1 });
    expect(rows).toHaveLength(1);
    await refreshCsrf();
  });

  it('7. the same recovery code cannot be used again on a new challenge', async () => {
    const loginRes = await login();
    const ch = loginRes.cookies.find((c) => c.name === 'pidb_2fa')!.value;
    const raw = recoveryCodes[0]!.toUpperCase().replace('-', '');
    const res = await login2fa(ch, raw);
    expect(res.statusCode).toBe(401);
    expect(main(res.body)).toContain('Invalid code');
  });

  it('8. 5 wrong codes lock the challenge, clear the cookie, and delete the row', async () => {
    const loginRes = await login();
    const ch = loginRes.cookies.find((c) => c.name === 'pidb_2fa')!.value;
    for (let i = 0; i < 4; i++) {
      const res = await login2fa(ch, '000000');
      expect(res.statusCode).toBe(401);
      expect(main(res.body)).toContain('Invalid code');
    }
    const last = await login2fa(ch, '000000');
    expect(last.statusCode).toBe(401);
    expect(main(last.body)).toContain('Too many attempts');
    const cleared = last.cookies.find((c) => c.name === 'pidb_2fa');
    expect(cleared?.value).toBe('');
    expect(getChallenge(t.db, ch)).toBeNull();
  });

  it('9. an already-expired challenge redirects GET /login/2fa to /login', async () => {
    const id = createChallenge(t.db, 1, -1, '', '');
    const res = await t.app.inject({ method: 'GET', url: '/login/2fa', cookies: { pidb_2fa: id } });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  it('10. regenerate rejects a wrong password, leaving codes unchanged', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/settings/2fa/recovery',
      cookies: { pidb_session: session },
      payload: { csrf, password: 'not-the-password', code: recoveryCodes[2] },
    });
    expect(res.statusCode).toBe(400);
    expect(main(res.body)).toContain('Invalid password or code.');
  });

  it('10. regenerate with the right password and a fresh code issues 10 new codes', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/settings/2fa/recovery',
      cookies: { pidb_session: session },
      payload: { csrf, password: 'pw', code: recoveryCodes[2] },
    });
    expect(res.statusCode).toBe(200);
    newRecoveryCodes = main(res.body).match(/[a-hjkmnp-z2-9]{5}-[a-hjkmnp-z2-9]{5}/g) ?? [];
    expect(newRecoveryCodes).toHaveLength(10);
  });

  it('10. an old recovery code no longer works after regeneration', async () => {
    // Exercised via /settings/2fa/recovery's reauth (not a login route) to avoid spending
    // more of the rate-limited /login /login/2fa budget than the case list requires.
    const res = await t.app.inject({
      method: 'POST',
      url: '/settings/2fa/recovery',
      cookies: { pidb_session: session },
      payload: { csrf, password: 'pw', code: recoveryCodes[1] },
    });
    expect(res.statusCode).toBe(400);
    expect(main(res.body)).toContain('Invalid password or code.');
  });

  it('11. disable requires the right password and a fresh code, then removes 2FA', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/settings/2fa/disable',
      cookies: { pidb_session: session },
      payload: { csrf, password: 'pw', code: newRecoveryCodes[0] },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/settings/2fa?done=saved');

    const settings = await t.app.inject({ method: 'GET', url: '/settings/2fa', cookies: { pidb_session: session } });
    expect(main(settings.body)).toContain('Set up two-factor');
    const home = await t.app.inject({ method: 'GET', url: '/', cookies: { pidb_session: session } });
    expect(main(home.body)).toContain('Two-factor authentication is off');
  });

  it('11. login needs no second step once 2FA is off', async () => {
    const res = await login();
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/');
    expect(res.cookies.find((c) => c.name === 'pidb_2fa')).toBeUndefined();
  });

  it('12. GET /login/2fa without any cookie redirects to /login', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/login/2fa' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  it('12. GET /settings/2fa without a session redirects to /login', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/settings/2fa' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/login');
  });
});
