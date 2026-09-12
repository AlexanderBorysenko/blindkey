import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PidbClient } from '../src/client.js';
import { runProjectsGet, runProjectsList, runSearch } from '../src/commands/projects.js';
import type { ProjectDetail, PublicProject } from '../src/api-types.js';
import { makeServer, type ServerFixture } from './helpers.js';

let s: ServerFixture;
const client = (scopes: Parameters<ServerFixture['token']>[0]) => new PidbClient({ url: s.url, token: s.token(scopes) });

beforeAll(async () => {
  s = await makeServer();
  s.project('acme');
  s.project('beta');
  s.doc('acme', 'deploy', 'how to deploy acme');
  s.secret('acme', 'DB', [{ key: 'host', value: 'db.internal' }, { key: 'password', value: 'hunter2hunter2' }]);
});
afterAll(async () => {
  await s.close();
});

describe('projects list', () => {
  it('renders a table of projects', async () => {
    const result = await runProjectsList(client(['projects:read']));
    expect(result.text.split('\n')[0]).toMatch(/^SLUG\s+NAME\s+STATUS\s+TAGS\s+UPDATED$/);
    expect(result.text).toContain('acme');
    expect(result.text).toContain('beta');
    expect((result.json as PublicProject[]).map((p) => p.slug)).toEqual(['acme', 'beta']);
  });

  it('renders just the header when the token can see no projects', async () => {
    const scoped = new PidbClient({ url: s.url, token: s.token(['projects:read'], []) });
    const result = await runProjectsList(scoped);
    expect(result.text.split('\n')).toEqual([
      'SLUG  NAME  STATUS  TAGS  UPDATED',
      '----  ----  ------  ----  -------',
    ]);
    expect(result.json).toEqual([]);
  });
});

describe('projects get', () => {
  it('shows the project with its documents and secret names', async () => {
    const result = await runProjectsGet(client(['projects:read', 'docs:read', 'secrets:meta']), 'acme');
    expect(result.text).toContain('acme');
    expect(result.text).toContain('deploy');
    expect(result.text).toContain('DB');
    const detail = result.json as ProjectDetail;
    expect(detail.documents.map((d) => d.slug)).toEqual(['deploy']);
    expect(detail.secrets[0]!.fields.map((f) => f.key).sort()).toEqual(['host', 'password']);
  });

  it('never prints a sensitive value', async () => {
    const result = await runProjectsGet(client(['projects:read', 'secrets:meta']), 'acme');
    expect(result.text).not.toContain('hunter2hunter2');
    expect(JSON.stringify(result.json)).not.toContain('hunter2hunter2');
  });
});

describe('search', () => {
  it('renders each section the token can see', async () => {
    const result = await runSearch(client(['projects:read', 'docs:read', 'secrets:meta']), 'deploy');
    expect(result.text).toMatch(/documents/i);
    expect(result.text).toContain('deploy');
  });

  it('omits sections the token cannot see', async () => {
    const result = await runSearch(client(['docs:read']), 'deploy');
    expect(result.text).not.toMatch(/secrets/i);
  });

  it('refuses instead of silently reporting nothing found when the token has no search scope', async () => {
    const err = await runSearch(client(['secrets:write']), 'deploy').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as { exitCode?: number }).exitCode).toBe(3);
  });
});
