/**
 * Send-time suppression for review asks (owner ruling 2026-09-29: a customer
 * who has tapped through to Google is never asked again).
 *
 * Enumerating every state that could ask a customer LATER (redeeming
 * cadences, stranded 'sending' rows released by reconcileStrandedSends, an
 * uncertain visit summary that enrolls after recovery, ...) never converges,
 * so the tracked /api/rate/:token/go click is recorded (review_requests
 * .redirected_at / last_redirected_at) and every review sender checks it at
 * the moment its ask is about to leave — inside the per-customer
 * `review-send:<customerId>` lock, so it cannot race the click's own stop.
 *
 * Anchor: an ask belongs to a VISIT (its service record, else its scheduled
 * visit) — for EVERY kind of ask, operator-initiated ones included; a click at
 * or after that visit's date is a response to it. A repeat customer's click for
 * an earlier visit predates the new visit's date and suppresses nothing. With no
 * visit on the row: a cadence anchors at its own start, an operator one-off
 * being minted (no row yet) at the customer's newest completed visit, and an
 * existing row at its own creation.
 *
 * Call sites (all inside the review-send lock):
 *   - review-request.js sendOutreachTouch  — cadence steps + one-off outreach, SMS and email
 *   - review-request.js sendSMS            — processScheduled queue, create(), tech resend
 *   - review-request.js processFollowups   — the Day-3 text follow-up
 *   - review-request.js sendInlineEmailCopy — the composer's inline email leg
 *   - routes/admin-communications.js      — the composer's SMS send seam (a draft minted
 *                                            before the click is refused, not sent)
 * An untracked click (the bare office URL) is invisible here by nature.
 */
const db = require('../models/db');
const { dateOnlyString, parseETDateTime } = require('../utils/datetime-et');

// A date-only visit column is that ET calendar day, so the anchor is ET
// midnight. new Date('YYYY-MM-DD') would be UTC midnight on Railway (TZ=UTC),
// 4–5 hours early, and a 9 p.m. ET click the evening before the visit would
// then suppress that visit's ask.
function etMidnight(value) {
  const ymd = dateOnlyString(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(ymd || '') ? parseETDateTime(`${ymd}T00:00`) : null;
}

// The visit date a review ask belongs to, or null.
async function visitAnchor({ serviceRecordId = null, scheduledServiceId = null } = {}, database = db) {
  if (serviceRecordId) {
    const row = await database('service_records').where({ id: serviceRecordId }).first('service_date');
    const anchor = etMidnight(row?.service_date);
    if (anchor) return anchor;
  }
  if (scheduledServiceId) {
    const row = await database('scheduled_services').where({ id: scheduledServiceId }).first('scheduled_date');
    const anchor = etMidnight(row?.scheduled_date);
    if (anchor) return anchor;
  }
  return null;
}

// Has this customer clicked a tracked review link at/after `since`?
async function reviewLinkClickedSince(customerId, since, database = db) {
  if (!customerId || !since || Number.isNaN(new Date(since).getTime())) return false;
  const row = await database('review_requests')
    .where({ customer_id: customerId })
    .whereNotNull('redirected_at')
    .where((b) => b.where('redirected_at', '>=', since).orWhere('last_redirected_at', '>=', since))
    .first('id');
  return Boolean(row);
}

// Operator-initiated asks with no visit and no cadence (Quick Links, admin,
// tech-trigger, Intelligence Bar one-offs): the customer's newest completed
// visit is the one the ask is about.
async function newestCompletedVisitAnchor(customerId, database = db) {
  if (!customerId) return null;
  const row = await database('service_records')
    .where({ customer_id: customerId, status: 'completed' })
    .orderBy('service_date', 'desc')
    .first('service_date');
  return etMidnight(row?.service_date);
}

// The guard for an ask described by a review_requests row (sendSMS, follow-ups,
// the inline email leg, the composer seam). The visit anchor always wins; the
// row's own creation is only the fallback when it has no visit.
async function askSuppressedByClick(request, database = db) {
  if (!request?.customer_id) return false;
  const anchor = (await visitAnchor({
    serviceRecordId: request.service_record_id, scheduledServiceId: request.scheduled_service_id,
  }, database)) || (request.created_at ? new Date(request.created_at) : null);
  return reviewLinkClickedSince(request.customer_id, anchor, database);
}

// The guard for a cadence / outreach touch that has no request row yet: the
// visit, else `fallbackAnchor` (a cadence's own start), else — when
// `newestVisitFallback` — the customer's newest completed visit.
async function touchSuppressedByClick(customerId, { serviceRecordId = null, scheduledServiceId = null, fallbackAnchor = null, newestVisitFallback = false } = {}, database = db) {
  const anchor = (await visitAnchor({ serviceRecordId, scheduledServiceId }, database))
    || (fallbackAnchor ? new Date(fallbackAnchor) : null)
    || (newestVisitFallback ? await newestCompletedVisitAnchor(customerId, database) : null);
  return reviewLinkClickedSince(customerId, anchor, database);
}

const REVIEW_LINK_CLICKED_REASON = 'This customer already tapped their Google review link, so no further review request is sent.';

module.exports = { reviewLinkClickedSince, askSuppressedByClick, touchSuppressedByClick, visitAnchor, newestCompletedVisitAnchor, REVIEW_LINK_CLICKED_REASON };
