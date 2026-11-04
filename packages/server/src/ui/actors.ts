import type { AppContext } from '../http/context.js';
import type { AuditRow } from '../repos/audit.js';
import { getUserById } from '../repos/admin.js';

export type LabeledAuditRow = AuditRow & { actor_label: string };

/**
 * Adds a human `actor_label` to audit rows: the username for a user, `token #n` for a token, and
 * `as <target> by <super>` for something done while a super user was impersonating.
 */
export function labelActors(ctx: AppContext, rows: AuditRow[]): LabeledAuditRow[] {
  const names = new Map<number, string>();
  const nameOf = (id: number | null): string => {
    if (id === null) return 'unknown';
    let n = names.get(id);
    if (n === undefined) {
      n = getUserById(ctx.db, id)?.username ?? `user #${id}`;
      names.set(id, n);
    }
    return n;
  };
  return rows.map((r) => {
    if (r.actor_type === 'token') return { ...r, actor_label: `token #${r.actor_id ?? '?'}` };
    const by = r.meta?.impersonator;
    const label = typeof by === 'number' ? `as ${nameOf(r.actor_id)} by ${nameOf(by)}` : nameOf(r.actor_id);
    return { ...r, actor_label: label };
  });
}
