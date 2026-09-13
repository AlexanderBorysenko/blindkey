const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function iso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19) + 'Z';
}

function shortDate(ms: number, now: number): string {
  const d = new Date(ms);
  const label = `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
  const sameYear = d.getUTCFullYear() === new Date(now).getUTCFullYear();
  return sameYear ? label : `${label}, ${d.getUTCFullYear()}`;
}

export function ago(ms: number, now = Date.now()): string {
  const diff = now - ms;
  const future = diff < 0;
  const abs = Math.abs(diff);
  const sec = abs / 1000;
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return future ? `in ${min} min` : `${min} min ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return future ? `in ${hours} h` : `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return future ? `in ${days} d` : `${days} d ago`;
  return shortDate(ms, now);
}

export const FLASH_MESSAGES = {
  created: 'Created',
  saved: 'Saved',
  deleted: 'Deleted',
  revoked: 'Token revoked',
} as const;

export function flashFor(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  return Object.prototype.hasOwnProperty.call(FLASH_MESSAGES, raw) ? FLASH_MESSAGES[raw as keyof typeof FLASH_MESSAGES] : null;
}
