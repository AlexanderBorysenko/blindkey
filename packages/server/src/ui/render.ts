import { Eta } from 'eta';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ago, iso } from './format.js';

const here = dirname(fileURLToPath(import.meta.url));
/** Templates are copied next to the compiled JS by the build (see package.json "build"). */
export const VIEWS_DIR = join(here, 'views');
export const PUBLIC_DIR = join(here, 'public');

const eta = new Eta({ views: VIEWS_DIR, cache: true, autoEscape: true });

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const fmt = { ago, iso };

export function renderPartial(view: string, data: Record<string, unknown> = {}): string {
  return eta.render(`partials/${view}`, { ...data, fmt });
}

export function renderPage(view: string, data: Record<string, unknown> = {}): string {
  const body = eta.render(view, { ...data, fmt });
  return eta.render('layout', { ...data, fmt, body });
}

/** Everything that is not the JSON API, the MCP endpoint or the health probe. */
export function isUiRequest(url: string): boolean {
  const path = url.split('?')[0] ?? '';
  return !(path.startsWith('/api/') || path === '/mcp' || path === '/health');
}
