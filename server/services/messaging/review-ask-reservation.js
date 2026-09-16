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
//
// REBUTTED FINDING (structural pass, "finding 6" / codex #4331 P1 pre-push
// audit on this seam): a review-ask reservation was given the SAME 72h age
// bound as a reply reservation, on the theory that a never-resolved
// placeholder should not hide from general readers forever. That bound has
// been REMOVED again for review-ask placeholders — they are excluded from
// general readers UNCONDITIONALLY, regardless of age. The two families are
// not the same risk:
//   - A reply reservation guards an AMBIGUOUS AUTOMATIC reply that may have
//     actually reached the customer. Hiding it forever would bury a real
//     sent message, so it surfaces after REPLY_RESERVATION_HOLD_HOURS for an
//     operator to see and settle.
//   - A review-ask reservation is SYNTHETIC. It is never itself a delivered
//     message — it is placeholder spacing evidence for an attempt that
//     either lands (and gets its own separately-logged row, or is promoted
//     to 'sent' in place) or doesn't. Letting an aged one surface to a
//     general reader is pure harm, not a safety net: these readers are not
//     display-only (csr-coach.verifyFollowUps marks a follow-up task
//     VERIFIED off exactly this kind of read; ContextAggregator feeds
//     composers a body with the reservation's status stripped) — an aged
//     'sending' placeholder from a crash before delivery would read as
//     genuine evidence the ask went out, when it never did.
// A stale, never-resolved review-ask reservation is instead resolved by the
// stranded-send reconciliation (review-request.js#_reconcileStrandedBatch:
// promote on provider evidence, release via releaseUnsent on proven-unsent)
// and, when that reconciliation's own review_requests claim never covers
// the row (an uncertain outcome that left the request 'pending' rather than
// 'sending'), exposed to an operator via the stale-reservation count folded
// into reconcileStrandedSends' own log line — never by quietly admitting it
// to a delivered-message reader once it ages out.

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
// NOT a general-reader hide bound (see the REBUTTED FINDING note above — a
// review-ask reservation is excluded from those readers unconditionally,
// any age). This is the ask-SPACING window only, mirroring ASK_SPACING_MS
// in review-ask-history.js, used in exactly two places: reserveForRequest's
// reuse-vs-renew decision (an existing unresolved reservation older than
// this is renewed in place rather than reused with a stale timestamp — a
// fresh delivery attempt must not compute its own retry math off a
// timestamp from a previous, long-over attempt) and the stale-reservation
// count reconcileStrandedSends logs for operator visibility.
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
// (history, counts, context, unanswered-thread checks) must hide.
function isUnresolvedSendReservation(row, now = Date.now()) {
  const metadata = unresolvedMetadata(row);
  if (!metadata) return false;
  // A review-ask placeholder is excluded UNCONDITIONALLY, any age (see the
  // REBUTTED FINDING note at the top of this file) — it is synthetic and
  // never itself a delivered message, so a general reader (csr-coach
  // follow-up verification, a composer's grounding context, an outbound
  // count) must never admit it once it ages past some window. It is
  // resolved by the stranded-send reconciliation, or surfaced to an
  // operator through that reconciliation's own stale-reservation count —
  // never by this predicate letting it through.
  if (metadata[REVIEW_ASK_MARKER] === true) return true;
  if (!REPLY_RESERVATION_MARKERS.some(marker => metadata[marker] === true)) return false;
  // A reply reservation guards an ambiguous AUTOMATIC reply that may have
  // actually reached the customer — bounded so a real send doesn't hide
  // forever (see REPLY_RESERVATION_HOLD_HOURS above).
  const createdAt = row.created_at ? new Date(row.created_at).getTime() : NaN;
  return !Number.isFinite(createdAt) || createdAt >= now - REPLY_RESERVATION_HOLD_MS;
}

// Excludes every unresolved send reservation at the SQL level (metadata is
// jsonb) — apply this to a query BEFORE any LIMIT/ORDER-then-slice so an
// unresolved placeholder can never displace a real row out of a bounded
// history window. `table` lets a caller that aliases or joins sms_log
// qualify the column; default matches a bare `db('sms_log')` query. Mirrors
// isUnresolvedSendReservation exactly: the review-ask arm is unconditional
// (any age), only the reply-marker arm carries an age bound.
function excludeUnresolvedSendReservations(query, table = 'sms_log') {
  const replyMarkers = REPLY_RESERVATION_MARKERS.map(marker => `COALESCE(${table}.metadata->>'${marker}', 'false') = 'true'`).join(' OR ');
  return query.whereRaw(
    `NOT (${table}.status = 'sending' AND (`
      + `COALESCE(${table}.metadata->>'${REVIEW_ASK_MARKER}', 'false') = 'true'`
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
// Reuse is bounded by REVIEW_ASK_RESERVATION_HOLD_HOURS (the ask-spacing
// window, NOT the general-reader hide — that stays unconditional, see the
// REBUTTED FINDING note above): an existing reservation older than its own
// spacing window is RENEWED in place (same row, created_at/updated_at reset
// to now) rather than reused as-is or replaced — see the comment at the
// renewal site for why (codex #4331 P1, pre-push audit on the seam itself).
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
    // reservation older than its own ask-spacing window is from a PRIOR
    // attempt whose spacing math is already over — reusing its stale
    // created_at as-is would compute a NEW retryAt in the past
    // (uncertain-outcome handling adds ASK_SPACING_MS to reservedAt), and
    // lastManualAskAt / _askSpacingHold would anchor the next hold on a
    // timestamp from an attempt that ended a long time ago, WHILE this new
    // attempt is relying on the same row as its own in-flight marker. (This
    // is purely a spacing-correctness fix — the row is excluded from
    // general readers unconditionally either way, at any age.)
    //
    // RENEWED IN PLACE (chosen over delete+insert): the SAME row keeps its
    // id — nothing downstream ever sees a second row, so releaseUnsent /
    // promote / the general-reader predicates all keep working against
    // whichever id a caller already holds. Resetting created_at (and
    // updated_at) to now is the write that keeps spacing correct for the
    // new attempt (retryAt / lastManualAskAt compute off the fresh
    // timestamp instead of a stale one already in the past) and keeps it
    // inside the window reconcileStrandedSends' stale-reservation count
    // uses, since it is actively being retried, not abandoned. A
    // delete+insert would reach the same spacing correctness but hands out
    // a new id for no benefit and reintroduces a (small) window where the
    // row briefly doesn't exist at all inside the same transaction.
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
//
// codex #4333 P1 (child-branch pre-push audit, "deduplicate promoted
// reservations against the actual provider log"): promote() is reached
// only when the accepted send's OWN separately-logged provider row exists
// or should exist independently of this placeholder (sendCustomerMessage
// logs the real send under the same metadata.review_request_id on its own
// — this reservation is redundant evidence, kept only in case that log
// write itself is what failed). Promoting unconditionally would leave TWO
// 'sent' outbound rows for one ask whenever the FAILURE was actually in the
// review_requests stamp or the reservation release, not the provider log:
// lastManualAskAt (review-ask-history.js) pairs at most one log row per
// review_requests.sms_sent_at, so the second row reads as an unmatched
// manual ask and can permanently stop a cadence (manual_ask_recent) that
// never saw a real manual send — and every OTHER general reader that
// counts raw outbound rows (customer-health's engagement score,
// signal-detector's NO_RESPONSE_MULTIPLE) double-counts the same delivered
// ask too. Consolidating HERE, before promoting, is what keeps every one
// of those readers correct at once without teaching each of them to
// correlate two rows by review_request_id — the invariant (at most one
// 'sent' row per delivered ask) holds at write time instead.
async function promote({ trx, reservation }) {
  if (!reservation?.id) return false;
  const conn = trx || defaultDb();
  const logger = require('../logger');
  try {
    if (reservation.requestId) {
      const realEvidence = await conn('sms_log')
        .where({ direction: 'outbound' })
        .whereIn('status', ['sent', 'delivered'])
        .whereNot('id', reservation.id)
        .whereRaw("metadata->>'review_request_id' = ?", [String(reservation.requestId)])
        .first('id');
      if (realEvidence) {
        // The real send already has its own row — this placeholder IS the
        // duplicate. Release it instead of promoting a second 'sent' row.
        await conn('sms_log').where({ id: reservation.id }).del();
        logger.warn(`[review] SMS accepted but its request row is unstamped — a separately-logged provider row already exists, so the reservation was released instead of promoted (requestId=${reservation.requestId})`);
        return true;
      }
    }
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

// Count of unresolved review-ask reservations older than the ask-spacing
// window — an operator-facing signal, not a cleanup action: reconciled and
// released via reconcileStrandedSends when its review_requests claim
// covers them; folded into that sweep's own log line (staleReservations=N)
// when it doesn't, so a stuck placeholder from a crash before delivery is
// visible without a dedicated view (the smallest honest exposure, per the
// pre-push audit — not a new reconciliation view).
async function countStaleUnresolved({ trx } = {}) {
  const conn = trx || defaultDb();
  const row = await conn('sms_log')
    .where({ status: 'sending' })
    .whereRaw(`metadata->>'${REVIEW_ASK_MARKER}' = 'true'`)
    .where('created_at', '<', new Date(Date.now() - REVIEW_ASK_RESERVATION_HOLD_MS))
    .count('* as c')
    .first();
  return parseInt(row?.c || 0, 10);
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
  countStaleUnresolved,
};
