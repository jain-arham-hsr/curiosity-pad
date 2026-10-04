// Small helpers with no browser dependencies, so they run under Node tests too.

export const uid = () => crypto.randomUUID();

export function slugify(text) {
  const slug = String(text)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return slug || 'untitled';
}

export function formatDuration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const sameDay = (a, b) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

export function clockTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function shortDate(ts) {
  const d = new Date(ts);
  if (sameDay(d, new Date())) return clockTime(ts);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString([], { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
}

export function stamp(ts) {
  const d = new Date(ts);
  return sameDay(d, new Date()) ? clockTime(ts) : `${shortDate(ts)}, ${clockTime(ts)}`;
}

export function ago(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}
