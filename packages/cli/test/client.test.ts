import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ApiError, PidbClient, scopedPath } from '../src/client.js';
import type { PublicProject } from '../src/api-types.js';
import { makeServer, type ServerFixture } from './helpers.js';

let s: ServerFixture;
const client = (token: string) => new PidbClient({ url: s.url, token });

beforeAll(async () => {
  s = await makeServer();
  s.project('acme');
  s.secret('acme', 'DB', [
    { key: 'host', value: 'db.internal' },
    { key: 'password', value: 'hunter2hunter2' },
  ]);
});
afterAll(async () => {
  await s.close();
});

describe('scopedPath', () => {
  it('maps global and project targets', () => {
    expect(scopedPath('global', 'secrets')).toBe('/api/v1/secrets');
    expect(scopedPath('acme', 'docs', '/deploy')).toBe('/api/v1/projects/acme/docs/deploy');
    expect(scopedPath('a b', 'secrets')).toBe('/api/v1/projects/a%20b/secrets');
  });
});

describe('PidbClient', () => {
  it('sends the bearer token and parses JSON', async () => {
    const projects = await client(s.token(['projects:read'])).json<PublicProject[]>('GET', '/api/v1/projects');
    expect(projects.map((p) => p.slug)).toEqual(['acme']);
  });

  it('appends query parameters and skips undefined ones', async () => {
    const res = await client(s.token(['docs:read'])).json<Record<string, unknown>>('GET', '/api/v1/search', {
      query: { q: 'acme', missing: undefined },
    });
    expect(res).toHaveProperty('documents');
  });

  it('returns a raw value for text/plain', async () => {
    const value = await client(s.token(['secrets:reveal'])).text(
      'GET',
      '/api/v1/projects/acme/secrets/DB/fields/password',
    );
    expect(value).toBe('hunter2hunter2');
  });

  it('maps 401 to exit code 3', async () => {
    const err = await client('pidb_nope').json('GET', '/api/v1/projects').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).exitCode).toBe(3);
    expect((err as ApiError).status).toBe(401);
  });

  it('maps 403 to exit code 3 and names the missing scope', async () => {
    const err = await client(s.token(['docs:read'])).json('GET', '/api/v1/projects').catch((e: unknown) => e);
    expect((err as ApiError).exitCode).toBe(3);
    expect((err as ApiError).message).toContain('projects:read');
  });

  it('maps 404 to exit code 4', async () => {
    const err = await client(s.token(['projects:read'])).json('GET', '/api/v1/projects/nope').catch((e: unknown) => e);
    expect((err as ApiError).exitCode).toBe(4);
  });

  it('renders 422 lint findings and unresolved refs', async () => {
    const c = client(s.token(['docs:write', 'docs:read']));
    const lint = await c
      .json('PUT', '/api/v1/projects/acme/docs/notes', {
        body: { title: 'T', category: 'notes', body_md: 'password = hunter2hunter2' },
      })
      .catch((e: unknown) => e);
    expect((lint as ApiError).status).toBe(422);
    expect((lint as ApiError).message).toMatch(/lint/);
    expect((lint as ApiError).message).toMatch(/line 1/);

    const refs = await c
      .json('PUT', '/api/v1/projects/acme/docs/notes', {
        body: { title: 'T', category: 'notes', body_md: 'see {{secret:Missing}}' },
      })
      .catch((e: unknown) => e);
    expect((refs as ApiError).message).toMatch(/\{\{secret:Missing\}\}/);
  });

  it('reports an unreachable server as a generic error', async () => {
    const err = await new PidbClient({ url: 'http://127.0.0.1:1', token: 't' })
      .json('GET', '/api/v1/projects')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as ApiError).exitCode).toBe(1);
    expect((err as Error).message).toMatch(/cannot reach/);
  });

  it('handles 204 responses', async () => {
    const c = client(s.token(['docs:write']));
    await c.json('PUT', '/api/v1/docs/tmp-doc', { body: { title: 'T', category: 'notes', body_md: 'hi' } });
    await expect(c.empty('DELETE', '/api/v1/docs/tmp-doc')).resolves.toBeUndefined();
  });
});
