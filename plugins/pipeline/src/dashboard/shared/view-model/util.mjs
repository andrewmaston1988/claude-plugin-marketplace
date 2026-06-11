// Time formatting shared by every dashboard panel. Previously duplicated
// verbatim in tui/app.mjs (_fmtAge) and the served client JS (fmtAge).
export function fmtAge(iso, now = Date.now()) {
  if (!iso) return "—";
  const diff = now - Date.parse(iso);
  if (isNaN(diff)) return "—";
  const s = Math.round(diff / 1000);
  if (s < 60)    return `${s}s`;
  if (s < 3600)  return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}
