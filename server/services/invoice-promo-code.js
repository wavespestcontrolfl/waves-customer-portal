/**
 * Promo code on an invoice's pay page (owner-approved 2026-11-18,
 * GATE_PAY_PROMO_CODE): the same codes the estimate page takes
 * (estimate-promo-code.js: an active, unexpired, fixed-dollar code from admin
 * Discounts, once per customer), worth the same one-time account credit,
 * applied to the invoice the customer is paying.
 *
 *   enter   the customer types the code. One invoice_promo_codes row, the
 *           amount frozen from the discount row. No money moves and no Stripe
 *           call is made. The page then reloads.
 *   redeem  the payment-setup step the reload runs (stripe.js
 *           createInvoicePaymentIntent) calls redeemAndApplyPromoCode inside
 *           its transaction, under the invoice row lock: the credit posts to
 *           the ledger once, one use is counted, and that amount is drawn
 *           against this invoice, all or nothing. The setup step then
 *           re-prices the payment, as it already does for a customer with
 *           automatic credit on. Only the promo amount is drawn, never the
 *           rest of the customer's balance.
 *
 * A new-customer-only code works on the customer's first invoice: the visit
 * that invoice bills does not count against them.
 *
 * Not offered on a payer-billed invoice, a statement-billed one, one that
 * must save a payment method first, or one with nothing due.
 */
const db = require('../models/db');
const logger = require('./logger');
const featureGates = require('../config/feature-gates');
const { round2, computeApplication } = require('./customer-credit');
const { invoiceAmountDue, assertInvoiceCollectible } = require('./invoice-helpers');
const { invoicePayerOwnership, linkedVisitIdOf } = require('./invoice-payer-ownership');
const Promo = require('./estimate-promo-code');

const gateOn = () => (typeof featureGates.isEnabled === 'function'
  ? featureGates.isEnabled('payPromoCode')
  : Boolean(featureGates.gates?.payPromoCode));
const APPLIED_BY = 'system:pay_promo_code';

// Why a code entered on a pay page posted no credit, as the office reads it.
const VOID_REASONS = {
  code_inactive: 'the code was switched off',
  customer_not_eligible: 'this customer is not eligible for the code or already used it',
  uses_exhausted: 'the code ran out of uses',
  invoice_below_minimum: 'the remaining balance is too small to apply this code',
  payment_plan_active: 'this invoice is on an active payment plan',
  invoice_not_payable: 'this invoice is no longer eligible for a promo code',
};

const RECONCILIATION_PENDING_CODES = new Set([
  'STRIPE_AMBIGUOUS_OUTCOME',
  'STRIPE_CHARGE_IN_PROGRESS',
  'STRIPE_CHARGED_DB_FAILED',
]);

const exceptVisitOf = (invoice) => ({
  serviceRecordId: invoice.service_record_id || null,
  scheduledServiceId: invoice.scheduled_service_id || null,
});

// Can a code be entered on this invoice at all? The customer's own invoice,
// still collectible, with something due.
function invoiceTakesPromoCode(invoice) {
  if (!invoice?.customer_id || invoice.payer_id || invoice.payer_statement_id) return false;
  try { assertInvoiceCollectible(invoice); } catch { return false; }
  return invoiceAmountDue(invoice) > 0;
}

function applicablePromoAmountForInvoice(faceAmount, invoice) {
  const face = round2(faceAmount);
  if (!(face > 0) || !invoice) return 0;
  const due = invoiceAmountDue(invoice);
  if (!(due > 0)) return 0;
  const { applyAmt } = computeApplication({ total: due, creditApplied: 0, amountPaid: 0, balance: face });
  return applyAmt > 0 ? applyAmt : 0;
}

async function promoDrawAmountForInvoice(invoiceId, conn) {
  try {
    const q = conn('customer_credit_ledger');
    if (!q || typeof q.where !== 'function') return null;
    const rows = await q
      .where({ invoice_id: invoiceId, created_by: APPLIED_BY })
      .select('delta');
    if (!Array.isArray(rows) || !rows.length) return null;
    const total = rows.reduce((sum, r) => sum + Math.max(0, -Number(r.delta || 0)), 0);
    return total > 0 ? round2(total) : null;
  } catch {
    return null;
  }
}

function effectivePromoCreditAmount(row, invoice, promoDrawAmount = null) {
  const face = round2(row.credit_amount);
  if (row.status === 'redeemed') {
    if (promoDrawAmount != null && promoDrawAmount > 0) return Math.min(face, round2(promoDrawAmount));
    if (invoice) {
      const appliedOnInvoice = round2(invoice.credit_applied || 0);
      return appliedOnInvoice > 0 ? Math.min(face, appliedOnInvoice) : face;
    }
    return face;
  }
  return invoice ? applicablePromoAmountForInvoice(face, invoice) : face;
}

const appliedView = (row, invoice = null, promoDrawAmount = null) => ({
  code: row.code,
  creditAmount: effectivePromoCreditAmount(row, invoice, promoDrawAmount),
  credited: row.status === 'redeemed',
});

async function hasActivePaymentPlan(invoiceId, conn) {
  if (!invoiceId) return false;
  const plan = await conn('payment_plans').where({ invoice_id: invoiceId, status: 'active' }).first('id');
  return Boolean(plan);
}

async function hasPendingSavedCardAttempt(invoiceId, conn) {
  if (!invoiceId) return false;
  try {
    await require('./stripe').assertNoInvoiceChargeReconciliationPending(invoiceId, conn, { readOnly: true });
    return false;
  } catch (err) {
    if (RECONCILIATION_PENDING_CODES.has(err?.code)) return true;
    throw err;
  }
}

async function isRenewalUnpayableForPromo(invoice, conn) {
  if (!invoice?.annual_prepay_term_id) return false;
  const refusal = await require('./termite-annual-renewal-charge').renewalPaymentRefusal(invoice, conn);
  return Boolean(refusal);
}

async function invoiceEligibleForPromoEntry(invoice, conn) {
  if (!invoiceTakesPromoCode(invoice)) return false;
  const owner = await invoicePayerOwnership(invoice, conn);
  if (owner !== null) return false;
  if (await hasActivePaymentPlan(invoice.id, conn)) return false;
  if (await hasPendingSavedCardAttempt(invoice.id, conn)) return false;
  if (await isRenewalUnpayableForPromo(invoice, conn)) return false;
  return true;
}

/**
 * What the pay page shows: the code on this invoice, or that one may be
 * entered. null when the gate is off or there is nothing to show.
 * `saveRequired`: the invoice must save a payment method first (the route's
 * own verdict); no code is offered there.
 */
async function promoCodeViewForInvoice(invoice, { saveRequired = false, payerOwnedLive = false, conn = db } = {}) {
  if (!gateOn() || !invoice?.id) return null;
  if (payerOwnedLive) return null;
  const row = await conn('invoice_promo_codes').where({ invoice_id: invoice.id }).first();
  if (row) {
    if (row.status === 'void') return null;
    const promoDraw = row.status === 'redeemed' ? await promoDrawAmountForInvoice(invoice.id, conn) : null;
    return { canEnter: false, applied: appliedView(row, invoice, promoDraw) };
  }
  if (saveRequired || !(await invoiceEligibleForPromoEntry(invoice, conn))) return null;
  return { canEnter: true, applied: null };
}

/**
 * What became of the code on this invoice, for the payment-setup response:
 * the page saved the code, reloaded, and this setup is where it was redeemed
 * (or was not). The applied block when the credit posted; null when it did
 * not (voided, or the invoice took none of it), so the page drops its note
 * and never promises a credit the payment was not priced with; undefined
 * (no key in the response) when the gate is off or the invoice has no code.
 */
async function promoCodeVerdictAfterSetup(invoiceId, conn = db) {
  try {
    if (!gateOn()) return undefined;
    const row = await conn('invoice_promo_codes').where({ invoice_id: invoiceId }).first();
    if (!row) return undefined;
    if (row.status !== 'redeemed') return null;
    const invoice = await conn('invoices')
      .where({ id: invoiceId })
      .first('id', 'total', 'credit_applied', 'amount_paid', 'status');
    const promoDraw = await promoDrawAmountForInvoice(invoiceId, conn);
    return { canEnter: false, applied: appliedView(row, invoice || null, promoDraw) };
  } catch (err) {
    logger.warn(`[invoice-promo-code] setup verdict not read for invoice ${invoiceId}: ${err.code || err.message}`);
    return undefined;
  }
}

/**
 * The credit a code entered on this invoice will post at the next payment
 * setup, or 0 (no code waiting, or the gate is off). Returns the full face
 * value that redeemRow posts into the credit ledger so full-coverage checks
 * that sum auto-apply balance + pending promo accurately predict settlement
 * even when the promo alone would stop at Stripe's $0.50 floor. A read
 * failure answers 0 and never fails the page.
 */
async function pendingPromoCredit(invoice, conn = db) {
  try {
    if (!gateOn() || !invoiceTakesPromoCode(invoice)) return 0;
    const read = (c) => c('invoice_promo_codes').where({ invoice_id: invoice.id, status: 'entered' }).first('credit_amount');
    // Inside a caller's transaction the read runs in a savepoint, so a
    // failure here cannot leave that transaction aborted.
    const row = conn.isTransaction ? await conn.transaction(read) : await read(conn);
    return row ? round2(row.credit_amount) : 0;
  } catch (err) {
    logger.warn(`[invoice-promo-code] pending credit not read for invoice ${invoice.id}: ${err.code || err.message}`);
    return 0;
  }
}

/**
 * Strict fail-closed read for money boundaries (/quote, /finalize,
 * /update-amount, combined allocation verification). Propagates DB errors
 * rather than returning 0 so a transient lookup failure never silently charges
 * an undiscounted invoice.
 */
async function strictPendingPromoCredit(invoice, conn = db) {
  if (!gateOn() || !invoiceTakesPromoCode(invoice)) return 0;
  const row = await conn('invoice_promo_codes')
    .where({ invoice_id: invoice.id, status: 'entered' })
    .first('credit_amount');
  if (!row) return 0;
  if (await hasActivePaymentPlan(invoice.id, conn)) return 0;
  return applicablePromoAmountForInvoice(row.credit_amount, invoice);
}

/**
 * Batch lookup of invoice IDs that currently hold an unredeemed promo code
 * (used by combined-balance sibling selection to avoid bundling a sibling
 * carrying an unredeemed promo code at its gross total).
 */
async function invoiceIdsWithPendingPromo(invoiceIds, conn = db) {
  const result = new Set();
  if (!gateOn() || !Array.isArray(invoiceIds) || !invoiceIds.length) return result;
  const q = conn('invoice_promo_codes');
  if (!q || typeof q.whereIn !== 'function') return result;
  const rows = await q
    .whereIn('invoice_id', invoiceIds)
    .where({ status: 'entered' })
    .select('invoice_id');
  if (!Array.isArray(rows)) return result;
  for (const r of rows) result.add(String(r.invoice_id));
  return result;
}

/**
 * Fence existing PaymentIntent flows (/quote, /finalize, /update-amount,
 * combined allocation verification) whenever an applicable unredeemed promo
 * code is waiting on this invoice: refuses with 409 staleBalance so the page
 * re-runs /setup to redeem the promo and mint a reduced PaymentIntent instead
 * of charging the undiscounted total. Fails closed on DB lookup errors.
 */
async function assertNoPendingPromoCode(invoice, conn = db) {
  if (!invoice) return;
  const pending = await strictPendingPromoCredit(invoice, conn);
  if (pending > 0) {
    const err = new Error('A promo code was applied to this invoice — refreshing your total.');
    err.statusCode = 409;
    err.staleBalance = true;
    err.code = 'PENDING_PROMO_REQUIRES_SETUP';
    throw err;
  }
}

/**
 * Record `rawCode` on an invoice. The caller owns the gate and the token, and
 * passes its transaction holding the invoice row lock as `conn`.
 * Returns { ok: true, applied } or { ok: false, reason }:
 * 'code_already_entered' or the one generic 'invalid_code'.
 */
async function enterPromoCodeOnInvoice({ invoice, rawCode, trackInsert = false }, conn = db) {
  const code = Promo.normalizeCode(rawCode);
  if (!code) return { ok: false, reason: 'invalid_code' };

  const existing = await conn('invoice_promo_codes').where({ invoice_id: invoice.id }).first();
  if (existing) {
    if (existing.code === code && existing.status !== 'void') {
      const promoDraw = existing.status === 'redeemed' ? await promoDrawAmountForInvoice(invoice.id, conn) : null;
      const res = { ok: true, applied: appliedView(existing, invoice, promoDraw) };
      if (trackInsert) res.insertedNew = false;
      return res;
    }
    return { ok: false, reason: 'code_already_entered' };
  }
  if (!(await invoiceEligibleForPromoEntry(invoice, conn))) return { ok: false, reason: 'invalid_code' };

  // The discount row is locked through the insert, as on the estimate page.
  const discount = await conn('discounts').where({ promo_code: code, is_active: true }).forUpdate().first();
  const creditAmount = Promo.creditAmountOf(discount);
  if (!creditAmount
    || !(applicablePromoAmountForInvoice(creditAmount, invoice) > 0)
    || await Promo.customerBlocked(conn, invoice.customer_id, discount, { exceptVisit: exceptVisitOf(invoice) })
    || !(await Promo.usesLeft(conn, discount))) {
    return { ok: false, reason: 'invalid_code' };
  }

  const [row] = await conn('invoice_promo_codes').insert({
    invoice_id: invoice.id, discount_id: discount.id, customer_id: invoice.customer_id, code, credit_amount: creditAmount,
  }).returning('*');
  await conn('activity_log').insert({
    customer_id: invoice.customer_id,
    action: 'invoice_promo_code_entered',
    description: `Customer entered promo code ${code} on an invoice's pay page ($${creditAmount.toFixed(2)} account credit toward it).`,
    metadata: JSON.stringify({ code, discountId: discount.id, creditAmount, invoiceId: invoice.id }),
  });
  const res = { ok: true, applied: appliedView(row, invoice) };
  if (trackInsert) res.insertedNew = true;
  return res;
}

async function voidRow(trx, row, reason) {
  await trx('invoice_promo_codes').where({ id: row.id, status: 'entered' })
    .update({ status: 'void', void_reason: reason, updated_at: trx.fn.now() });
  await trx('activity_log').insert({
    customer_id: row.customer_id,
    action: 'invoice_promo_code_not_credited',
    description: `Promo code ${row.code} was entered on an invoice's pay page but no credit was posted: ${VOID_REASONS[reason]}.`,
    metadata: JSON.stringify({ code: row.code, discountId: row.discount_id, reason, invoiceId: row.invoice_id }),
  });
  return 0;
}

async function redeemRow(trx, row, invoice) {
  // Locked: an estimate redeeming the same code takes this lock too, so the
  // once-per-customer check sees it whichever commits first.
  const discount = await trx('discounts').where({ id: row.discount_id }).forUpdate().first();
  if (!Promo.isRedeemableDiscount(discount, row.code)) return voidRow(trx, row, 'code_inactive');
  if (await Promo.customerBlocked(trx, invoice.customer_id, discount, { exceptVisit: exceptVisitOf(invoice) })) {
    return voidRow(trx, row, 'customer_not_eligible');
  }
  const amount = round2(row.credit_amount);
  const entry = await Promo.mintPromoCredit(trx, {
    discountId: discount.id,
    customerId: invoice.customer_id,
    amount,
    note: `Promo code ${row.code} (invoice ${invoice.id})`,
    createdBy: APPLIED_BY,
  });
  if (!entry) return voidRow(trx, row, 'uses_exhausted');
  await trx('invoice_promo_codes').where({ id: row.id }).update({
    status: 'redeemed', redeemed_at: trx.fn.now(), credit_ledger_id: entry.id, updated_at: trx.fn.now(),
  });
  await trx('activity_log').insert({
    customer_id: invoice.customer_id,
    action: 'invoice_promo_code_credited',
    description: `Promo code ${row.code}: $${amount.toFixed(2)} account credit posted toward an invoice.`,
    metadata: JSON.stringify({ code: row.code, discountId: discount.id, creditAmount: amount, ledgerId: entry.id, invoiceId: invoice.id }),
  });
  return amount;
}

/**
 * The payment-setup step's hook, inside its transaction with the invoice row
 * locked and any open payment already retired. A code entered on this
 * invoice and not redeemed yet is redeemed (the credit posts, one use is
 * counted) AND that amount is drawn against the invoice, as one step in a
 * savepoint: if the invoice takes none of it (an active payment plan, a
 * payment attached after all, or third-party payer ownership), nothing is
 * posted and the code stays entered, so a code is never spent on an invoice it
 * did not lower. Only the promo amount is drawn, whatever the customer's
 * automatic-credit choice. Never throws: the payment is then set up at the
 * amount due as it stands. Returns the amount applied to the invoice, or 0.
 */
async function redeemAndApplyPromoCode(trx, invoice) {
  try {
    if (!gateOn() || !invoiceTakesPromoCode(invoice)) return 0;
    // Every statement inside the savepoint, the first read included: an error
    // here must never leave the setup step's own transaction aborted.
    return await trx.transaction(async (savepoint) => {
      const row = await savepoint('invoice_promo_codes').where({ invoice_id: invoice.id, status: 'entered' }).first();
      if (!row) return 0;
      // Lock the customer row (billing lock order: invoices FOR UPDATE held by
      // caller -> customers FOR UPDATE) so a concurrent customer-default payer
      // assignment cannot race past invoicePayerOwnership when the invoice has
      // no linked scheduled visit row.
      const custLockQuery = savepoint('customers').where({ id: invoice.customer_id });
      if (typeof custLockQuery.forUpdate === 'function') await custLockQuery.forUpdate().first('id');
      // Verify live third-party payer ownership inside the lock before
      // spending the homeowner's one-time promo code on a payer-owned invoice.
      // Void confirmed payer ownership so checkout does not loop on a stale
      // entered row; leave entered only when ownership cannot be verified.
      const liveOwner = await invoicePayerOwnership(invoice, savepoint);
      if (liveOwner === 'payer_owned') {
        return voidRow(savepoint, row, 'invoice_not_payable');
      }
      if (liveOwner !== null) {
        throw Object.assign(new Error('promo credit blocked for unverifiable payer ownership'), { promoNotApplied: liveOwner });
      }
      if (await hasActivePaymentPlan(invoice.id, savepoint)) {
        return 0;
      }
      if (await isRenewalUnpayableForPromo(invoice, savepoint)) {
        return voidRow(savepoint, row, 'invoice_not_payable');
      }
      if (!(applicablePromoAmountForInvoice(row.credit_amount, invoice) > 0)) {
        return voidRow(savepoint, row, 'invoice_below_minimum');
      }
      const effectiveVisitId = await linkedVisitIdOf(invoice, savepoint);
      const posted = await redeemRow(savepoint, row, invoice);
      // Voided (switched off, used up, not eligible): that verdict is kept.
      if (!(posted > 0)) return 0;
      const drawn = await require('./customer-credit').applyAccountCreditToInvoice({
        invoiceId: invoice.id,
        customerRequested: true,
        applyAtMost: posted,
        createdBy: APPLIED_BY,
        ...(effectiveVisitId ? { requireSelfPayScheduledServiceId: effectiveVisitId } : {}),
      }, savepoint);
      if (!(drawn?.applied > 0)) {
        throw Object.assign(new Error('promo credit not applied'), { promoNotApplied: drawn?.skipped || 'nothing_applied' });
      }
      return drawn.applied;
    });
  } catch (err) {
    if (err?.promoNotApplied) {
      logger.info(`[invoice-promo-code] invoice ${invoice.id}: code left entered, the invoice took no credit (${err.promoNotApplied})`);
    } else {
      logger.error(`[invoice-promo-code] invoice ${invoice.id}: credit not posted (${err?.code || err?.message})`);
    }
    return 0;
  }
}

module.exports = {
  promoCodeVerdictAfterSetup,
  pendingPromoCredit,
  strictPendingPromoCredit,
  invoiceIdsWithPendingPromo,
  assertNoPendingPromoCode,
  promoCodeViewForInvoice,
  enterPromoCodeOnInvoice,
  redeemAndApplyPromoCode,
};
