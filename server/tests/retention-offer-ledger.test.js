'use strict';

// Retention offer money math (PR E): the $75 cap across 2 charges, partial
// last application, exhaustion, and the pure invoice-line shape.

jest.mock('../models/db', () => jest.fn());

const { retentionDiscountForInvoice, offerEligibility } = require('../services/cancellation-resolution/retention-offer');

function offer(overrides = {}) {
  return {
    id: 'offer-1',
    status: 'granted',
    percent_off: 15,
    max_charges: 2,
    cap_amount: 75,
    charges_applied: 0,
    amount_applied: 0,
    ...overrides,
  };
}

describe('retentionDiscountForInvoice', () => {
  test('first charge: plain 15%, negative line after the tier discount', () => {
    const out = retentionDiscountForInvoice(offer(), 120);
    expect(out.amount).toBe(18);
    expect(out.lineItem).toMatchObject({ amount: -18, unit_price: -18, category: 'retention_offer' });
    expect(out.lineItem.description).toBe('Stay offer — 15% off (1 of 2)');
    expect(out.exhaustsOffer).toBe(false);
  });

  test('cap binds: a big second charge takes only what is left of $75', () => {
    const out = retentionDiscountForInvoice(offer({ charges_applied: 1, amount_applied: 45 }), 400);
    expect(out.amount).toBe(30); // 75 - 45, not 60
    expect(out.exhaustsOffer).toBe(true);
  });

  test('two charges max, regardless of cap headroom', () => {
    expect(retentionDiscountForInvoice(offer({ charges_applied: 2, amount_applied: 20 }), 100)).toBeNull();
    const second = retentionDiscountForInvoice(offer({ charges_applied: 1, amount_applied: 10 }), 100);
    expect(second.exhaustsOffer).toBe(true); // 2nd application is the last
  });

  test('nothing applies to a non-granted offer, zero subtotal, or spent cap', () => {
    expect(retentionDiscountForInvoice(offer({ status: 'exhausted' }), 100)).toBeNull();
    expect(retentionDiscountForInvoice(offer({ status: 'voided' }), 100)).toBeNull();
    expect(retentionDiscountForInvoice(offer(), 0)).toBeNull();
    expect(retentionDiscountForInvoice(offer({ amount_applied: 75 }), 100)).toBeNull();
  });

  test('rounding stays on cents', () => {
    const out = retentionDiscountForInvoice(offer(), 89.99);
    expect(out.amount).toBe(13.5); // 13.4985 → 13.50
  });
});

describe('offerEligibility blocker names', () => {
  const good = {
    tenureDays: 400,
    completedPaidVisits: 5,
    accountCurrent: true,
    openComplaint: false,
    openCallbackLanes: [],
    prepay: false,
    billingMode: 'monthly_membership',
    priorRetentionOfferAt: null,
    manualPriceOverrideAt: null,
    families: ['pest_control'],
  };

  test('clean account on price is eligible with the cancelled family', () => {
    const out = offerEligibility(good, { reasonCode: 'price', families: ['pest_control'] });
    expect(out).toMatchObject({ eligible: true, familyKey: 'pest_control', blockers: [] });
  });

  test('each rule reports its own blocker', () => {
    expect(offerEligibility(good, { reasonCode: 'away', families: ['pest_control'] }).blockers).toContain('reason_not_money_eligible');
    expect(offerEligibility({ ...good, families: ['termite_bait'] }, { reasonCode: 'price', families: ['termite_bait'] }).blockers).toContain('no_eligible_family');
    expect(offerEligibility({ ...good, tenureDays: 100 }, { reasonCode: 'price' }).blockers).toContain('tenure_under_12_months');
    expect(offerEligibility({ ...good, completedPaidVisits: 3 }, { reasonCode: 'price' }).blockers).toContain('under_4_paid_visits');
    expect(offerEligibility({ ...good, accountCurrent: false }, { reasonCode: 'price' }).blockers).toContain('account_not_current');
    expect(offerEligibility({ ...good, openComplaint: true }, { reasonCode: 'price' }).blockers).toContain('open_complaint');
    expect(offerEligibility({ ...good, openCallbackLanes: ['lawn'] }, { reasonCode: 'price' }).blockers).toContain('open_callback');
    expect(offerEligibility({ ...good, prepay: true }, { reasonCode: 'price' }).blockers).toContain('annual_prepay');
    expect(offerEligibility({ ...good, billingMode: 'one_time' }, { reasonCode: 'price' }).blockers).toContain('billing_lane_not_recurring');
    expect(offerEligibility({ ...good, priorRetentionOfferAt: new Date().toISOString() }, { reasonCode: 'price' }).blockers).toContain('offer_within_18_months');
  });
});
