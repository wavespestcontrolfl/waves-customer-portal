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
  // An accept at the customer's own address leaves its visits unstamped; they were refused as "another property".
  test('a visit with no property or stamped address is at the customer\'s primary address', () => {
    const estimate = { address: '12 Palm Way, Bradenton, FL 34205' };
    const unstamped = { property_id: null, service_address_line1: null };
    expect(propertyMatches(unstamped, estimate, { address_line1: '12 Palm Way', city: 'Bradenton', zip: '34205' })).toBe(true);
    expect(propertyMatches(unstamped, estimate, { address_line1: '40 Gulf Dr', city: 'Bradenton', zip: '34205' })).toBe(false);
    expect(propertyMatches(unstamped, estimate)).toBe(false);
    const stampedElsewhere = { service_address_line1: '40 Gulf Dr', service_address_city: 'Bradenton', service_address_zip: '34205' };
    expect(propertyMatches(stampedElsewhere, estimate, { address_line1: '12 Palm Way' })).toBe(false);
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

  // Saved engine rows keep the list price on the row and the tier on the estimate's recurring block. Before, such a
  // line's saving had no name, so a Platinum plan's invoice printed one net line (production estimate, 2026-11-22).
  test('a list-price row with no tier record takes the estimate\'s tier when its rate is the whole saving', () => {
    const row = (perApplicationPrice, sourceLine = {}) => ({ ...line, perApplicationPrice, parentRecurringDiscounted: true,
      sourceLine: { service: 'pest_control', perTreatment: 120, annualAfterDiscount: perApplicationPrice * 4, ...sourceLine } });
    const names = (quote) => quote.discounts.map(({ name, dollars, percent, named }) => [name, dollars, percent, named]);
    const platinum = { tierDiscounted: true, estimateTier: { tier: 'platinum', amount: 0.2 } };
    expect(names(acceptedPricing(row(96), platinum))).toEqual([['WaveGuard Platinum', 24, 20, true]]);
    // The engine discounts the annual: a few cents either way are still the tier's.
    expect(names(acceptedPricing(row(96.03), platinum))).toEqual([['WaveGuard Platinum', 23.97, 20, true]]);
    expect(names(acceptedPricing(row(95.96), platinum))).toEqual([['WaveGuard Platinum', 24.04, 20, true]]);
    // A saving that is not the tier's rate, a service credit, or an estimate with no tier rate stays unnamed.
    const unnamed = (dollars) => [['Accepted estimate discount', dollars, undefined, false]];
    expect(names(acceptedPricing(row(108), platinum))).toEqual(unnamed(12));
    expect(names(acceptedPricing(row(90), platinum))).toEqual(unnamed(30));
    expect(names(acceptedPricing(row(96, { serviceSpecificDiscounts: [{ amount: 24 }] }), platinum))).toEqual(unnamed(24));
    // A row flagged out of percentage discounts never takes the tier, whatever its numbers.
    expect(names(acceptedPricing(row(96, { excludeFromPctDiscount: true }), platinum))).toEqual(unnamed(24));
    expect(names(acceptedPricing(row(96, { discountEligible: false }), platinum))).toEqual(unnamed(24));
    // A service that takes no tier percentage (palm injection has a flat credit) never takes the tier name.
    expect(names(acceptedPricing(row(96, { service: 'palm_injection' }), platinum))).toEqual(unnamed(24));
    expect(names(acceptedPricing(row(96, { service: 'rodent_bait' }), platinum))).toEqual(unnamed(24));
    expect(names(acceptedPricing(row(96, { service: 'rodent_bait', perApplicationBilled: true }), platinum)))
      .toEqual([['WaveGuard Platinum', 24, 20, true]]);
    // Staff moved this row's own price (its final annual is under its tier annual): part of the saving is theirs.
    expect(names(acceptedPricing(row(96, { annualAfterDiscount: 400, manualFinalAnnual: 384 }), platinum))).toEqual(unnamed(24));
    expect(names(acceptedPricing(row(96, { annualAfterDiscount: undefined, manualFinalAnnual: 384 }), platinum))).toEqual(unnamed(24));
    expect(names(acceptedPricing(row(96, { manualFinalAnnual: 384 }), platinum))).toEqual([['WaveGuard Platinum', 24, 20, true]]);
    expect(names(acceptedPricing(row(96), { tierDiscounted: true, estimateTier: null }))).toEqual(unnamed(24));
    expect(names(acceptedPricing(row(96), { tierDiscounted: true, estimateTier: { tier: 'platinum', amount: 0 } }))).toEqual(unnamed(24));
    // The line's own record still wins over the estimate's.
    expect(names(acceptedPricing(row(102, { discount: { appliedDiscounts: [{ type: 'waveguard', tier: 'gold', amount: 0.15 }] } }), platinum)))
      .toEqual([['WaveGuard Gold', 18, 15, true]]);
    // One-time work never takes the recurring tier.
    expect(acceptedPricing({ source: 'one_time', price: 96, sourceLine: { priceBeforeDiscount: 120, priceAfterDiscount: 96 } }, platinum).discounts)
      .toEqual([{ name: 'Accepted estimate discount', dollars: 24, named: false }]);
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

    // The saved engine shape: the list price on the row, the tier and the rate the accept used on the recurring block.
    test('a list-price row prints the estimate\'s tier at its saved rate; any other saving on it keeps one line', async () => {
      adminCustomers.scheduleLinesFromEstimate.mockReturnValue([{ ...estimateLine, perApplicationPrice: 88,
        sourceLine: { service: 'pest_control', perTreatment: 110, annualAfterDiscount: 352 } }]);
      const billed = { ...visit, estimated_price: 88 };
      const platinum = (recurring, extra = {}) => ({ ...estimate, waveguard_tier: 'Platinum', estimate_data: { result: { recurring }, ...extra } });
      const read = (estimateRow) => acceptedVisitBreakdown(billed, { database: fakeDb({ estimateRow }) });
      expect(await read(platinum({ tier: 'Platinum', discount: 0.2 }))).toEqual({ breakdown: {
        base: 110, amount: 88, discounts: [{ name: 'WaveGuard Platinum', dollars: 22 }] } });
      // An empty tier column reads the saved recurring block, as the accept does.
      expect((await read({ ...platinum({ waveGuardTier: 'Platinum', discount: 0.2 }), waveguard_tier: null })).breakdown.discounts)
        .toEqual([{ name: 'WaveGuard Platinum', dollars: 22 }]);
      // The rate the estimate saved decides, never today's tier table: another rate, or none saved, keeps one line.
      expect((await read(platinum({ tier: 'Platinum', discount: 0.1 }))).reason).toBe('discount_unnamed');
      expect((await read(platinum({ tier: 'Platinum' }))).reason).toBe('discount_unnamed');
      // A staff discount on recurring work, in either saved shape, shares the saving; Bronze has no tier saving.
      expect((await read(platinum({ tier: 'Platinum', discount: 0.2 }, { summary: estimate.estimate_data.summary }))).reason).toBe('discount_unnamed');
      expect((await read(platinum({ tier: 'Platinum', discount: 0.2, manualDiscount: { amount: 5 } }))).reason).toBe('discount_unnamed');
      expect((await read({ ...platinum({ tier: 'Platinum', discount: 0.2 }), waveguard_tier: 'Bronze' })).reason).toBe('discount_unnamed');
      // The block is read from the saved result the lines come from: an engine result with no mapped result.
      const engineOnly = (recurring) => ({ ...estimate, waveguard_tier: 'Platinum', estimate_data: { engineResult: { recurring } } });
      expect((await read(engineOnly({ tier: 'Platinum', discount: 0.2 }))).breakdown.discounts)
        .toEqual([{ name: 'WaveGuard Platinum', dollars: 22 }]);
      expect((await read(engineOnly({ tier: 'Platinum', discount: 0.2, manualDiscount: { amount: 5 } }))).reason).toBe('discount_unnamed');
      // A staff discount kept only on the engine's own result, beside the mapped result, still shares the saving.
      expect((await read(platinum({ tier: 'Platinum', discount: 0.2 }, { engineResult: { summary: { manualDiscount: { amount: 5 } } } }))).reason)
        .toBe('discount_unnamed');
      // The legacy nested block also supplies rows: which block priced the line is unknown, so nothing is named.
      expect((await read({ ...estimate, waveguard_tier: 'Platinum', estimate_data: { result: { recurring: { tier: 'Platinum', discount: 0.2 },
        results: { recurring: { tier: 'Gold', discount: 0.15, services: [{ service: 'pest_control' }] } } } } })).reason).toBe('discount_unnamed');
      // The column and the block name different tiers: the block's rate is another tier's, so nothing is named.
      expect((await read(platinum({ tier: 'Gold', discount: 0.2 }))).reason).toBe('discount_unnamed');
      // A lower-case column still finds its rate in the send snapshot, whose keys are title case.
      expect((await read({ ...platinum({ tier: 'Platinum' }, { sendSnapshot: { tierDiscounts: { Platinum: 0.2 } } }), waveguard_tier: 'platinum' }))
        .breakdown.discounts).toEqual([{ name: 'WaveGuard Platinum', dollars: 22 }]);
    });

    // A multi-program accept leaves each first visit unpriced; the first bill covers it at the accepted price.
    test('the first bill prices a visit the accept left unpriced; a priced visit must still match', async () => {
      const unpriced = { ...visit, estimated_price: null };
      expect((await acceptedVisitBreakdown(unpriced, { database: fakeDb() })).reason).toBe('not_priced');
      expect((await acceptedVisitBreakdown(unpriced, { database: fakeDb(), firstApplication: true })).breakdown)
        .toMatchObject({ base: 110, amount: 94.05 });
      expect((await acceptedVisitBreakdown({ ...visit, estimated_price: 99 }, { database: fakeDb(), firstApplication: true })).reason)
        .toBe('price_changed');
      // A program with no saving still bills its own price there, so it does not keep a bundle's discounts off.
      adminCustomers.scheduleLinesFromEstimate.mockReturnValue([{ ...estimateLine, perApplicationPrice: 110,
        sourceLine: { perTreatment: 110, priceAfterDiscount: 110 } }]);
      expect((await acceptedVisitBreakdown({ ...visit, estimated_price: 110 }, { database: fakeDb() })).reason).toBe('no_discount');
      expect((await acceptedVisitBreakdown(unpriced, { database: fakeDb(), firstApplication: true })).breakdown)
        .toEqual({ base: 110, amount: 110, discounts: [] });
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
