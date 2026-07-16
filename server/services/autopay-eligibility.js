const defaultDb = require('../models/db');
const { etDateString } = require('../utils/datetime-et');

function isPaused(customer, now = new Date()) {
  if (!customer?.autopay_paused_until) return false;
  const pausedUntil = String(
    customer.autopay_paused_until instanceof Date
      ? customer.autopay_paused_until.toISOString()
      : customer.autopay_paused_until
  ).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(pausedUntil) && pausedUntil >= etDateString(now);
}

function isExpiredCardMethod(method, now = new Date()) {
  if (!method || isBankMethodType(method.method_type)) return false;
  const expMonth = Number(method.exp_month);
  const expYear = Number(method.exp_year);
  if (!Number.isInteger(expMonth) || expMonth < 1 || expMonth > 12 || !Number.isInteger(expYear)) {
    return true;
  }
  const [currentYear, currentMonth] = etDateString(now).split('-').map(Number);
  return expYear < currentYear || (expYear === currentYear && expMonth < currentMonth);
}

function isChargeableAutopayMethod(method, now = new Date()) {
  return !!method
    && method.processor === 'stripe'
    && method.is_default === true
    && method.autopay_enabled === true
    && !!method.stripe_payment_method_id
    && !isExpiredCardMethod(method, now);
}

async function getChargeableAutopayMethod(customer, knex) {
  if (!customer?.id) return false;

  try {
    return await knex('payment_methods')
      .where({
        customer_id: customer.id,
        processor: 'stripe',
        is_default: true,
        autopay_enabled: true,
      })
      .first(
        'id', 'processor', 'method_type', 'stripe_payment_method_id',
        'is_default', 'autopay_enabled', 'exp_month', 'exp_year'
      );
  } catch {
    return null;
  }
}

async function customerOnAutopay(customer, options = {}) {
  const knex = options.db || defaultDb;
  if (!customer) return false;
  if (customer.autopay_enabled === false) return false;
  if (isPaused(customer, options.now)) return false;

  const paymentMethod = await getChargeableAutopayMethod(customer, knex);
  if (!isChargeableAutopayMethod(paymentMethod, options.now)) return false;

  if (customer.ach_status && customer.ach_status !== 'active') {
    return paymentMethod.method_type === 'card';
  }

  return true;
}

// SQL form of customerOnAutopay() for aggregates that can't afford one query per
// customer (e.g. dashboard coverage counts). Mirrors the JS predicate exactly:
// not disabled, not paused (ET date), and a canonical default Stripe autopay
// payment_methods row exists — with the ACH-not-active → card-only fallback, where
// a NULL/'' ach_status is treated as "no ACH block" (matching the JS, where '' is
// falsy). Requires the customers table to be aliased `c` in the caller's query.
// The single `?` binds today's ET date. Returns { sql, binding } so callers can
// also NOT() it.
function autopayActivePredicate() {
  const sql = `(
    c.autopay_enabled IS NOT FALSE
    AND NOT (c.autopay_paused_until IS NOT NULL AND c.autopay_paused_until >= ?::date)
    AND EXISTS (
      SELECT 1 FROM payment_methods pm
      WHERE pm.customer_id = c.id
        AND pm.processor = 'stripe'
        AND pm.is_default = true
        AND pm.autopay_enabled = true
        AND pm.stripe_payment_method_id IS NOT NULL
        AND (
          pm.method_type IN ('ach', 'us_bank_account', 'bank', 'bank_account')
          OR (
            pm.exp_month BETWEEN 1 AND 12
            AND pm.exp_year IS NOT NULL
            AND (
              pm.exp_year > EXTRACT(YEAR FROM CURRENT_DATE)
              OR (
                pm.exp_year = EXTRACT(YEAR FROM CURRENT_DATE)
                AND pm.exp_month >= EXTRACT(MONTH FROM CURRENT_DATE)
              )
            )
          )
        )
        AND (
          c.ach_status IS NULL OR c.ach_status = '' OR c.ach_status = 'active'
          OR pm.method_type = 'card'
        )
    )
  )`;
  return { sql, binding: etDateString() };
}

// Bank rows appear under BOTH aliases — savePaymentMethod writes 'ach',
// other paths have written Stripe's 'us_bank_account' (the same pair
// enrollConsentedMethod's BANK_ALIASES handles). Every bank guard must
// accept both or alias rows slip past it (Codex #2706 r5).
function isBankMethodType(methodType) {
  const t = String(methodType || '').toLowerCase();
  return t === 'ach' || t === 'us_bank_account';
}

module.exports = {
  customerOnAutopay,
  getChargeableAutopayMethod,
  isChargeableAutopayMethod,
  isBankMethodType,
  isExpiredCardMethod,
  isPaused,
  autopayActivePredicate,
};
