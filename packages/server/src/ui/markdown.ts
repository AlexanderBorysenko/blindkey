import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';
import { SECRET_REF_RE, parseSecretRefs } from '@blindkey/shared';

const ALLOWED_TAGS = [
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'blockquote', 'pre', 'code', 'em', 'strong', 'del',
  'ul', 'ol', 'li', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr', 'br', 'span',
];

/**
 * `secretNameSchema` forbids only "/"; `(` `)` `!` `'` `*` are all otherwise
 * legal in a secret name, and `encodeURIComponent` deliberately leaves those
 * five characters unescaped (they're in its "unreserved" set). Left alone,
 * an unescaped `(` or `)` in the encoded name breaks out of a Markdown link
 * destination `(...)`, truncating the href and leaking the remainder as
 * literal text. Percent-encode them too — the path segment still decodes
 * back to the exact same secret name, so the href shape is unchanged.
 */
function encodeSecretName(name: string): string {
  return encodeURIComponent(name).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

function refHref(ref: { project: string | null; global: boolean; name: string }, scope: string): string {
  const base = ref.global ? '/global' : ref.project ? `/p/${encodeURIComponent(ref.project)}` : scope;
  return `${base}/secrets/${encodeSecretName(ref.name)}`;
}

/**
 * The visible link label must stay the literal `{{secret:...}}` text. A `[`,
 * `]` or backtick in the name would otherwise close the Markdown label early
 * (or open a code span), breaking the link or leaking text. Backslash-escape
 * them — CommonMark strips the backslash and renders the original character
 * as plain text, so the label is unaffected once rendered.
 */
function escapeLabel(raw: string): string {
  return raw.replace(/\\/g, '\\\\').replace(/[[\]]/g, '\\$&').replace(/`/g, '\\`');
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
    return `[${escapeLabel(raw)}](${refHref(ref, scope)})`;
  });
  const html = marked.parse(linked, { async: false }) as string;
  return sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: { a: ['href', 'title'], code: ['class'], span: ['class'] },
    allowedSchemes: ['http', 'https', 'mailto'],
    disallowedTagsMode: 'escape',
  });
}
