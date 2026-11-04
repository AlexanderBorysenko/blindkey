import type { CliConfig } from './config.js';
import { CliError, EXIT_AUTH, EXIT_GENERIC, EXIT_NOT_FOUND } from './errors.js';

export interface ApiErrorBody {
  error: string;
  message?: string;
  [key: string]: unknown;
}

function exitCodeFor(status: number): number {
  if (status === 401 || status === 403) return EXIT_AUTH;
  if (status === 404) return EXIT_NOT_FOUND;
  return EXIT_GENERIC;
}

function describeError(status: number, body: ApiErrorBody): string {
  if (status === 401 && body.error === 'token_expired') return 'token expired — run `blindkey login <url>` again';
  const head = body.message && body.message !== body.error ? `${body.error}: ${body.message}` : body.error;
  const lines = [`${head} (HTTP ${status})`];
  if (typeof body.scope === 'string') lines.push(`  required scope: ${body.scope}`);
  if (Array.isArray(body.findings)) {
    for (const f of body.findings) {
      const finding = f as { line?: number; reason?: string };
      lines.push(`  line ${finding.line ?? '?'}: ${finding.reason ?? 'possible secret value'}`);
    }
    lines.push('  re-run with --force to save anyway');
  }
  if (Array.isArray(body.unresolved)) {
    lines.push(`  unresolved refs: ${body.unresolved.join(', ')}`);
    lines.push('  re-run with --force to save anyway');
  }
  if (Array.isArray(body.issues)) {
    for (const i of body.issues) {
      const issue = i as { path?: unknown[]; message?: string };
      const path = (issue.path ?? []).join('.') || '(root)';
      lines.push(`  ${path}: ${issue.message ?? 'invalid'}`);
    }
    if (status === 400 && body.issues.some((i) => (i as { message?: string }).message === 'workspace required')) {
      lines.push('  you can see several workspaces — name one with the target `global@<workspace-slug>` (list them with `blindkey workspaces`)');
    }
  }
  return lines.join('\n');
}

export class ApiError extends CliError {
  constructor(
    public readonly status: number,
    public readonly body: ApiErrorBody,
  ) {
    super(describeError(status, body), exitCodeFor(status));
    this.name = 'ApiError';
  }
}

export interface RequestOptions {
  body?: unknown;
  accept?: string;
  query?: Record<string, string | number | undefined>;
}

export function seg(value: string): string {
  return encodeURIComponent(value);
}

/**
 * Same pattern as `slugSchema` in @blindkey/shared. Duplicated on purpose: importing the zod schema
 * would bundle all of zod into the plugin hook (67 KB -> 757 KB); client.test.ts pins the two together.
 */
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export type Target = { kind: 'project'; slug: string } | { kind: 'global'; workspace: string | null };

/** `<target>`: a project slug, `global` (workspace inferred) or `global@<workspace-slug>`. */
export function parseTarget(raw: string): Target {
  if (raw !== 'global' && !raw.startsWith('global@')) return { kind: 'project', slug: raw };
  if (raw === 'global') return { kind: 'global', workspace: null };
  const workspace = raw.slice('global@'.length);
  if (!SLUG_RE.test(workspace)) {
    throw new CliError(
      `invalid target "${raw}" — expected \`global@<workspace-slug>\` (lowercase letters, digits, dashes); list workspaces with \`blindkey workspaces\``,
    );
  }
  return { kind: 'global', workspace };
}

/**
 * `global` / `global@<ws>` target the top-level collection (with `?workspace=` when named); anything
 * else is a project slug. `defaultWorkspace` fills in a bare `global` (see `BlindkeyClient.scoped`).
 */
export function scopedPath(target: string, kind: 'secrets' | 'docs', rest = '', defaultWorkspace?: string): string {
  const t = parseTarget(target);
  if (t.kind === 'project') return `/api/v1/projects/${seg(t.slug)}/${kind}${rest}`;
  const workspace = t.workspace ?? defaultWorkspace;
  return `/api/v1/${kind}${rest}${workspace ? `?workspace=${seg(workspace)}` : ''}`;
}

export interface ClientOptions {
  /** Workspace for a bare `global` target (e.g. the bound project's); undefined = let the server decide. */
  defaultWorkspace?: () => Promise<string | undefined>;
}

/** `scopedPath` with the client's default workspace applied to a bare `global` target. */
export async function scopedFor(client: BlindkeyClient, target: string, kind: 'secrets' | 'docs', rest = ''): Promise<string> {
  return scopedPath(target, kind, rest, target === 'global' ? await client.defaultWorkspace() : undefined);
}

export class BlindkeyClient {
  constructor(
    private readonly config: CliConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly options: ClientOptions = {},
  ) {}

  /** The workspace a bare `global` resolves to client-side, if any. */
  async defaultWorkspace(): Promise<string | undefined> {
    return this.options.defaultWorkspace ? await this.options.defaultWorkspace() : undefined;
  }

  get url(): string {
    return this.config.url;
  }

  private target(path: string, query: RequestOptions['query']): string {
    const u = new URL(this.config.url + path);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) u.searchParams.set(key, String(value));
    }
    return u.toString();
  }

  private async send(method: string, path: string, opts: RequestOptions = {}): Promise<Response> {
    const headers: Record<string, string> = { accept: opts.accept ?? 'application/json' };
    if (this.config.token) headers.authorization = `Bearer ${this.config.token}`;
    if (opts.body !== undefined) headers['content-type'] = 'application/json';

    let res: Response;
    try {
      res = await this.fetchImpl(this.target(path, opts.query), {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new CliError(`cannot reach ${this.config.url}: ${reason}`);
    }

    if (!res.ok) {
      const text = await res.text();
      let body: ApiErrorBody = { error: 'http_error', message: text.slice(0, 500) };
      try {
        const parsed = JSON.parse(text) as unknown;
        if (parsed && typeof parsed === 'object' && typeof (parsed as ApiErrorBody).error === 'string') {
          body = parsed as ApiErrorBody;
        }
      } catch {
        // keep the raw-text fallback
      }
      throw new ApiError(res.status, body);
    }
    return res;
  }

  async json<T>(method: string, path: string, opts?: RequestOptions): Promise<T> {
    const res = await this.send(method, path, opts);
    return (await res.json()) as T;
  }

  /** Same as json(), but keeps the status code — `PUT /docs/:doc` answers 201 on create and 200 on update. */
  async jsonStatus<T>(method: string, path: string, opts?: RequestOptions): Promise<{ status: number; data: T }> {
    const res = await this.send(method, path, opts);
    return { status: res.status, data: (await res.json()) as T };
  }

  async text(method: string, path: string, opts?: RequestOptions): Promise<string> {
    const res = await this.send(method, path, { ...opts, accept: 'text/plain' });
    return await res.text();
  }

  async empty(method: string, path: string, opts?: RequestOptions): Promise<void> {
    await this.send(method, path, opts);
  }
}
