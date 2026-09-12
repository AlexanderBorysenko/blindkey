import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';
import { SECRET_REF_RE, parseSecretRefs } from '@pidb/shared';
import { escapeHtml } from './render.js';

const ALLOWED_TAGS = [
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'blockquote', 'pre', 'code', 'em', 'strong', 'del',
  'ul', 'ol', 'li', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr', 'br', 'span',
];

function refHref(ref: { project: string | null; global: boolean; name: string }, scope: string): string {
  const base = ref.global ? '/global' : ref.project ? `/p/${encodeURIComponent(ref.project)}` : scope;
  return `${base}/secrets/${encodeURIComponent(ref.name)}`;
}

/**
 * Renders a document body. `{{secret:...}}` references become links to the
 * secret's page — the reference text is a NAME, never a value.
 */
export function renderMarkdown(md: string, scope: string): string {
  const refs = new Map(parseSecretRefs(md).map((r) => [r.raw, r]));
  const linked = md.replace(SECRET_REF_RE, (raw: string) => {
    const ref = refs.get(raw);
    if (!ref) return raw;
    return `[${raw}](${refHref(ref, scope)})`;
  });
  const html = marked.parse(linked, { async: false }) as string;
  return sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: { a: ['href', 'title'], code: ['class'], span: ['class'] },
    allowedSchemes: ['http', 'https', 'mailto'],
    disallowedTagsMode: 'escape',
  });
}

export { escapeHtml };
