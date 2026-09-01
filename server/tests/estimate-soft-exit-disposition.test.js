/**
 * Customer soft exit — the reason-tagged decline (GATE_ESTIMATE_SOFT_EXIT).
 * The chip keys map onto the SAME normalized loss codes the staff modal
 * writes, so analytics read one vocabulary; text is clipped and stripped;
 * "Other" without a note is refused exactly as the staff path refuses it.
 */
const {
  CUSTOMER_DECLINE_REASONS,
  customerDispositionUpdates,
  isDispositionCode,
} = require('../services/estimate-disposition');

describe('CUSTOMER_DECLINE_REASONS', () => {
  test('every customer reason maps to a real disposition code', () => {
    for (const code of Object.values(CUSTOMER_DECLINE_REASONS)) {
      expect(isDispositionCode(code)).toBe(true);
    }
  });
  test('still_deciding is not a decline reason', () => {
    expect(CUSTOMER_DECLINE_REASONS.still_deciding).toBeUndefined();
  });
});

describe('customerDispositionUpdates', () => {
  test('no reason → no updates (the plain decline stays a plain decline)', () => {
    expect(customerDispositionUpdates({})).toEqual({ updates: null });
    expect(customerDispositionUpdates({ reason: '' })).toEqual({ updates: null });
  });

  test('unknown reason keys are a 400, never a silent default', () => {
    expect(customerDispositionUpdates({ reason: 'declined_price' }).error).toMatch(/Invalid reason/);
    expect(customerDispositionUpdates({ reason: 'still_deciding' }).error).toMatch(/Invalid reason/);
  });

  test('price → declined_price, customer-sourced, label populated', () => {
    const { updates } = customerDispositionUpdates({ reason: 'price', note: ' way <b>over</b> budget ' });
    expect(updates.disposition).toBe('declined_price');
    expect(updates.disposition_source).toBe('customer');
    expect(updates.disposition_at).toBeInstanceOf(Date);
    expect(updates.disposition_note).toBe('way bover/b budget');
    expect(updates.decline_reason).toBe('Too expensive');
    expect(updates.competitor_name).toBeNull();
    expect(updates.competitor_price).toBeNull();
  });

  test('competitor carries name + price; a garbage price is a 400', () => {
    const { updates } = customerDispositionUpdates({
      reason: 'competitor', competitorName: ' Bugs-R-Us ', competitorPrice: '$39.50',
    });
    expect(updates.disposition).toBe('declined_competitor');
    expect(updates.competitor_name).toBe('Bugs-R-Us');
    expect(updates.competitor_price).toBe(39.5);
    expect(customerDispositionUpdates({ reason: 'competitor', competitorPrice: 'cheap' }).error).toMatch(/dollar amount/);
  });

  test('competitor fields are ignored on non-competitor reasons', () => {
    const { updates } = customerDispositionUpdates({ reason: 'timing', competitorName: 'X', competitorPrice: '10' });
    expect(updates.competitor_name).toBeNull();
    expect(updates.competitor_price).toBeNull();
  });

  test('other requires a note', () => {
    expect(customerDispositionUpdates({ reason: 'other' }).error).toMatch(/little more/);
    expect(customerDispositionUpdates({ reason: 'other', note: 'moving next month' }).updates.disposition).toBe('declined_other');
  });

  test('note is clipped to 500 chars', () => {
    const { updates } = customerDispositionUpdates({ reason: 'timing', note: 'x'.repeat(900) });
    expect(updates.disposition_note).toHaveLength(500);
  });
});
