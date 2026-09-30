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

// Completion-time customer messages (the completion/report text, the decline
// notice, a deferred completion replay) leave the pay link OUT while a dispute
// hold stands: the customer was told on the call that all billing follow-up
// is on hold. The report link and the rest of the message still send. Fail
// closed - a lookup failure answers true (omit the link) rather than risk a
// pay link reaching a disputing customer.
async function shouldWithholdPayLink(customerId, database = db) {
  if (!customerId) return false;
  try {
    return await customerHasActiveCollectionHold(customerId, database);
  } catch (err) {
    require('../logger').warn(`[collection-hold] pay-link hold lookup failed for customer ${customerId} - omitting the pay link: ${err.message}`);
    return true;
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
// admin and a distinct autopay event. The charge primitives call this AT the
// charge boundary (the same place the default guard would have refused), so a
// hold that lands between the route and the charge is still attributed.
// `database` is the transaction the primitive already holds. Best-effort - a
// failed lookup or write only logs, it never blocks or fails the charge.
async function recordHoldOverride({ customerId, actorId = null, ip = null, userAgent = null, route = null, invoiceId = null, database = db }) {
  try {
    // On a caller's transaction the lookup runs in a SAVEPOINT: a failed query
    // would otherwise leave that transaction aborted (25P02) and turn this
    // best-effort trail into a blocked charge on the next statement.
    const held = database?.isTransaction && typeof database.transaction === 'function'
      ? await database.transaction((sp) => customerHasActiveCollectionHold(customerId, sp))
      : await customerHasActiveCollectionHold(customerId, database);
    if (!held) return false;
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

// ---------------------------------------------------------------------------
// Withheld pay link marker (owner ruling 2026-09-30: releasing a dispute hold
// SENDS every invoice whose pay link the hold withheld, immediately).
//
// While a dispute hold stands, three completion lanes leave the visit invoice
// a DRAFT that nobody sends: the single-visit completion text goes report-only,
// a deferred completion replay strips its pay link, and a grouped-stop packet
// closeout reports payment_pending. Each stamps the invoice with
// HOLD_WITHHELD_SEND_ERROR at that moment, in invoices.scheduled_send_error
// (the codebase's existing durable stamp column for a draft's send state - see
// `payer_billed:` and `renewal_send_withheld:`; invoices has no metadata
// column, so no migration). The marker is the ONLY thing the release looks
// for, so a release never sends an unrelated draft. Invoices withheld before
// this shipped carry no marker; the office sends those by hand.
//
// releaseWithheldInvoices is the one claim: a single UPDATE moves a marked,
// still-draft, self-pay, unpaid invoice onto the normal scheduled-send queue
// (status 'scheduled', scheduled_send_at now - the same idiom the packet
// closeout uses) and clears the marker in the same statement. The queue worker
// then applies the usual consent, suppression, quiet-hours and payer rules and
// the Day 3-90 reminder ladder starts from the send. Because the claim and the
// clear are one statement, however many paths call it (the office release, the
// deferred-replay retry) an invoice is queued at most once.
// ---------------------------------------------------------------------------
const HOLD_WITHHELD_SEND_ERROR = 'dispute_hold_pay_link_withheld';

// Stamp a draft invoice as withheld by the hold. Only a draft with no other
// send stamp (NULL / empty) is marked: a payer_billed:, renewal or park stamp
// carries its own meaning and is never overwritten. Best-effort by design -
// callers log a failure and carry on; the completion itself must not fail.
async function markInvoiceWithheldByHold(invoiceId, database = db) {
  if (!invoiceId) return false;
  // On a caller's transaction the write runs in a SAVEPOINT so a failed
  // statement cannot leave the caller's transaction aborted (25P02).
  if (database.isTransaction && typeof database.transaction === 'function') {
    return database.transaction((sp) => stampWithheld(invoiceId, sp));
  }
  return stampWithheld(invoiceId, database);
}

async function stampWithheld(invoiceId, database) {
  const n = await database('invoices')
    .where({ id: invoiceId, status: 'draft' })
    .whereNull('payer_id')
    .whereNull('sent_at')
    .where((q) => q.whereNull('scheduled_send_error').orWhere('scheduled_send_error', ''))
    .update({ scheduled_send_error: HOLD_WITHHELD_SEND_ERROR, updated_at: database.fn.now() });
  return Number(n) > 0;
}

// Queue the invoices the hold withheld. `customerId` = every marked invoice of
// that customer (the office release); `invoiceId` = one (a retry that finds the
// hold gone). Returns { queued: [ids], cleared: n }. Nothing moves while the
// customer still has an active dispute hold (checked inside the UPDATE itself,
// so a hold landing mid-release wins). Marked rows that are no longer sendable
// (paid, void, refunded, already sent, payer-owned) only lose the marker.
async function releaseWithheldInvoices({ customerId = null, invoiceId = null, database = db } = {}) {
  if (!customerId && !invoiceId) return { queued: [], cleared: 0 };
  const scope = (q) => {
    q.where('scheduled_send_error', HOLD_WITHHELD_SEND_ERROR);
    if (invoiceId) q.where({ id: invoiceId });
    if (customerId) q.where({ customer_id: customerId });
    return q.whereNotExists(function noActiveDisputeHold() { disputeHoldExistsSql(this, 'invoices.customer_id'); });
  };
  const queued = await scope(database('invoices'))
    .where({ status: 'draft' })
    .whereNull('payer_id').whereNull('payer_statement_id')
    .whereNull('paid_at').whereNull('sent_at').whereNull('sms_sent_at').whereNull('email_sent_at')
    .update({
      status: 'scheduled', scheduled_send_at: database.fn.now(), scheduled_send_attempts: 0,
      scheduled_send_error: null, updated_at: database.fn.now(),
    })
    .returning('id');
  const cleared = await scope(database('invoices')).update({ scheduled_send_error: null, updated_at: database.fn.now() });
  return { queued: queued.map((r) => (r && typeof r === 'object' ? r.id : r)), cleared: Number(cleared) || 0 };
}

module.exports = {
  markInvoiceWithheldByHold,
  releaseWithheldInvoices,
  HOLD_WITHHELD_SEND_ERROR,
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
  shouldWithholdPayLink,
  assertNoCollectionHold,
  collectionHoldInvoiceIds,
};
