const { acceptedPricing, acceptedVisitBreakdown, matchServiceLine, propertyMatches, estimateDiscountContext, invoiceDiscountContext } = require('../services/completion-pricing');

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
      sourceLine: { service: 'pest_control', perTreatment: 120, visitsPerYear: 4, annualAfterDiscount: perApplicationPrice * 4, ...sourceLine } });
    const names = (quote) => quote.discounts.map(({ name, dollars, percent, named }) => [name, dollars, percent, named]);
    const platinum = { tierDiscounted: true, estimateTier: { tier: 'platinum', amount: 0.2 } };
    expect(names(acceptedPricing(row(96), platinum))).toEqual([['WaveGuard Platinum', 24, 20, true]]);
    // A saving that is not the tier's rate, a service credit, or an estimate with no tier rate stays unnamed.
    const unnamed = (dollars) => [['Accepted estimate discount', dollars, undefined, false]];
    // The saved annual must be the tier's annual to the cent: a few cents off is not the tier, and no annual or no
    // visit count proves nothing.
    expect(names(acceptedPricing(row(96.03), platinum))).toEqual(unnamed(23.97));
    expect(names(acceptedPricing(row(95.96), platinum))).toEqual(unnamed(24.04));
    expect(names(acceptedPricing(row(96, { annualAfterDiscount: undefined }), platinum))).toEqual(unnamed(24));
    expect(names(acceptedPricing(row(96, { visitsPerYear: undefined }), platinum))).toEqual(unnamed(24));
    // The engine discounts the annual, so the per-visit share can sit a cent off rate x list price and still be the tier's.
    const gold = { tierDiscounted: true, estimateTier: { tier: 'gold', amount: 0.15 } };
    expect(names(acceptedPricing(row(28.33, { perTreatment: 33.33, visitsPerYear: 9, annualAfterDiscount: 254.97 }), gold)))
      .toEqual([['WaveGuard Gold', 5, 15, true]]);
    // A program priced from its annual: the list price is the rounded per-visit share of the saved annual list, which
    // is then the basis. A saved annual that is not the list price's basis is not used.
    expect(names(acceptedPricing(row(85, { perTreatment: 100, annual: 400.01, annualAfterDiscount: 340.01 }), gold)))
      .toEqual([['WaveGuard Gold', 15, 15, true]]);
    expect(names(acceptedPricing(row(85, { perTreatment: 100, annual: 500, annualAfterDiscount: 340.01 }), gold))).toEqual(unnamed(15));
    // A row with its own per-application net has no annual rounding: it must match to the cent.
    expect(names(acceptedPricing(row(96, { priceAfterDiscount: 96 }), platinum))).toEqual([['WaveGuard Platinum', 24, 20, true]]);
    expect(names(acceptedPricing(row(96.04, { priceAfterDiscount: 96.04 }), platinum))).toEqual(unnamed(23.96));
    // A half cent rounds either way: $100.10 at 15% is $85.085, saved by the engine as $85.09. No other cent passes.
    expect(names(acceptedPricing(row(85.09, { perTreatment: 100.1, priceAfterDiscount: 85.09 }), gold))).toEqual([['WaveGuard Gold', 15.01, 15, true]]);
    expect(names(acceptedPricing(row(85.08, { perTreatment: 100.1, priceAfterDiscount: 85.08 }), gold))).toEqual([['WaveGuard Gold', 15.02, 15, true]]);
    expect(names(acceptedPricing(row(85.1, { perTreatment: 100.1, priceAfterDiscount: 85.1 }), gold))).toEqual(unnamed(15));
    expect(names(acceptedPricing(row(79.99, { perTreatment: 100, priceAfterDiscount: 79.99 }), platinum))).toEqual(unnamed(20.01));
    // The row's own net is another price than the one billed: the row conflicts with itself, so nothing is named.
    expect(names(acceptedPricing(row(85, { perTreatment: 100, priceAfterDiscount: 90 }), gold))).toEqual(unnamed(15));
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
    // The eligibility the row saved at the estimate wins over what today's rules say about its service.
    expect(names(acceptedPricing(row(96, { service: 'rodent_bait', waveGuardDiscountEligible: true }), platinum)))
      .toEqual([['WaveGuard Platinum', 24, 20, true]]);
    expect(names(acceptedPricing(row(96, { service: 'rodent_bait', perApplicationBilled: true, waveGuardDiscountEligible: false }), platinum)))
      .toEqual(unnamed(24));
    // A rate the row recorded for itself must be the tier's rate: a recorded 0% or another rate keeps one line.
    expect(names(acceptedPricing(row(96, { discount: { appliedDiscountPercent: 0, effectiveDiscount: 0 } }), platinum))).toEqual(unnamed(24));
    expect(names(acceptedPricing(row(96, { discount: { effectiveDiscount: 0.15 } }), platinum))).toEqual(unnamed(24));
    expect(names(acceptedPricing(row(96, { discount: { appliedDiscountPercent: 0.2, effectiveDiscount: 0.2 } }), platinum)))
      .toEqual([['WaveGuard Platinum', 24, 20, true]]);
    // A row with a custom label and no key of its own takes the service the schedule matched it to.
    const custom = row(96, { service: undefined, name: 'Exterior program' });
    expect(names(acceptedPricing(custom, platinum))).toEqual(unnamed(24));
    expect(names(acceptedPricing({ ...custom, serviceKey: 'pest_control_quarterly' }, platinum))).toEqual([['WaveGuard Platinum', 24, 20, true]]);
    // Staff moved this row's own price (its final annual is under its tier annual): part of the saving is theirs.
    expect(names(acceptedPricing(row(96, { annualAfterDiscount: 400, manualFinalAnnual: 384 }), platinum))).toEqual(unnamed(24));
    expect(names(acceptedPricing(row(96, { annualAfterDiscount: undefined, manualFinalAnnual: 384 }), platinum))).toEqual(unnamed(24));
    expect(names(acceptedPricing(row(96, { manualFinalAnnual: 384 }), platinum))).toEqual([['WaveGuard Platinum', 24, 20, true]]);
    expect(names(acceptedPricing(row(96), { tierDiscounted: true, estimateTier: null }))).toEqual(unnamed(24));
    expect(names(acceptedPricing(row(96), { tierDiscounted: true, estimateTier: { tier: 'platinum', amount: 0 } }))).toEqual(unnamed(24));
    // A tier share and a staff discount on one row with no split (the mapped lawn shape: a rate, no tier record): the
    // staff discount cannot name the whole saving. A row that recorded 0% took no tier, so the saving is staff's.
    const staffed = { manualName: 'Military Discount', tierDiscounted: true, estimateTier: null };
    const lawn = (discount) => row(80, { service: 'lawn_care', perTreatment: 100, annualAfterDiscount: 340, manualFinalAnnual: 320, discount });
    expect(names(acceptedPricing(lawn({ effectiveDiscount: 0.15, appliedDiscountPercent: 0.15 }), staffed))).toEqual(unnamed(20));
    expect(names(acceptedPricing(lawn({ effectiveDiscount: 0, appliedDiscountPercent: 0 }), staffed)))
      .toEqual([['Military Discount', 20, undefined, true]]);
    // The line's own record still wins over the estimate's.
    expect(names(acceptedPricing(row(102, { discount: { appliedDiscounts: [{ type: 'waveguard', tier: 'gold', amount: 0.15 }] } }), platinum)))
      .toEqual([['WaveGuard Gold', 18, 15, true]]);
    // One-time work never takes the recurring tier.
    expect(acceptedPricing({ source: 'one_time', price: 96, sourceLine: { priceBeforeDiscount: 120, priceAfterDiscount: 96 } }, platinum).discounts)
      .toEqual([{ name: 'Accepted estimate discount', dollars: 24, named: false }]);
  });

  test('a row that saved only its net takes the list price and tier of the engine line beside it, when every figure agrees', () => {
    // The mapped lawn shape: per visit, per year and per month are all the accepted net, with only a rate on the row.
    // The engine's own line of the service keeps the list annual and the tier record.
    const waveguard = (tier, amount) => ({ appliedDiscounts: [{ tier, type: 'waveguard', amount }] });
    const engineLawn = (extra = {}) => ({ service: 'lawn_care', name: 'Lawn Care', annual: 1068, perApp: 118.67, frequency: 9,
      annualBeforeDiscount: 1068, annualAfterDiscount: 961.2, discount: waveguard('silver', 0.1), ...extra });
    const lawnRow = (sourceLine = {}, perApplicationPrice = 106.8) => ({ ...line, perApplicationPrice, parentRecurringDiscounted: true,
      serviceKey: 'lawn_care_6week', sourceLine: { service: 'lawn_care', perTreatment: perApplicationPrice, annual: 961.2,
        annualAfterDiscount: 961.2, visitsPerYear: 9, discount: { effectiveDiscount: 0.1, appliedDiscountPercent: 0.1 }, ...sourceLine } });
    const silver = (engineLineItems = [engineLawn()], estimateTier = { tier: 'silver', amount: 0.1 }) => ({ tierDiscounted: true, estimateTier, engineLineItems });
    const quote = (row, context) => {
      const { base, amount, discounts } = acceptedPricing(row, context);
      return [base, amount, discounts.map(({ name, dollars, percent, named }) => [name, dollars, percent, named])];
    };
    // $1,068 a year over 9 visits is $118.67 a visit; 10% off is $106.80, the visit's price. The total does not change.
    expect(quote(lawnRow(), silver())).toEqual([118.67, 106.8, [['WaveGuard Silver', 11.87, 10, true]]]);
    const oneLine = [106.8, 106.8, []];
    // Any figure that disagrees keeps the row's own net as its base: one line.
    expect(quote(lawnRow({ annualAfterDiscount: 961.11 }), silver())).toEqual([106.8, 106.8, []]);
    expect(quote(lawnRow(), silver([engineLawn({ frequency: 8 })]))).toEqual(oneLine);
    expect(quote(lawnRow(), silver([engineLawn({ annualBeforeDiscount: undefined })]))).toEqual(oneLine);
    expect(quote(lawnRow(), silver([engineLawn({ annualAfterDiscount: 961.11 })]))).toEqual(oneLine);
    // The engine applied another tier or rate than the estimate's, or another discount beside the tier.
    expect(quote(lawnRow(), silver([engineLawn({ discount: waveguard('gold', 0.1) })]))).toEqual(oneLine);
    expect(quote(lawnRow(), silver([engineLawn()], { tier: 'silver', amount: 0.15 }))).toEqual(oneLine);
    expect(quote(lawnRow(), silver([engineLawn({ discount: { appliedDiscounts: [...waveguard('silver', 0.1).appliedDiscounts,
      { type: 'military', amount: 0.05 }] } })]))).toEqual(oneLine);
    // Two engine lines of the service, none, or no tier the estimate itself names (a staff discount on recurring work,
    // a Bronze estimate).
    expect(quote(lawnRow(), silver([engineLawn(), engineLawn({ annual: 1200, annualBeforeDiscount: 1200 })]))).toEqual(oneLine);
    expect(quote(lawnRow(), silver([]))).toEqual(oneLine);
    expect(quote(lawnRow(), silver([engineLawn()], null))).toEqual(oneLine);
    // Both annuals agree with each other but not with the tier rate on the list annual ($1,068 at 10% is $961.20).
    expect(quote(lawnRow({ annual: 961.23, annualAfterDiscount: 961.23 }), silver([engineLawn({ annualAfterDiscount: 961.23 })])))
      .toEqual(oneLine);
    // A row that records another discount of its own is not the tier's saving.
    expect(quote(lawnRow({ discount: { effectiveDiscount: 0.1, appliedDiscounts: [{ type: 'military', amount: 0.1 }] } }), silver()))
      .toEqual(oneLine);
    // A malformed discount record on the row keeps one line and does not throw.
    expect(quote(lawnRow({ discount: { effectiveDiscount: 0.1, appliedDiscounts: 'silver' } }), silver())).toEqual(oneLine);
    // Only the invoice's context carries the engine lines: the Complete Service card prices from the estimate's context
    // alone, so a recovered list price never becomes a price a proposal could cut to.
    const saved = { id: 'e1', waveguard_tier: 'Silver',
      estimate_data: { engineResult: { lineItems: [engineLawn()] }, result: { recurring: { tier: 'Silver', discount: 0.1 } } } };
    expect(estimateDiscountContext(saved)).not.toHaveProperty('engineLineItems');
    expect(invoiceDiscountContext(saved)).toEqual({ ...estimateDiscountContext(saved), engineLineItems: [engineLawn()] });
    expect(quote(lawnRow(), estimateDiscountContext(saved))).toEqual(oneLine);
    expect(quote(lawnRow(), invoiceDiscountContext(saved))).toEqual([118.67, 106.8, [['WaveGuard Silver', 11.87, 10, true]]]);
    // A row with its own list or net figures is priced by them, never by the engine line.
    expect(quote(lawnRow({ priceAfterDiscount: 106.8 }), silver())).toEqual(oneLine);
    // The engine list price is taken only when the list-price rules name the whole saving as the tier: a row that
    // recorded another rate (0%), a row flagged out of percentage discounts, or a service credit keeps its own net as
    // its base, with no saving, so no surface sees a list price the row never proved.
    expect(quote(lawnRow({ discount: { effectiveDiscount: 0, appliedDiscountPercent: 0 } }), silver())).toEqual(oneLine);
    expect(quote(lawnRow({ excludeFromPctDiscount: true }), silver())).toEqual(oneLine);
    expect(quote(lawnRow({ serviceSpecificDiscounts: [{ amount: 5 }] }), silver())).toEqual(oneLine);
    // A row with a WaveGuard record of its own is not the net-only shape: its record is never paired with the engine's
    // list price (a Gold record would print Gold for a Silver saving).
    expect(quote(lawnRow({ discount: { effectiveDiscount: 0.1, appliedDiscounts: [{ type: 'waveguard', tier: 'gold', amount: 0.1 }] } }), silver()))
      .toEqual(oneLine);
    // The tree-and-shrub shape that rounds another way: $565 a year over 6 visits at 20% is $75.34 a visit, but the row
    // saved $451.92 a year and bills $75.32. The figures disagree by 2 cents, so the row keeps one line.
    const shrub = engineLawn({ service: 'tree_shrub', name: 'Tree & Shrub', annual: 565, perApp: 94.17, frequency: 6,
      annualBeforeDiscount: 565, annualAfterDiscount: 452, discount: waveguard('platinum', 0.2) });
    const shrubRow = lawnRow({ service: 'tree_shrub', annual: 451.92, annualAfterDiscount: 451.92, visitsPerYear: 6,
      discount: { effectiveDiscount: 0.2, appliedDiscountPercent: 0.2 } }, 75.32);
    expect(quote({ ...shrubRow, serviceKey: 'tree_shrub_program' }, silver([shrub], { tier: 'platinum', amount: 0.2 })))
      .toEqual([75.32, 75.32, []]);
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

    // With the estimate row and the schedule line the visit matched, which the nightly check prices (invoice-tier-line-check.js).
    test('a visit still at the accepted price gets the estimate price and each named discount', async () => {
      expect(await acceptedVisitBreakdown(visit, { database: fakeDb() })).toEqual({ breakdown: {
        base: 110, amount: 94.05, discounts: [{ name: 'WaveGuard Silver', dollars: 11 }, { name: 'Military Discount', dollars: 4.95 }] },
      estimate, line: estimateLine });
    });

    test('anything of its own, a moved price, another estimate state or an unnamed saving keeps one line', async () => {
      const reason = async (row, db = fakeDb()) => (await acceptedVisitBreakdown(row, { database: db })).reason;
      expect(await acceptedVisitBreakdown({ ...visit, estimated_price: 99 }, { database: fakeDb() })).toEqual({ breakdown: null, reason: 'price_changed' });
      expect(await reason({ ...visit, primary_line_price: 110 })).toBe('own_price_or_discount');
      expect(await reason({ ...visit, line_discount_dollars: 11 })).toBe('own_price_or_discount');
      expect(await reason({ ...visit, prepaid_amount: 94.05 })).toBe('prepaid');
      expect(await reason(visit, fakeDb({ addons: [{ id: 'a1' }] }))).toBe('add_ons');
      expect(await reason(visit, fakeDb({ estimateRow: { ...estimate, status: 'sent' } }))).toBe('estimate_not_accepted');
      const unnamedRow = { ...estimate, estimate_data: {} };
      expect(await acceptedVisitBreakdown(visit, { database: fakeDb({ estimateRow: unnamedRow }) }))
        .toEqual({ breakdown: null, reason: 'discount_unnamed', estimate: unnamedRow, line: estimateLine });
      // A line the reader gave no per-visit price: the estimate and the line ride along for the nightly check too.
      const unpricedLine = { ...estimateLine, perApplicationPrice: null };
      adminCustomers.scheduleLinesFromEstimate.mockReturnValue([unpricedLine]);
      expect(await acceptedVisitBreakdown(visit, { database: fakeDb() }))
        .toEqual({ breakdown: null, reason: 'no_breakdown', estimate, line: unpricedLine });
    });

    // The saved engine shape: the list price on the row, the tier and the rate the accept used on the recurring block.
    test('a list-price row prints the estimate\'s tier at its saved rate; any other saving on it keeps one line', async () => {
      adminCustomers.scheduleLinesFromEstimate.mockReturnValue([{ ...estimateLine, perApplicationPrice: 88,
        sourceLine: { service: 'pest_control', perTreatment: 110, visitsPerYear: 4, annualAfterDiscount: 352 } }]);
      const billed = { ...visit, estimated_price: 88 };
      const platinum = (recurring, extra = {}) => ({ ...estimate, waveguard_tier: 'Platinum', estimate_data: { result: { recurring }, ...extra } });
      const read = (estimateRow) => acceptedVisitBreakdown(billed, { database: fakeDb({ estimateRow }) });
      expect(await read(platinum({ tier: 'Platinum', discount: 0.2 }))).toEqual(expect.objectContaining({ breakdown: {
        base: 110, amount: 88, discounts: [{ name: 'WaveGuard Platinum', dollars: 22 }] } }));
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
      // Every stored staff discount spot counts, not only the first one with an amount.
      expect((await read(platinum({ tier: 'Platinum', discount: 0.2 }))).breakdown.discounts).toHaveLength(1);
      expect((await read({ ...estimate, waveguard_tier: 'Platinum', estimate_data: { result: { recurring: { tier: 'Platinum', discount: 0.2 },
        manualDiscount: { amount: 10, recurringAmount: 0 }, totals: { manualDiscount: { amount: 5, recurringAmount: 5 } } } } })).reason)
        .toBe('discount_unnamed');
      // A record with a value and no saved share (an older shape, replayed onto recurring work) counts too; an empty one does not.
      const withStaff = (manualDiscount) => ({ ...estimate, waveguard_tier: 'Platinum',
        estimate_data: { result: { recurring: { tier: 'Platinum', discount: 0.2 }, manualDiscount } } });
      expect((await read(withStaff({ type: 'FIXED', value: 50, oneTimeAmount: 0 }))).reason).toBe('discount_unnamed');
      expect((await read(withStaff({ amount: 10, recurringAmount: '' }))).reason).toBe('discount_unnamed');
      expect((await read(withStaff({ type: 'FIXED', value: 0, amount: 0 }))).breakdown.discounts).toEqual([{ name: 'WaveGuard Platinum', dollars: 22 }]);
      expect((await read(withStaff({ amount: 10, recurringAmount: 0 }))).breakdown.discounts).toEqual([{ name: 'WaveGuard Platinum', dollars: 22 }]);
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
