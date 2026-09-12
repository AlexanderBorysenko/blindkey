import { describe, it, expect } from 'vitest';
import { makeTestApp, auth } from './helpers.js';
import { listAudit } from '../src/repos/audit.js';

const staging = { name: 'Staging server', description: 'box', tags: ['ssh'], fields: [{ key: 'host', value: '10.0.0.1' }, { key: 'password', value: 'pw-1' }, { key: 'private_key', value: 'KEYDATA' }] };

describe('secrets routes', () => {
  it('creates and lists meta without sensitive values', async () => {
    const t = await makeTestApp();
    t.project('alpha');
    const w = auth(t.token(['secrets:write', 'secrets:meta'], ['alpha']));
    const c = await t.app.inject({ method: 'POST', url: '/api/v1/projects/alpha/secrets', headers: w, payload: staging });
    expect(c.statusCode).toBe(201);
    expect(c.json().fields).toEqual([{ key: 'host', sensitive: false, value: '10.0.0.1' }, { key: 'password', sensitive: true }, { key: 'private_key', sensitive: true }]);
    expect(JSON.stringify(c.json())).not.toContain('pw-1');
    const l = await t.app.inject({ method: 'GET', url: '/api/v1/projects/alpha/secrets', headers: w });
    expect(l.json()).toHaveLength(1);
    const one = await t.app.inject({ method: 'GET', url: '/api/v1/projects/alpha/secrets/Staging%20server', headers: w });
    expect(one.json().name).toBe('Staging server');
    expect((await t.app.inject({ method: 'POST', url: '/api/v1/projects/alpha/secrets', headers: w, payload: staging })).statusCode).toBe(409);
    expect((await t.app.inject({ method: 'POST', url: '/api/v1/projects/alpha/secrets', headers: w, payload: { name: 'x', fields: [{ key: 'port', value: 22 }] } })).statusCode).toBe(400);
  });
  it('reveals a sensitive field only with secrets:reveal and audits it', async () => {
    const t = await makeTestApp();
    t.project('alpha');
    await t.app.inject({ method: 'POST', url: '/api/v1/projects/alpha/secrets', headers: auth(t.token(['secrets:write'])), payload: staging });
    const meta = auth(t.token(['secrets:meta'], ['alpha']));
    const reveal = auth(t.token(['secrets:reveal', 'secrets:meta'], ['alpha']));
    const denied = await t.app.inject({ method: 'GET', url: '/api/v1/projects/alpha/secrets/Staging%20server/fields/password', headers: meta });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().scope).toBe('secrets:reveal');
    const host = await t.app.inject({ method: 'GET', url: '/api/v1/projects/alpha/secrets/Staging%20server/fields/host', headers: meta });
    expect(host.json()).toEqual({ key: 'host', value: '10.0.0.1' });
    const pw = await t.app.inject({ method: 'GET', url: '/api/v1/projects/alpha/secrets/Staging%20server/fields/password', headers: reveal });
    expect(pw.json()).toEqual({ key: 'password', value: 'pw-1' });
    const plain = await t.app.inject({ method: 'GET', url: '/api/v1/projects/alpha/secrets/Staging%20server/fields/password', headers: { ...reveal, accept: 'text/plain' } });
    expect(plain.headers['content-type']).toContain('text/plain');
    expect(plain.body).toBe('pw-1');
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/projects/alpha/secrets/Staging%20server/fields/nope', headers: reveal })).statusCode).toBe(404);
    const audits = listAudit(t.db, { action: 'secret.reveal' });
    expect(audits).toHaveLength(2);
    expect(audits.map((a) => a.field_key)).toEqual(['password', 'password']);
    expect(audits[0]?.actor_type).toBe('token');
  });
  it('reveals all fields with one audit row per sensitive field', async () => {
    const t = await makeTestApp();
    t.project('alpha');
    await t.app.inject({ method: 'POST', url: '/api/v1/projects/alpha/secrets', headers: auth(t.token(['secrets:write'])), payload: staging });
    const r = await t.app.inject({ method: 'GET', url: '/api/v1/projects/alpha/secrets/Staging%20server/fields', headers: auth(t.token(['secrets:reveal'], ['alpha'])) });
    expect(r.json()).toEqual({ name: 'Staging server', fields: { host: '10.0.0.1', password: 'pw-1', private_key: 'KEYDATA' } });
    expect(listAudit(t.db, { action: 'secret.reveal' }).map((a) => a.field_key).sort()).toEqual(['password', 'private_key']);
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/projects/alpha/secrets/Staging%20server/fields', headers: auth(t.token(['secrets:meta'])) })).statusCode).toBe(403);
  });
  it('updates and deletes with secrets:write, global secrets work', async () => {
    const t = await makeTestApp();
    const w = auth(t.token(['secrets:write', 'secrets:reveal', 'secrets:meta']));
    expect((await t.app.inject({ method: 'POST', url: '/api/v1/secrets', headers: w, payload: { name: 'GitHub PAT', fields: [{ key: 'token', value: 't1' }] } })).statusCode).toBe(201);
    const u = await t.app.inject({ method: 'PATCH', url: '/api/v1/secrets/GitHub%20PAT', headers: w, payload: { fields: [{ key: 'token', value: 't2' }, { key: 'url', value: 'https://github.com' }], description: 'd' } });
    expect(u.statusCode).toBe(200);
    expect(u.json().fields).toEqual([{ key: 'token', sensitive: true }, { key: 'url', sensitive: false, value: 'https://github.com' }]);
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/secrets/GitHub%20PAT/fields/token', headers: w })).json().value).toBe('t2');
    expect((await t.app.inject({ method: 'DELETE', url: '/api/v1/secrets/GitHub%20PAT', headers: w })).statusCode).toBe(204);
    expect((await t.app.inject({ method: 'DELETE', url: '/api/v1/secrets/GitHub%20PAT', headers: w })).statusCode).toBe(404);
    expect(listAudit(t.db, {}).map((a) => a.action)).toEqual(['secret.delete', 'secret.reveal', 'secret.update', 'secret.create']);
  });
  it('returns a decrypt_failed 500 with the secret id and no message when the DEK is corrupted', async () => {
    const t = await makeTestApp();
    t.project('alpha');
    await t.app.inject({ method: 'POST', url: '/api/v1/projects/alpha/secrets', headers: auth(t.token(['secrets:write'])), payload: staging });
    const id = (t.db.prepare(`SELECT id FROM secrets WHERE name = ?`).get('Staging server') as { id: number }).id;
    t.db.prepare(`UPDATE secrets SET dek_wrapped = x'00' WHERE name = ?`).run('Staging server');
    const r = await t.app.inject({ method: 'GET', url: '/api/v1/projects/alpha/secrets/Staging%20server', headers: auth(t.token(['secrets:meta'], ['alpha'])) });
    expect(r.statusCode).toBe(500);
    expect(r.json()).toEqual({ error: 'decrypt_failed', secret_id: id });
  });
  it('requires secrets:meta before revealing whether a field or secret exists', async () => {
    const t = await makeTestApp();
    t.project('alpha');
    await t.app.inject({ method: 'POST', url: '/api/v1/projects/alpha/secrets', headers: auth(t.token(['secrets:write'])), payload: staging });
    const docsOnly = auth(t.token(['docs:read'], ['alpha']));
    const existing = await t.app.inject({ method: 'GET', url: '/api/v1/projects/alpha/secrets/Staging%20server/fields/password', headers: docsOnly });
    expect(existing.statusCode).toBe(403);
    const missing = await t.app.inject({ method: 'GET', url: '/api/v1/projects/alpha/secrets/Nope/fields/password', headers: docsOnly });
    expect(missing.statusCode).toBe(403);
  });
  it('removes a field via PATCH removeFields', async () => {
    const t = await makeTestApp();
    t.project('alpha');
    const w = auth(t.token(['secrets:write', 'secrets:meta'], ['alpha']));
    await t.app.inject({ method: 'POST', url: '/api/v1/projects/alpha/secrets', headers: w, payload: staging });
    const u = await t.app.inject({ method: 'PATCH', url: '/api/v1/projects/alpha/secrets/Staging%20server', headers: w, payload: { removeFields: ['host'] } });
    expect(u.statusCode).toBe(200);
    const meta = await t.app.inject({ method: 'GET', url: '/api/v1/projects/alpha/secrets/Staging%20server', headers: w });
    expect(meta.json().fields.map((f: { key: string }) => f.key)).toEqual(['password', 'private_key']);
  });
  it('rejects PATCH renaming a secret onto an existing name in the same project', async () => {
    const t = await makeTestApp();
    t.project('alpha');
    const w = auth(t.token(['secrets:write', 'secrets:meta'], ['alpha']));
    await t.app.inject({ method: 'POST', url: '/api/v1/projects/alpha/secrets', headers: w, payload: staging });
    await t.app.inject({ method: 'POST', url: '/api/v1/projects/alpha/secrets', headers: w, payload: { name: 'Other', fields: [{ key: 'host', value: 'h' }] } });
    const r = await t.app.inject({ method: 'PATCH', url: '/api/v1/projects/alpha/secrets/Other', headers: w, payload: { name: 'Staging server' } });
    expect(r.statusCode).toBe(409);
  });
  it('hides out-of-scope projects as 404', async () => {
    const t = await makeTestApp();
    t.project('alpha');
    t.project('beta');
    const r = await t.app.inject({ method: 'GET', url: '/api/v1/projects/beta/secrets', headers: auth(t.token(['secrets:meta'], ['alpha'])) });
    expect(r.statusCode).toBe(404);
  });
});
