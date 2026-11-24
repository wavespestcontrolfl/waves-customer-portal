// Booking-win tracking (owner 2026-11-23): when the office books a visit for a
// customer who still has an open estimate, the booking should carry that
// estimate so the existing accept-on-book flow records the win. Without the
// link the estimate stays sent/viewed and later reads as "expired / no answer"
// even though the customer said yes by phone or text.
//
// Pure helpers only. Linking itself reuses the modal's applyScheduleEstimate
// and the server's markEstimateManuallyAccepted path; nothing here sends,
// charges or changes a price.

import { formatETDate } from '../../lib/timezone';

export const OPEN_ESTIMATE_LINK_WINDOW_DAYS = 60;

const DAY_MS = 24 * 60 * 60 * 1000;

function sentMs(estimate) {
  const stamp = estimate?.sentAt || estimate?.createdAt;
  const ms = stamp ? new Date(stamp).getTime() : NaN;
  return Number.isFinite(ms) ? ms : null;
}

// An estimate the office should be offered a link to: still open (sent or
// viewed), owned by THIS customer (matched on id, never on a phone or a
// name), not already tied to a visit, and sent within the last 60 days. A
// missing or unreadable date is "not recent" so the prompt stays quiet.
export function isRecentOpenEstimate(estimate, customerId, nowMs = Date.now()) {
  if (!estimate || customerId == null || customerId === '') return false;
  if (estimate.status !== 'sent' && estimate.status !== 'viewed') return false;
  if (estimate.linkedAppointment) return false;
  if (estimate.customerId == null || String(estimate.customerId) !== String(customerId)) return false;
  const ms = sentMs(estimate);
  if (ms == null) return false;
  const age = nowMs - ms;
  // One day of slack for clock skew; the window itself is 60 days.
  return age >= -DAY_MS && age <= OPEN_ESTIMATE_LINK_WINDOW_DAYS * DAY_MS;
}

export function recentOpenEstimates(estimates = [], customerId, nowMs = Date.now()) {
  return estimates
    .filter((estimate) => isRecentOpenEstimate(estimate, customerId, nowMs))
    .sort((a, b) => (sentMs(b) || 0) - (sentMs(a) || 0));
}

function shortDate(estimate) {
  const ms = sentMs(estimate);
  // Eastern, like every office-facing date (AGENTS.md), and the same
  // sent-or-created stamp the picker label reads.
  return ms == null ? '' : formatETDate(ms, { month: 'short', day: 'numeric' });
}

// The words staff see under the Estimate source picker. Null when there is
// nothing to say.
export function openEstimateLinkNotice({ estimates = [], linkedEstimate = null, customerId, nowMs = Date.now() } = {}) {
  if (linkedEstimate) {
    if (!isRecentOpenEstimate({ ...linkedEstimate, linkedAppointment: null }, customerId, nowMs)) return null;
    return `This customer has an open estimate from ${shortDate(linkedEstimate)}. It is linked so this booking counts as won. Press Clear to book without it.`;
  }
  const open = recentOpenEstimates(estimates, customerId, nowMs);
  if (open.length === 0) return null;
  if (open.length === 1) {
    return `This customer has an open estimate from ${shortDate(open[0])}. Pick it above so this booking counts as won.`;
  }
  return `This customer has ${open.length} open estimates (newest from ${shortDate(open[0])}). Pick the one they said yes to so this booking counts as won.`;
}
