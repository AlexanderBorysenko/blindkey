import { spawn as defaultSpawn } from 'node:child_process';

export interface SpawnSpec {
  cmd: string;
  args: string[];
}

/**
 * The platform-specific way to open a URL in the default browser (spec §2.3).
 *
 * win32 (fix round 1): deliberately does **not** go through `cmd /c start` — even with `spawn`
 * (no `shell: true`), `cmd.exe` itself re-parses whatever it's handed as a command line and treats
 * `&`, `|`, `%NAME%`, etc. as special, so a hostile/malformed url could still smuggle a second
 * command past `start`'s own quirky argument handling. `rundll32 url.dll,FileProtocolHandler <url>`
 * opens a url the same way Explorer does, without invoking any shell interpreter at all.
 *
 * darwin: `open` is a plain program, not a shell, so `spawn` (no `shell: true`) is already immune to
 * shell-metacharacter injection here; `openBrowser`'s caller additionally only ever calls this with a
 * url that passed strict validation (http(s), matching origin/path/code shape), which can never begin
 * with `-`, so there is no `open`-level flag-injection risk either.
 */
export function browserSpawnSpec(url: string, platform: NodeJS.Platform): SpawnSpec {
  if (platform === 'darwin') return { cmd: 'open', args: [url] };
  if (platform === 'win32') return { cmd: 'rundll32', args: ['url.dll,FileProtocolHandler', url] };
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
