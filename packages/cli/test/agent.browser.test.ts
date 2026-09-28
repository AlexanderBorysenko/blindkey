import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { browserSpawnSpec, openBrowser } from '../src/agent/browser.js';

function fakeSpawn() {
  const child = new EventEmitter() as EventEmitter & { unref: () => void };
  child.unref = vi.fn();
  return { spawnImpl: vi.fn(() => child), child };
}

describe('browserSpawnSpec', () => {
  it('darwin uses `open`', () => {
    expect(browserSpawnSpec('https://example.com/connect', 'darwin')).toEqual({ cmd: 'open', args: ['https://example.com/connect'] });
  });
  it('win32 uses `cmd /c start "" <url>`', () => {
    expect(browserSpawnSpec('https://example.com/connect', 'win32')).toEqual({
      cmd: 'cmd',
      args: ['/c', 'start', '""', 'https://example.com/connect'],
    });
  });
  it('anything else (linux, etc.) uses `xdg-open`', () => {
    expect(browserSpawnSpec('https://example.com/connect', 'linux')).toEqual({ cmd: 'xdg-open', args: ['https://example.com/connect'] });
    expect(browserSpawnSpec('https://example.com/connect', 'freebsd')).toEqual({ cmd: 'xdg-open', args: ['https://example.com/connect'] });
  });
});

describe('openBrowser', () => {
  it('spawns detached with stdio ignored and unrefs, and returns the spawn spec', () => {
    const { spawnImpl, child } = fakeSpawn();
    const spec = openBrowser('https://example.com/connect', 'darwin', spawnImpl);
    expect(spec).toEqual({ cmd: 'open', args: ['https://example.com/connect'] });
    expect(spawnImpl).toHaveBeenCalledWith('open', ['https://example.com/connect'], { detached: true, stdio: 'ignore' });
    expect(child.unref).toHaveBeenCalled();
  });

  it('swallows an "error" event from the spawned child (e.g. command not found)', () => {
    const { spawnImpl, child } = fakeSpawn();
    expect(() => {
      openBrowser('https://example.com/connect', 'linux', spawnImpl);
      child.emit('error', new Error('ENOENT'));
    }).not.toThrow();
  });

  it('swallows a synchronous throw from spawnImpl itself', () => {
    const spawnImpl = vi.fn(() => {
      throw new Error('boom');
    });
    expect(() => openBrowser('https://example.com/connect', 'win32', spawnImpl as never)).not.toThrow();
  });
});
