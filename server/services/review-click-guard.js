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

// A date-only visit column is that ET calendar day, so the fallback anchor is
// ET midnight. new Date('YYYY-MM-DD') would be UTC midnight on Railway (TZ=UTC),
// 4–5 hours early, and a 9 p.m. ET click the evening before the visit would
// then suppress that visit's ask.
function etMidnight(value) {
  const ymd = dateOnlyString(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(ymd || '') ? parseETDateTime(`${ymd}T00:00`) : null;
}

// The moment a visit completed, when the completion flow recorded one, else ET
// midnight of its date. Two completed visits on the same day then anchor at
// their own completion instants: a click between them is not a response to the
// second. Fields are the ones the completion flow writes:
//   service_records.ended_at (service report v1)
//   scheduled_services.actual_end_time / check_out_time / completed_at (the same
//   order lifecycle-email-sweeps and the field-team program read)
function instantOrMidnight(instant, date) {
  if (instant) {
    const d = new Date(instant);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return etMidnight(date);
}
const scheduledEnd = (row) => row?.actual_end_time || row?.check_out_time || row?.completed_at || null;
// A completed record with no ended_at (pest-recap creates these, linked by
// scheduled_service_id) takes its linked visit's completion instant before the
// date fallback.
async function recordAnchor(row, database) {
  if (!row) return null;
  if (row.ended_at) return instantOrMidnight(row.ended_at, row.service_date);
  if (row.scheduled_service_id) {
    const visit = await database('scheduled_services').where({ id: row.scheduled_service_id })
      .first('actual_end_time', 'check_out_time', 'completed_at');
    if (scheduledEnd(visit)) return instantOrMidnight(scheduledEnd(visit), row.service_date);
  }
  return etMidnight(row.service_date);
}
const scheduledInstant = (row) => instantOrMidnight(scheduledEnd(row), row?.scheduled_date);

// The visit a review ask belongs to, as a completion instant (or ET midnight), or null.
async function visitAnchor({ serviceRecordId = null, scheduledServiceId = null } = {}, database = db) {
  if (serviceRecordId) {
    const row = await database('service_records').where({ id: serviceRecordId }).first('service_date', 'ended_at', 'scheduled_service_id');
    const anchor = await recordAnchor(row, database);
    if (anchor) return anchor;
  }
  if (scheduledServiceId) {
    const row = await database('scheduled_services').where({ id: scheduledServiceId })
      .first('scheduled_date', 'actual_end_time', 'check_out_time', 'completed_at');
    const anchor = scheduledInstant(row);
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
  // The LATEST of the newest completed service record and the newest completed
  // scheduled visit (a completed appointment can exist with no service record).
  // Same predicates as sendGatedAsk's visit-context lookup: scheduled_services
  // status 'completed' ordered by scheduled_date desc; service_records
  // status 'completed' ordered by service_date desc.
  const [record, visit] = await Promise.all([
    database('service_records').where({ customer_id: customerId, status: 'completed' })
      .orderBy('service_date', 'desc').orderByRaw('ended_at DESC NULLS LAST')
      .first('service_date', 'ended_at', 'scheduled_service_id'),
    database('scheduled_services').where({ customer_id: customerId, status: 'completed' })
      // Same-day ties by the SAME instant scheduledInstant() reads (actual end,
      // then check-out, then completed_at), so the later visit always wins.
      .orderBy('scheduled_date', 'desc').orderByRaw('COALESCE(actual_end_time, check_out_time, completed_at) DESC NULLS LAST')
      .first('scheduled_date', 'actual_end_time', 'check_out_time', 'completed_at'),
  ]);
  const dates = [await recordAnchor(record, database), scheduledInstant(visit)].filter(Boolean);
  return dates.length ? new Date(Math.max(...dates.map((d) => d.getTime()))) : null;
}

// The customer already went to Google: a tracked click since the anchor, or
// (GATE_REVIEW_ASK_TECH_VOICE) a confirmed "I already left a review" text on
// record (review-ask-holds.js customerSaidReviewed).
async function alreadyReviewedSince(customerId, anchor, database, { clicksOnly = false } = {}) {
  if (await reviewLinkClickedSince(customerId, anchor, database)) return true;
  return !clicksOnly && require('./review-ask-holds').customerSaidReviewed(customerId, { database });
}

// The guard for an ask described by a review_requests row (sendSMS, follow-ups,
// the inline email leg, the composer seam). The visit anchor always wins. A row
// with no visit (a manual create(), an Intelligence Bar or composer ask) is about
// the customer's newest completed visit, or about whatever led to it being
// minted, so it anchors at the EARLIER of that visit and the row's own creation:
// a click since either point means the customer already went to Google.
async function askSuppressedByClick(request, database = db) {
  if (!request?.customer_id) return false;
  let anchor = await visitAnchor({
    serviceRecordId: request.service_record_id, scheduledServiceId: request.scheduled_service_id,
  }, database);
  if (!anchor) {
    const candidates = [
      await newestCompletedVisitAnchor(request.customer_id, database),
      request.created_at ? new Date(request.created_at) : null,
    ].filter((d) => d && !Number.isNaN(d.getTime()));
    anchor = candidates.length ? new Date(Math.min(...candidates.map((d) => d.getTime()))) : null;
  }
  return alreadyReviewedSince(request.customer_id, anchor, database);
}

// The same guard for an ask known only by its id (a bundled completion ask):
// the row is read here so every caller judges the same columns. A missing row
// is not suppressed; a failed read throws, and callers fail closed.
// review_requests has no scheduled_service_id column: an ask's visit is its
// service record.
async function askIdSuppressedByClick(reviewRequestId, database = db) {
  const request = await database('review_requests').where({ id: reviewRequestId })
    .first('id', 'customer_id', 'service_record_id', 'created_at', 'template_key');
  return askSuppressedByClick(request, database);
}

// The guard for a cadence / outreach touch that has no request row yet: the
// visit, else `fallbackAnchor` (a cadence's own start), else — when
// `newestVisitFallback` — the customer's newest completed visit. `clicksOnly`:
// the sequence runner, whose review-ask holds record a reviewed claim under
// its own reason.
async function touchSuppressedByClick(customerId, { serviceRecordId = null, scheduledServiceId = null, fallbackAnchor = null, newestVisitFallback = false, clicksOnly = false } = {}, database = db) {
  const anchor = (await visitAnchor({ serviceRecordId, scheduledServiceId }, database))
    || (fallbackAnchor ? new Date(fallbackAnchor) : null)
    || (newestVisitFallback ? await newestCompletedVisitAnchor(customerId, database) : null);
  return alreadyReviewedSince(customerId, anchor, database, { clicksOnly });
}

const REVIEW_LINK_CLICKED_REASON = 'This customer already tapped their Google review link, so no further review request is sent.';

module.exports = { reviewLinkClickedSince, askSuppressedByClick, askIdSuppressedByClick, touchSuppressedByClick, visitAnchor, newestCompletedVisitAnchor, REVIEW_LINK_CLICKED_REASON };
