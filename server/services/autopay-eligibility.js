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
  // Legacy rows store 2-digit expiry years — normalize exactly like the
  // charge path does (stripe.js normalizeLegacyExpiry), or a valid '12/32'
  // card reads as year 32 and eligibility refuses a method collection
  // would happily charge (dashboard says unchargeable, charge succeeds).
  const rawYear = Number(method.exp_year);
  const expYear = Number.isFinite(rawYear) && rawYear > 0 && rawYear < 100 ? rawYear + 2000 : rawYear;
  if (!Number.isInteger(expMonth) || expMonth < 1 || expMonth > 12 || !Number.isInteger(expYear)) {
    return true;
  }
  const [currentYear, currentMonth] = etDateString(now).split('-').map(Number);
  return expYear < currentYear || (expYear === currentYear && expMonth < currentMonth);
}

// Bank rows the charge path refuses regardless of customers.ach_status —
// the METHOD's own verification state (billing-v2 writes these on the
// microdeposit flow). Mirrored by methodEligibleForCharge in stripe.js and
// by the SQL predicate below; the three must agree or billing-health calls
// a method "chargeable" that collection refuses at charge time.
const BLOCKED_PM_ACH_STATUSES = ['pending_verification', 'verification_failed'];

function isChargeableAutopayMethod(method, now = new Date()) {
  return !!method
    && method.processor === 'stripe'
    && method.is_default === true
    && method.autopay_enabled === true
    && !!method.stripe_payment_method_id
    && !isExpiredCardMethod(method, now)
    && !(isBankMethodType(method.method_type)
      && BLOCKED_PM_ACH_STATUSES.includes(method.ach_status));
}

async function getChargeableAutopayMethod(customer, knex, { rethrow = false, now = new Date() } = {}) {
  if (!customer?.id) return false;

  try {
    // Legacy data (or a pre-fix race) can hold SEVERAL default+enabled rows,
    // and the charge path (stripe.js) walks candidates in a deterministic
    // order until an eligible one is found. Mirror that walk: an unordered
    // .first() could surface a pending-verification bank row and declare the
    // customer unchargeable while a chargeable card sits beside it — making
    // this predicate disagree with the SQL aggregate and the charge path
    // (codex #3495 r1 P1).
    const candidates = await knex('payment_methods')
      .where({
        customer_id: customer.id,
        processor: 'stripe',
        is_default: true,
        autopay_enabled: true,
      })
      .orderBy([{ column: 'updated_at', order: 'desc' }, { column: 'id', order: 'asc' }])
      .select(
        'id', 'processor', 'method_type', 'stripe_payment_method_id',
        'is_default', 'autopay_enabled', 'exp_month', 'exp_year', 'ach_status'
      );
    // The customer-level ACH rule and the ENROLLMENT POINTER both
    // participate, mirroring StripeService.charge() exactly (codex #3495
    // P0): customers.autopay_payment_method_id is "the method actually in
    // charge" — with legacy duplicate defaults, ignoring it could hand a
    // completion caller a different method than the enrolled one. Callers
    // commonly pass a bare { id } (completion/quote paths), so absent
    // fields are LOOKED UP, never assumed (a failed lookup treats ACH as
    // blocked and the pointer as unset — fail toward the walk) — or
    // rethrows for failClosed callers, same contract as the outer catch.
    let achStatus = customer.ach_status;
    let pointerId = customer.autopay_payment_method_id;
    if (achStatus === undefined || pointerId === undefined) {
      try {
        const custRow = await knex('customers').where({ id: customer.id })
          .first('ach_status', 'autopay_payment_method_id');
        if (achStatus === undefined) achStatus = custRow?.ach_status ?? null;
        if (pointerId === undefined) pointerId = custRow?.autopay_payment_method_id ?? null;
      } catch (lookupErr) {
        if (rethrow) throw lookupErr;
        if (achStatus === undefined) achStatus = 'suspended';
        if (pointerId === undefined) pointerId = null;
      }
    }
    const achBlockedForCustomer = !!(achStatus && achStatus !== 'active');
    const eligible = (m) => isChargeableAutopayMethod(m, now)
      && !(achBlockedForCustomer && isBankMethodType(m.method_type));
    // Pointer first — charge() honors it before the default fallback; an
    // ineligible pointer falls through to the walk, same as charge()'s
    // "falling back to default lookup" branch.
    if (pointerId) {
      const pointerRow = (candidates || []).find((m) => String(m.id) === String(pointerId))
        || await knex('payment_methods')
          .where({ id: pointerId, customer_id: customer.id, processor: 'stripe', autopay_enabled: true })
          .first(
            'id', 'processor', 'method_type', 'stripe_payment_method_id',
            'is_default', 'autopay_enabled', 'exp_month', 'exp_year', 'ach_status'
          );
      if (pointerRow && eligible({ ...pointerRow, is_default: true })) {
        // charge() accepts the pointer regardless of is_default (the
        // pointer normally IS the default; enrollment repoints both) —
        // return the NORMALIZED row, because customerOnAutopay rechecks it
        // with isChargeableAutopayMethod, which requires is_default (hook
        // P1: a raw non-default pointer row would pass here and then fail
        // the recheck, reading as not-on-autopay).
        return { ...pointerRow, is_default: true };
      }
    }
    return (candidates || []).find(eligible) || null;
  } catch (err) {
    // Swallowed by default (a broken read means "no chargeable method" for
    // display/scheduling call sites). Callers whose SAFE direction is
    // "still enrolled" — e.g. deciding whether to lift an autopay hold —
    // pass failClosed and handle the throw themselves: a swallowed read
    // error here reads as confirmed unenrollment and activates reminders
    // for an enrolled customer (Codex #3493 r16).
    if (rethrow) throw err;
    return null;
  }
}

async function customerOnAutopay(customer, options = {}) {
  const knex = options.db || defaultDb;
  if (!customer) return false;
  if (customer.autopay_enabled === false) return false;
  if (isPaused(customer, options.now)) return false;

  const paymentMethod = await getChargeableAutopayMethod(customer, knex, {
    rethrow: options.failClosed === true,
    now: options.now,
  });
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
// The single `?` binds today's ET date once; pause and card-expiry checks both
// read that same value so a UTC month rollover cannot split their definition of
// "today". Returns { sql, binding } so callers can also NOT() it.
function autopayActivePredicate(now = new Date()) {
  const sql = `EXISTS (
    SELECT 1
    FROM (VALUES (?::date)) AS et(today)
    WHERE c.autopay_enabled IS NOT FALSE
      AND NOT (c.autopay_paused_until IS NOT NULL AND c.autopay_paused_until >= et.today)
      AND EXISTS (
        SELECT 1 FROM payment_methods pm
        WHERE pm.customer_id = c.id
        AND pm.processor = 'stripe'
        AND pm.is_default = true
        AND pm.autopay_enabled = true
        AND pm.stripe_payment_method_id IS NOT NULL
        AND (
          (
            pm.method_type IN ('ach', 'us_bank_account', 'bank', 'bank_account')
            -- The METHOD's own verification state blocks a bank row exactly
            -- like the charge path (stripe.js methodEligibleForCharge) —
            -- without this a pending/failed-verification bank row counts as
            -- "chargeable" on billing-health while collection refuses it.
            AND (pm.ach_status IS NULL
              OR pm.ach_status NOT IN ('pending_verification', 'verification_failed'))
          )
          -- Card expiry accepts legacy 2-digit years (+2000), mirroring the
          -- charge path's normalizeLegacyExpiry — a '12/32' card is valid.
          -- The casts live inside CASE THEN, which Postgres evaluates only
          -- after the WHEN regexes pass (unlike AND, whose conjuncts may
          -- reorder), so a non-numeric value can never reach ::integer.
          -- Restricted to NON-bank rows (hook r4 P1): a blocked bank row
          -- with populated expiry fields must not slip through this branch.
          OR (
          (pm.method_type IS NULL
            OR pm.method_type NOT IN ('ach', 'us_bank_account', 'bank', 'bank_account'))
          AND CASE
            WHEN NULLIF(BTRIM(pm.exp_month), '') ~ '^[0-9]{1,2}$'
              AND NULLIF(BTRIM(pm.exp_year), '') ~ '^([0-9]{2}|[0-9]{4})$'
            THEN (
              NULLIF(BTRIM(pm.exp_month), '')::integer BETWEEN 1 AND 12
              AND (
                (CASE WHEN NULLIF(BTRIM(pm.exp_year), '')::integer < 100
                      THEN NULLIF(BTRIM(pm.exp_year), '')::integer + 2000
                      ELSE NULLIF(BTRIM(pm.exp_year), '')::integer END)
                  > EXTRACT(YEAR FROM et.today)
                OR (
                  (CASE WHEN NULLIF(BTRIM(pm.exp_year), '')::integer < 100
                        THEN NULLIF(BTRIM(pm.exp_year), '')::integer + 2000
                        ELSE NULLIF(BTRIM(pm.exp_year), '')::integer END)
                    = EXTRACT(YEAR FROM et.today)
                  AND NULLIF(BTRIM(pm.exp_month), '')::integer >= EXTRACT(MONTH FROM et.today)
                )
              )
            )
            ELSE FALSE
          END
          )
        )
        AND (
          c.ach_status IS NULL OR c.ach_status = '' OR c.ach_status = 'active'
          OR pm.method_type = 'card'
        )
      )
  )`;
  return { sql, binding: etDateString(now) };
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
