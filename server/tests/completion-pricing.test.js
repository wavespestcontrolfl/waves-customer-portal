const { acceptedPricing, acceptedVisitBreakdown, matchServiceLine, propertyMatches } = require('../services/completion-pricing');

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
  test('a lawn rounds job is the 9x lawn plan, and no other cadence', () => {
    const lawn = { source: 'recurring', serviceId: 'lawn' };
    const job = { service_id: 'lawn', is_recurring: true, recurring_pattern: 'lawn_rounds_9' };
    // Estimate lines carry the 9x plan as custom + 42 days (the scheduler's form).
    expect(matchServiceLine(job, [{ ...lawn, cadence: 'custom', intervalDays: 42 }]).status).toBe('matched');
    expect(matchServiceLine(job, [{ ...lawn, cadence: 'every_6_weeks' }]).status).toBe('matched');
    expect(matchServiceLine(job, [{ ...lawn, cadence: 'quarterly' }]).status).toBe('unmatched');
    expect(matchServiceLine(job, [{ ...lawn, cadence: 'monthly' }]).status).toBe('unmatched');
    expect(matchServiceLine(job, [{ ...lawn, cadence: 'custom', intervalDays: 30 }]).status).toBe('unmatched');
    expect(matchServiceLine(job, [{ ...lawn, cadence: 'custom', intervalDays: null }]).status).toBe('unmatched');
    // Other jobs compare exactly as before.
    expect(matchServiceLine({ ...job, recurring_pattern: 'quarterly' }, [{ ...lawn, cadence: 'custom', intervalDays: 42 }]).status).toBe('unmatched');
  });
  test('another property never matches the same customer service', () => {
    expect(propertyMatches({ property_id: 'a' }, { property_id: 'b' })).toBe(false);
  });
  test('the accepted saving is named by the tier on the line and the estimate\'s own discount', () => {
    const silver = (sourceLine = {}, perApplicationPrice = 94.05) => ({ ...line, perApplicationPrice, sourceLine: { perTreatment: 110, priceAfterDiscount: perApplicationPrice,
      discount: { effectiveDiscount: 0.1, appliedDiscounts: [{ type: 'waveguard', tier: 'silver', amount: 0.1 }] }, ...sourceLine } });
    const names = (quote) => quote.discounts.map(({ name, dollars, named }) => [name, dollars, named]);
    // Tier, then the staff discount on what is left.
    expect(names(acceptedPricing(silver(), { manualName: 'Military Discount' })))
      .toEqual([['WaveGuard Silver', 11, true], ['Military Discount', 4.95, true]]);
    // Tier alone: a few cents of rounding stay with the tier; a price floor's smaller saving is still the tier's.
    expect(names(acceptedPricing(silver({}, 98.97)))).toEqual([['WaveGuard Silver', 11.03, true]]);
    expect(names(acceptedPricing(silver({}, 104)))).toEqual([['WaveGuard Silver', 6, true]]);
    // Anything the estimate does not name is shown to staff but marked unnamed.
    expect(names(acceptedPricing(silver()))).toEqual([['WaveGuard Silver', 11, true], ['Other accepted discount', 4.95, false]]);
    expect(names(acceptedPricing(silver({ serviceSpecificDiscounts: [{ amount: 4.95 }] }), { manualName: 'Military Discount' })))
      .toEqual([['WaveGuard Silver', 11, true], ['Other accepted discount', 4.95, false]]);
    const listPriceRow = silver({ discount: undefined });
    expect(names(acceptedPricing(listPriceRow, { manualName: 'Military Discount', tierDiscounted: true })))
      .toEqual([['Accepted estimate discount', 15.95, false]]);
    expect(names(acceptedPricing(listPriceRow, { manualName: 'Military Discount' }))).toEqual([['Military Discount', 15.95, true]]);
  });

  describe('acceptedVisitBreakdown', () => {
    const estimate = { id: 'e1', customer_id: 'c1', property_id: 'p1', status: 'accepted', waveguard_tier: 'Silver',
      estimate_data: { summary: { manualDiscount: { amount: 19.8, recurringAmount: 19.8, label: 'Military Discount' } } } };
    const visit = { id: 's1', customer_id: 'c1', property_id: 'p1', source_estimate_id: 'e1', service_id: 'pest',
      is_recurring: true, recurring_pattern: 'quarterly', estimated_price: 94.05, primary_line_price: null };
    const estimateLine = { source: 'recurring', cadence: 'quarterly', serviceId: 'pest', perApplicationPrice: 94.05,
      sourceLine: { perTreatment: 110, priceAfterDiscount: 94.05, discount: { appliedDiscounts: [{ type: 'waveguard', tier: 'silver', amount: 0.1 }] } } };
    const fakeDb = ({ addons = [], estimateRow = estimate } = {}) => (table) => {
      const q = { where: () => q, select: async () => [] };
      q.first = async () => ({ scheduled_service_addons: addons[0] || null, estimates: estimateRow })[table] ?? null;
      return q;
    };
    const adminCustomers = require('../routes/admin-customers')._private;
    beforeEach(() => { jest.spyOn(adminCustomers, 'scheduleLinesFromEstimate').mockReturnValue([estimateLine]); });
    afterEach(() => jest.restoreAllMocks());

    test('a visit still at the accepted price gets the estimate price and each named discount', async () => {
      expect(await acceptedVisitBreakdown(visit, { database: fakeDb() })).toEqual({ breakdown: {
        base: 110, amount: 94.05, discounts: [{ name: 'WaveGuard Silver', dollars: 11 }, { name: 'Military Discount', dollars: 4.95 }] } });
    });

    test('anything of its own, a moved price, another estimate state or an unnamed saving keeps one line', async () => {
      const reason = async (row, db = fakeDb()) => (await acceptedVisitBreakdown(row, { database: db })).reason;
      expect(await reason({ ...visit, estimated_price: 99 })).toBe('price_changed');
      expect(await reason({ ...visit, primary_line_price: 110 })).toBe('own_price_or_discount');
      expect(await reason({ ...visit, line_discount_dollars: 11 })).toBe('own_price_or_discount');
      expect(await reason({ ...visit, prepaid_amount: 94.05 })).toBe('prepaid');
      expect(await reason(visit, fakeDb({ addons: [{ id: 'a1' }] }))).toBe('add_ons');
      expect(await reason(visit, fakeDb({ estimateRow: { ...estimate, status: 'sent' } }))).toBe('estimate_not_accepted');
      expect(await reason(visit, fakeDb({ estimateRow: { ...estimate, estimate_data: {} } }))).toBe('discount_unnamed');
    });
  });

  test('raw engine duplicates stay ambiguous only in the completion reader', () => {
    const { acceptanceServiceLists } = require('../routes/estimate-public');
    const item = { service: 'pest_control', perApp: 100, annual: 400, visitsPerYear: 4 };
    const source = { engineResult: { lineItems: [item, { ...item, perApp: 120, annual: 480 }] } };
    expect(acceptanceServiceLists(source).recurringSvcList).toHaveLength(1);
    expect(acceptanceServiceLists(source, { preserveDuplicates: true }).recurringSvcList).toHaveLength(2);
  });

});
