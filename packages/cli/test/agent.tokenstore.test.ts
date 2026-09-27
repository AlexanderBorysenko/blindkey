import { describe, it, expect } from 'vitest';
import { keyringStore, memoryStore } from '../src/agent/tokenstore.js';
import { CliError } from '../src/errors.js';

describe('memoryStore', () => {
  it('starts empty and get() resolves to null for an unknown profile', async () => {
    const store = memoryStore();
    expect(await store.get('work')).toBeNull();
  });

  it('set/get/delete round-trip', async () => {
    const store = memoryStore();
    await store.set('work', 'pidb_abc123');
    expect(await store.get('work')).toBe('pidb_abc123');
    await store.delete('work');
    expect(await store.get('work')).toBeNull();
  });

  it('accepts a seed map and keeps profiles independent', async () => {
    const store = memoryStore({ work: 'pidb_seed' });
    expect(await store.get('work')).toBe('pidb_seed');
    expect(await store.get('personal')).toBeNull();
    await store.set('personal', 'pidb_other');
    expect(await store.get('work')).toBe('pidb_seed');
  });
});

// keyringStore is only exercised here through an injected loader, so this suite never touches
// the real OS keychain — memoryStore covers actual token-store behavior above.
describe('keyringStore', () => {
  it('surfaces a CliError when @napi-rs/keyring cannot be loaded (neither the data-dir require nor normal resolution work)', async () => {
    const store = keyringStore('/nonexistent/data/dir', () => {
      throw new Error('Cannot find module \'@napi-rs/keyring\'');
    });
    await expect(store.get('work')).rejects.toThrow(CliError);
    await expect(store.get('work')).rejects.toThrow(/no OS credential store available/);
  });

  it('uses the injected loader to talk to a fake Entry class, and never a real keychain', async () => {
    const saved = new Map<string, string>();
    class FakeEntry {
      constructor(
        private service: string,
        private account: string,
      ) {}
      setPassword(pw: string): void {
        saved.set(`${this.service}:${this.account}`, pw);
      }
      getPassword(): string | null {
        return saved.get(`${this.service}:${this.account}`) ?? null;
      }
      deletePassword(): boolean {
        return saved.delete(`${this.service}:${this.account}`);
      }
    }
    const store = keyringStore('/nonexistent/data/dir', () => ({ Entry: FakeEntry }));
    expect(await store.get('work')).toBeNull();
    await store.set('work', 'pidb_fake');
    expect(await store.get('work')).toBe('pidb_fake');
    expect(saved.get('pidb:profile:work')).toBe('pidb_fake');
    await store.delete('work');
    expect(await store.get('work')).toBeNull();
  });
});
