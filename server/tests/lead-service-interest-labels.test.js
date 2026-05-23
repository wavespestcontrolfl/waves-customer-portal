const publicQuoteRouter = require('../routes/public-quote');
const leadWebhookRouter = require('../routes/lead-webhook');

describe('quote workflow service interest labels', () => {
  const {
    buildPublicQuoteServiceInterest,
    buildCompactPublicQuoteServiceInterest,
    buildCompactCustomerServiceInterest,
  } = publicQuoteRouter._internals;

  const {
    normalizeLeadServiceInterest,
    shouldApplyTriageServiceInterest,
  } = leadWebhookRouter._test;

  test('public quote recurring pest labels include selected cadence', () => {
    expect(buildPublicQuoteServiceInterest({ pest: { frequency: 'quarterly' } }))
      .toBe('Quarterly Pest Control');
    expect(buildPublicQuoteServiceInterest({ pest: { frequency: 'bimonthly' } }))
      .toBe('Bi-Monthly Pest Control');
    expect(buildPublicQuoteServiceInterest({ pest: { frequency: 'bi-monthly' } }))
      .toBe('Bi-Monthly Pest Control');
    expect(buildPublicQuoteServiceInterest({ pest: { frequency: 'monthly' } }))
      .toBe('Monthly Pest Control');
  });

  test('public quote pest labels default unsupported cadence the same way pricing does', () => {
    expect(buildPublicQuoteServiceInterest({ pest: { frequency: 'semiannual' } }))
      .toBe('Quarterly Pest Control');
    expect(buildPublicQuoteServiceInterest({ pest: { frequency: 'unknown' } }))
      .toBe('Quarterly Pest Control');
  });

  test('public quote recurring lawn labels are explicit without overflowing customer field', () => {
    expect(buildPublicQuoteServiceInterest({
      pest: { frequency: 'quarterly' },
      lawn: { track: 'st_augustine', tier: 'enhanced' },
    })).toBe('Quarterly Pest Control + Recurring Lawn Care');

    const compact = buildCompactPublicQuoteServiceInterest({
      pest: { frequency: 'quarterly' },
      lawn: { track: 'st_augustine', tier: 'enhanced' },
    });

    expect(compact).toBe('Quarterly Pest + Lawn Care');
    expect(compact.length).toBeLessThanOrEqual(32);
  });

  test('upsell customer service interest stays compact instead of truncating mid-label', () => {
    const compact = buildCompactCustomerServiceInterest([
      'Quarterly Pest Control',
      'Lawn Care',
    ]);

    expect(compact).toBe('Quarterly Pest + Lawn Care');
    expect(compact.length).toBeLessThanOrEqual(32);
  });

  test('compact customer service interest drops overflow add-ons cleanly', () => {
    const compact = buildCompactCustomerServiceInterest([
      'Quarterly Pest Control',
      'Lawn Care',
      'Mosquito & No-See-Um Control',
    ]);

    expect(compact).toBe('Quarterly Pest + Lawn Care');
    expect(compact).not.toMatch(/Ca$/);
    expect(compact.length).toBeLessThanOrEqual(32);
  });

  test('lead webhook formats quote workflow frequency before storing service interest', () => {
    expect(normalizeLeadServiceInterest({ interest: 'pest', frequency: 'one-time' }))
      .toBe('One-Time Pest Control');
    expect(normalizeLeadServiceInterest({ interest: 'pest', frequency: 'ongoing' }))
      .toBe('Recurring Pest Control');
    expect(normalizeLeadServiceInterest({ interest: 'pest', frequency: 'not-sure' }))
      .toBe('Pest Control Consultation');
    expect(normalizeLeadServiceInterest({ interest: 'lawn', frequency: 'one-time' }))
      .toBe('One-Time Lawn Care');
    expect(normalizeLeadServiceInterest({ interest: 'both', frequency: 'ongoing' }))
      .toBe('Recurring Pest Control + Recurring Lawn Care');
  });

  test('lead webhook normalizes legacy parenthetical one-time labels', () => {
    expect(normalizeLeadServiceInterest({ service_interest: 'Pest Control (One-Time)' }))
      .toBe('One-Time Pest Control');
    expect(normalizeLeadServiceInterest({ service_interest: 'Lawn Care (Consult)' }))
      .toBe('Lawn Care Consultation');
  });

  test('AI triage does not overwrite workflow-specific service interest labels', () => {
    expect(shouldApplyTriageServiceInterest('One-Time Pest Control', 'General Pest Control')).toBe(false);
    expect(shouldApplyTriageServiceInterest('Recurring Lawn Care', 'General Lawn Care')).toBe(false);
    expect(shouldApplyTriageServiceInterest('Pest Control Consultation', 'General Pest Control')).toBe(false);
    expect(shouldApplyTriageServiceInterest('Pest Control', 'General Pest Control')).toBe(true);
    expect(shouldApplyTriageServiceInterest('', 'General Pest Control')).toBe(true);
  });
});
