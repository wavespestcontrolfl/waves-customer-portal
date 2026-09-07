const { acceptedPricing, matchServiceLine, propertyMatches } = require('../services/completion-pricing');

describe('completion estimate evidence', () => {
  const line = { source: 'recurring', cadence: 'quarterly', serviceId: 'pest',
    perApplicationPrice: 85, sourceLine: { perTreatment: 100, priceAfterDiscount: 85,
      discount: { effectiveDiscount: .15, appliedDiscounts: [{ type: 'waveguard', tier: 'Gold', amount: .15 }] } } };
  test('accepted net carries its existing discount once', () => {
    expect(acceptedPricing(line)).toMatchObject({ amount: 85, base: 100, savings: 15, provenUndiscounted: false,
      discounts: [{ name: 'WaveGuard Gold', dollars: 15, percent: 15 }] });
  });
  test('unknown net is not a new undiscounted base', () => {
    expect(acceptedPricing({ ...line, perApplicationPrice: undefined, parentRecurringDiscounted: true }))
      .toMatchObject({ amount: null, provenUndiscounted: false, breakdownAvailable: false });
  });
  test('explicit free accepted line stays zero', () => {
    expect(acceptedPricing({ ...line, perApplicationPrice: 0, sourceLine: { perTreatment: 100, manualFinalAnnual: 0 } }).amount).toBe(0);
  });
  test('service identity, unique line and cadence are required', () => {
    const job = { service_id: 'pest', is_recurring: true, recurring_pattern: 'quarterly' };
    expect(matchServiceLine(job, [line, { ...line, serviceId: 'lawn' }]).line).toBe(line);
    expect(matchServiceLine(job, [line, line]).status).toBe('ambiguous');
    expect(matchServiceLine({ ...job, recurring_pattern: 'monthly' }, [line]).status).toBe('unmatched');
    expect(matchServiceLine({ service_type: 'Pest' }, [line]).status).toBe('unmatched');
  });
  test('another property never matches the same customer service', () => {
    expect(propertyMatches({ property_id: 'a' }, { property_id: 'b' })).toBe(false);
  });
  test('raw engine duplicates stay ambiguous only in the completion reader', () => {
    const { acceptanceServiceLists } = require('../routes/estimate-public');
    const item = { service: 'pest_control', perApp: 100, annual: 400, visitsPerYear: 4 };
    const source = { engineResult: { lineItems: [item, { ...item, perApp: 120, annual: 480 }] } };
    expect(acceptanceServiceLists(source).recurringSvcList).toHaveLength(1);
    expect(acceptanceServiceLists(source, { preserveDuplicates: true }).recurringSvcList).toHaveLength(2);
  });

});
