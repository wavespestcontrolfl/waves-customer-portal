// Booking-win tracking (owner 2026-11-23): when the office books a visit for a
// customer who still has an open estimate, the booking should carry that
// estimate so the existing accept-on-book flow records the win. Without the
// link the estimate stays sent/viewed and later reads as "expired / no answer"
// even though the customer said yes by phone or text.
//
// Nothing here links anything. The form shows a notice with a "Link it"
// button, and the button is the same pick as choosing the estimate in the
// Estimate source picker (applyScheduleEstimate), so the server's accept-on-book
// path and its refusals are exactly what they are today.
//
// Pure helpers only.

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
// name), not already tied to a visit, sent within the last 60 days, and one
// the server says a staff booking can accept (`bookable`, computed from the
// same refusals POST /admin/schedule applies: portal plan-start quotes, bill-
// by-invoice proposals not yet won, gated or dropped add-ons, the retired
// tree-and-shrub cadence). A missing flag or an unreadable date is "no", so the
// prompt stays quiet.
export function isRecentOpenEstimate(estimate, customerId, nowMs = Date.now()) {
  if (!estimate || customerId == null || customerId === '') return false;
  if (estimate.status !== 'sent' && estimate.status !== 'viewed') return false;
  if (estimate.bookable !== true) return false;
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

// The words staff see under the Estimate source picker, and the estimate the
// "Link it" button picks (null when staff must choose among several). Null
// when there is nothing to say.
export function openEstimateLinkNotice({ estimates = [], customerId, nowMs = Date.now() } = {}) {
  const open = recentOpenEstimates(estimates, customerId, nowMs);
  if (open.length === 0) return null;
  if (open.length === 1) {
    return {
      text: `This customer has an open estimate from ${shortDate(open[0])}. Link it so this booking counts as won.`,
      estimateId: open[0].id,
    };
  }
  return {
    text: `This customer has ${open.length} open estimates (newest from ${shortDate(open[0])}). Pick the one they said yes to above so this booking counts as won.`,
    estimateId: null,
  };
}
