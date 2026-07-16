const {
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
    expect(isChargeableAutopayMethod({ ...chargeableCard, exp_month: 7, exp_year: 2026 }, now)).toBe(true);
    expect(isChargeableAutopayMethod({ ...chargeableAch, exp_month: null, exp_year: null }, now)).toBe(true);
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
