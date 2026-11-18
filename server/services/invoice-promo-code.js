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
const { isEnabled } = require('../config/feature-gates');
const { round2 } = require('./customer-credit');
const { invoiceAmountDue, assertInvoiceCollectible } = require('./invoice-helpers');
const Promo = require('./estimate-promo-code');

const gateOn = () => isEnabled('payPromoCode');
const APPLIED_BY = 'system:pay_promo_code';

// Why a code entered on a pay page posted no credit, as the office reads it.
const VOID_REASONS = {
  code_inactive: 'the code was switched off',
  customer_not_eligible: 'this customer is not eligible for the code or already used it',
  uses_exhausted: 'the code ran out of uses',
};

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

const appliedView = (row) => ({ code: row.code, creditAmount: round2(row.credit_amount), credited: row.status === 'redeemed' });

/**
 * What the pay page shows: the code on this invoice, or that one may be
 * entered. null when the gate is off or there is nothing to show.
 * `saveRequired`: the invoice must save a payment method first (the route's
 * own verdict); no code is offered there.
 */
async function promoCodeViewForInvoice(invoice, { saveRequired = false, conn = db } = {}) {
  if (!gateOn() || !invoice?.id) return null;
  const row = await conn('invoice_promo_codes').where({ invoice_id: invoice.id }).first();
  if (row) return row.status === 'void' ? null : { canEnter: false, applied: appliedView(row) };
  return !saveRequired && invoiceTakesPromoCode(invoice) ? { canEnter: true, applied: null } : null;
}

/**
 * The credit a code entered on this invoice will post at the next payment
 * setup, or 0 (no code waiting, or the gate is off). The pay page projects
 * it so nothing is offered at the pre-credit amount in the meantime. A read
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
 * Record `rawCode` on an invoice. The caller owns the gate and the token, and
 * passes its transaction holding the invoice row lock as `conn`.
 * Returns { ok: true, applied } or { ok: false, reason }:
 * 'code_already_entered' or the one generic 'invalid_code'.
 */
async function enterPromoCodeOnInvoice({ invoice, rawCode }, conn = db) {
  const code = Promo.normalizeCode(rawCode);
  if (!code) return { ok: false, reason: 'invalid_code' };

  const existing = await conn('invoice_promo_codes').where({ invoice_id: invoice.id }).first();
  if (existing) {
    return existing.code === code && existing.status !== 'void'
      ? { ok: true, applied: appliedView(existing) }
      : { ok: false, reason: 'code_already_entered' };
  }
  if (!invoiceTakesPromoCode(invoice)) return { ok: false, reason: 'invalid_code' };

  // The discount row is locked through the insert, as on the estimate page.
  const discount = await conn('discounts').where({ promo_code: code, is_active: true }).forUpdate().first();
  const creditAmount = Promo.creditAmountOf(discount);
  if (!creditAmount
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
  return { ok: true, applied: appliedView(row) };
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
  if (!discount || discount.is_active !== true) return voidRow(trx, row, 'code_inactive');
  if (await Promo.customerBlocked(trx, invoice.customer_id, discount, { exceptVisit: exceptVisitOf(invoice) })) {
    return voidRow(trx, row, 'customer_not_eligible');
  }
  const amount = round2(row.credit_amount);
  const entry = await Promo.mintPromoCredit(trx, {
    discountId: discount.id, customerId: invoice.customer_id, amount, note: `Promo code ${row.code} (invoice ${invoice.id})`,
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
 * payment attached after all), nothing is posted and the code stays entered,
 * so a code is never spent on an invoice it did not lower. Only the promo
 * amount is drawn, whatever the customer's automatic-credit choice. Never
 * throws: the payment is then set up at the amount due as it stands.
 * Returns the amount applied to the invoice, or 0.
 */
async function redeemAndApplyPromoCode(trx, invoice) {
  try {
    if (!gateOn() || !invoiceTakesPromoCode(invoice)) return 0;
    // Every statement inside the savepoint, the first read included: an error
    // here must never leave the setup step's own transaction aborted.
    return await trx.transaction(async (savepoint) => {
      const row = await savepoint('invoice_promo_codes').where({ invoice_id: invoice.id, status: 'entered' }).first();
      if (!row) return 0;
      const posted = await redeemRow(savepoint, row, invoice);
      // Voided (switched off, used up, not eligible): that verdict is kept.
      if (!(posted > 0)) return 0;
      const drawn = await require('./customer-credit').applyAccountCreditToInvoice({
        invoiceId: invoice.id, customerRequested: true, applyAtMost: posted, createdBy: APPLIED_BY,
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
  pendingPromoCredit,
  promoCodeViewForInvoice,
  enterPromoCodeOnInvoice,
  redeemAndApplyPromoCode,
};
