export interface SecretRef {
  raw: string;
  /** Project slug for cross-project refs; null for same-project or global refs. */
  project: string | null;
  global: boolean;
  name: string;
}

const REF_RE = /\{\{\s*secret:([^}]*?)\s*\}\}/g;

export function parseSecretRefs(md: string): SecretRef[] {
  const out: SecretRef[] = [];
  const seen = new Set<string>();
  for (const m of md.matchAll(REF_RE)) {
    const target = (m[1] ?? '').trim();
    if (!target) continue;
    let ref: SecretRef;
    const slash = target.indexOf('/');
    if (slash === -1) {
      ref = { raw: m[0], project: null, global: false, name: target };
    } else {
      const scope = target.slice(0, slash).trim();
      const name = target.slice(slash + 1).trim();
      if (!scope || !name) continue;
      ref =
        scope === 'global'
          ? { raw: m[0], project: null, global: true, name }
          : { raw: m[0], project: scope, global: false, name };
    }
    const key = `${ref.global ? 'global' : (ref.project ?? '')}/${ref.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}
