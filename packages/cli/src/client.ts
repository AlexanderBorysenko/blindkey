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
  if (status === 401 && body.error === 'token_expired') return 'token expired — run `pidb login <url>` again';
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

/** `global` targets the top-level collection; anything else is a project slug. */
export function scopedPath(target: string, kind: 'secrets' | 'docs', rest = ''): string {
  const base = target === 'global' ? `/api/v1/${kind}` : `/api/v1/projects/${seg(target)}/${kind}`;
  return `${base}${rest}`;
}

export class PidbClient {
  constructor(
    private readonly config: CliConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

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
