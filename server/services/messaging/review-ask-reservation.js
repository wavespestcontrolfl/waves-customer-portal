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
// General readers of sms_log — conversation history, outbound counts,
// message context fed to composers — must not treat the still-unresolved
// placeholder as a message Waves definitely sent: the provider may never
// have received it (Codex #4331 P2). Once the row resolves to a real
// status it IS a real message like any other row and must not be hidden.
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
function isUnresolvedReviewAskReservation(row) {
  if (!row || row.status !== 'sending') return false;
  const metadata = typeof row.metadata === 'string' ? parseMetadata(row.metadata) : row.metadata;
  return metadata?.review_ask_reservation === true;
}

// Excludes unresolved review-ask reservations at the SQL level (metadata is
// jsonb) — apply this to a query BEFORE any LIMIT/ORDER-then-slice so an
// unresolved placeholder can never displace a real row out of a bounded
// history window. `table` lets a caller that aliases or joins sms_log
// qualify the column; default matches a bare `db('sms_log')` query.
function excludeUnresolvedReviewAskReservations(query, table = 'sms_log') {
  return query.whereRaw(
    `NOT (${table}.status = 'sending' AND COALESCE(${table}.metadata->>'review_ask_reservation', 'false') = 'true')`,
  );
}

module.exports = { isUnresolvedReviewAskReservation, excludeUnresolvedReviewAskReservations };
