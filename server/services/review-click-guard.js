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
 * visit); a click at or after that visit's date is a response to it. A repeat
 * customer's click for an earlier visit predates the new visit's date and
 * suppresses nothing. An ask with no visit anchor (an operator one-off) is
 * anchored at its own creation, so only a click AFTER it was queued counts.
 *
 * Call sites (all inside the review-send lock):
 *   - review-request.js sendOutreachTouch  — cadence steps + one-off outreach, SMS and email
 *   - review-request.js sendSMS            — processScheduled queue, create(), tech resend
 *   - review-request.js processFollowups   — the Day-3 text follow-up
 *   - review-request.js sendInlineEmailCopy — the composer's inline email leg
 * An untracked click (the bare office URL) is invisible here by nature.
 */
const db = require('../models/db');

const AUTOMATIC_TRIGGERS = ['auto', 'auto_inline', 'sequence'];

// The visit date a review ask belongs to, or null.
async function visitAnchor({ serviceRecordId = null, scheduledServiceId = null } = {}, database = db) {
  if (serviceRecordId) {
    const row = await database('service_records').where({ id: serviceRecordId }).first('service_date');
    if (row?.service_date) return new Date(row.service_date);
  }
  if (scheduledServiceId) {
    const row = await database('scheduled_services').where({ id: scheduledServiceId }).first('scheduled_date');
    if (row?.scheduled_date) return new Date(row.scheduled_date);
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

// The guard for an ask described by a review_requests row (sendSMS, follow-ups,
// the inline email leg). `followup` asks always anchor on the visit.
async function askSuppressedByClick(request, { followup = false } = {}, database = db) {
  if (!request?.customer_id) return false;
  const automatic = followup || AUTOMATIC_TRIGGERS.includes(request.triggered_by);
  const anchor = (automatic ? await visitAnchor({
    serviceRecordId: request.service_record_id, scheduledServiceId: request.scheduled_service_id,
  }, database) : null) || (request.created_at ? new Date(request.created_at) : null);
  return reviewLinkClickedSince(request.customer_id, anchor, database);
}

// The guard for a cadence / outreach touch that has no request row yet.
async function touchSuppressedByClick(customerId, { serviceRecordId = null, scheduledServiceId = null } = {}, database = db) {
  const anchor = await visitAnchor({ serviceRecordId, scheduledServiceId }, database);
  return reviewLinkClickedSince(customerId, anchor, database);
}

module.exports = { reviewLinkClickedSince, askSuppressedByClick, touchSuppressedByClick, visitAnchor };
