/**
 * Active DISPUTE hold (collections_flags collection_hold) as a money-movement
 * stop.
 *
 * A dispute raised on a collections voice call writes a customer-level
 * `collection_hold` flag (outbound-voice/flags.js placeDisputeHold) and tells
 * the customer "all billing follow-up is on hold". Every OFF-SESSION charge
 * primitive (StripeService.charge, chargeInvoiceWithSavedCard,
 * chargeSavedPaymentMethodOffSession) checks it by DEFAULT and refuses before
 * any Stripe call; a customer- or operator-initiated caller opts out
 * explicitly (`customerInitiated` / `operatorOverride`). The completion
 * balance sweep and pay-combined also fold it into "dunning stopped"
 * (completion-balance-sweep.dunningStoppedInvoiceIds).
 *
 * ONLY dispute holds stop money. collection_hold is also written as a
 * fallback ARTIFACT when a wrong-number / wrong-party report could not be
 * filed (collections-conversation.js) — those rows mean "pause outreach",
 * not "don't charge the saved card", so they must not stop a charge. The
 * discriminator is the row's reason text: placeDisputeHold writes
 * `dispute on call: <summary>` or `dispute raised on call`
 * (DISPUTE_REASON_PREFIX), the fallbacks write `wrong-number report ...` /
 * `wrong-party answer ...`. Rows written before this change carry the same
 * strings, so no backfill or migration is needed. A dispute raised while a
 * fallback hold is already active upgrades that row's reason (flags.js), so
 * the one-active-row-per-flag index can never hide a dispute.
 *
 * The flag row is the single source of truth: an unreleased row
 * (released_at IS NULL) holds; releaseFlag stamps released_at and every
 * lane resumes on its next attempt. There is deliberately NO cross-writer
 * locking: the hold writer must never wait on, or fail because of, a charge
 * in flight. A charge sees every hold that committed before its check; a
 * hold committing in the milliseconds after the check races the charge
 * exactly like a dispute call landing just after the card was charged.
 *
 * Refusal codes (both thrown BEFORE any Stripe call, both RETRYABLE):
 *   COLLECTION_HOLD_ACTIVE        a dispute hold is active
 *   COLLECTION_HOLD_CHECK_FAILED  the lookup itself failed (fail closed)
 * Callers must treat them as "not attempted, retry after release": never a
 * decline, a payer refusal or a handled outcome, and never a payment-failed
 * message or pay link.
 */

const db = require('../../models/db');

const HOLD_FLAG = 'collection_hold';
const DISPUTE_REASON_PREFIX = 'dispute';
const HOLD_ACTIVE_CODE = 'COLLECTION_HOLD_ACTIVE';
const HOLD_CHECK_FAILED_CODE = 'COLLECTION_HOLD_CHECK_FAILED';
const isCollectionHoldRefusal = (err) => err?.code === HOLD_ACTIVE_CODE || err?.code === HOLD_CHECK_FAILED_CODE;

// Restrict a collections_flags query to ACTIVE DISPUTE holds.
function activeDisputeHolds(query) {
  return query
    .where({ flag: HOLD_FLAG })
    .whereNull('released_at')
    .whereRaw('reason ILIKE ?', [`${DISPUTE_REASON_PREFIX}%`]);
}

// The same discriminator as a correlated EXISTS body for queries that join
// through their own alias (termite grace-lapse scans): `this` is the
// whereExists/whereNotExists builder and `outerCustomerColumn` e.g. 'tt.customer_id'.
function disputeHoldExistsSql(builder, outerCustomerColumn) {
  return builder.select(1).from('collections_flags as f')
    .whereRaw('f.customer_id = ??', [outerCustomerColumn])
    .where('f.flag', HOLD_FLAG)
    .whereNull('f.released_at')
    .whereRaw('f.reason ILIKE ?', [`${DISPUTE_REASON_PREFIX}%`]);
}

async function customerHasActiveCollectionHold(customerId, database = db) {
  if (!customerId) return false;
  const row = await activeDisputeHolds(database('collections_flags').where({ customer_id: customerId })).first('id');
  return !!row;
}

// Same answer, but a lookup failure throws COLLECTION_HOLD_CHECK_FAILED
// (fail closed, retryable) instead of the raw DB error.
async function customerHasActiveCollectionHoldChecked(customerId, database = db) {
  try {
    return await customerHasActiveCollectionHold(customerId, database);
  } catch (err) {
    throw Object.assign(new Error(`Collection hold could not be verified (${err.message}). Review before charging.`), {
      code: HOLD_CHECK_FAILED_CODE,
      cause: err,
    });
  }
}

// The default-on guard the off-session charge primitives call. Throws the
// coded refusal; returns nothing when clear.
async function assertNoCollectionHold(customerId, database = db) {
  if (await customerHasActiveCollectionHoldChecked(customerId, database)) {
    throw Object.assign(new Error('Collection is on hold for this customer (billing dispute). Review before charging.'), {
      code: HOLD_ACTIVE_CODE,
    });
  }
}

// Set of (stringified) invoice ids whose customer has an active dispute hold.
async function collectionHoldInvoiceIds(invoiceIds, { database = db } = {}) {
  if (!invoiceIds || !invoiceIds.length) return new Set();
  const invoices = await database('invoices')
    .whereIn('id', invoiceIds)
    .select('id', 'customer_id');
  const customerIds = [...new Set(invoices.map((r) => r.customer_id).filter(Boolean).map(String))];
  if (!customerIds.length) return new Set();
  const flags = await activeDisputeHolds(database('collections_flags').whereIn('customer_id', customerIds))
    .select('customer_id');
  const held = new Set(flags.map((r) => String(r.customer_id)));
  return new Set(invoices.filter((r) => r.customer_id && held.has(String(r.customer_id))).map((r) => String(r.id)));
}

// An operator-ordered charge (operatorOverride) goes past an active dispute
// hold. It is never blocked, but it must leave a trail: an audit row naming the
// admin and a distinct autopay event. Best-effort - a failed lookup or write
// only logs, it never blocks or fails the charge.
async function recordHoldOverride({ customerId, actorId = null, ip = null, userAgent = null, route, invoiceId = null }) {
  try {
    if (!(await customerHasActiveCollectionHold(customerId))) return false;
    const { recordAuditEvent } = require('../audit-log');
    const { logAutopay } = require('../autopay-log');
    await recordAuditEvent({
      actor_type: 'technician',
      actor_id: actorId,
      action: 'customer.collection_hold_overridden',
      resource_type: 'customer',
      resource_id: customerId,
      metadata: { route, invoice_id: invoiceId },
      ip_address: ip,
      user_agent: userAgent,
      critical: false,
    });
    await logAutopay(customerId, 'collection_hold_overridden', { details: { route, invoice_id: invoiceId, admin_id: actorId } });
    return true;
  } catch (err) {
    require('../logger').warn(`[collection-hold] override trail failed for customer ${customerId}: ${err.message}`);
    return false;
  }
}

module.exports = {
  recordHoldOverride,
  activeDisputeHolds,
  disputeHoldExistsSql,
  HOLD_FLAG,
  DISPUTE_REASON_PREFIX,
  HOLD_ACTIVE_CODE,
  HOLD_CHECK_FAILED_CODE,
  isCollectionHoldRefusal,
  customerHasActiveCollectionHold,
  customerHasActiveCollectionHoldChecked,
  assertNoCollectionHold,
  collectionHoldInvoiceIds,
};
