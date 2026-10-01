'use strict';

/**
 * Text-leg idempotency for the explicit billing-channel router
 * (billing-channel-routing.js's dispatchBillingChannels -> sendBillingLeg
 * -> the per-leg recursive sendCustomerMessageCore in
 * send-customer-message.js).
 *
 * Email and App already dedupe an explicit billing leg against the SAME
 * notificationEventKey a replay (a producer's deferred replay row
 * re-entering the router) re-fans-out under:
 *   - Email: idempotencyKey `billing_channel_email:${notificationEventKey}:email`
 *     (billing-channel-email.js), enforced by email-template-library.js's
 *     idempotency_key lookup + unique-violation collision handling
 *     (email_messages.idempotency_key is a real UNIQUE index).
 *   - App:   notifyCustomer(..., { dedupeKey: notificationEventKey })
 *     (push-channel-routing.js ~475), enforced by notification-service.js's
 *     pg_advisory_xact_lock(hashtext('<customerId>:<dedupeKey>')) + a
 *     metadata dedupeKey lookup, both inside one transaction.
 * Text had NO event dedupe at all — a replay re-texted a customer whose
 * Text already went out. This module closes that gap.
 *
 * There is no unique index backing this lookup the way email_messages has
 * one for idempotency_key (adding one is a migration, and pushed
 * migrations are frozen), so correctness comes from a NONBLOCKING CLAIM,
 * not a constraint, and NOT from holding a transaction across the Twilio
 * HTTP call: `DB_POOL_MAX`/knexfile's pool minimum is 2 in production, and
 * holding a connection for a whole provider round trip would let two
 * concurrent billing Text legs occupy both pool connections and stall a
 * third caller on acquisition. Every DB touch here is a short, local
 * transaction that commits (releasing its connection) BEFORE `send()` is
 * ever called:
 *
 *   1. Inside one short transaction: pg_try_advisory_xact_lock (NON-
 *      blocking — a caller that can't get it returns a schedulable
 *      BILLING_TEXT_LEG_IN_FLIGHT hold instead of waiting on a connection),
 *      then check for a prior ACCEPTED Text for this customer+notice (a
 *      dedupe hit — see findAcceptedBillingTextLeg), then check for a
 *      live (unexpired) claim someone else already holds for this exact
 *      key (also BILLING_TEXT_LEG_IN_FLIGHT), else write our own claim row
 *      and commit.
 *   2. `send()` runs with NO connection held.
 *   3. The claim is cleared (best-effort, logged) ONLY on a definite
 *      outcome (settleClaim):
 *        - 'not_sent': nothing reached Twilio, so a replay may send.
 *        - 'accepted' AND a durable accepted row for this key is already
 *          visible (findAcceptedBillingTextLeg) — a replay's step 1 lookup
 *          dedupes on that row instead.
 *      'accepted' with no durable row yet (twilio.js's primary log insert
 *      failed, or the provider-handoff reservation is promoted by
 *      send-customer-message.js only after this wrapper returns) keeps the
 *      claim and stamps the accepted SID on it; step 1 treats a stamped
 *      claim as a dedupe hit, never a resend. Anything else — 'uncertain'
 *      (a Twilio timeout the adapter RETURNS rather than throws), a missing
 *      outcome, or send() THROWING — keeps the claim unstamped: delivery is
 *      unknown, so it ages into the stale-claim operator hold below.
 *      A delete that keeps failing after a definite outcome marks the
 *      claim release_pending (releaseClaim) instead, so it is cleared by
 *      the next attempt or the releasePending sweep, never read as live.
 *
 * The claim is a plain sms_log row (no new table, no index) — the SAME
 * table the reply/review-ask send reservations already use for exactly
 * this "placeholder inserted just before the provider call" shape
 * (sms-suggest-mode.js's createReplyHoldingReservation) — but with its OWN
 * marker (`billing_text_leg_claim`), never one of REPLY_RESERVATION_MARKERS
 * (review-ask-reservation.js): those markers are read directly (as literal
 * strings, not the shared constant) by sms-suggest-mode.js's and
 * sms-auto-send.js's own reply-in-flight/cleanup sweeps, which are scoped
 * by PHONE thread, not by customer+notice — reusing one of those markers
 * would make an unrelated billing text visible to (and possibly swept by)
 * that machinery. General sms_log readers (customer-health, the context
 * aggregator, the click follow-up gate, …) hide it through the shared
 * excludeUnresolvedSendReservations / isUnresolvedSendReservation, which
 * treat BILLING_TEXT_LEG_CLAIM_MARKER as a synthetic placeholder hidden
 * while 'sending' at any age — a claim can persist (see step 3), and an
 * empty row must never read as customer contact. The scheduled-SMS
 * recovery sweeps in scheduler.js require `scheduled_for IS NOT NULL`,
 * which this claim never sets. `findAcceptedBillingTextLeg` applies the
 * shared exclusion too, on top of its own status filter.
 *
 * A claim can outlive its own send when the owning process crashes or is
 * killed between claiming and settling. CLAIM_STALE_MS (5 minutes — far
 * longer than a Twilio REST round trip or a pool-acquisition wait, and the
 * same constant this module already uses for its own infra-failure retry
 * delay) is the line: past it, delivery is genuinely UNKNOWN, so a later
 * attempt returns a non-retryable held result instead of resending (which
 * could double-text a customer whose earlier attempt actually went out) or
 * silently dropping the notice. It logs an error naming the customer and
 * key for operator review; nothing here clears a stale claim automatically.
 *
 * Scope: explicit billing Text legs ONLY —
 * metadata.billingDeliveryLeg === 'sms' with a non-empty
 * metadata.notificationEventKey and a customerId. A legacy SMS send (no
 * billingDeliveryLeg — every other caller of send-customer-message.js /
 * TwilioService.sendSMS) or a non-billing send never reaches the lookup at
 * all and is byte-identical to before this lane.
 */

const db = require('../../models/db');
const logger = require('../logger');
const {
  excludeUnresolvedSendReservations,
  BILLING_TEXT_LEG_CLAIM_MARKER: CLAIM_MARKER,
} = require('./review-ask-reservation');

// A provider handoff Twilio genuinely accepted for this exact notice.
// Never 'failed'/'blocked' (a refused attempt still owes a resend) and
// never 'scheduled'/'sending' — a producer's own queued/in-flight replay
// row for this same key (or our own in-flight claim) IS the replay
// currently under way, not prior acceptance evidence, and must not dedupe
// itself away. A provider-handoff reservation Twilio accepted is promoted
// to status 'sent' in place (sms-suggest-mode.js's
// settleReplyHoldingReservation) with this leg's billingDeliveryLeg/
// notificationEventKey carried over from twilio.js's providerSmsMetadata,
// so it satisfies this same filter with no special case needed here.
const ACCEPTED_STATUSES = ['queued', 'sent', 'delivered'];

// Retry/hold windows. DEDUPE_RETRY_MS mirrors send-customer-message.js's
// own DEFAULT_PROVIDER_RETRY_DELAY_MS (5 min) for an infra failure.
// IN_FLIGHT_RETRY_MS is short — the attempt actually in flight is a single
// Twilio round trip, seconds, not minutes. CLAIM_STALE_MS is documented at
// the top of this file.
const DEDUPE_RETRY_MS = 5 * 60 * 1000;
const IN_FLIGHT_RETRY_MS = 2 * 60 * 1000;
const CLAIM_STALE_MS = 5 * 60 * 1000;

// sms_log.from_phone is varchar(20) — this sentinel must fit (mirrors
// push-channel-routing.js's own short 'push' sentinel for the same reason).
const CLAIM_FROM_PHONE = 'billing-text-claim';

function lockKey(customerId, notificationEventKey) {
  return `billing_text_leg:${customerId}:${notificationEventKey}`;
}

// Durable evidence a Text leg for this exact customer + notice already
// reached the provider. Status-scoped to ACCEPTED_STATUSES (excludes
// 'sending'/'scheduled'), so an unresolved review-ask/reply send
// reservation — or our own in-flight claim — cannot match structurally
// either way; excludeUnresolvedSendReservations applied on top regardless
// (see the file header).
//
// Two row shapes count. A row with billingDeliveryLeg 'sms' (what
// twilio.js persists for an explicit billing Text leg from this lane on),
// or a PRE-MARKER row: twilio.js already stamped notificationEventKey on
// accepted rows before billingDeliveryLeg existed, so a text accepted
// before this deploy carries this notice's exact key with no leg marker.
// That arm is held to a real Twilio message SID (SM…/MM…), which an App
// push proof row or an Email record never has, and to a NULL marker, so an
// explicit 'push'/'email' leg row can never read as a sent text.
async function findAcceptedBillingTextLeg(conn, customerId, notificationEventKey) {
  return excludeUnresolvedSendReservations(
    conn('sms_log')
      .where({ customer_id: customerId, direction: 'outbound' })
      .whereRaw("metadata->>'notificationEventKey' = ?", [notificationEventKey])
      .where(function textLeg() {
        this.whereRaw("metadata->>'billingDeliveryLeg' = 'sms'")
          .orWhere(function preMarkerText() {
            this.whereRaw("metadata->>'billingDeliveryLeg' IS NULL")
              .whereRaw("(twilio_sid LIKE 'SM%' OR twilio_sid LIKE 'MM%')");
          });
      })
      .whereIn('status', ACCEPTED_STATUSES),
  )
    .orderBy('created_at', 'desc')
    .first(['twilio_sid', 'created_at']);
}

// A live (still 'sending') claim for this exact customer + notice — ours
// or a concurrent attempt's. Never excludeUnresolvedSendReservations here:
// this IS the in-flight row we're deliberately looking for, not a general
// "recent messages" read.
async function findLiveClaim(conn, customerId, notificationEventKey) {
  return conn('sms_log')
    .where({ customer_id: customerId, direction: 'outbound', status: 'sending' })
    .whereRaw(`metadata->>'${CLAIM_MARKER}' = 'true'`)
    .whereRaw("metadata->>'notificationEventKey' = ?", [notificationEventKey])
    .orderBy('created_at', 'desc')
    .first(['id', 'created_at', 'metadata']);
}

function claimMetadata(claim) {
  const raw = claim?.metadata;
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw) || {}; } catch { return {}; }
}

// A claim settleClaim stamped after Twilio accepted the send (see step 3
// in the file header). Returns the accepted SID, or null.
function acceptedClaimSid(claim) {
  const sid = claimMetadata(claim).acceptedProviderMessageId;
  return typeof sid === 'string' && sid ? sid : null;
}

async function insertClaim(conn, customerId, notificationEventKey, input) {
  const [inserted] = await conn('sms_log')
    .insert({
      customer_id: customerId,
      direction: 'outbound',
      from_phone: CLAIM_FROM_PHONE,
      to_phone: String(input?.to || '').slice(0, 20),
      message_body: '',
      status: 'sending',
      created_at: new Date(),
      message_type: 'billing_text_leg_claim',
      metadata: JSON.stringify({
        [CLAIM_MARKER]: true,
        billingDeliveryLeg: 'sms',
        notificationEventKey,
      }),
    })
    .returning('id');
  return inserted?.id || inserted || null;
}

// Runs only after a DEFINITE outcome (settleClaim). A claim left behind
// here would read as in flight to every later attempt and then age into
// the stale operator hold, suppressing a text that never went out. So the
// delete gets ONE retry, and if that also throws the claim is marked
// release_pending: the next attempt for this notice clears it under the
// key's lock (claimOrResolve), and review-ask-reservation.js's
// releasePending sweep deletes it on the review-reconcile cadence — the
// same durable-ownership shape review-ask reservations use. Only if even
// the mark fails (the database is down) does the claim fall back to the
// stale hold, which fails safe: an operator sees it, nothing resends.
async function releaseClaim(claimId) {
  if (!claimId) return;
  const claimRow = () => db('sms_log')
    .where({ id: claimId, status: 'sending' })
    .whereRaw(`metadata->>'${CLAIM_MARKER}' = 'true'`);
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await claimRow().del();
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  try {
    await claimRow().update({
      metadata: db.raw('metadata || ?::jsonb', [JSON.stringify({ release_pending: true })]),
    });
    logger.warn(`[billing-text-leg-dedupe] claim ${claimId} release failed twice (${lastErr.message}) — marked release_pending`);
  } catch (err) {
    logger.error(
      `[billing-text-leg-dedupe] claim ${claimId} release and release_pending mark both failed (${err.message}) — `
      + 'it ages into the stale-claim operator hold',
    );
  }
}

// Twilio accepted, but no durable accepted row is visible yet: keep the
// claim and record the acceptance on it so a replay dedupes off the claim
// itself. Metadata only — never twilio_sid: the Twilio status webhook
// matches sms_log rows by SID and would settle this claim into a visible
// history row. If even this write fails, the unstamped claim still ages into
// staleClaimHold (operator review) — never a resend.
async function stampAcceptedClaim(claimId, result) {
  const sid = result?.providerMessageId || '';
  if (!claimId || !sid) return false;
  try {
    const updated = await db('sms_log')
      .where({ id: claimId, status: 'sending' })
      .whereRaw(`metadata->>'${CLAIM_MARKER}' = 'true'`)
      .update({
        metadata: db.raw("metadata || ?::jsonb", [JSON.stringify({
          acceptedProviderMessageId: String(sid),
          acceptedAt: result.sentAt || new Date().toISOString(),
        })]),
      });
    return Number(updated) > 0;
  } catch (err) {
    logger.error(`[billing-text-leg-dedupe] could not record acceptance on claim ${claimId}: ${err.message}`);
    return false;
  }
}

// Step 3 of the file header: release the claim only on a definite outcome.
async function settleClaim(claimId, customerId, notificationEventKey, result) {
  const outcome = result?.deliveryOutcome;
  if (outcome === 'not_sent') {
    await releaseClaim(claimId);
    return;
  }
  if (outcome === 'accepted' && result?.sent === true) {
    let durable = null;
    try {
      durable = await findAcceptedBillingTextLeg(db, customerId, notificationEventKey);
    } catch (err) {
      logger.warn(`[billing-text-leg-dedupe] durable-acceptance check failed for claim ${claimId}: ${err.message}`);
    }
    if (durable) {
      await releaseClaim(claimId);
      return;
    }
    if (await stampAcceptedClaim(claimId, result)) return;
  }
  logger.warn(
    `[billing-text-leg-dedupe] keeping claim ${claimId} for customer ${customerId}, key ${notificationEventKey} `
    + `(outcome ${outcome || 'missing'}) — delivery not proven either way, never auto-resent`,
  );
}

function isStaleClaim(claim, now = Date.now()) {
  const createdAt = claim?.created_at ? new Date(claim.created_at).getTime() : NaN;
  return !Number.isFinite(createdAt) || now - createdAt >= CLAIM_STALE_MS;
}

// Same shape family as the Email/App deduped results (billing-channel-
// email.js's acceptedResult spreading result.deduped;
// email-template-library.js's dedupedResultForExistingMessage;
// push-channel-routing.js's appNotification?.push?.deduped branch): sent +
// accepted + deduped, carrying the ORIGINAL provider evidence so
// downstream readers (e.g. send-customer-message.js's
// recordReceiptSmsDelivery, which regex-matches providerMessageId against
// a real Twilio SID) see the real sid, not a synthetic one.
function dedupedAcceptance(row) {
  return {
    sent: true,
    provider: 'twilio',
    deliveryOutcome: 'accepted',
    deduped: true,
    providerMessageId: row.twilio_sid || null,
    sentAt: row.created_at,
  };
}

// Schedulable: something else (a genuinely concurrent replay) is working
// this exact key RIGHT NOW. In REPLAY_HOLD_CODES — the caller's replay
// retries shortly rather than resending or giving up.
function inFlightHold() {
  return {
    sent: false, blocked: true, deliveryOutcome: 'not_sent', code: 'BILLING_TEXT_LEG_IN_FLIGHT',
    error: 'A concurrent attempt for this billing text is in flight', retryable: true, deferred: true,
    nextAllowedAt: new Date(Date.now() + IN_FLIGHT_RETRY_MS).toISOString(),
  };
}

// A claim outlived CLAIM_STALE_MS with no settlement — its owner almost
// certainly crashed mid-send, and delivery is genuinely unknown. NOT in
// REPLAY_HOLD_CODES and NOT retryable: this must surface to an operator,
// never silently resend (a real prior send may have gone out) or silently
// drop the notice.
function staleClaimHold(claim, customerId, notificationEventKey) {
  logger.error(
    `[billing-text-leg-dedupe] stale claim (>${Math.round(CLAIM_STALE_MS / 60000)}m) for customer ${customerId}, `
    + `key ${notificationEventKey} (claim id ${claim.id}, claimed at ${claim.created_at}) — `
    + 'delivery is unknown; held for operator review, never auto-resent',
  );
  return {
    sent: false, blocked: true, deliveryOutcome: 'uncertain', code: 'BILLING_TEXT_LEG_CLAIM_STALE',
    reason: 'A prior attempt for this billing text did not settle — delivery is unknown and this notice is held for operator review',
    retryable: false,
  };
}

// Runs entirely inside one short transaction: the non-blocking lock, the
// prior-acceptance lookup, the live-claim lookup, and (only if none of
// those resolve it) the claim insert. Returns { outcome } when the caller
// must not send (deduped / in-flight / stale), or { claimId } to proceed.
async function claimOrResolve(trx, customerId, notificationEventKey, input) {
  const acquired = await trx.raw('SELECT pg_try_advisory_xact_lock(hashtextextended(?, 0)) AS locked', [lockKey(customerId, notificationEventKey)]);
  const row = acquired?.rows?.[0];
  const locked = row?.locked === true || row?.locked === 't';
  if (!locked) return { outcome: inFlightHold() };

  const prior = await findAcceptedBillingTextLeg(trx, customerId, notificationEventKey);
  if (prior) return { outcome: dedupedAcceptance(prior) };

  const liveClaim = await findLiveClaim(trx, customerId, notificationEventKey);
  if (liveClaim) {
    const acceptedSid = acceptedClaimSid(liveClaim);
    if (acceptedSid) return { outcome: dedupedAcceptance({ twilio_sid: acceptedSid, created_at: liveClaim.created_at }) };
    if (claimMetadata(liveClaim).release_pending !== true) {
      return { outcome: isStaleClaim(liveClaim) ? staleClaimHold(liveClaim, customerId, notificationEventKey) : inFlightHold() };
    }
    // Its owner saw a definite outcome but could not delete it (releaseClaim):
    // clear it here, under this key's lock, and claim afresh — at any age.
    await trx('sms_log').where({ id: liveClaim.id, status: 'sending' }).del();
  }

  const claimId = await insertClaim(trx, customerId, notificationEventKey, input);
  return { claimId };
}

/**
 * Guards an explicit billing Text leg's check-then-send. `send` is the
 * caller's actual provider dispatch (a zero-arg thunk) — invoked EXACTLY
 * ONCE, whether or not this guard applies, and always with no database
 * connection held by this module.
 *
 * Not an explicit billing Text leg (no billingDeliveryLeg === 'sms', no
 * notificationEventKey, or no customerId) -> `send()` runs unprotected,
 * byte-identical to before this lane — no lock, no lookup, no claim.
 */
async function withBillingTextLegLock(input, send) {
  const metadata = input?.metadata || {};
  if (metadata.billingDeliveryLeg !== 'sms') return send();
  const notificationEventKey = String(metadata.notificationEventKey || '').trim();
  const customerId = input?.customerId;
  if (!notificationEventKey || !customerId) return send();

  let claimId;
  try {
    const claimed = await db.transaction((trx) => claimOrResolve(trx, customerId, notificationEventKey, input));
    if (claimed.outcome) return claimed.outcome;
    claimId = claimed.claimId;
  } catch (err) {
    // The lock/lookup/claim step failed before send() was ever considered.
    // Without it we can't rule out a prior accepted text, so fail CLOSED
    // with a schedulable hold rather than sending unprotected.
    logger.warn(`[billing-text-leg-dedupe] lock/lookup failed before send, holding for retry: ${err.message}`);
    return {
      sent: false, blocked: true, deliveryOutcome: 'not_sent', code: 'BILLING_TEXT_DEDUPE_UNAVAILABLE',
      error: 'Billing text dedupe state is unavailable', retryable: true, deferred: true,
      nextAllowedAt: new Date(Date.now() + DEDUPE_RETRY_MS).toISOString(),
    };
  }

  // A throw skips settleClaim entirely: delivery is unknown, so the claim
  // stays and ages into staleClaimHold (operator review), never a resend.
  const result = await send();
  await settleClaim(claimId, customerId, notificationEventKey, result);
  return result;
}

module.exports = {
  withBillingTextLegLock,
  findAcceptedBillingTextLeg,
  findLiveClaim,
  ACCEPTED_STATUSES,
  CLAIM_STALE_MS,
};
