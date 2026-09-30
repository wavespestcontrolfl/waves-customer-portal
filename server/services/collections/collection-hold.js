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

module.exports = { HOLD_FLAG, customerHasActiveCollectionHold, collectionHoldInvoiceIds };
