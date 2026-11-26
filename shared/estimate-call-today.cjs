'use strict';

// The "Call today" estimate list rule, in ONE place (owner 2026-11-19, plan page "Lead to Customer Plan",
// phase 1). The Estimates page filters its rows with isCallTodayEstimate, and the 9 AM push
// (server/services/estimate-call-today-push.js) counts the same rows with the same function, so the push and
// the page cannot disagree. Plain CommonJS so the server requires it and the Vite client imports it through the
// `@estimate-call-today` alias (client/vite.config.js), like shared/estimate-monthly-average.cjs.

const HOUR = 3600000;

// The outcome a person taps on a Call today row (owner 2026-11-20, D1 A): one tap saves it with who and when, and the
// row leaves the list. The server accepts only these keys (POST /api/admin/estimates/:id/call-outcome); the page shows
// the labels in this order.
const CALL_OUTCOMES = Object.freeze([
  Object.freeze({ key: 'booked', label: 'Booked' }),
  Object.freeze({ key: 'call_back', label: 'Call back' }),
  Object.freeze({ key: 'not_interested', label: 'Not interested' }),
  Object.freeze({ key: 'no_answer', label: 'No answer' }),
]);

// What the customer picked under "What would help you decide?" on the estimate page (owner 2026-11-21, estimate page
// changes, change 1), as a row says it after "Still deciding:". The keys are the server's STILL_DECIDING_REASONS
// (server/services/estimate-change-request.js); estimate-call-list.test.js keeps the two lists equal.
const STILL_DECIDING_HELP = Object.freeze({
  price: 'wants a lower price',
  person: 'wants to talk to a person first',
  quotes: 'is comparing other quotes',
  timing: 'says it is not the right time yet',
  other: 'picked "Something else"',
});

const stampMs = (iso) => {
  const ts = iso ? new Date(iso).getTime() : NaN;
  return Number.isNaN(ts) ? null : ts;
};

// When the customer sent the newest of those reasons ({ reason, at } on the row), or null.
function stillDecidingMs(estimate) {
  const told = estimate?.stillDeciding;
  return told && Object.hasOwn(STILL_DECIDING_HELP, String(told.reason)) ? stampMs(told.at) : null;
}

// Most recent customer touch on the estimate. First-view timestamps alone
// misclassify customers who re-open or click days later, so idle-time checks
// must key off the latest of view/re-view/click. A reason the customer sent
// under "What would help you decide?" is a touch too, so Call today, Going cold
// and Follow-up overdue all count idle time from it.
function lastEngagementMs(estimate) {
  const stamps = [estimate?.lastViewedAt, estimate?.viewedAt, estimate?.lastClickedAt]
    .map(stampMs)
    .concat(stillDecidingMs(estimate))
    .filter((ts) => ts != null);
  return stamps.length ? Math.max(...stamps) : null;
}

// The row checks every Call today row passes, held rows on the page too: a VIEWED, unarchived offer someone delivered,
// with a phone to call.
function isCallableEstimate(estimate) {
  if (estimate?.status !== 'viewed' || estimate.archivedAt || estimate.undeliveredSelfServe) return false;
  return !!String(estimate.customerPhone || '').trim();
}

// Call today = the hot window the 48h "Going cold" check misses: a VIEWED
// offer whose last customer touch was 2h–48h ago and that nobody has phoned, followed up on or logged a call outcome
// for since. Every outcome counts (owner 2026-11-20, D1 A), No answer and Call back too: the row comes back only when
// the customer opens or taps the estimate again.
// The upper edge is inclusive and isGoingColdEstimate starts strictly past 48h, so the two never
// share an offer (and the 7d+ overdue bucket sits further out still). Needs a phone to call.
// Never a self-serve quote nobody delivered (undeliveredSelfServe: plan restart, plan start, report
// card). The list route and the 9 AM push both set it through callTodayFields, from one rule
// (server/services/self-serve-estimates.js): the customer opened it from the portal, and the
// mint promises no follow-up.
// A row whose call outcomes could not be read (callOutcomeUnknown: the list route's batched read failed) is withheld:
// a failed read must not put a row someone already logged back on the list. The 9 AM push sends nothing then.
// A customer who sent a reason under "What would help you decide?" (stillDeciding) skips the 2h wait: that wait gives
// a customer time to book alone, and this one has said what they need. The row shows at once and stays until someone
// answers the reason (a call, a follow-up or an outcome after it) or 48h pass since the last touch. The skip itself
// lasts 48h from the reason: an older reason is not a pending request (the call read goes back 30 days only, so an
// old reason could look unanswered), and a later open then follows the plain 2h rule.
function isCallTodayEstimate(estimate, nowMs = Date.now()) {
  if (!isCallableEstimate(estimate) || estimate.callOutcomeUnknown) return false;
  const last = lastEngagementMs(estimate);
  if (last == null) return false;
  const contacts = [estimate.lastCalledAt, estimate.lastFollowUpAt, estimate.lastCallOutcome?.at]
    .map(stampMs).filter((ts) => ts != null);
  // Any contact AFTER the customer's last touch takes the offer off the list.
  if (contacts.some((ts) => ts > last)) return false;
  const age = nowMs - last;
  if (age > 48 * HOUR) return false;
  const told = stillDecidingMs(estimate);
  const reasonWaits = told != null && nowMs - told <= 48 * HOUR && !contacts.some((ts) => ts > told);
  return reasonWaits || age >= 2 * HOUR;
}

module.exports = { HOUR, CALL_OUTCOMES, STILL_DECIDING_HELP, lastEngagementMs, isCallableEstimate, isCallTodayEstimate };
