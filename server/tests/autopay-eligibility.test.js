const {
  autopayActivePredicate,
  customerOnAutopay,
  isChargeableAutopayMethod,
  isExpiredCardMethod,
  isPaused,
} = require('../services/autopay-eligibility');

const chargeableCard = {
  id: 'pm-1',
  processor: 'stripe',
  method_type: 'card',
  stripe_payment_method_id: 'pm_stripe_1',
  is_default: true,
  autopay_enabled: true,
  exp_month: 12,
  exp_year: 2099,
};

const chargeableAch = {
  ...chargeableCard,
  method_type: 'ach',
};

function knexReturning(row) {
  const query = {
    where() { return query; },
    andWhere(fn) { if (typeof fn === 'function') fn.call(query); return query; },
    orWhere() { return query; },
    orderBy() { return query; },
    select() { return Promise.resolve(row ? [row] : []); },
    first() { return Promise.resolve(row); },
  };
  return () => query;
}

describe('autopay eligibility', () => {
  test('requires autopay to be enabled', async () => {
    await expect(customerOnAutopay({
      id: 'customer-1',
      autopay_enabled: false,
      autopay_payment_method_id: 'pm-1',
    }, { db: knexReturning(null) })).resolves.toBe(false);
  });

  test('accepts an active customer with a chargeable autopay method', async () => {
    await expect(customerOnAutopay({
      id: 'customer-1',
      autopay_enabled: true,
      autopay_payment_method_id: 'pm-1',
    }, { db: knexReturning(chargeableCard) })).resolves.toBe(true);
  });

  test('rejects stale customer payment method ids without a chargeable Stripe row', async () => {
    await expect(customerOnAutopay({
      id: 'customer-1',
      autopay_enabled: true,
      autopay_payment_method_id: 'pm-stale',
    }, { db: knexReturning(null) })).resolves.toBe(false);
  });

  test('a payment_methods read error reads as not-on-autopay by default, but THROWS under failClosed — hold-lifting call sites must not mistake a broken read for unenrollment (Codex #3493 r16)', async () => {
    const brokenKnex = () => ({
      where() { return this; },
      orderBy() { return this; },
      // the candidate walk reads via orderBy().select(); first() kept for
      // the ach_status lookup path
      select() { return Promise.reject(new Error('read failed')); },
      first() { return Promise.reject(new Error('read failed')); },
    });
    const customer = { id: 'customer-1', autopay_enabled: true };
    await expect(customerOnAutopay(customer, { db: brokenKnex })).resolves.toBe(false);
    await expect(customerOnAutopay(customer, { db: brokenKnex, failClosed: true })).rejects.toThrow('read failed');
  });

  test('requires the payment method row to match the monthly autopay charge contract', () => {
    expect(isChargeableAutopayMethod(chargeableCard)).toBe(true);
    expect(isChargeableAutopayMethod({ ...chargeableCard, processor: 'legacy' })).toBe(false);
    expect(isChargeableAutopayMethod({ ...chargeableCard, is_default: false })).toBe(false);
    expect(isChargeableAutopayMethod({ ...chargeableCard, autopay_enabled: false })).toBe(false);
    expect(isChargeableAutopayMethod({ ...chargeableCard, stripe_payment_method_id: null })).toBe(false);
  });

  test('rejects expired or unknown-expiry cards while preserving bank eligibility', () => {
    const now = new Date('2026-07-16T16:00:00Z');
    expect(isExpiredCardMethod({ ...chargeableCard, exp_month: 6, exp_year: 2026 }, now)).toBe(true);
    expect(isChargeableAutopayMethod({ ...chargeableCard, exp_month: 6, exp_year: 2026 }, now)).toBe(false);
    expect(isChargeableAutopayMethod({ ...chargeableCard, exp_month: null, exp_year: null }, now)).toBe(false);
    expect(isChargeableAutopayMethod({ ...chargeableCard, exp_month: '', exp_year: '2099' }, now)).toBe(false);
    expect(isChargeableAutopayMethod({ ...chargeableCard, exp_month: 'xx', exp_year: '2099' }, now)).toBe(false);
    expect(isChargeableAutopayMethod({ ...chargeableCard, exp_month: '12', exp_year: 'nope' }, now)).toBe(false);
    expect(isChargeableAutopayMethod({ ...chargeableCard, exp_month: 7, exp_year: 2026 }, now)).toBe(true);
    expect(isChargeableAutopayMethod({ ...chargeableAch, exp_month: null, exp_year: null }, now)).toBe(true);
  });

  test('guards varchar expiry casts before aggregate numeric comparisons', () => {
    const monthBoundaryUtc = new Date('2026-03-01T02:30:00Z');
    const { sql, binding } = autopayActivePredicate(monthBoundaryUtc);
    const normalizedSql = sql.replace(/\s+/g, ' ').trim();

    const monthGuard = "NULLIF(BTRIM(pm.exp_month), '') ~ '^[0-9]{1,2}$'";
    const yearGuard = "NULLIF(BTRIM(pm.exp_year), '') ~ '^([0-9]{2}|[0-9]{4})$'";
    const monthCast = "NULLIF(BTRIM(pm.exp_month), '')::integer";
    const yearCast = "NULLIF(BTRIM(pm.exp_year), '')::integer";
    // Legacy 2-digit years normalize (+2000) inside the same guarded CASE,
    // mirroring the charge path's normalizeLegacyExpiry.
    const normalizedYear = `(CASE WHEN ${yearCast} < 100 THEN ${yearCast} + 2000 ELSE ${yearCast} END)`;

    expect(normalizedSql).toContain(`CASE WHEN ${monthGuard} AND ${yearGuard} THEN (`);
    expect(normalizedSql).toContain(`${monthCast} BETWEEN 1 AND 12`);
    expect(normalizedSql).toContain('FROM (VALUES (?::date)) AS et(today)');
    expect(normalizedSql).toContain('c.autopay_paused_until >= et.today');
    expect(normalizedSql).toContain(`${normalizedYear} > EXTRACT(YEAR FROM et.today)`);
    expect(normalizedSql).toContain(`${monthCast} >= EXTRACT(MONTH FROM et.today)`);
    // Bank rows blocked by the METHOD's own verification state, exactly like
    // the charge path (stripe.js methodEligibleForCharge).
    expect(normalizedSql).toContain(
      "pm.ach_status NOT IN ('pending_verification', 'verification_failed')",
    );
    // The card-expiry branch is restricted to NON-bank rows (hook r4 P1) —
    // a blocked bank row with populated expiry fields must not pass it.
    expect(normalizedSql).toContain(
      "OR ( (pm.method_type IS NULL OR pm.method_type NOT IN ('ach', 'us_bank_account', 'bank', 'bank_account')) AND CASE",
    );
    expect(normalizedSql).toContain('ELSE FALSE END');
    expect(normalizedSql.indexOf(monthGuard)).toBeLessThan(normalizedSql.indexOf(monthCast));
    expect(normalizedSql.indexOf(yearGuard)).toBeLessThan(normalizedSql.indexOf(yearCast));
    expect(normalizedSql).not.toContain('pm.exp_month BETWEEN');
    expect(normalizedSql).not.toContain('CURRENT_DATE');
    expect((sql.match(/\?/g) || [])).toHaveLength(1);
    expect(binding).toBe('2026-02-28');
  });

  test('keeps JS and SQL card expiry on the prior ET month during UTC rollover', () => {
    const utcMarchButEtFebruary = new Date('2026-03-01T02:30:00Z');

    expect(isExpiredCardMethod({ ...chargeableCard, exp_month: 2, exp_year: 2026 }, utcMarchButEtFebruary)).toBe(false);
    expect(isExpiredCardMethod({ ...chargeableCard, exp_month: 1, exp_year: 2026 }, utcMarchButEtFebruary)).toBe(true);
    expect(autopayActivePredicate(utcMarchButEtFebruary).binding).toBe('2026-02-28');
  });

  test('finds the default Stripe autopay payment method row', async () => {
    await expect(customerOnAutopay({
      id: 'customer-1',
      autopay_enabled: true,
    }, { db: knexReturning(chargeableCard) })).resolves.toBe(true);
  });

  test('treats pause dates as active through the full ET calendar day', async () => {
    const lateOnPausedDayEt = new Date('2026-05-09T03:30:00Z');
    const afterPausedDayEt = new Date('2026-05-09T04:30:00Z');
    expect(isPaused({ autopay_paused_until: '2026-05-08' }, lateOnPausedDayEt)).toBe(true);
    expect(isPaused({ autopay_paused_until: '2026-05-08' }, afterPausedDayEt)).toBe(false);
    await expect(customerOnAutopay({
      id: 'customer-1',
      autopay_enabled: true,
      autopay_payment_method_id: 'pm-1',
      autopay_paused_until: '2026-05-08',
    }, { db: knexReturning(chargeableCard), now: lateOnPausedDayEt })).resolves.toBe(false);
  });

  test('requires the chargeable method to be card when ACH is not active', async () => {
    await expect(customerOnAutopay({
      id: 'customer-1',
      autopay_enabled: true,
      autopay_payment_method_id: 'pm-1',
      ach_status: 'suspended',
    }, { db: knexReturning(chargeableAch) })).resolves.toBe(false);

    await expect(customerOnAutopay({
      id: 'customer-1',
      autopay_enabled: true,
      autopay_payment_method_id: 'pm-1',
      ach_status: 'suspended',
    }, { db: knexReturning(chargeableCard) })).resolves.toBe(true);
  });
});

// Runtime contract for the generated PostgreSQL predicate. This stays skipped
// in unit-only environments and runs anywhere CI provides DATABASE_URL.
const SKIP = !process.env.DATABASE_URL;
const describeWithPostgres = SKIP ? describe.skip : describe;

describeWithPostgres('autopay aggregate PostgreSQL contract', () => {
  let database;

  beforeAll(() => {
    database = require('knex')(require('../knexfile').test);
  });

  afterAll(async () => {
    await database?.destroy();
  });

  test('treats blank and malformed varchar expiry values as inactive without raising', async () => {
    // Frozen clock — the legacy-two-digit '32' row must stay future-dated
    // deterministically (codex #3495 r1 P1).
    const { sql, binding } = autopayActivePredicate(new Date('2026-07-16T16:00:00Z'));
    const result = await database.raw(`
      WITH c(id, autopay_enabled, autopay_paused_until, ach_status, autopay_payment_method_id) AS (
        VALUES
          ('blank-month', true, NULL::date, NULL::text, NULL::uuid),
          ('blank-year', true, NULL::date, NULL::text, NULL::uuid),
          ('invalid-month', true, NULL::date, NULL::text, NULL::uuid),
          ('invalid-year', true, NULL::date, NULL::text, NULL::uuid),
          ('valid-card', true, NULL::date, NULL::text, NULL::uuid),
          ('legacy-two-digit', true, NULL::date, NULL::text, NULL::uuid),
          ('pending-bank', true, NULL::date, NULL::text, NULL::uuid),
          ('pending-bank-card-exp', true, NULL::date, NULL::text, NULL::uuid)
      ), payment_methods(
        customer_id, processor, is_default, autopay_enabled,
        stripe_payment_method_id, method_type, exp_month, exp_year, ach_status
      ) AS (
        VALUES
          ('blank-month', 'stripe', true, true, 'pm_blank_month', 'card', '  ', '2099', NULL::text),
          ('blank-year', 'stripe', true, true, 'pm_blank_year', 'card', '12', '    ', NULL::text),
          ('invalid-month', 'stripe', true, true, 'pm_invalid_month', 'card', 'xx', '2099', NULL::text),
          ('invalid-year', 'stripe', true, true, 'pm_invalid_year', 'card', '12', 'nope', NULL::text),
          ('valid-card', 'stripe', true, true, 'pm_valid', 'card', '12', '2099', NULL::text),
          ('legacy-two-digit', 'stripe', true, true, 'pm_legacy', 'card', '12', '32', NULL::text),
          ('pending-bank', 'stripe', true, true, 'pm_pending', 'ach', NULL::text, NULL::text, 'pending_verification'),
          ('pending-bank-card-exp', 'stripe', true, true, 'pm_pending_exp', 'ach', '12', '2099', 'pending_verification')
      )
      SELECT c.id, ${sql} AS active
      FROM c
      ORDER BY c.id
    `, [binding]);

    expect(Object.fromEntries(result.rows.map((row) => [row.id, row.active]))).toEqual({
      'blank-month': false,
      'blank-year': false,
      'invalid-month': false,
      'invalid-year': false,
      'valid-card': true,
      // '12'/'32' = Dec 2032 — normalized like the charge path.
      'legacy-two-digit': true,
      // The method's own verification state blocks a bank row.
      'pending-bank': false,
      // ...even when the bank row carries populated expiry fields — the
      // card-expiry branch is non-bank only (hook r4 P1).
      'pending-bank-card-exp': false,
    });
  });

  test('uses the bound ET month during the UTC month-rollover window', async () => {
    const utcMarchButEtFebruary = new Date('2026-03-01T02:30:00Z');
    const { sql, binding } = autopayActivePredicate(utcMarchButEtFebruary);
    const result = await database.raw(`
      WITH c(id, autopay_enabled, autopay_paused_until, ach_status, autopay_payment_method_id) AS (
        VALUES
          ('february-card', true, NULL::date, NULL::text, NULL::uuid),
          ('january-card', true, NULL::date, NULL::text, NULL::uuid)
      ), payment_methods(
        customer_id, processor, is_default, autopay_enabled,
        stripe_payment_method_id, method_type, exp_month, exp_year, ach_status
      ) AS (
        VALUES
          ('february-card', 'stripe', true, true, 'pm_february', 'card', '02', '2026', NULL::text),
          ('january-card', 'stripe', true, true, 'pm_january', 'card', '01', '2026', NULL::text)
      )
      SELECT c.id, ${sql} AS active
      FROM c
      ORDER BY c.id
    `, [binding]);

    expect(binding).toBe('2026-02-28');
    expect(Object.fromEntries(result.rows.map((row) => [row.id, row.active]))).toEqual({
      'february-card': true,
      'january-card': false,
    });
  });
});

describe('charge-path parity (cron-gap audit B4)', () => {
  // Frozen clock (codex #3495 r1 P1): with a live clock these assertions
  // would start failing without a code change in January 2033.
  const frozenNow = new Date('2026-07-16T16:00:00Z');
  test('legacy 2-digit expiry years normalize like the charge path', () => {
    // A '12/32' card is valid until Dec 2032 — the old predicate read year
    // 32 and refused a method collection would charge.
    expect(isExpiredCardMethod({ ...chargeableCard, exp_month: '12', exp_year: '32' }, frozenNow)).toBe(false);
    expect(isExpiredCardMethod({ ...chargeableCard, exp_month: '12', exp_year: '02' }, frozenNow)).toBe(true);
    expect(isChargeableAutopayMethod({ ...chargeableCard, exp_month: '12', exp_year: '32' }, frozenNow)).toBe(true);
  });

  test('bank rows in pending/failed verification are not chargeable; verified and NULL are', () => {
    expect(isChargeableAutopayMethod({ ...chargeableAch, ach_status: 'pending_verification' }, frozenNow)).toBe(false);
    expect(isChargeableAutopayMethod({ ...chargeableAch, ach_status: 'verification_failed' }, frozenNow)).toBe(false);
    expect(isChargeableAutopayMethod({ ...chargeableAch, ach_status: 'verified' }, frozenNow)).toBe(true);
    expect(isChargeableAutopayMethod({ ...chargeableAch }, frozenNow)).toBe(true);
    // Cards are untouched by ach_status.
    expect(isChargeableAutopayMethod({ ...chargeableCard, ach_status: 'pending_verification' }, frozenNow)).toBe(true);
  });

  test('walks all default methods before declaring autopay inactive (multi-default legacy data)', async () => {
    // A pending-verification bank row beside a chargeable card must not
    // make customerOnAutopay() false — mirror the charge path's candidate
    // walk (codex #3495 r1 P1).
    const rows = [
      { ...chargeableAch, id: 'pm-bank', ach_status: 'pending_verification' },
      { ...chargeableCard, id: 'pm-card' },
    ];
    const query = {
      where() { return query; },
      orderBy() { return query; },
      select() { return Promise.resolve(rows); },
      first() { return Promise.resolve(rows[0]); },
    };
    await expect(customerOnAutopay({
      id: 'customer-1',
      autopay_enabled: true,
    }, { db: () => query, now: frozenNow })).resolves.toBe(true);
  });
});
