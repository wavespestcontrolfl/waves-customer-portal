// Returning-visitor projection for the estimate page (GATE_ESTIMATE_RETURN_VISIT).
//
// Pure: takes the sessionized estimate_views (estimate-engagement-sessions,
// oldest-first, the current open already counted) and the estimate blob, and
// returns the `returnVisit` block the page renders — or null on a first
// visit. Every entry in `changes` is named from a DURABLE stamp the customer
// can see the effect of; nothing is inferred from updated_at, because a
// "something changed" we cannot name is exactly the surprise the strip
// exists to prevent. The converse holds too: an EMPTY list only means no
// recognized stamp fired, never that the price or plan are unchanged — the
// page's empty-state copy must not claim equality (pre-push codex P1).

const { SESSION_GAP_MINUTES } = require('./estimate-engagement-sessions');

function toDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function serviceOptOutChanges(estimateData, since) {
  const events = estimateData?.serviceOptOut?.events;
  if (!Array.isArray(events)) return [];
  let serviceOptOutLabel = (key) => key;
  try {
    ({ serviceOptOutLabel } = require('./estimate-service-opt-out'));
  } catch (_) { /* label fallback is the key */ }
  const out = [];
  for (const e of events) {
    const at = toDate(e?.at);
    if (!at || !e?.serviceKey || at <= since) continue;
    const label = e.label || serviceOptOutLabel(e.serviceKey);
    out.push({
      kind: e.included === false ? 'service_removed' : 'service_restored',
      label: e.included === false
        ? `You removed ${label}; the price below reflects that.`
        : `You added ${label} back; the price below reflects that.`,
      at: at.toISOString(),
    });
  }
  return out;
}

function extensionChange(extensionAutoGrantedAt, since) {
  const at = toDate(extensionAutoGrantedAt);
  if (!at || at <= since) return [];
  return [{ kind: 'extension_granted', label: 'Your expiration date was extended.', at: at.toISOString() }];
}

/**
 * @param {{ sessions: Array<{startedAt: Date, endedAt: Date}>, estimateData: object,
 *           extensionAutoGrantedAt?: string|Date|null }} args
 * @returns {{ visitNumber: number, lastVisitAt: string, changes: Array } | null}
 */
function buildReturnVisitPayload({
  sessions, estimateData = {}, extensionAutoGrantedAt = null, sessionGapMinutes = SESSION_GAP_MINUTES,
} = {}) {
  const list = Array.isArray(sessions) ? sessions.filter((s) => s && toDate(s.endedAt)) : [];
  if (list.length < 2) return null;
  const previous = list[list.length - 2];
  const previousEnd = toDate(previous.endedAt);
  // Boundary = the END of the previous 30-minute session window, not its last
  // counted open. The page's own /data?refresh=1 re-fetches after a removal or
  // restore are deliberately NOT estimate_views rows, so a mutation the
  // customer made — and saw — during that sitting lands after endedAt; naming
  // it as "changed since your last visit" would re-announce their own click
  // (GH codex P2 on #3708). Anything inside the gap window belongs to the
  // sitting it happened in.
  const since = new Date(previousEnd.getTime() + sessionGapMinutes * 60000);
  const changes = [
    ...serviceOptOutChanges(estimateData, since),
    ...extensionChange(extensionAutoGrantedAt, since),
  ].sort((a, b) => a.at.localeCompare(b.at));
  return {
    visitNumber: list.length,
    lastVisitAt: previousEnd.toISOString(),
    changes,
  };
}

module.exports = { buildReturnVisitPayload };
