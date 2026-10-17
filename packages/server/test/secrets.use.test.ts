import { describe, it, expect } from 'vitest';
import { makeTestApp, auth } from './helpers.js';
import { listAudit } from '../src/repos/audit.js';

const staging = {
  name: 'Staging server',
  description: 'box',
  tags: ['ssh'],
  fields: [
    { key: 'host', value: '10.0.0.1' },
    { key: 'password', value: 'pw-1' },
    { key: 'private_key', value: 'KEYDATA' },
  ],
};

describe('secret use endpoint (spec §1.2)', () => {
  it('returns all field values for secrets:use and writes one secret.used audit row with no values', async () => {
    const t = await makeTestApp();
    t.project('alpha');
    await t.app.inject({ method: 'POST', url: '/api/v1/projects/alpha/secrets', headers: auth(t.token(['secrets:write'])), payload: staging });
    const useToken = auth(t.token(['secrets:use'], ['alpha']));
    const r = await t.app.inject({ method: 'POST', url: '/api/v1/projects/alpha/secrets/Staging%20server/use', headers: useToken, payload: { purpose: 'exec' } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ name: 'Staging server', fields: { host: '10.0.0.1', password: 'pw-1', private_key: 'KEYDATA' }, sensitive: ['password', 'private_key'] });

    const used = listAudit(t.db, { action: 'secret.used' });
    expect(used).toHaveLength(1);
    expect(used[0]?.meta).toEqual({ purpose: 'exec', fields: ['host', 'password', 'private_key'], agent: false });
    expect(JSON.stringify(used[0]?.meta)).not.toContain('pw-1');
    expect(JSON.stringify(used[0]?.meta)).not.toContain('KEYDATA');
  });

  it('agent flag in the audit meta reflects an agent-kind token', async () => {
    const t = await makeTestApp();
    t.project('alpha');
    await t.app.inject({ method: 'POST', url: '/api/v1/projects/alpha/secrets', headers: auth(t.token(['secrets:write'])), payload: staging });
    const agentToken = auth(t.token(['secrets:use'], ['alpha'], 'agent'));
    const r = await t.app.inject({ method: 'POST', url: '/api/v1/projects/alpha/secrets/Staging%20server/use', headers: agentToken, payload: { purpose: 'env' } });
    expect(r.statusCode).toBe(200);
    const used = listAudit(t.db, { action: 'secret.used' });
    expect(used[0]?.meta).toMatchObject({ agent: true });
  });

  it('filters to requested fields only, and audits only the requested keys', async () => {
    const t = await makeTestApp();
    t.project('alpha');
    await t.app.inject({ method: 'POST', url: '/api/v1/projects/alpha/secrets', headers: auth(t.token(['secrets:write'])), payload: staging });
    const useToken = auth(t.token(['secrets:use'], ['alpha']));
    const r = await t.app.inject({
      method: 'POST',
      url: '/api/v1/projects/alpha/secrets/Staging%20server/use',
      headers: useToken,
      payload: { purpose: 'write', fields: ['host', 'password'] },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ name: 'Staging server', fields: { host: '10.0.0.1', password: 'pw-1' }, sensitive: ['password'] });
    const used = listAudit(t.db, { action: 'secret.used' });
    expect(used[0]?.meta).toEqual({ purpose: 'write', fields: ['host', 'password'], agent: false });
  });

  it('unknown field name → 404, no audit row written', async () => {
    const t = await makeTestApp();
    t.project('alpha');
    await t.app.inject({ method: 'POST', url: '/api/v1/projects/alpha/secrets', headers: auth(t.token(['secrets:write'])), payload: staging });
    const useToken = auth(t.token(['secrets:use'], ['alpha']));
    const r = await t.app.inject({
      method: 'POST',
      url: '/api/v1/projects/alpha/secrets/Staging%20server/use',
      headers: useToken,
      payload: { purpose: 'exec', fields: ['nope'] },
    });
    expect(r.statusCode).toBe(404);
    expect(listAudit(t.db, { action: 'secret.used' })).toHaveLength(0);
  });

  it('a token without secrets:use or secrets:reveal → 403', async () => {
    const t = await makeTestApp();
    t.project('alpha');
    await t.app.inject({ method: 'POST', url: '/api/v1/projects/alpha/secrets', headers: auth(t.token(['secrets:write'])), payload: staging });
    const metaOnly = auth(t.token(['secrets:meta'], ['alpha']));
    const r = await t.app.inject({ method: 'POST', url: '/api/v1/projects/alpha/secrets/Staging%20server/use', headers: metaOnly, payload: { purpose: 'exec' } });
    expect(r.statusCode).toBe(403);
    expect(r.json().scope).toBe('secrets:use');
  });

  it('a secrets:use-only token still gets 403 from the reveal endpoints (Review Focus 1)', async () => {
    const t = await makeTestApp();
    t.project('alpha');
    await t.app.inject({ method: 'POST', url: '/api/v1/projects/alpha/secrets', headers: auth(t.token(['secrets:write'])), payload: staging });
    const useOnly = auth(t.token(['secrets:use'], ['alpha']));
    const fields = await t.app.inject({ method: 'GET', url: '/api/v1/projects/alpha/secrets/Staging%20server/fields', headers: useOnly });
    expect(fields.statusCode).toBe(403);
    const one = await t.app.inject({ method: 'GET', url: '/api/v1/projects/alpha/secrets/Staging%20server/fields/password', headers: useOnly });
    expect(one.statusCode).toBe(403);
  });

  it('a secrets:reveal token may call use too', async () => {
    const t = await makeTestApp();
    t.project('alpha');
    await t.app.inject({ method: 'POST', url: '/api/v1/projects/alpha/secrets', headers: auth(t.token(['secrets:write'])), payload: staging });
    const revealToken = auth(t.token(['secrets:reveal'], ['alpha']));
    const r = await t.app.inject({ method: 'POST', url: '/api/v1/projects/alpha/secrets/Staging%20server/use', headers: revealToken, payload: { purpose: 'exec' } });
    expect(r.statusCode).toBe(200);
    expect(r.json().fields.password).toBe('pw-1');
  });

  it('works on the global secrets base too', async () => {
    const t = await makeTestApp();
    await t.app.inject({ method: 'POST', url: '/api/v1/secrets', headers: auth(t.token(['secrets:write'])), payload: { name: 'GitHub PAT', fields: [{ key: 'token', value: 't1' }] } });
    const useToken = auth(t.token(['secrets:use']));
    const r = await t.app.inject({ method: 'POST', url: '/api/v1/secrets/GitHub%20PAT/use', headers: useToken, payload: { purpose: 'env' } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ name: 'GitHub PAT', fields: { token: 't1' }, sensitive: ['token'] });
  });

  it('rejects an invalid purpose with 400', async () => {
    const t = await makeTestApp();
    t.project('alpha');
    await t.app.inject({ method: 'POST', url: '/api/v1/projects/alpha/secrets', headers: auth(t.token(['secrets:write'])), payload: staging });
    const useToken = auth(t.token(['secrets:use'], ['alpha']));
    const r = await t.app.inject({ method: 'POST', url: '/api/v1/projects/alpha/secrets/Staging%20server/use', headers: useToken, payload: { purpose: 'delete' } });
    expect(r.statusCode).toBe(400);
  });
});
