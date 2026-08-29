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

/** "2 services · ~55 min" for a grouped stop; null for a single row. */
export function stopSummaryLabel(stop) {
  if (!stop || !stop.isVisit) return null;
  const minutes = stop.services.reduce((acc, s) => acc + (Number(s.estimatedDuration) || 0), 0);
  const n = stop.services.length;
  return `${n} service${n === 1 ? '' : 's'}${minutes ? ` · ~${minutes} min` : ''}`;
}
