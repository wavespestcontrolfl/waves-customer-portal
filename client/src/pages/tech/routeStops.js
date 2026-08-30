// Visit-group stops for the tech route (visit-group-scope.md §3).
// The schedule feed attaches a shared `visit` summary to every row that
// belongs to a visit group; rows without one are their own stop. Pure —
// unit-tested without React.
export const TERMINAL_STATUSES = new Set(['completed', 'skipped', 'cancelled', 'no_show']);

function stopKeyOf(service) {
  return service && service.visit && service.visit.id ? `visit:${service.visit.id}` : `row:${service.id}`;
}

/**
 * Group a tech's services into stops, preserving the feed order of first
 * appearance. Each stop: { key, isVisit, services, primary, liveCount }.
 * `primary` = the first non-terminal member (the row the En Route / On Site
 * taps act on; the server fans out to the siblings), else the first member.
 */
export function groupServicesIntoStops(services) {
  const order = [];
  const byKey = new Map();
  (services || []).forEach((s) => {
    if (!s || !s.id) return;
    const key = stopKeyOf(s);
    if (!byKey.has(key)) { byKey.set(key, []); order.push(key); }
    byKey.get(key).push(s);
  });
  return order.map((key) => {
    const members = byKey.get(key);
    const live = members.filter((m) => !TERMINAL_STATUSES.has(m.status));
    return {
      key,
      isVisit: key.startsWith('visit:') && members.length > 1,
      services: members,
      primary: live[0] || members[0],
      liveCount: live.length,
    };
  });
}

/** First stop with any non-terminal member — the tech's next stop. */
export function nextStopOf(stops) {
  return (stops || []).find((st) => st.liveCount > 0) || null;
}

/**
 * The stop's window = union of the members' windows (the visit parent
 * stores the same union; a 09-10 + 10-11 chain is one 09-11 stop) —
 * codex #3603 r1. Falls back to the primary's own window for a single row.
 */
export function stopWindow(stop) {
  if (!stop) return { windowStart: null, windowEnd: null, windowDisplay: null };
  if (!stop.isVisit) {
    const p = stop.primary || {};
    return { windowStart: p.windowStart || null, windowEnd: p.windowEnd || null, windowDisplay: p.windowDisplay || null };
  }
  const starts = stop.services.map((s) => s.windowStart).filter(Boolean).sort();
  const ends = stop.services.map((s) => s.windowEnd).filter(Boolean).sort();
  return { windowStart: starts[0] || null, windowEnd: ends[ends.length - 1] || null, windowDisplay: null };
}

/**
 * Every member's property alerts, deduplicated by text (two services at
 * one stop can carry different field instructions — codex #3603 r1). Keeps
 * the first object form seen so type-driven accents still apply.
 */
export function stopPropertyAlerts(stop) {
  if (!stop) return [];
  const seen = new Set();
  const out = [];
  stop.services.forEach((s) => {
    (Array.isArray(s.propertyAlerts) ? s.propertyAlerts : []).forEach((a) => {
      const text = typeof a === 'string' ? a : a && a.text;
      if (!text || seen.has(text)) return;
      seen.add(text);
      out.push(a);
    });
  });
  return out;
}

/** "2 services · ~55 min" for a grouped stop; null for a single row. */
export function stopSummaryLabel(stop) {
  if (!stop || !stop.isVisit) return null;
  const minutes = stop.services.reduce((acc, s) => acc + (Number(s.estimatedDuration) || 0), 0);
  const n = stop.services.length;
  return `${n} service${n === 1 ? '' : 's'}${minutes ? ` · ~${minutes} min` : ''}`;
}
