'use strict';

// A review-ask reservation is a synthetic outbound sms_log row
// (review-request.js#reserveReviewSms) inserted just before the SMS
// provider call so the 72h ask-spacing window has evidence even when the
// provider's delivery outcome comes back uncertain. It stays a placeholder
// — status 'sending' — only until it resolves: a confirmed send either
// deletes it (review-request.js#releaseReviewSmsReservation — the normal
// case, since the send itself already logged its own row) or, when no
// separately-logged provider row was found, flips this same row's status
// to 'sent' in place (admin-communications.js's settleReviewReservation).
//
// A Communications reply reservation (sms-suggest-mode's
// createReplyHoldingReservation, marker manual_send_reservation) and the
// automatic reply reservation (sms-auto-send, marker auto_send_reservation)
// are the same kind of placeholder: inserted 'sending' before the provider
// call and only settled — stamped sent, deleted, or held — afterward.
//
// General readers of sms_log — conversation history, outbound counts,
// message context fed to composers, unanswered-thread checks — must not
// treat either still-unresolved placeholder as a message Waves definitely
// sent: the provider may never have received it (Codex #4331 P2; pre-push
// P1 on the reply marker). Once the row resolves to a real status it IS a
// real message like any other row and must not be hidden.
//
// review-ask-history.js's own spacing-evidence reader already tests exactly
// this (status === 'sending' + the marker) — this module is the one place
// both it and every general reader share, so the semantics can't drift.

function parseMetadata(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

// True only while the reservation is still in flight/unconfirmed. A row
// that has since resolved to any other status (sent, delivered, failed,
// undelivered, blocked, canceled…) is a real message and returns false.
// Every 'sending' placeholder a general reader must not mistake for a sent
// message: the review-ask reservation, the Communications reply reservation
// (manual_send_reservation) and the automatic reply reservation
// (auto_send_reservation, sms-auto-send). Only the FIRST is review-ask
// spacing evidence — history readers use the narrow predicate.
const REVIEW_ASK_MARKER = 'review_ask_reservation';
const REPLY_RESERVATION_MARKERS = ['manual_send_reservation', 'auto_send_reservation'];
const SEND_RESERVATION_MARKERS = [REVIEW_ASK_MARKER, ...REPLY_RESERVATION_MARKERS];
// A reply placeholder is hidden only while its reconciliation hold runs
// (sms-auto-send's uncertain-claim hold). Past that it SURFACES as the
// unresolved attempt it is, so an operator can see and settle it — an
// unbounded hide would bury an ambiguous automatic reply for good.
const REPLY_RESERVATION_HOLD_HOURS = 24;
const REPLY_RESERVATION_HOLD_MS = REPLY_RESERVATION_HOLD_HOURS * 60 * 60 * 1000;

function unresolvedMetadata(row) {
  if (!row || row.status !== 'sending') return null;
  return typeof row.metadata === 'string' ? parseMetadata(row.metadata) : row.metadata;
}

// True only while a REVIEW-ASK reservation is still in flight/unconfirmed. A
// row that has since resolved to any other status (sent, delivered, failed,
// undelivered, blocked, canceled…) is a real message and returns false. This
// is the spacing-evidence predicate: a reply reservation is NOT a review ask.
function isUnresolvedReviewAskReservation(row) {
  return unresolvedMetadata(row)?.[REVIEW_ASK_MARKER] === true;
}

// True while ANY send reservation is still in flight — what general readers
// (history, counts, context, unanswered-thread checks) must hide.
function isUnresolvedSendReservation(row, now = Date.now()) {
  const metadata = unresolvedMetadata(row);
  if (!metadata) return false;
  if (metadata[REVIEW_ASK_MARKER] === true) return true;
  if (!REPLY_RESERVATION_MARKERS.some(marker => metadata[marker] === true)) return false;
  const createdAt = row.created_at ? new Date(row.created_at).getTime() : NaN;
  return !Number.isFinite(createdAt) || createdAt >= now - REPLY_RESERVATION_HOLD_MS;
}

// Excludes every unresolved send reservation at the SQL level (metadata is
// jsonb) — apply this to a query BEFORE any LIMIT/ORDER-then-slice so an
// unresolved placeholder can never displace a real row out of a bounded
// history window. `table` lets a caller that aliases or joins sms_log
// qualify the column; default matches a bare `db('sms_log')` query.
function excludeUnresolvedSendReservations(query, table = 'sms_log') {
  const replyMarkers = REPLY_RESERVATION_MARKERS.map(marker => `COALESCE(${table}.metadata->>'${marker}', 'false') = 'true'`).join(' OR ');
  return query.whereRaw(
    `NOT (${table}.status = 'sending' AND (`
      + `COALESCE(${table}.metadata->>'${REVIEW_ASK_MARKER}', 'false') = 'true'`
      + ` OR ((${replyMarkers}) AND ${table}.created_at >= NOW() - INTERVAL '${REPLY_RESERVATION_HOLD_HOURS} hours')))`,
  );
}

module.exports = {
  isUnresolvedReviewAskReservation,
  isUnresolvedSendReservation,
  excludeUnresolvedSendReservations,
  SEND_RESERVATION_MARKERS,
  REPLY_RESERVATION_HOLD_HOURS,
};
