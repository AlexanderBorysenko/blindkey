import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeServer, runCliAsync, runCliKeepStdinOpen, runCliWithFileStdin } from './helpers.js';
import { startEnrollment, confirmEnrollment } from '../../server/src/services/twofactor.js';
import { getTotp, openTotpSecret } from '../../server/src/repos/twofactor.js';
import { hotp, stepAt } from '../../server/src/auth/totp.js';
import type { Actor } from '../../server/src/auth/principal.js';
import type { AppContext } from '../../server/src/http/context.js';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const baseEnv = (dir: string) => ({ PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', BLINDKEY_CONFIG_HOME: dir });

/**
 * `blindkey login` reads its prompts from real stdin (packages/cli/src/prompt.ts),
 * not the injectable `LoginIo` used by login.test.ts. These tests spawn the
 * actual CLI with a piped, non-TTY stdin carrying several newline-separated
 * answers, to exercise the shared line reader end to end — the bug this
 * guards against only reproduces across a real process boundary with a real
 * pipe, never via the in-process `io` fixture.
 */
describe('blindkey login — piped (non-interactive) stdin', () => {
  it('answers a piped username + password prompt sequence (no 2FA)', async () => {
    const s = await makeServer();
    try {
      await s.admin('alex', 'correct horse battery');
      const dir = mkdtempSync(join(tmpdir(), 'blindkey-piped-'));
      const r = await runCliAsync(['login', s.url], baseEnv(dir), repoRoot, 'alex\ncorrect horse battery\n');
      expect(r.status).toBe(0);
      const saved = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as { token: string };
      expect(saved.token).toMatch(/^bk_/);
      expect(r.stdout).not.toContain('correct horse battery');
      expect(r.stderr).not.toContain('correct horse battery');
    } finally {
      await s.close();
    }
  });

  it('answers a piped username + password + 2FA code prompt sequence, in order', async () => {
    const s = await makeServer();
    try {
      await s.admin('jo', 'correct horse battery');
      const adminId = (s.db.prepare('SELECT id FROM admin WHERE username = ?').get('jo') as { id: number }).id;
      const ctx: AppContext = { db: s.db, ring: s.ring };
      const actor: Actor = { principal: { kind: 'admin', id: adminId, scopes: ['admin'], projectIds: null }, ip: '1.1.1.1', userAgent: 't' };
      startEnrollment(ctx, adminId);
      const enrollSecret = openTotpSecret(s.ring, getTotp(s.db, adminId)!);
      await confirmEnrollment(ctx, actor, hotp(enrollSecret, stepAt(Date.now())));
      const code = hotp(openTotpSecret(s.ring, getTotp(s.db, adminId)!), stepAt(Date.now()) + 1);

      const dir = mkdtempSync(join(tmpdir(), 'blindkey-piped-2fa-'));
      const r = await runCliAsync(['login', s.url], baseEnv(dir), repoRoot, `jo\ncorrect horse battery\n${code}\n`);
      expect(r.status).toBe(0);
      const saved = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as { token: string };
      expect(saved.token).toMatch(/^bk_/);
      expect(r.stdout).not.toContain('correct horse battery');
      expect(r.stdout).not.toContain(code);
      expect(r.stderr).not.toContain('correct horse battery');
      expect(r.stderr).not.toContain(code);
    } finally {
      await s.close();
    }
  });

  it(
    'exits promptly after a successful login even when the caller keeps stdin open',
    async () => {
      // Regression: the shared reader must go idle (paused + unref'd) between
      // prompts, not just once the pipe finally reaches EOF. A caller that
      // holds its end of the pipe open (spawn's default stdio: 'pipe', `docker
      // exec -i`, a CI harness) must still see `blindkey login` exit right after it
      // has every answer it needs.
      const s = await makeServer();
      try {
        await s.admin('robin', 'correct horse battery');
        const dir = mkdtempSync(join(tmpdir(), 'blindkey-piped-keepopen-'));
        const r = await runCliKeepStdinOpen(['login', s.url], baseEnv(dir), repoRoot, 'robin\ncorrect horse battery\n', 5000);
        expect(r.timedOut).toBe(false);
        expect(r.status).toBe(0);
        const saved = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as { token: string };
        expect(saved.token).toMatch(/^bk_/);
      } finally {
        await s.close();
      }
    },
    8000,
  );

  it('logs in with stdin redirected from a file (not a pipe)', async () => {
    // Regression: process.stdin is an fs.ReadStream when redirected from a
    // file (or /dev/null), and unlike a socket/pipe it has no ref()/unref()
    // at runtime, even though NodeJS.ReadStream's type declares both
    // unconditionally. Calling them unguarded throws before any request is
    // sent — this must work exactly like `blindkey login <url> < answers.txt`.
    const s = await makeServer();
    try {
      await s.admin('dana', 'correct horse battery');
      const dir = mkdtempSync(join(tmpdir(), 'blindkey-file-stdin-'));
      const answersFile = join(dir, 'answers.txt');
      writeFileSync(answersFile, 'dana\ncorrect horse battery\n');
      const r = await runCliWithFileStdin(['login', s.url], baseEnv(dir), repoRoot, answersFile);
      expect(r.stderr).not.toContain('TypeError');
      expect(r.status).toBe(0);
      const saved = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as { token: string };
      expect(saved.token).toMatch(/^bk_/);
    } finally {
      await s.close();
    }
  });

  it('fails cleanly (no TypeError) when stdin is /dev/null', async () => {
    // No server interaction is expected here: an empty password from a
    // closed stdin must be rejected before any /auth/token request is made,
    // so this doesn't spend any of the 5/min rate-limit budget on a server.
    const dir = mkdtempSync(join(tmpdir(), 'blindkey-devnull-'));
    const r = await runCliWithFileStdin(['login', 'http://127.0.0.1:1', '--username', 'alex'], baseEnv(dir), repoRoot, '/dev/null');
    expect(r.stderr).not.toContain('TypeError');
    expect(r.stderr).not.toContain('is not a function');
    expect(r.stderr).toContain('username and password are required');
    expect(r.status).not.toBe(0);
  });
});
