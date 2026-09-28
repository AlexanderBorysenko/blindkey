import { spawn as defaultSpawn } from 'node:child_process';

export interface SpawnSpec {
  cmd: string;
  args: string[];
}

/** The platform-specific way to open a URL in the default browser (spec §2.3). */
export function browserSpawnSpec(url: string, platform: NodeJS.Platform): SpawnSpec {
  if (platform === 'darwin') return { cmd: 'open', args: [url] };
  // `start` treats its first quoted argument as the window title, so an empty title must be passed
  // explicitly or `start` would otherwise treat the url itself as the title and fail to open it.
  if (platform === 'win32') return { cmd: 'cmd', args: ['/c', 'start', '""', url] };
  return { cmd: 'xdg-open', args: [url] };
}

/**
 * Opens `url` in the platform's default browser, best-effort (spec §2.3): spawned detached and
 * unref'd so it never keeps the CLI process alive, stdio ignored, and any failure to spawn (missing
 * `xdg-open` on a headless box, etc.) is swallowed — the caller has already printed the url and code
 * for the user to use manually. Returns the spawn spec so callers/tests can assert on it without
 * actually needing a browser to be present.
 */
export function openBrowser(
  url: string,
  platform: NodeJS.Platform = process.platform,
  spawnImpl: typeof defaultSpawn = defaultSpawn,
): SpawnSpec {
  const spec = browserSpawnSpec(url, platform);
  try {
    const child = spawnImpl(spec.cmd, spec.args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {
      // best-effort: the user can still open the printed url manually
    });
    child.unref();
  } catch {
    // best-effort: spawnImpl itself threw synchronously (e.g. command not found on some platforms)
  }
  return spec;
}
