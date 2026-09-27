import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeServer, runCliAsync } from './helpers.js';
import { startEnrollment, confirmEnrollment } from '../../server/src/services/twofactor.js';
import { getTotp, openTotpSecret } from '../../server/src/repos/twofactor.js';
import { hotp, stepAt } from '../../server/src/auth/totp.js';
import type { Actor } from '../../server/src/auth/principal.js';
import type { AppContext } from '../../server/src/http/context.js';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const baseEnv = (dir: string) => ({ PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', PIDB_CONFIG_HOME: dir });

/**
 * `pidb login` reads its prompts from real stdin (packages/cli/src/prompt.ts),
 * not the injectable `LoginIo` used by login.test.ts. These tests spawn the
 * actual CLI with a piped, non-TTY stdin carrying several newline-separated
 * answers, to exercise the shared line reader end to end — the bug this
 * guards against only reproduces across a real process boundary with a real
 * pipe, never via the in-process `io` fixture.
 */
describe('pidb login — piped (non-interactive) stdin', () => {
  it('answers a piped username + password prompt sequence (no 2FA)', async () => {
    const s = await makeServer();
    try {
      await s.admin('alex', 'correct horse battery');
      const dir = mkdtempSync(join(tmpdir(), 'pidb-piped-'));
      const r = await runCliAsync(['login', s.url], baseEnv(dir), repoRoot, 'alex\ncorrect horse battery\n');
      expect(r.status).toBe(0);
      const saved = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as { token: string };
      expect(saved.token).toMatch(/^pidb_/);
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

      const dir = mkdtempSync(join(tmpdir(), 'pidb-piped-2fa-'));
      const r = await runCliAsync(['login', s.url], baseEnv(dir), repoRoot, `jo\ncorrect horse battery\n${code}\n`);
      expect(r.status).toBe(0);
      const saved = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as { token: string };
      expect(saved.token).toMatch(/^pidb_/);
      expect(r.stdout).not.toContain('correct horse battery');
      expect(r.stdout).not.toContain(code);
      expect(r.stderr).not.toContain('correct horse battery');
      expect(r.stderr).not.toContain(code);
    } finally {
      await s.close();
    }
  });
});
