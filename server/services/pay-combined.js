/**
 * Pay-page full-balance collection (owner ruling 2026-08-16, gate
 * payIncludeBalance): the /pay page itemizes the customer's other open
 * self-pay invoices and the Pay button charges the COMBINED total in ONE
 * PaymentIntent, payer-statement style — the PI carries a per-invoice
 * allocation in metadata, and the settle paths mark every allocated invoice
 * paid with its own ledger row. Invoices are never merged or re-totalled;
 * each keeps its own number, amounts, receipt, and dunning identity.
 *
 * This module is the ONE authority for:
 *   - which sibling invoices ride a combined charge (selection);
 *   - the allocation snapshot and its metadata encoding (codec);
 *   - re-verifying an allocation against LOCKED rows at every later money
 *     seam (mint reuse, update-amount, finalize, confirm, webhook settle).
 *
 * Selection = open-balance.js (the shared open-invoice authority: delivered
 * self-pay rows with a positive remainder, live payer re-resolution, oldest
 * first) MINUS:
 *   - admin-stopped-dunning invoices ("stop dunning" also means "don't force
 *     the customer to pay it here" — same signal the completion sweep and
 *     previsit-balance honor; owner confirmed 2026-08-16);
 *   - invoices that already carry a PaymentIntent (their own pay session or
 *     a saved-card claim owns them — a combined charge must never race an
 *     invoice someone is paying elsewhere).
 * Any resolve failure or candidate-page truncation makes the sibling read
 * INCOMPLETE → the combined flow declines to engage (single-invoice
 * behavior, exactly as if the gate were off) rather than assert a total the
 * read cannot prove complete (same suppression contract as the SMS line).
 *
 * The allocation is cents-exact: PI base amount === Σ allocation cents, and
 * every later seam re-checks each locked row's remainder against its
 * allocated cents — any drift is a 409 "balance changed, refresh", never a
 * charge against numbers the customer isn't looking at.
 */

const db = require('../models/db');
const logger = require('./logger');
const { isEnabled } = require('../config/feature-gates');
const { openBalanceInvoices } = require('./open-balance');
const { dunningStoppedInvoiceIds } = require('./completion-balance-sweep');
const { invoiceAmountDue, isInvoiceCollectibleStatus } = require('./invoice-helpers');

// Stripe metadata values cap at 500 chars. The compact `${id}:${cents}`
// encoding spends ~44 chars per sibling, so 8 siblings stay comfortably
// under the cap (prod max open invoices per customer is single digits).
// MORE than 8 means the combined total could not be complete → decline to
// engage rather than force a partial "total".
const MAX_COMBINED_SIBLINGS = 8;

const amountDueCents = (invoice) => Math.round(invoiceAmountDue(invoice) * 100);

/**
 * The sibling invoices a combined charge for `anchorInvoice` would collect,
 * or null when the combined flow must not engage (gate off, payer-billed
 * anchor, incomplete read, over-cap, or simply no siblings). Never throws —
 * a null return always degrades to today's single-invoice flow.
 */
async function combinedEligibleSiblings(anchorInvoice, { database = db, reusePaymentIntentId = null } = {}) {
  try {
    if (!isEnabled('payIncludeBalance')) return null;
    if (!anchorInvoice?.customer_id) return null;
    // A payer-billed or statement-accrued anchor is the third party's money —
    // never fan the homeowner's balance into it.
    if (anchorInvoice.payer_id || anchorInvoice.payer_statement_id) return null;

    let incomplete = null;
    const candidates = await openBalanceInvoices(anchorInvoice.customer_id, {
      excludeInvoiceId: anchorInvoice.id,
      database,
      onResolveFailure: () => { incomplete = 'payer resolve failed'; },
      onTruncation: () => { incomplete = 'candidate bound hit'; },
    });
    if (incomplete) {
      logger.warn(`[pay-combined] sibling read incomplete for invoice ${anchorInvoice.invoice_number} (${incomplete}) — combined flow disabled for this session`);
      return null;
    }
    if (!candidates.length) return null;

    const stopped = await dunningStoppedInvoiceIds(candidates.map((inv) => inv.id), { database });
    const eligible = candidates.filter((inv) => !stopped.has(String(inv.id))
      // An attached PI means another pay session or a saved-card claim owns
      // this invoice right now — leave it to that rail. The one exception is
      // OUR OWN combined PI being re-set-up (page reload): siblings stamped
      // with the anchor's current PI stay included, or every reload would
      // shed them.
      && (!inv.stripe_payment_intent_id
        || (reusePaymentIntentId && String(inv.stripe_payment_intent_id) === String(reusePaymentIntentId))));
    if (!eligible.length) return null;
    if (eligible.length > MAX_COMBINED_SIBLINGS) {
      logger.warn(`[pay-combined] customer ${anchorInvoice.customer_id} has ${eligible.length} eligible siblings (cap ${MAX_COMBINED_SIBLINGS}) — combined flow disabled for this session`);
      return null;
    }
    return eligible;
  } catch (err) {
    logger.warn(`[pay-combined] sibling selection failed for invoice ${anchorInvoice?.id}: ${err.message} — combined flow disabled for this session`);
    return null;
  }
}

/**
 * Allocation snapshot for a combined charge: anchor first, then siblings
 * oldest-first, each with its cents-exact remainder at snapshot time.
 */
function buildAllocation(anchorInvoice, siblings) {
  const rows = [anchorInvoice, ...siblings];
  return rows.map((inv) => ({
    invoiceId: String(inv.id),
    invoiceNumber: inv.invoice_number,
    cents: amountDueCents(inv),
  }));
}

const allocationTotalCents = (allocation) => allocation.reduce((sum, a) => sum + a.cents, 0);

/** `${id}:${cents}` CSV — compact enough for Stripe's 500-char metadata cap. */
function encodeAllocation(allocation) {
  return allocation.map((a) => `${a.invoiceId}:${a.cents}`).join(',');
}

/**
 * Parse a PI's combined allocation. Returns null for non-combined PIs;
 * throws on a PRESENT-but-malformed allocation (a combined PI whose
 * allocation can't be read must never settle as single-invoice). Fails
 * closed on every ambiguous shape: zero/negative/unsafe cent values (a
 * zero-cent share would "settle" an invoice no money covered), duplicate
 * invoice ids (one invoice must never absorb two shares of the charge),
 * and more entries than the mint could legitimately produce (anchor +
 * MAX_COMBINED_SIBLINGS bounds the processing loop).
 */
function parseCombinedAllocation(piMetadata) {
  const raw = piMetadata?.combined_allocation;
  if (!raw) return null;
  const parts = String(raw).split(',');
  if (parts.length > MAX_COMBINED_SIBLINGS + 1) {
    throw new Error(`Combined allocation names ${parts.length} invoices — above the ${MAX_COMBINED_SIBLINGS + 1}-entry bound`);
  }
  const seen = new Set();
  const entries = parts.map((part) => {
    const idx = part.lastIndexOf(':');
    const invoiceId = part.slice(0, idx);
    const cents = Number(part.slice(idx + 1));
    if (!invoiceId || !Number.isSafeInteger(cents) || cents <= 0) {
      throw new Error(`Malformed combined allocation entry: ${part}`);
    }
    if (seen.has(invoiceId)) {
      throw new Error(`Duplicate invoice in combined allocation: ${invoiceId}`);
    }
    seen.add(invoiceId);
    return { invoiceId, cents };
  });
  if (!entries.length) throw new Error('Empty combined allocation');
  return entries;
}

const isCombinedPiMetadata = (piMetadata) => !!piMetadata?.combined_allocation;

/**
 * Re-verify a combined allocation against LOCKED invoice rows inside the
 * caller's transaction. Locks in ascending id order (deadlock-safe against
 * concurrent combined flows), and checks per row:
 *   - still collectible, still self-pay (payer_id / payer_statement_id null);
 *   - remainder cents still exactly the allocated cents;
 *   - PI binding: bound to `expectPaymentIntentId` (or unbound for siblings
 *     when `allowUnbound` — the mint path locks before stamping).
 * Throws a 409-shaped error on any drift so the page refreshes to live
 * numbers instead of charging against a changed balance.
 */
async function verifyAllocationLocked(trx, allocation, { anchorInvoiceId, expectPaymentIntentId = null, allowUnbound = false } = {}) {
  const ids = allocation.map((a) => a.invoiceId).sort();
  const rows = await trx('invoices').whereIn('id', ids).orderBy('id', 'asc').forUpdate();
  const byId = new Map(rows.map((r) => [String(r.id), r]));
  const staleErr = (why) => {
    const err = new Error('The account balance changed since this page loaded — refreshing to the latest amounts.');
    err.statusCode = 409;
    err.staleBalance = true;
    err.reason = why;
    return err;
  };
  for (const entry of allocation) {
    const row = byId.get(String(entry.invoiceId));
    if (!row) throw staleErr(`invoice ${entry.invoiceId} not found`);
    if (!isInvoiceCollectibleStatus(row.status)) throw staleErr(`invoice ${row.invoice_number} is ${row.status}`);
    if (row.payer_id || row.payer_statement_id) throw staleErr(`invoice ${row.invoice_number} became payer-billed`);
    if (amountDueCents(row) !== entry.cents) throw staleErr(`invoice ${row.invoice_number} remainder changed`);
    const bound = row.stripe_payment_intent_id ? String(row.stripe_payment_intent_id) : null;
    const isAnchor = String(row.id) === String(anchorInvoiceId);
    if (expectPaymentIntentId && bound && bound !== String(expectPaymentIntentId)) {
      throw staleErr(`invoice ${row.invoice_number} has a different active payment`);
    }
    if (!bound && !allowUnbound && !isAnchor) {
      throw staleErr(`invoice ${row.invoice_number} lost its payment binding`);
    }
  }
  return rows;
}

/**
 * Does this PI belong to `invoiceId`? Single-invoice PIs answer via
 * waves_invoice_id; a combined PI also OWNS every invoice its allocation
 * names (siblings are stamped with the anchor's PI, so every per-invoice
 * ownership check must accept the allocation membership or sibling pay
 * pages / settles would refuse their own money).
 */
function paymentIntentOwnsInvoice(piMetadata, invoiceId) {
  const metaId = piMetadata?.waves_invoice_id;
  if (metaId && String(metaId) === String(invoiceId)) return true;
  try {
    const alloc = parseCombinedAllocation(piMetadata);
    return !!alloc?.some((a) => String(a.invoiceId) === String(invoiceId));
  } catch {
    return false;
  }
}

/**
 * Live combined context for an invoice's CURRENT PaymentIntent, derived from
 * the DB stamps (every allocated invoice carries the PI id), not a Stripe
 * read: the stamped rows are edit-locked while the PI is attached, so their
 * remainders are exactly what the PI was priced from. Returns null when the
 * gate is off (kill switch outranks the persisted stamps — later seams then
 * degrade to single-invoice and clear the sibling stamps) or when no live
 * sibling rides the PI.
 */
async function combinedContextForInvoice(anchorInvoice, { database = db } = {}) {
  if (!isEnabled('payIncludeBalance')) return null;
  if (!anchorInvoice?.stripe_payment_intent_id) return null;
  const siblings = await database('invoices')
    .where({ stripe_payment_intent_id: anchorInvoice.stripe_payment_intent_id })
    .whereNot('id', anchorInvoice.id)
    .whereIn('status', ['sent', 'viewed', 'overdue'])
    .orderBy('created_at', 'asc');
  const live = siblings.filter((s) => amountDueCents(s) > 0);
  if (!live.length) return null;
  const allocation = buildAllocation(anchorInvoice, live);
  return { siblings: live, allocation, totalCents: allocationTotalCents(allocation) };
}

/**
 * Unstamp a PaymentIntent from every collectible invoice EXCEPT the ids in
 * `keepInvoiceIds` — the cleanup half of sibling stamping. Runs whenever a
 * combined PI is canceled/replaced or a new mint's allocation drops a
 * previously-included sibling, so no invoice stays bound to a PI that will
 * never collect it. Paid/processing rows are never touched (their PI ref is
 * the settlement audit trail).
 */
async function clearPaymentIntentStamps(database, paymentIntentId, { keepInvoiceIds = [] } = {}) {
  if (!paymentIntentId) return 0;
  const query = database('invoices')
    .where({ stripe_payment_intent_id: paymentIntentId })
    .whereNotIn('status', ['paid', 'processing', 'prepaid']);
  if (keepInvoiceIds.length) query.whereNotIn('id', keepInvoiceIds);
  return query.update({ stripe_payment_intent_id: null, updated_at: database.fn.now() });
}

/**
 * Settle a combined PaymentIntent: one transaction (advisory-locked on the
 * PI, same namespace as the single-invoice settle) that, for EVERY invoice
 * in the allocation, flips it paid/processing and ensures its own
 * per-invoice payments row. Idempotent per invoice — a webhook redelivery
 * or a /confirm racing the webhook re-runs safely. The card surcharge (PI
 * total − allocation total) rides the ANCHOR's ledger row, so Σ payments
 * rows === cash captured to the cent.
 *
 * `details` is the resolved tender info (paymentMethod, cardBrand,
 * cardLastFour, receiptUrl) the caller derived from the PI/charge.
 * Returns { settled, paymentStatus, invoiceIds, anchorPaymentRow }.
 */
async function settleCombinedPaymentIntent(paymentIntent, details, { eventCreated = null } = {}) {
  const { invoicePaymentStatusForIntent } = require('./stripe-invoice-state');
  const { etDateString } = require('../utils/datetime-et');
  const piId = paymentIntent.id;
  const allocation = parseCombinedAllocation(paymentIntent.metadata);
  if (!allocation) throw new Error(`PI ${piId} is not a combined payment`);
  const anchorInvoiceId = paymentIntent.metadata?.waves_invoice_id || allocation[0].invoiceId;

  const paymentStatus = invoicePaymentStatusForIntent(paymentIntent, details.paymentMethod);
  const invoiceStatus = paymentStatus === 'paid' ? 'paid' : 'processing';
  const chargedCents = Number(paymentIntent.amount_received || paymentIntent.amount || 0);
  const allocCents = allocationTotalCents(allocation);
  const surchargeCents = Math.round(Number(paymentIntent.metadata?.card_surcharge || 0) * 100);
  // Cash captured must equal allocation + recorded surcharge to the cent
  // (1c rounding tolerance). A mismatch means the PI amount drifted from
  // the allocation snapshot — never guess a split; the caller quarantines.
  if (paymentStatus === 'paid' && Math.abs(chargedCents - (allocCents + surchargeCents)) > 1) {
    const err = new Error(
      `Combined PI ${piId} captured ${chargedCents}c but allocation+surcharge is ${allocCents + surchargeCents}c`,
    );
    err.code = 'COMBINED_ALLOCATION_MISMATCH';
    throw err;
  }

  const settledInvoiceIds = [];
  let anchorPaymentRow = null;
  await db.transaction(async (trx) => {
    await trx.raw(
      'SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
      ['stripe.pi.payment', String(piId)],
    );
    const ids = allocation.map((a) => a.invoiceId).sort();
    const rows = await trx('invoices').whereIn('id', ids).orderBy('id', 'asc').forUpdate();
    const byId = new Map(rows.map((r) => [String(r.id), r]));

    // 'disputed' is terminal for this PI (mirrors the single-invoice
    // confirm guard): the money already went back via the chargeback.
    const disputedRow = await trx('payments')
      .where({ stripe_payment_intent_id: piId, status: 'disputed' })
      .first('id');
    if (disputedRow) {
      throw new Error('This payment was disputed after it succeeded — the invoices cannot be re-marked paid from the old payment session');
    }

    const existingRows = await trx('payments').where({ stripe_payment_intent_id: piId });
    const rowForInvoice = (invId) => existingRows.find(
      (p) => String(p.metadata?.invoice_id ?? (typeof p.metadata === 'string' ? safeJson(p.metadata)?.invoice_id : null)) === String(invId),
    );

    for (const entry of allocation) {
      const invoice = byId.get(String(entry.invoiceId));
      const isAnchor = String(entry.invoiceId) === String(anchorInvoiceId);
      if (!invoice) {
        logger.error(`[pay-combined] settle: allocated invoice ${entry.invoiceId} missing for PI ${piId} — recording residual`);
        await recordResidual(trx, paymentIntent, entry, 'allocated invoice not found');
        continue;
      }
      const status = String(invoice.status || '').toLowerCase();
      if (['void', 'refunded', 'canceled', 'cancelled'].includes(status)) {
        logger.error(`[pay-combined] settle: allocated invoice ${invoice.invoice_number} is ${status} for PI ${piId} — recording residual`);
        await recordResidual(trx, paymentIntent, entry, `allocated invoice is ${status}`);
        continue;
      }
      if (['paid', 'prepaid'].includes(status)) {
        // Already settled. By THIS PI (redelivery/race) → idempotent skip.
        // By a DIFFERENT PI → this allocation's share was double-collected;
        // record the residual so an operator refunds it.
        if (String(invoice.stripe_payment_intent_id || '') !== String(piId)) {
          logger.error(`[pay-combined] settle: invoice ${invoice.invoice_number} already ${status} by another payment — recording residual for PI ${piId}`);
          await recordResidual(trx, paymentIntent, entry, `invoice already ${status} by ${invoice.stripe_payment_intent_id || 'unknown'}`);
        }
        const existing = rowForInvoice(invoice.id);
        if (existing && isAnchor) anchorPaymentRow = existing;
        continue;
      }
      if (String(invoice.stripe_payment_intent_id || '') && String(invoice.stripe_payment_intent_id) !== String(piId)) {
        logger.error(`[pay-combined] settle: invoice ${invoice.invoice_number} bound to a different payment — recording residual for PI ${piId}`);
        await recordResidual(trx, paymentIntent, entry, `invoice bound to ${invoice.stripe_payment_intent_id}`);
        continue;
      }

      const invoiceUpdates = {
        status: invoiceStatus,
        processor: 'stripe',
        stripe_payment_intent_id: piId,
        stripe_charge_id: typeof paymentIntent.latest_charge === 'string'
          ? paymentIntent.latest_charge
          : paymentIntent.latest_charge?.id || null,
        updated_at: trx.fn.now(),
      };
      if (invoiceStatus === 'paid') invoiceUpdates.paid_at = new Date().toISOString();
      if (details.paymentMethod) invoiceUpdates.payment_method = details.paymentMethod;
      if (details.cardBrand) invoiceUpdates.card_brand = details.cardBrand;
      if (details.cardLastFour) invoiceUpdates.card_last_four = details.cardLastFour;
      if (details.receiptUrl) invoiceUpdates.receipt_url = details.receiptUrl;
      await trx('invoices').where({ id: invoice.id }).update(invoiceUpdates);

      const existing = rowForInvoice(invoice.id);
      if (existing) {
        // ACH: the processing handler inserted this row — flip it in place.
        if (!['paid', 'refunded', 'disputed'].includes(existing.status) && invoiceStatus === 'paid') {
          await trx('payments').where({ id: existing.id }).update({
            status: 'paid',
            updated_at: new Date(),
            payment_date: etDateString(eventCreated ? new Date(eventCreated * 1000) : undefined),
            receipt_url: details.receiptUrl || existing.receipt_url || null,
            metadata: trx.raw(
              `jsonb_set(jsonb_set(COALESCE(metadata, '{}'::jsonb), '{payment_state}', '"paid"'), '{settled_event_at}', to_jsonb(?::text))`,
              [eventCreated ? new Date(eventCreated * 1000).toISOString() : new Date().toISOString()],
            ),
          });
        }
        if (isAnchor) anchorPaymentRow = existing;
        settledInvoiceIds.push(invoice.id);
        continue;
      }

      const shareCents = entry.cents + (isAnchor ? surchargeCents : 0);
      const [inserted] = await trx('payments').insert({
        customer_id: invoice.customer_id,
        processor: 'stripe',
        stripe_payment_intent_id: piId,
        stripe_charge_id: invoiceUpdates.stripe_charge_id,
        payment_date: etDateString(eventCreated ? new Date(eventCreated * 1000) : undefined),
        amount: shareCents / 100,
        base_amount_cents: entry.cents,
        surcharge_amount_cents: isAnchor ? surchargeCents : 0,
        surcharge_rate_bps: isAnchor ? Number(paymentIntent.metadata?.surcharge_rate_bps || 0) : 0,
        surcharge_policy_version: isAnchor ? (paymentIntent.metadata?.surcharge_policy_version || null) : null,
        card_funding: paymentIntent.metadata?.card_funding || null,
        card_brand: details.cardBrand || null,
        status: paymentStatus,
        description: `Invoice ${invoice.invoice_number} (combined balance payment${isAnchor && surchargeCents > 0 ? `, includes $${(surchargeCents / 100).toFixed(2)} card processing fee` : ''})${paymentStatus === 'processing' ? ' (bank payment pending)' : ''}`,
        receipt_url: details.receiptUrl || null,
        card_last_four: details.cardLastFour || null,
        metadata: JSON.stringify({
          invoice_id: invoice.id,
          combined_payment: true,
          combined_anchor_invoice_id: String(anchorInvoiceId),
          stripe_receipt_url: details.receiptUrl || null,
          base_amount: entry.cents / 100,
          card_surcharge: isAnchor ? surchargeCents / 100 : 0,
          charged_amount: shareCents / 100,
          payment_method: details.paymentMethod || paymentIntent.payment_method_types?.[0] || null,
          payment_state: paymentStatus,
          settled_event_at: paymentStatus === 'paid'
            ? (eventCreated ? new Date(eventCreated * 1000).toISOString() : new Date().toISOString())
            : null,
        }),
      }).returning('*');
      if (isAnchor) anchorPaymentRow = inserted;
      settledInvoiceIds.push(invoice.id);
    }
  });

  // Post-settle side effects, per invoice, outside the money transaction —
  // each is best-effort and independently recoverable.
  if (invoiceStatus === 'paid') {
    for (const invId of settledInvoiceIds) {
      try {
        await require('./invoice-followups').stopOnPayment(invId);
      } catch (e) {
        logger.warn(`[pay-combined] stopOnPayment failed for invoice ${invId}: ${e.message}`);
      }
      try {
        const fresh = await db('invoices').where({ id: invId }).first();
        if (fresh) await require('./annual-prepay-renewals').syncTermForInvoicePayment(fresh);
      } catch (e) {
        logger.warn(`[pay-combined] term sync failed for invoice ${invId}: ${e.message}`);
      }
      try {
        const ReceiptDeliveryQueue = require('./receipt-delivery-queue');
        await ReceiptDeliveryQueue.enqueueReceiptDelivery({
          invoiceId: invId,
          stripePaymentIntentId: piId,
          source: 'combined_pay',
        });
      } catch (e) {
        logger.warn(`[pay-combined] receipt enqueue failed for invoice ${invId}: ${e.message}`);
      }
    }
    try {
      require('./receipt-delivery-queue').scheduleReceiptDeliveryDrain({ delayMs: 1000, limit: 10 });
    } catch { /* drain is interval-backed */ }
  }

  return { settled: settledInvoiceIds.length, paymentStatus, invoiceIds: settledInvoiceIds, anchorPaymentRow };
}

function safeJson(value) {
  try { return JSON.parse(value); } catch { return null; }
}

// Durable operator queue entry for an allocation share that could NOT be
// settled onto its invoice (row missing/void/already paid elsewhere): the
// money is captured, so the shortfall must be loud, never silent.
async function recordResidual(trx, paymentIntent, entry, reason) {
  await trx('stripe_orphan_charges')
    .insert({
      stripe_payment_intent_id: `${paymentIntent.id}:${entry.invoiceId}`,
      stripe_charge_id: typeof paymentIntent.latest_charge === 'string'
        ? paymentIntent.latest_charge
        : paymentIntent.latest_charge?.id || null,
      customer_id: paymentIntent.metadata?.waves_customer_id || null,
      invoice_id: entry.invoiceId,
      amount: entry.cents / 100,
      source: 'combined_pay_webhook',
      original_db_error: String(reason).slice(0, 1000),
    })
    .onConflict('stripe_payment_intent_id')
    .ignore();
}

module.exports = {
  MAX_COMBINED_SIBLINGS,
  amountDueCents,
  combinedEligibleSiblings,
  buildAllocation,
  allocationTotalCents,
  encodeAllocation,
  parseCombinedAllocation,
  isCombinedPiMetadata,
  verifyAllocationLocked,
  paymentIntentOwnsInvoice,
  combinedContextForInvoice,
  clearPaymentIntentStamps,
  settleCombinedPaymentIntent,
};
