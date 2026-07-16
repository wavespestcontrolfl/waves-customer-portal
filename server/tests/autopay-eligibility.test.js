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
    const { sql, binding } = autopayActivePredicate();
    const normalizedSql = sql.replace(/\s+/g, ' ').trim();

    const monthGuard = "NULLIF(BTRIM(pm.exp_month), '') ~ '^[0-9]{1,2}$'";
    const yearGuard = "NULLIF(BTRIM(pm.exp_year), '') ~ '^[0-9]{4}$'";
    const monthCast = "NULLIF(BTRIM(pm.exp_month), '')::integer";
    const yearCast = "NULLIF(BTRIM(pm.exp_year), '')::integer";

    expect(normalizedSql).toContain(`CASE WHEN ${monthGuard} AND ${yearGuard} THEN (`);
    expect(normalizedSql).toContain(`${monthCast} BETWEEN 1 AND 12`);
    expect(normalizedSql).toContain(`${yearCast} > EXTRACT(YEAR FROM CURRENT_DATE)`);
    expect(normalizedSql).toContain('ELSE FALSE END');
    expect(normalizedSql.indexOf(monthGuard)).toBeLessThan(normalizedSql.indexOf(monthCast));
    expect(normalizedSql.indexOf(yearGuard)).toBeLessThan(normalizedSql.indexOf(yearCast));
    expect(normalizedSql).not.toContain('pm.exp_month BETWEEN');
    expect(binding).toMatch(/^\d{4}-\d{2}-\d{2}$/);
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
    const { sql, binding } = autopayActivePredicate();
    const result = await database.raw(`
      WITH c(id, autopay_enabled, autopay_paused_until, ach_status) AS (
        VALUES
          ('blank-month', true, NULL::date, NULL::text),
          ('blank-year', true, NULL::date, NULL::text),
          ('invalid-month', true, NULL::date, NULL::text),
          ('invalid-year', true, NULL::date, NULL::text),
          ('valid-card', true, NULL::date, NULL::text)
      ), payment_methods(
        customer_id, processor, is_default, autopay_enabled,
        stripe_payment_method_id, method_type, exp_month, exp_year
      ) AS (
        VALUES
          ('blank-month', 'stripe', true, true, 'pm_blank_month', 'card', '  ', '2099'),
          ('blank-year', 'stripe', true, true, 'pm_blank_year', 'card', '12', '    '),
          ('invalid-month', 'stripe', true, true, 'pm_invalid_month', 'card', 'xx', '2099'),
          ('invalid-year', 'stripe', true, true, 'pm_invalid_year', 'card', '12', 'nope'),
          ('valid-card', 'stripe', true, true, 'pm_valid', 'card', '12',
            (EXTRACT(YEAR FROM CURRENT_DATE)::integer + 1)::text)
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
    });
  });
});
