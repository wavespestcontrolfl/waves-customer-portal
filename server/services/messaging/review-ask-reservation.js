'use strict';

// A review-ask reservation is a synthetic outbound sms_log row inserted
// just before the SMS provider call so the 72h ask-spacing window has
// evidence even when the provider's delivery outcome comes back uncertain.
// It stays a placeholder — status 'sending' — only until it resolves: a
// confirmed send either deletes it (releaseUnsent/releaseById — the normal
// case, since the send itself already logged its own row) or, when no
// separately-logged provider row was found, flips this same row's status
// to 'sent' in place (promote — admin-communications.js's
// settleReviewReservation does the equivalent for its own reservation).
//
// This module is the SINGLE owner of the review-ask reservation's
// lifecycle (codex #4331 structural pass): every review-request.js /
// admin-communications.js call site that creates, releases, or promotes one
// of these rows goes through reserveForRequest / releaseUnsent / releaseById
// / promote here, rather than each keeping its own inline INSERT/UPDATE/DELETE.
// Six P1/P2 findings on this stack were all instances of ONE class — a
// reservation some release/retry/cleanup/reader path didn't account for —
// and every one of them was a consequence of the lifecycle being
// reimplemented ad hoc at each call site instead of owned in one place.
//
// A Communications reply reservation (sms-suggest-mode's
// createReplyHoldingReservation, marker manual_send_reservation) and the
// automatic reply reservation (sms-auto-send, marker auto_send_reservation)
// are the same kind of placeholder: inserted 'sending' before the provider
// call and only settled — stamped sent, deleted, or held — afterward. Their
// own creation/settlement lifecycle stays where it is (sms-suggest-mode.js /
// sms-auto-send.js) — only the shared "is this hidden from a general
// reader" predicate lives here.
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
// A review-ask placeholder gets the SAME treatment, mirrored at the ask-
// spacing window itself (ASK_SPACING_MS in review-ask-history.js) rather
// than the reply hold's shorter one (codex #4331 P1, structural pass,
// finding 6): a review-ask reservation that never resolves — a crash before
// settlement, or a stamp failure whose promotion also failed — used to hide
// from every general reader FOREVER. Past 72h the send attempt is
// definitively over one way or another (its own spacing window has
// elapsed), so the placeholder is no longer live spacing evidence and must
// stop hiding as a real row: an operator investigating the thread, a
// signal-detector count, or a drafter's grounding history must see it as
// the unresolved 'sending' oddity it now is, not as a message that never
// happened.
const REVIEW_ASK_RESERVATION_HOLD_HOURS = 72;
const REVIEW_ASK_RESERVATION_HOLD_MS = REVIEW_ASK_RESERVATION_HOLD_HOURS * 60 * 60 * 1000;

function unresolvedMetadata(row) {
  if (!row || row.status !== 'sending') return null;
  return typeof row.metadata === 'string' ? parseMetadata(row.metadata) : row.metadata;
}

// True only while a REVIEW-ASK reservation is still in flight/unconfirmed. A
// row that has since resolved to any other status (sent, delivered, failed,
// undelivered, blocked, canceled…) is a real message and returns false. This
// is the spacing-evidence predicate: a reply reservation is NOT a review ask.
// Deliberately UNBOUNDED by age — every caller of this narrow predicate
// (review-ask-history.js's lastManualAskAt, _askSpacingHold) already scopes
// its own lookback window (typically ASK_SPACING_MS itself), so bounding it
// here too would just duplicate that window in a second place.
function isUnresolvedReviewAskReservation(row) {
  return unresolvedMetadata(row)?.[REVIEW_ASK_MARKER] === true;
}

// True while ANY send reservation is still in flight — what general readers
// (history, counts, context, unanswered-thread checks) must hide. Both
// reservation families age out of the hide on their own hold: a review-ask
// placeholder past REVIEW_ASK_RESERVATION_HOLD_HOURS, a reply placeholder
// past REPLY_RESERVATION_HOLD_HOURS.
function isUnresolvedSendReservation(row, now = Date.now()) {
  const metadata = unresolvedMetadata(row);
  if (!metadata) return false;
  const createdAt = row.created_at ? new Date(row.created_at).getTime() : NaN;
  const withinHold = (holdMs) => !Number.isFinite(createdAt) || createdAt >= now - holdMs;
  if (metadata[REVIEW_ASK_MARKER] === true) return withinHold(REVIEW_ASK_RESERVATION_HOLD_MS);
  if (!REPLY_RESERVATION_MARKERS.some(marker => metadata[marker] === true)) return false;
  return withinHold(REPLY_RESERVATION_HOLD_MS);
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
      + `(COALESCE(${table}.metadata->>'${REVIEW_ASK_MARKER}', 'false') = 'true' AND ${table}.created_at >= NOW() - INTERVAL '${REVIEW_ASK_RESERVATION_HOLD_HOURS} hours')`
      + ` OR ((${replyMarkers}) AND ${table}.created_at >= NOW() - INTERVAL '${REPLY_RESERVATION_HOLD_HOURS} hours')))`,
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Lifecycle: create / release / promote a review-ask reservation.
//
// Every function below accepts a `trx` (or falls back to the module-level
// db) so a caller already holding the request-row lock in a transaction
// keeps the reservation write inside it.
// ─────────────────────────────────────────────────────────────────────────

let dbSingleton = null;
function defaultDb() {
  if (!dbSingleton) dbSingleton = require('../../models/db');
  return dbSingleton;
}

// Idempotent: reuses an existing UNRESOLVED reservation for this exact
// review_request_id instead of ever inserting a second one. Codex #4331 P2
// (structural pass, finding 2): a retry after a lost COMMIT acknowledgement
// (the write actually landed, but the caller never saw the response) used
// to insert a SECOND 'sending' row, and a later definitive not_sent deleted
// only the one it knew about — the other stood as ask-spacing evidence for
// the full 72h with nothing behind it. The caller is expected to already
// hold the request row's lock (the conditional status UPDATE the ask-branch
// callers run first) so this lookup-then-insert can't itself race a second
// reservation for the same request.
// Reuse is bounded by REVIEW_ASK_RESERVATION_HOLD_HOURS: an existing
// reservation older than its own hold is RENEWED in place (same row,
// created_at/updated_at reset to now) rather than reused as-is or
// replaced — see the comment at the renewal site for why (codex #4331 P1,
// pre-push audit on the seam itself).
async function reserveForRequest({ trx, request, to, body, fromPhone }) {
  const conn = trx || defaultDb();
  const existing = await conn('sms_log')
    .where({ status: 'sending' })
    .whereRaw("metadata->>'review_request_id' = ?", [String(request.id)])
    .whereRaw(`metadata->>'${REVIEW_ASK_MARKER}' = 'true'`)
    .first('id', 'created_at');
  if (existing) {
    const ageMs = Date.now() - new Date(existing.created_at).getTime();
    if (ageMs < REVIEW_ASK_RESERVATION_HOLD_MS) {
      return { id: existing.id, reservedAt: new Date(existing.created_at), requestId: request.id, reused: true };
    }
    // codex #4331 P1 (pre-push audit on the seam itself): an unresolved
    // reservation older than its own hold has already aged out of
    // isUnresolvedSendReservation's hide and out of the spacing window a
    // fresh retryAt would be computed from — reusing its stale created_at
    // as-is would compute a retryAt in the past (uncertain-outcome handling
    // adds ASK_SPACING_MS to reservedAt) and let it read as resolved-and-
    // gone to any reader keyed on the 72h hold, WHILE this new attempt is
    // relying on it as its own in-flight marker.
    //
    // RENEWED IN PLACE (chosen over delete+insert): the SAME row keeps its
    // id — nothing downstream ever sees a second row, so releaseUnsent /
    // promote / the general-reader predicates all keep working against
    // whichever id a caller already holds. Resetting created_at (and
    // updated_at) to now is the one write that keeps every reader's
    // semantics correct at once: isUnresolvedSendReservation's hide
    // restarts its 72h window from the new attempt (it is genuinely in
    // flight again), the spacing readers compute retryAt/lastManualAskAt
    // off the new timestamp instead of a stale one already in the past,
    // and any age-based cleanup of expired reservations no longer matches
    // a row that is actively being retried. A delete+insert would achieve
    // the same reader semantics but hands out a new id for no benefit and
    // reintroduces a (small) window where the row briefly doesn't exist at
    // all inside the same transaction.
    const renewedAt = new Date();
    await conn('sms_log').where({ id: existing.id, status: 'sending' }).update({
      from_phone: fromPhone,
      to_phone: to,
      message_body: body,
      created_at: renewedAt,
      updated_at: renewedAt,
    });
    return { id: existing.id, reservedAt: renewedAt, requestId: request.id, reused: true, renewed: true };
  }
  const reservedAt = new Date();
  const [reservation] = await conn('sms_log').insert({
    customer_id: request.customer_id,
    direction: 'outbound',
    from_phone: fromPhone,
    to_phone: to,
    message_body: body,
    status: 'sending',
    message_type: 'review',
    metadata: JSON.stringify({ [REVIEW_ASK_MARKER]: true, review_request_id: request.id }),
    created_at: reservedAt,
    updated_at: reservedAt,
  }).returning('id');
  if (!reservation?.id) throw new Error(`Could not reserve review ask before sending (requestId=${request.id})`);
  return { id: reservation.id, reservedAt, requestId: request.id, reused: false };
}

// Deletes every unresolved review-ask reservation for a request. This is
// the ONE routine every "proven this ask was not/no-longer usably delivered"
// exit calls — a real send stamped sent, a definitive not_sent, a blocked
// policy refusal, a claim lost to another sender, or a stranded-send sweep
// that proved no delivery. Deletes rather than merely marking, matching the
// pre-existing convention (releaseReviewSmsReservation): the request row
// itself, not this placeholder, is the durable record.
async function releaseUnsent({ trx, requestId }) {
  if (!requestId) return 0;
  const conn = trx || defaultDb();
  return conn('sms_log')
    .where({ status: 'sending' })
    .whereRaw("metadata->>'review_request_id' = ?", [String(requestId)])
    .whereRaw(`metadata->>'${REVIEW_ASK_MARKER}' = 'true'`)
    .del();
}

// Deletes one reservation row by its own id — for a caller (the
// admin-communications.js composer seam) that tracks the reservation by id
// rather than by review_request_id (its reservation metadata carries no
// review_request_id; the row is correlated to the send purely through the
// caller's own in-memory state).
async function releaseById({ trx, id }) {
  if (!id) return 0;
  const conn = trx || defaultDb();
  return conn('sms_log').where({ id }).del();
}

// Turn an ask reservation into durable delivery evidence: the provider
// accepted, so this is no longer an unresolved in-flight marker and the
// expiry sweep must never reclaim it.
async function promote({ trx, reservation }) {
  if (!reservation?.id) return false;
  const conn = trx || defaultDb();
  const logger = require('../logger');
  try {
    const promoted = await conn('sms_log').where({ id: reservation.id, status: 'sending' })
      .update({ status: 'sent', updated_at: new Date() });
    if (!promoted) return false;
    logger.warn(`[review] SMS accepted but its request row is unstamped — reservation kept as delivery evidence (requestId=${reservation.requestId || 'n/a'})`);
    return true;
  } catch (err) {
    logger.warn(`[review] review SMS reservation promotion failed (requestId=${reservation.requestId || 'n/a'}): ${err.message}`);
    return false;
  }
}

module.exports = {
  isUnresolvedReviewAskReservation,
  isUnresolvedSendReservation,
  excludeUnresolvedSendReservations,
  SEND_RESERVATION_MARKERS,
  REPLY_RESERVATION_HOLD_HOURS,
  REVIEW_ASK_RESERVATION_HOLD_HOURS,
  REVIEW_ASK_MARKER,
  reserveForRequest,
  releaseUnsent,
  releaseById,
  promote,
};
