const {
  isCustomerServiceHeld,
  seriesCustomerSkipReason,
} = require('../services/series-customer-eligibility');

describe('isCustomerServiceHeld (single definition of a whole-account hold)', () => {
  const pausedAt = new Date('2026-09-11T14:00:00Z');

  test('an unpaused customer is not held', () => {
    expect(isCustomerServiceHeld({ service_paused_at: null, service_pause_reason: null })).toBe(false);
    expect(isCustomerServiceHeld({})).toBe(false);
    expect(isCustomerServiceHeld(null)).toBe(false);
  });

  test('a hand-set pause reason is a hold', () => {
    expect(isCustomerServiceHeld({ service_paused_at: pausedAt, service_pause_reason: 'owner hold' })).toBe(true);
  });

  test('a paused row with no reason is a hold (fail closed)', () => {
    expect(isCustomerServiceHeld({ service_paused_at: pausedAt, service_pause_reason: null })).toBe(true);
  });

  test('an autopay_final_failure pause is not a hold (visits continue)', () => {
    expect(isCustomerServiceHeld({ service_paused_at: pausedAt, service_pause_reason: 'autopay_final_failure' })).toBe(false);
  });

  test('the series skip rule uses the same predicate', () => {
    expect(seriesCustomerSkipReason({ active: true, service_paused_at: pausedAt, service_pause_reason: 'owner hold' })).toBe('customer_service_held');
    expect(seriesCustomerSkipReason({ active: true, service_paused_at: pausedAt, service_pause_reason: 'autopay_final_failure' })).toBeNull();
  });
});
