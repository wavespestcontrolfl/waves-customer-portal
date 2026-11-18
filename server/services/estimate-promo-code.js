/**
 * Promo code on the customer estimate page (owner-approved 2026-11-18,
 * GATE_ESTIMATE_PROMO_CODE): a code from admin Discounts is worth a one-time
 * account credit. The estimate's price never changes.
 *
 *   enter   the customer types the code on an open estimate. One row in
 *           estimate_promo_codes, the amount frozen from the discount row.
 *           No money moves and nothing is sent.
 *   redeem  the estimate is accepted (the customer's accept or the office's
 *           Mark Won). The credit posts once to the customer-credit ledger
 *           and one use is counted, so an estimate nobody accepts never
 *           spends a use or becomes a balance.
 *
 * The credit is ordinary account credit, as the $25 referral reward is: it
 * comes off an invoice when the customer has automatic credit on, or when
 * the office applies it.
 *
 * Exactly-once comes from the schema (migration 20261118120000): one code
 * per estimate, one mint per row, one redemption of a code per customer.
 * The gate is read on both legs: off, no code is taken and none is redeemed.
 */
const db = require('../models/db');
const logger = require('./logger');
const { isEnabled } = require('../config/feature-gates');
const { postCreditMovement, round2 } = require('./customer-credit');
const { storedManualDiscountCandidates } = require('./estimate-manual-discount-replay');

const CODE_RE = /^[A-Z0-9][A-Z0-9_-]{2,49}$/;
const CREATED_BY = 'system:estimate_promo_code';
// An estimate outside these states can still be accepted, so its entered
// code still holds one of the discount's uses.
const DEAD_ESTIMATE_STATUSES = ['declined', 'expired', 'send_failed'];
// Rules of a discount row that an account credit cannot honor: they scope the
// discount to one service, one tier, one tender or one customer group.
const UNSUPPORTED_RULES = [
  'service_key_filter', 'service_category_filter', 'requires_waveguard_tier', 'payment_method_condition',
  'requires_military', 'requires_senior', 'requires_multi_home', 'requires_prepayment', 'requires_referral',
  'min_service_count', 'min_subtotal',
];
// Why an accepted estimate's code posted no credit, as the office reads it.
const VOID_REASONS = {
  code_inactive: 'the code was switched off',
  customer_not_eligible: 'this customer is not eligible for the code or already used it',
  uses_exhausted: 'the code ran out of uses',
  no_customer: 'the accepted estimate has no customer account',
  office_discount: 'the office added a discount to the estimate after the code was entered',
};

const gateOn = () => isEnabled('estimatePromoCode');

function normalizeCode(raw) {
  const code = String(raw == null ? '' : raw).trim().toUpperCase();
  return CODE_RE.test(code) ? code : null;
}

function parseEstimateData(estimate) {
  const raw = estimate?.estimate_data;
  if (!raw) return {};
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw) || {}; } catch { return {}; }
}

// Owner 2026-11-18: a code never stacks on a discount the office already put
// on the estimate.
function estimateHasStaffDiscount(estimate) {
  const data = parseEstimateData(estimate);
  if (Number(data?.operatorPriceAdjustment?.value) > 0) return true;
  return storedManualDiscountCandidates(data)
    .some((d) => d && typeof d === 'object' && (Number(d.value) > 0 || Number(d.amount) > 0));
}

// The credit a discount row is worth, or null when it cannot be redeemed as
// one: only an active fixed-dollar promo code with no rule this path cannot
// check, before its expiry.
function creditAmountOf(discount, now = new Date()) {
  if (!discount || discount.is_active !== true || !discount.promo_code) return null;
  if (discount.discount_type !== 'fixed_amount') return null;
  if (UNSUPPORTED_RULES.some((rule) => discount[rule])) return null;
  if (discount.promo_code_expiry && new Date(discount.promo_code_expiry) < now) return null;
  const amount = round2(discount.amount);
  return amount > 0 ? amount : null;
}

async function customerHasCompletedService(conn, customerId) {
  const row = await conn('service_records').where({ customer_id: customerId })
    .whereRaw("COALESCE(status, 'completed') = 'completed'").first('id');
  return Boolean(row);
}

// Did this customer redeem this discount's code as an account credit? The
// office promo path (DiscountEngine.applyPromoCode) reads it too, so a code
// is good once per customer whichever way it is used.
async function customerRedeemedPromoCredit(conn, customerId, discountId) {
  return Boolean(await conn('estimate_promo_codes')
    .where({ discount_id: discountId, redeemed_customer_id: customerId, status: 'redeemed' }).first('id'));
}

// Has this customer had this discount before: redeemed here, or assigned by
// the office (customer_discounts, the admin promo path)?
async function customerAlreadyUsed(conn, customerId, discountId) {
  if (await customerRedeemedPromoCredit(conn, customerId, discountId)) return true;
  return Boolean(await conn('customer_discounts').where({ customer_id: customerId, discount_id: discountId }).first('id'));
}

async function customerBlocked(conn, customerId, discount) {
  if (!customerId) return false;
  if (discount.requires_new_customer && await customerHasCompletedService(conn, customerId)) return true;
  return customerAlreadyUsed(conn, customerId, discount.id);
}

// Uses already counted plus codes waiting on estimates that can still be accepted.
async function usesLeft(conn, discount) {
  const max = Number(discount.promo_code_max_uses);
  if (!(max > 0)) return true;
  const held = await conn('estimate_promo_codes as p')
    .join('estimates as e', 'e.id', 'p.estimate_id')
    .where({ 'p.discount_id': discount.id, 'p.status': 'entered' })
    .whereNotIn('e.status', DEAD_ESTIMATE_STATUSES)
    .whereNull('e.archived_at')
    .count('* as c').first();
  return Number(discount.promo_code_current_uses || 0) + Number(held?.c || 0) < max;
}

const appliedView = (row) => ({ code: row.code, creditAmount: round2(row.credit_amount), credited: row.status === 'redeemed' });

/**
 * What the estimate page shows: the code on this estimate, if any, and
 * whether the field is offered. null when the gate is off or there is
 * nothing to show.
 * `open`: the estimate can still be accepted (the route's own check).
 */
async function promoCodeViewForEstimate(estimate, { open = false, conn = db } = {}) {
  if (!gateOn() || !estimate?.id) return null;
  const row = await conn('estimate_promo_codes').where({ estimate_id: estimate.id }).first();
  if (row) return row.status === 'void' ? null : { canEnter: false, applied: appliedView(row) };
  return open && !estimateHasStaffDiscount(estimate) ? { canEnter: true, applied: null } : null;
}

/**
 * Record `rawCode` on an open estimate. The caller owns the gate, the token
 * and the estimate's open state, and passes its transaction holding the
 * estimate row lock as `conn`, so the code and its audit row are saved
 * together and never onto an estimate accepted meanwhile.
 * Returns { ok: true, applied } or
 * { ok: false, reason }: 'discount_already_applied', 'code_already_entered'
 * or the one generic 'invalid_code' for everything else, so the answer never
 * says why a code failed.
 */
async function enterPromoCode({ estimate, rawCode }, conn = db) {
  const code = normalizeCode(rawCode);
  if (!code) return { ok: false, reason: 'invalid_code' };

  const existing = await conn('estimate_promo_codes').where({ estimate_id: estimate.id }).first();
  if (existing) {
    return existing.code === code && existing.status !== 'void'
      ? { ok: true, applied: appliedView(existing) }
      : { ok: false, reason: 'code_already_entered' };
  }
  if (estimateHasStaffDiscount(estimate)) return { ok: false, reason: 'discount_already_applied' };

  // The discount row is locked through the insert: two customers entering a
  // code with one use left wait on each other, and the second one counts
  // the first one's saved code.
  const discount = await conn('discounts').where({ promo_code: code, is_active: true }).forUpdate().first();
  const creditAmount = creditAmountOf(discount);
  if (!creditAmount
    || await customerBlocked(conn, estimate.customer_id, discount)
    || !(await usesLeft(conn, discount))) {
    return { ok: false, reason: 'invalid_code' };
  }

  const [row] = await conn('estimate_promo_codes')
    .insert({ estimate_id: estimate.id, discount_id: discount.id, code, credit_amount: creditAmount })
    .onConflict('estimate_id').ignore()
    .returning('*');
  // A second tab won the insert: answer from the row that stands.
  if (!row) return enterPromoCode({ estimate, rawCode }, conn);

  await conn('activity_log').insert({
    customer_id: estimate.customer_id || null,
    estimate_id: estimate.id,
    action: 'estimate_promo_code_entered',
    description: `Customer entered promo code ${code} on their estimate ($${creditAmount.toFixed(2)} account credit when accepted).`,
    metadata: JSON.stringify({ code, discountId: discount.id, creditAmount }),
  });
  return { ok: true, applied: appliedView(row) };
}

// Close a code that cannot be redeemed, with the audit row the office reads
// in Recent activity. Nothing is told to the customer here.
async function voidRow(conn, { row, customerId, reason }) {
  const closed = await conn('estimate_promo_codes').where({ id: row.id, status: 'entered' })
    .update({ status: 'void', void_reason: reason, updated_at: conn.fn.now() });
  if (closed) {
    await conn('activity_log').insert({
      customer_id: customerId,
      estimate_id: row.estimate_id,
      action: 'estimate_promo_code_not_credited',
      description: `Promo code ${row.code} was on this accepted estimate but no credit was posted: ${VOID_REASONS[reason]}.`,
      metadata: JSON.stringify({ code: row.code, discountId: row.discount_id, reason }),
    });
  }
  return 'void';
}

// One accepted estimate's code, redeemed inside `trx`. Returns the outcome.
// The customer is the accepted row's own, read here: a caller never names
// who is credited.
async function redeemInTransaction(trx, estimateId) {
  const row = await trx('estimate_promo_codes').where({ estimate_id: estimateId, status: 'entered' }).forUpdate().first();
  if (!row) return 'none';
  const accepted = await trx('estimates').where({ id: estimateId, status: 'accepted' }).first('customer_id', 'estimate_data');
  if (!accepted) return 'none';
  const customerId = accepted.customer_id;
  // No stacking, judged again on the accepted row: the office may have added
  // a discount after the customer entered the code.
  if (estimateHasStaffDiscount(accepted)) return voidRow(trx, { row, customerId: customerId || null, reason: 'office_discount' });
  // Accepted with no customer account to credit: closed with its audit row so
  // the office sees the promise, never left waiting on a step that will not run.
  if (!customerId) return voidRow(trx, { row, customerId: null, reason: 'no_customer' });
  const discount = await trx('discounts').where({ id: row.discount_id }).first();
  if (!discount || discount.is_active !== true) return voidRow(trx, { row, customerId, reason: 'code_inactive' });
  if (await customerBlocked(trx, customerId, discount)) return voidRow(trx, { row, customerId, reason: 'customer_not_eligible' });

  // The count and its cap in one statement: two accepts can never both take the last use.
  const counted = await trx('discounts').where({ id: discount.id })
    .where(function underCap() {
      this.whereNull('promo_code_max_uses').orWhere('promo_code_max_uses', '<=', 0)
        .orWhereRaw('COALESCE(promo_code_current_uses, 0) < promo_code_max_uses');
    })
    .update({ promo_code_current_uses: trx.raw('COALESCE(promo_code_current_uses, 0) + 1') });
  if (!counted) return voidRow(trx, { row, customerId, reason: 'uses_exhausted' });

  const amount = round2(row.credit_amount);
  const { entry } = await postCreditMovement({
    customerId,
    delta: amount,
    source: 'promo_code',
    note: `Promo code ${row.code} (estimate ${estimateId})`,
    createdBy: CREATED_BY,
  }, trx);
  await trx('estimate_promo_codes').where({ id: row.id }).update({
    status: 'redeemed',
    redeemed_at: trx.fn.now(),
    redeemed_customer_id: customerId,
    credit_ledger_id: entry.id,
    updated_at: trx.fn.now(),
  });
  await trx('activity_log').insert({
    customer_id: customerId,
    estimate_id: estimateId,
    action: 'estimate_promo_code_credited',
    description: `Promo code ${row.code}: $${amount.toFixed(2)} account credit posted on acceptance.`,
    metadata: JSON.stringify({ code: row.code, discountId: discount.id, creditAmount: amount, ledgerId: entry.id }),
  });
  return 'redeemed';
}

/**
 * Post the credit for an accepted estimate's code. Called after the accept
 * commits; never throws, since a credit problem must not fail an acceptance.
 * Safe to call again: a redeemed or voided row is left alone.
 * Returns 'redeemed' | 'void' | 'none' | 'off' | 'failed'.
 */
async function redeemPromoCodeForAcceptedEstimate({ estimateId }) {
  if (!gateOn()) return 'off';
  if (!estimateId) return 'none';
  try {
    const outcome = await db.transaction((trx) => redeemInTransaction(trx, estimateId));
    if (outcome !== 'none') logger.info(`[estimate-promo-code] estimate ${estimateId}: ${outcome}`);
    return outcome;
  } catch (err) {
    // Two of one customer's estimates accepted at once with the same code:
    // the one-per-customer index refused the second mint and rolled it back.
    if (err?.code === '23505') {
      const row = await db('estimate_promo_codes').where({ estimate_id: estimateId, status: 'entered' }).first();
      if (row) await voidRow(db, { row, customerId: null, reason: 'customer_not_eligible' }).catch(() => {});
      return 'void';
    }
    logger.error(`[estimate-promo-code] estimate ${estimateId}: credit not posted (${err?.code || err?.message})`);
    return 'failed';
  }
}

const SWEEP_LIMIT = 100;

/**
 * Recovery for the post-accept credit step (hourly, services/scheduler.js).
 * That step runs after the accept commits and is a fast path, not the
 * guarantee: a failure there, or an accept made while the gate was off,
 * leaves the code waiting on an accepted estimate. This redeems every such
 * row through the same idempotent step. Nothing is sent.
 */
async function sweepAcceptedPromoCodes() {
  if (!gateOn()) return { checked: 0, redeemed: 0 };
  const waiting = await db('estimate_promo_codes as p')
    .join('estimates as e', 'e.id', 'p.estimate_id')
    .where({ 'p.status': 'entered', 'e.status': 'accepted' })
    .orderBy('p.created_at', 'asc')
    .limit(SWEEP_LIMIT)
    .pluck('p.estimate_id');
  let redeemed = 0;
  for (const estimateId of waiting) {
    if (await redeemPromoCodeForAcceptedEstimate({ estimateId }) === 'redeemed') redeemed += 1;
  }
  return { checked: waiting.length, redeemed };
}

module.exports = {
  sweepAcceptedPromoCodes,
  customerRedeemedPromoCredit,
  normalizeCode,
  creditAmountOf,
  estimateHasStaffDiscount,
  promoCodeViewForEstimate,
  enterPromoCode,
  redeemPromoCodeForAcceptedEstimate,
};
