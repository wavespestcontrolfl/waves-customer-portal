/**
 * Active collection_hold (collections_flags) as a money-movement stop.
 *
 * A dispute raised on a collections voice call writes a customer-level
 * `collection_hold` flag (outbound-voice/flags.js placeDisputeHold) and tells
 * the customer "all billing follow-up is on hold". The off-session charge
 * paths (completion balance sweep, the completion / extended autopay lanes,
 * combined pay) historically honored only an admin-STOPPED
 * invoice_followup_sequences row, so a disputed invoice could still be
 * charged to the saved card. Those paths now also treat an active hold as
 * "dunning stopped" — see completion-balance-sweep.dunningStoppedInvoiceIds
 * (cheap preflight) and stripe.chargeInvoiceWithSavedCard /
 * customer-credit.applyAccountCreditToInvoice (binding, under the charge
 * transaction, refuseWhenDunningStopped).
 *
 * The flag row is the single source of truth: an unreleased row (released_at
 * IS NULL) holds, releaseFlag stamps released_at and charging resumes on the
 * next attempt. Rows written before this change are honored as-is — no
 * backfill, no migration.
 *
 * SERIALIZATION with the hold writer: a plain read cannot order a charge
 * against a hold committing a moment later (the flag is an INSERT, so there
 * is no row to FOR UPDATE). Both sides therefore take a per-customer
 * transaction-scoped advisory lock: the charge / credit paths take it SHARED
 * (concurrent charges do not queue behind each other) and hold it through
 * their whole transaction, Stripe call included; outbound-voice/flags.js
 * writeFlag takes it EXCLUSIVE around the collection_hold insert. A hold
 * that commits before the charge locks is seen by the check that follows the
 * lock; one that arrives later waits until the charge transaction ends.
 *
 * Every function here THROWS on a read failure and never swallows it: callers
 * treat a thrown lookup as "cannot prove there is no hold" and refuse.
 */

const db = require('../../models/db');

const HOLD_FLAG = 'collection_hold';

async function customerHasActiveCollectionHold(customerId, database = db) {
  if (!customerId) return false;
  const row = await database('collections_flags')
    .where({ customer_id: customerId, flag: HOLD_FLAG })
    .whereNull('released_at')
    .first('id');
  return !!row;
}

const lockKey = (customerId) => `collections_hold:${customerId}`;

// Writer side (flags.writeFlag, collection_hold only). Blocks while any
// charge transaction for the customer is in flight.
async function lockCustomerHoldExclusive(trx, customerId) {
  await trx.raw('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [lockKey(customerId)]);
}

// Charge / credit side: take the shared lock FIRST, then read. Held until
// the surrounding transaction ends. Returns true when a hold is active.
async function customerHasActiveCollectionHoldLocked(trx, customerId) {
  if (!customerId) return false;
  await trx.raw('SELECT pg_advisory_xact_lock_shared(hashtextextended(?, 0))', [lockKey(customerId)]);
  return customerHasActiveCollectionHold(customerId, trx);
}

// Set of (stringified) invoice ids whose customer has an active hold.
async function collectionHoldInvoiceIds(invoiceIds, { database = db } = {}) {
  if (!invoiceIds || !invoiceIds.length) return new Set();
  const invoices = await database('invoices')
    .whereIn('id', invoiceIds)
    .select('id', 'customer_id');
  const customerIds = [...new Set(invoices.map((r) => r.customer_id).filter(Boolean).map(String))];
  if (!customerIds.length) return new Set();
  const flags = await database('collections_flags')
    .whereIn('customer_id', customerIds)
    .where({ flag: HOLD_FLAG })
    .whereNull('released_at')
    .select('customer_id');
  const held = new Set(flags.map((r) => String(r.customer_id)));
  return new Set(invoices.filter((r) => r.customer_id && held.has(String(r.customer_id))).map((r) => String(r.id)));
}

module.exports = {
  HOLD_FLAG,
  customerHasActiveCollectionHold,
  customerHasActiveCollectionHoldLocked,
  lockCustomerHoldExclusive,
  collectionHoldInvoiceIds,
};
