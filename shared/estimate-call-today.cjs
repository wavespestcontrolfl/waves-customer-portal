'use strict';

// The "Call today" estimate list rule, in ONE place (owner 2026-11-19, plan page "Lead to Customer Plan",
// phase 1). The Estimates page filters its rows with isCallTodayEstimate, and the 9 AM push
// (server/services/estimate-call-today-push.js) counts the same rows with the same function, so the push and
// the page cannot disagree. Plain CommonJS so the server requires it and the Vite client imports it through the
// `@estimate-call-today` alias (client/vite.config.js), like shared/estimate-monthly-average.cjs.

const HOUR = 3600000;

// Most recent customer touch on the estimate. First-view timestamps alone
// misclassify customers who re-open or click days later, so idle-time checks
// must key off the latest of view/re-view/click. A delivered self-serve quote
// counts only touches at or after its first delivery (selfServeDeliveredAt,
// set by callTodayFields for the page and the push alike): the customer's
// portal look before the send is no response to it (codex pre-push P1).
function lastEngagementMs(estimate) {
  const from = estimate?.selfServeDeliveredAt ? new Date(estimate.selfServeDeliveredAt).getTime() : -Infinity;
  const stamps = [
    estimate?.lastViewedAt,
    estimate?.viewedAt,
    estimate?.lastClickedAt,
  ]
    .map((iso) => (iso ? new Date(iso).getTime() : NaN))
    .filter((ts) => !Number.isNaN(ts) && ts >= from);
  return stamps.length ? Math.max(...stamps) : null;
}

// Call today = the hot window the 48h "Going cold" check misses: a VIEWED
// offer whose last customer touch was 2h–48h ago and that nobody has phoned or followed up on since.
// The upper edge is inclusive and isGoingColdEstimate starts strictly past 48h, so the two never
// share an offer (and the 7d+ overdue bucket sits further out still). Needs a phone to call.
// Never a self-serve quote nobody delivered (undeliveredSelfServe: plan restart, plan start, report
// card). The list route and the 9 AM push both set it through callTodayFields, from one rule
// (server/services/self-serve-estimates.js): the customer opened it from the portal, and the
// mint promises no follow-up. A delivered one counts touches from its delivery (lastEngagementMs).
function isCallTodayEstimate(estimate, nowMs = Date.now()) {
  if (estimate?.status !== 'viewed' || estimate.archivedAt || estimate.undeliveredSelfServe) return false;
  if (!String(estimate.customerPhone || '').trim()) return false;
  const last = lastEngagementMs(estimate);
  if (last == null) return false;
  const age = nowMs - last;
  if (age < 2 * HOUR || age > 48 * HOUR) return false;
  // Any contact AFTER the customer's last touch takes the offer off the list.
  for (const contact of [estimate.lastCalledAt, estimate.lastFollowUpAt]) {
    const ts = contact ? new Date(contact).getTime() : NaN;
    if (!Number.isNaN(ts) && ts > last) return false;
  }
  return true;
}

module.exports = { HOUR, lastEngagementMs, isCallTodayEstimate };
