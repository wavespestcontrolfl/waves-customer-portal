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

// Estimate-level wording, never "you": the public token is one link that a
// spouse or bookkeeper may open after the share action, and estimate_views
// carries no viewer identity — the strip describes what happened to the
// ESTIMATE, not what the current reader did (GH codex P2 on #3708). Multiple
// events for one service collapse to the service's FINAL state after the
// boundary, so a removal that was later restored is never described as
// reflected in the current price (GH codex P2).
function serviceOptOutChanges(estimateData, since, until = null) {
  const events = estimateData?.serviceOptOut?.events;
  if (!Array.isArray(events)) return [];
  let serviceOptOutLabel = (key) => key;
  try {
    ({ serviceOptOutLabel } = require('./estimate-service-opt-out'));
  } catch (_) { /* label fallback is the key */ }
  // Final state per service is decided by EVERY event after the boundary —
  // current-sitting events included — so a between-visits change that the
  // customer has since reversed during this sitting is never announced as
  // still reflected in the price. Then: a service whose latest event fell in
  // the current sitting is not announced at all (the page re-fetched after
  // that click; the reader just saw it) — pre-push codex P1 + GH codex r3 P2.
  const latestByKey = new Map();
  for (const e of events) {
    const at = toDate(e?.at);
    if (!at || !e?.serviceKey || at <= since) continue;
    const prev = latestByKey.get(e.serviceKey);
    if (!prev || at > prev.at) latestByKey.set(e.serviceKey, { event: e, at });
  }
  const out = [];
  for (const [serviceKey, { event, at }] of latestByKey) {
    if (until && at >= until) continue;
    // Customer-authored: it happened from an already-open page — seen. The
    // public opt-out route stamps actor:'customer' at the source; events
    // written before that stamp existed carry none and read as customer.
    // Staff-authored events (actor:'staff' — the send-time lead-service
    // park / revert, PR #3711) are the ones this line exists for; until
    // that writer lands, the extension grant is the only announced stamp.
    if (String(event.actor || 'customer') !== 'staff') continue;
    const label = event.label || serviceOptOutLabel(serviceKey);
    out.push({
      kind: event.included === false ? 'service_removed' : 'service_restored',
      label: event.included === false
        ? `${label} was removed from this estimate; the price below reflects that.`
        : `${label} was added back to this estimate; the price below reflects that.`,
      at: at.toISOString(),
    });
  }
  return out;
}

function extensionChange(extensionAutoGrantedAt, since) {
  const at = toDate(extensionAutoGrantedAt);
  if (!at || at <= since) return [];
  return [{ kind: 'extension_granted', label: 'The expiration date was extended.', at: at.toISOString() }];
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
  // Service events between the previous visit's end and this visit's start
  // can only come from a page that was ALREADY open (a real return inserts a
  // view row and starts a new session), so a customer's own between-visits
  // click is never "since your last visit" — no matter how long the tab sat
  // idle (GH codex P2 rounds 2–5 on #3708: the fixed 30-minute gap was the
  // wrong model). Staff-authored events (a lead-service park or revert at
  // send time) are the ones worth announcing in that window. An extension
  // grant is independently durable and compares against the previous
  // visit's end itself.
  const current = list[list.length - 1];
  const currentStart = toDate(current.startedAt);
  const changes = [
    ...serviceOptOutChanges(estimateData, previousEnd, currentStart),
    ...extensionChange(extensionAutoGrantedAt, previousEnd),
  ].sort((a, b) => a.at.localeCompare(b.at));
  void sessionGapMinutes;
  return {
    visitNumber: list.length,
    lastVisitAt: previousEnd.toISOString(),
    changes,
  };
}

module.exports = { buildReturnVisitPayload };
