const {
  amountToPounds,
  buildMixOrder,
  calculateNutrientLedgerFromRows,
  calculateNutrients,
  calculateProductAmount,
  classifyProtocolLine,
  effectiveAreaFactor,
  findNutrientProductsMissingRates,
  findNutrientProductsMissingConversions,
  isConditionalSelected,
  isDateInWindow,
  matchCatalogProduct,
  parseVisitNutrientTargets,
  parseProtocolLines,
  resolveProtocolItems,
  selectedMayFertilizerBranch,
  summarizeCalibration,
  summarizeAnnualN,
  summarizeOrdinanceStatus,
} = require('../services/waveguard-plan-engine');
const {
  calculateAppliedNutrients,
  toDateOnly,
} = require('../services/nutrient-ledger');

describe('waveguard-plan-engine helpers', () => {
  test('isDateInWindow handles normal blackout windows', () => {
    const rule = {
      restricted_start_month: 6,
      restricted_start_day: 1,
      restricted_end_month: 9,
      restricted_end_day: 30,
    };

    expect(isDateInWindow(new Date('2026-06-01T12:00:00'), rule)).toBe(true);
    expect(isDateInWindow(new Date('2026-09-30T12:00:00'), rule)).toBe(true);
    expect(isDateInWindow(new Date('2026-10-01T12:00:00'), rule)).toBe(false);
  });

  test('isDateInWindow evaluates month/day in Eastern Time', () => {
    const rule = {
      restricted_start_month: 6,
      restricted_start_day: 1,
      restricted_end_month: 9,
      restricted_end_day: 30,
    };

    expect(isDateInWindow(new Date('2026-06-01T02:00:00Z'), rule)).toBe(false);
    expect(isDateInWindow(new Date('2026-06-01T16:00:00Z'), rule)).toBe(true);
  });

  test('isDateInWindow handles wraparound windows', () => {
    const rule = {
      restricted_start_month: 11,
      restricted_start_day: 15,
      restricted_end_month: 2,
      restricted_end_day: 15,
    };

    expect(isDateInWindow(new Date('2026-12-10T12:00:00'), rule)).toBe(true);
    expect(isDateInWindow(new Date('2026-01-10T12:00:00'), rule)).toBe(true);
    expect(isDateInWindow(new Date('2026-03-01T12:00:00'), rule)).toBe(false);
  });

  test('summarizeOrdinanceStatus blocks N and P products during active restrictions', () => {
    const ordinance = {
      jurisdiction_name: 'North Port',
      jurisdiction_type: 'city',
      restricted_start_month: 4,
      restricted_start_day: 1,
      restricted_end_month: 9,
      restricted_end_day: 30,
      restricted_nitrogen: true,
      restricted_phosphorus: true,
      phosphorus_requires_soil_test: true,
      source_name: 'City of North Port Fertilizer Ordinance',
    };
    const candidateItems = [{
      product: {
        name: 'LESCO 24-0-11',
        analysis_n: 24,
        analysis_p: 0,
      },
    }, {
      product: {
        name: 'Starter Fert 10-2-10',
        analysis_n: 10,
        analysis_p: 2,
      },
    }];

    const result = summarizeOrdinanceStatus({
      date: new Date('2026-04-15T12:00:00'),
      ordinances: [ordinance],
      candidateItems,
    });

    expect(result.blocks.map((b) => b.code)).toEqual(
      expect.arrayContaining(['nitrogen_blackout', 'phosphorus_blackout'])
    );
    expect(result.warnings.map((w) => w.code)).toContain('phosphorus_soil_test');
  });

  test('summarizeOrdinanceStatus does not block potassium-only products in blackout', () => {
    const result = summarizeOrdinanceStatus({
      date: new Date('2026-06-15T12:00:00'),
      ordinances: [{
        jurisdiction_name: 'Sarasota County',
        restricted_start_month: 6,
        restricted_start_day: 1,
        restricted_end_month: 9,
        restricted_end_day: 30,
        restricted_nitrogen: true,
        restricted_phosphorus: true,
      }],
      candidateItems: [{
        product: {
          name: 'K-Flow 0-0-25',
          analysis_n: 0,
          analysis_p: 0,
          analysis_k: 25,
        },
      }],
    });

    expect(result.blocks).toEqual([]);
  });

  test('summarizeOrdinanceStatus treats unmatched N-P-K text as blackout risk', () => {
    const result = summarizeOrdinanceStatus({
      date: new Date('2026-06-15T12:00:00'),
      ordinances: [{
        jurisdiction_name: 'Sarasota County',
        restricted_start_month: 6,
        restricted_start_day: 1,
        restricted_end_month: 9,
        restricted_end_day: 30,
        restricted_nitrogen: true,
        restricted_phosphorus: true,
      }],
      candidateItems: [{
        raw: 'LESCO 24-0-11 fert',
        product: null,
      }],
    });

    expect(result.blocks.map((b) => b.code)).toContain('nitrogen_blackout');
  });

  test('summarizeCalibration hard-blocks missing and expired calibration', () => {
    expect(summarizeCalibration({
      calibration: null,
      date: new Date('2026-05-01T12:00:00'),
    }).blocks[0].code).toBe('missing_calibration');

    const expired = summarizeCalibration({
      calibration: {
        system_name: '110-Gallon Spray Tank #1',
        carrier_gal_per_1000: 2,
        expires_at: '2026-04-01T12:00:00Z',
        tank_capacity_gal: 110,
      },
      date: new Date('2026-05-01T12:00:00'),
    });

    expect(expired.blocks[0].code).toBe('expired_calibration');
  });

  test('summarizeCalibration blocks ambiguous active equipment calibrations', () => {
    const result = summarizeCalibration({
      calibrations: [
        { equipment_system_id: 'tank', system_name: '110-Gallon Spray Tank #1', carrier_gal_per_1000: 2 },
        { equipment_system_id: 'backpack', system_name: 'FlowZone Typhoon 2.5 #1', carrier_gal_per_1000: 0.5 },
      ],
      date: new Date('2026-05-01T12:00:00'),
    });

    expect(result.selected).toBeNull();
    expect(result.blocks[0].code).toBe('equipment_selection_required');
    expect(result.options).toHaveLength(2);
  });

  test('isConditionalSelected includes base products and excludes unselected optional products', () => {
    const base = { role: 'base', conditional: false, raw: 'Acelepryn Xtra liquid preventive', product: { id: 'ace', name: 'Acelepryn Xtra' } };
    const optional = { role: 'conditional', conditional: true, raw: 'Primo Maxx PGR Premium only', product: { id: 'primo', name: 'Primo Maxx' } };
    const conditionalPrimary = { role: 'base', conditional: true, raw: 'IF P index <80: LESCO 24-2-11', product: { id: 'fert-p', name: 'LESCO 24-2-11' } };

    expect(isConditionalSelected(base)).toBe(true);
    expect(isConditionalSelected(optional)).toBe(false);
    expect(isConditionalSelected(conditionalPrimary)).toBe(false);
    expect(isConditionalSelected(conditionalPrimary, { selectedConditionalProductIds: 'fert-p' })).toBe(true);
    expect(isConditionalSelected(optional, { selectedConditionalProductIds: ['primo'] })).toBe(true);
    expect(isConditionalSelected(optional, { selectedConditionalProductNames: 'Primo Maxx' })).toBe(true);
  });


  test('parseProtocolLines and matchCatalogProduct turn protocol text into matched product candidates', () => {
    const lines = parseProtocolLines('Acelepryn Xtra preventive insect coverage\nK-Flow 0-0-25 support', 'base');
    const catalog = [
      { id: '1', name: 'K-Flow 0-0-25' },
      { id: '2', name: 'Acelepryn Xtra' },
    ];

    expect(lines).toHaveLength(2);
    expect(matchCatalogProduct(lines[0], catalog).name).toBe('Acelepryn Xtra');
    expect(matchCatalogProduct(lines[1], catalog).name).toBe('K-Flow 0-0-25');
  });

  test('matchCatalogProduct handles protocol shorthand that omits catalog vendor prefix', () => {
    const product = matchCatalogProduct(
      { raw: 'K-Flow 0-0-25 liquid K ($2.18)' },
      [{ id: '1', name: 'LESCO K-Flow 0-0-25' }]
    );

    expect(product.name).toBe('LESCO K-Flow 0-0-25');
  });

  test('matchCatalogProduct strips protocol cost annotations and NPK prefixes', () => {
    const product = matchCatalogProduct(
      { raw: 'Chelated Iron Plus ($1.52)' },
      [{ id: '1', name: 'LESCO 12-0-0 Chelated Iron Plus' }]
    );

    expect(product.name).toBe('LESCO 12-0-0 Chelated Iron Plus');
  });

  test('matchCatalogProduct uses configured catalog aliases', () => {
    const product = matchCatalogProduct(
      { raw: 'LESCO 24-0-11 75% PolyPlus fert ($8.68)' },
      [{
        id: '1',
        name: 'LESCO 24-0-11',
        aliases: ['LESCO 24-0-11 75% PolyPlus OPTI'],
      }]
    );

    expect(product.name).toBe('LESCO 24-0-11');
  });

  test('matchCatalogProduct prefers priced canonical inventory rows over needs-price duplicates', () => {
    const product = matchCatalogProduct(
      { raw: 'LESCO 24-0-11 fert ($8.68)' },
      [
        { id: 'generic', name: 'LESCO 24-0-11', needs_pricing: true },
        { id: 'canonical', name: 'LESCO 24-0-11', best_price: 33.79, needs_pricing: false },
      ]
    );

    expect(product.id).toBe('canonical');
  });

  test('matchCatalogProduct keeps exact NPK match above priced sibling fertilizers', () => {
    const product = matchCatalogProduct(
      { raw: 'LESCO 24-0-11 fert ($8.68)' },
      [
        { id: 'phosphorus', name: 'LESCO 24-2-11', best_price: 40.48, needs_pricing: false },
        { id: 'zero-p', name: 'LESCO 24-0-11', needs_pricing: true },
      ]
    );

    expect(product.id).toBe('zero-p');
  });

  test('calculateProductAmount uses lawn area and carrier calibration', () => {
    const result = calculateProductAmount({
      product: {
        default_rate_per_1000: 0.46,
        rate_unit: 'fl_oz',
      },
      lawnSqft: 18750,
      carrierGalPer1000: 2,
    });

    expect(result.amount).toBe(8.625);
    expect(result.amountUnit).toBe('fl_oz');
    expect(result.carrierGallons).toBe(37.5);
  });

  test('calculateProductAmount applies protocol area factor for spot allowances', () => {
    const result = calculateProductAmount({
      product: {
        default_rate_per_1000: 0.113,
        rate_unit: 'oz',
      },
      lawnSqft: 10000,
      carrierGalPer1000: 1,
      areaFactor: 0.25,
    });

    expect(result.treatedSqft).toBe(2500);
    expect(result.amount).toBe(0.283);
    expect(result.carrierGallons).toBe(2.5);
  });

  test('parseVisitNutrientTargets reads protocol N rate notes', () => {
    expect(parseVisitNutrientTargets('LAST N before blackout. N app @ 0.75 lb N/1K.')).toMatchObject({
      targetNPer1000: 0.75,
      targetKPer1000: null,
    });
    expect(parseVisitNutrientTargets('Fall color. N app final @ 0.75 lb N/1K.')).toMatchObject({
      targetNPer1000: 0.75,
    });
    expect(parseVisitNutrientTargets('Fall color. N app 4 FINAL @ 0.75 lb N/1K.')).toMatchObject({
      targetNPer1000: 0.75,
    });
    expect(parseVisitNutrientTargets('Split timing. N app 1/2-3 @ 0.75 lb N/1K.')).toMatchObject({
      targetNPer1000: 0.75,
    });
    expect(parseVisitNutrientTargets('N rate: 0 lb N.')).toMatchObject({
      targetNPer1000: 0,
    });
  });

  test('calculateProductAmount derives granular fertilizer rate and cost from target N and inventory', () => {
    const zeroP = calculateProductAmount({
      product: {
        name: 'LESCO 24-0-11',
        analysis_n: 24,
        analysis_p: 0,
        analysis_k: 11,
        best_price: 33.79,
        cost_per_unit: 33.79 / 50,
        cost_unit: 'lb',
        container_size: '50 lb',
      },
      lawnSqft: 10000,
      carrierGalPer1000: 0,
      targetNPer1000: 0.75,
    });
    const lowP = calculateProductAmount({
      product: {
        name: 'LESCO 24-2-11',
        analysis_n: 24,
        analysis_p: 2,
        analysis_k: 11,
        best_price: 40.48,
        cost_per_unit: 40.48 / 50,
        cost_unit: 'lb',
        container_size: '50 lb',
      },
      lawnSqft: 10000,
      carrierGalPer1000: 0,
      targetNPer1000: 0.75,
    });

    expect(zeroP).toMatchObject({
      ratePer1000: 3.125,
      rateUnit: 'lb',
      rateSource: 'target_n_analysis',
      amount: 31.25,
      amountUnit: 'lb',
      materialCost: 21.12,
      materialCostSource: 'inventory_cost_per_unit',
    });
    expect(lowP.materialCost).toBe(25.3);
  });

  test('calculateProductAmount derives fertilizer analysis from imported NPK product names', () => {
    const result = calculateProductAmount({
      product: {
        name: 'LESCO 24-2-11 50% NOS Plus BIO 6% Fe',
        best_price: 40.48,
        cost_per_unit: 40.48 / 50,
        cost_unit: 'lb',
        container_size: '50 lb',
      },
      lawnSqft: 10000,
      carrierGalPer1000: 0,
      targetNPer1000: 0.75,
    });

    expect(result).toMatchObject({
      ratePer1000: 3.125,
      rateUnit: 'lb',
      rateSource: 'target_n_analysis',
      amount: 31.25,
      materialCost: 25.3,
    });
  });

  test('matched imported NPK fertilizers carry parsed analysis into compliance and nutrient projection', () => {
    const product = matchCatalogProduct(
      { raw: 'LESCO 24-2-11 fert' },
      [{
        id: 'imported-low-p',
        name: 'LESCO 24-2-11 50% NOS Plus BIO 6% Fe',
        best_price: 40.48,
        cost_per_unit: 40.48 / 50,
        cost_unit: 'lb',
        container_size: '50 lb',
      }]
    );
    const nutrients = calculateNutrients([{
      product,
      mix: { amount: 31.25, amountUnit: 'lb' },
    }], 10000);
    const ordinance = summarizeOrdinanceStatus({
      date: new Date('2026-06-15T12:00:00'),
      ordinances: [{
        jurisdiction_name: 'Sarasota County',
        restricted_start_month: 6,
        restricted_start_day: 1,
        restricted_end_month: 9,
        restricted_end_day: 30,
        restricted_nitrogen: true,
        restricted_phosphorus: true,
      }],
      candidateItems: [{ product }],
    });

    expect(product).toMatchObject({
      analysis_n: 24,
      analysis_p: 2,
      analysis_k: 11,
    });
    expect(nutrients).toEqual({
      nPer1000: 0.75,
      pPer1000: 0.063,
      kPer1000: 0.344,
    });
    expect(ordinance.blocks.map((block) => block.code)).toEqual(
      expect.arrayContaining(['nitrogen_blackout', 'phosphorus_blackout'])
    );
  });

  test('classifyProtocolLine marks Celsius as spot allowance and May fertilizers as one-of branch', () => {
    const celsius = classifyProtocolLine('Celsius WG + NIS broadleaf ($3.84)', 'base');
    const branch = classifyProtocolLine('★ IF P index ≥80: LESCO 24-0-11 ($8.68)', 'base');
    const abbreviatedBranch = classifyProtocolLine('★ IF P ≥80: LESCO 24-0-11 ($8.68)', 'base');

    expect(celsius.scope).toBe('SPOT_ALLOWANCE');
    expect(celsius.areaFactorDefault).toBe(0.25);
    expect(effectiveAreaFactor(celsius, { weedPressure: 'CLEAN' })).toBe(0.125);
    expect(branch).toMatchObject({
      scope: 'BRANCH_ONE_OF',
      branchGroupId: 'MAY_P_INDEX_FERTILIZER',
      conditionFlag: 'soil_p_index',
    });
    expect(abbreviatedBranch.scope).toBe('BRANCH_ONE_OF');
  });

  test('resolveProtocolItems selects only one May fertilizer branch and defaults missing soil test to 24-0-11', () => {
    const lines = parseProtocolLines(
      '★ IF P index <80: LESCO 24-2-11 ($7.43)\n★ IF P ≥80: LESCO 24-0-11 ($8.68)\nCarbonPro-L biostimulant ($14.24)\nChelated Iron Plus ($1.52)',
      'base'
    );
    const products = [
      { id: 'low-p', name: 'LESCO 24-2-11' },
      { id: 'zero-p', name: 'LESCO 24-0-11' },
      { id: 'carbon', name: 'CarbonPro-L' },
      { id: 'iron', name: 'LESCO 12-0-0 Chelated Iron Plus' },
    ];

    const defaultItems = resolveProtocolItems(lines, products);
    const lowPItems = resolveProtocolItems(lines, products, { soilPIndex: 62 });

    expect(selectedMayFertilizerBranch({ soilPIndex: null }).branchKey).toBe('LESCO_24_0_11');
    expect(defaultItems.filter((item) => item.selected).map((item) => item.product?.name)).toEqual([
      'LESCO 24-0-11',
      'CarbonPro-L',
      'LESCO 12-0-0 Chelated Iron Plus',
    ]);
    expect(lowPItems.filter((item) => item.selected).map((item) => item.product?.name)).toEqual([
      'LESCO 24-2-11',
      'CarbonPro-L',
      'LESCO 12-0-0 Chelated Iron Plus',
    ]);
  });

  test('resolveProtocolItems lets explicit selection override default May fertilizer branch', () => {
    const lines = parseProtocolLines(
      '★ IF P index <80: LESCO 24-2-11 ($7.43)\n★ IF P ≥80: LESCO 24-0-11 ($8.68)',
      'base'
    );
    const products = [
      { id: 'low-p', name: 'LESCO 24-2-11' },
      { id: 'zero-p', name: 'LESCO 24-0-11' },
    ];

    const items = resolveProtocolItems(lines, products, { selectedConditionalProductIds: 'low-p' });

    expect(items.map((item) => [item.product?.id, item.selected, item.selectionReason])).toEqual([
      ['low-p', true, 'explicit_branch_selection'],
      ['zero-p', false, 'mutually_exclusive_branch_not_selected'],
    ]);
  });

  test('effectiveAreaFactor accepts stored lowercase premium tier for premium-only lines', () => {
    const line = classifyProtocolLine('Premium: Hydretain ($10.59)', 'base');

    expect(line.scope).toBe('PREMIUM_ONLY');
    expect(effectiveAreaFactor(line, { plan: 'premium' })).toBe(1);
    expect(effectiveAreaFactor(line, { plan: 'Platinum' })).toBe(1);
    expect(effectiveAreaFactor(line, { plan: 'standard' })).toBe(0);
  });

  test('resolveProtocolItems preserves premium-only lines from service context tier', () => {
    const lines = parseProtocolLines('Premium: Hydretain ($10.59)', 'base');
    const products = [{ id: 'hydr', name: 'Hydretain' }];

    const premiumItems = resolveProtocolItems(lines, products, {}, { service: { waveguard_tier: 'Platinum' } });
    const standardItems = resolveProtocolItems(lines, products, {}, { service: { waveguard_tier: 'standard' } });

    expect(premiumItems[0].selected).toBe(true);
    expect(standardItems[0].selected).toBe(false);
  });

  test('resolveProtocolItems selects premium-only secondary lines for eligible tier', () => {
    const lines = parseProtocolLines('Hydretain drought prep Premium ($10.59)', 'conditional');
    const products = [{ id: 'hydr', name: 'Hydretain' }];

    const premiumItems = resolveProtocolItems(lines, products, {}, { service: { waveguard_tier: 'Platinum' } });
    const standardItems = resolveProtocolItems(lines, products, {}, { service: { waveguard_tier: 'Silver' } });

    expect(premiumItems[0]).toMatchObject({
      conditional: true,
      selected: true,
      selectionReason: 'premium_or_drought_prep_selected',
    });
    expect(standardItems[0].selected).toBe(false);
  });

  test('resolveProtocolItems selects drought-prep premium lines from normalized drought flags', () => {
    const lines = parseProtocolLines('Hydretain drought prep Premium ($10.59)', 'conditional');
    const products = [{ id: 'hydr', name: 'Hydretain' }];

    const conditionFlagItems = resolveProtocolItems(lines, products, { conditionFlags: 'drought_stress' }, { service: { waveguard_tier: 'Silver' } });
    const propertyFlagItems = resolveProtocolItems(lines, products, { propertyFlags: 'drought_prep' }, { service: { waveguard_tier: 'Silver' } });
    const mergedFlagItems = resolveProtocolItems(lines, products, {
      conditionFlags: 'heat_stress',
      propertyFlags: 'drought_prep',
    }, { service: { waveguard_tier: 'Silver' } });
    const storedStressItems = resolveProtocolItems(lines, products, {}, {
      service: { waveguard_tier: 'Silver' },
      stressFlags: { drought_stress: true, heat_stress: false },
    });

    expect(conditionFlagItems[0]).toMatchObject({
      selected: true,
      selectionReason: 'premium_or_drought_prep_selected',
    });
    expect(propertyFlagItems[0].selected).toBe(true);
    expect(mergedFlagItems[0].selected).toBe(true);
    expect(storedStressItems[0].selected).toBe(true);
    expect(effectiveAreaFactor(conditionFlagItems[0], { conditionFlags: 'drought_stress' })).toBe(1);
    expect(effectiveAreaFactor(propertyFlagItems[0], { propertyFlags: 'drought_prep' })).toBe(1);
    expect(effectiveAreaFactor(propertyFlagItems[0], { includePremiumOnly: true })).toBe(1);
    expect(effectiveAreaFactor(storedStressItems[0], { stressFlags: { drought_stress: true } })).toBe(1);
  });

  test('effectiveAreaFactor honors explicit conditional rescue selections without condition flags', () => {
    const [line] = parseProtocolLines('Talstar P curative if threshold met ($3.82)', 'conditional');

    expect(line.scope).toBe('CONDITIONAL_RESCUE');
    expect(effectiveAreaFactor({ ...line, selected: false }, {})).toBe(0);
    expect(effectiveAreaFactor({ ...line, selected: true }, {})).toBe(1);
  });

  test('calculateNutrientLedgerFromRows normalizes historical totals to per-1000 units', () => {
    const ledger = calculateNutrientLedgerFromRows(
      [{ product_name: 'LESCO 24-0-11', total_amount: 10, amount_unit: 'lb' }],
      [{ name: 'LESCO 24-0-11', analysis_n: 24, analysis_p: 0, analysis_k: 11 }],
      10000,
      2026,
    );

    expect(ledger.totalN).toBe(2.4);
    expect(ledger.nApplied).toBe(0.24);
  });

  test('summarizeAnnualN reports remaining budget and exceeded status', () => {
    const near = summarizeAnnualN({
      currentN: 3.4,
      projectedVisitN: 0.25,
      annualNLimit: 4,
    });
    expect(near.status).toBe('near_limit');
    expect(near.remainingAfterVisit).toBe(0.35);
    expect(near.percentUsedAfterVisit).toBe(91.3);

    const exceeded = summarizeAnnualN({
      currentN: 3.9,
      projectedVisitN: 0.25,
      annualNLimit: 4,
    });
    expect(exceeded.status).toBe('exceeded');
    expect(exceeded.remainingAfterVisit).toBe(0);
  });

  test('nutrient ledger helpers normalize pg DATE objects and completion amounts', () => {
    expect(toDateOnly(new Date('2026-05-03T00:00:00.000Z'))).toBe('2026-05-03');
    expect(toDateOnly(new Date('2026-05-03T04:00:00.000Z'))).toBe('2026-05-03');
    expect(toDateOnly(new Date('2026-05-03T02:30:00.000Z'))).toBe('2026-05-02');
    expect(toDateOnly('2026-05-03T02:30:00.000Z')).toBe('2026-05-02');
    expect(calculateAppliedNutrients({
      product: { analysis_n: 24, analysis_p: 0, analysis_k: 11 },
      amount: 10,
      amountUnit: 'lb',
      lawnSqft: 10000,
    })).toEqual({
      nAppliedPer1000: 0.24,
      pAppliedPer1000: 0,
      kAppliedPer1000: 0.11,
    });
  });

  test('calculateNutrients reads analysis fields from plan items', () => {
    const nutrients = calculateNutrients([{
      product: { analysis_n: 24, analysis_p: 0, analysis_k: 11 },
      mix: { amount: 10, amountUnit: 'lb' },
    }], 10000);

    expect(nutrients.nPer1000).toBe(0.24);
    expect(nutrients.kPer1000).toBe(0.11);
  });

  test('calculateNutrients converts ounces to pounds and refuses fluid ounces without density', () => {
    const dry = calculateNutrients([{
      product: { analysis_n: 24, analysis_p: 0, analysis_k: 0 },
      mix: { amount: 16, amountUnit: 'oz' },
    }], 1000);
    const liquid = calculateNutrients([{
      product: { analysis_n: 12, analysis_p: 0, analysis_k: 0 },
      mix: { amount: 3, amountUnit: 'fl_oz' },
    }], 1000);

    expect(dry.nPer1000).toBe(0.24);
    expect(liquid.nPer1000).toBe(0);
    expect(amountToPounds(3, 'fl_oz')).toBeNull();
  });

  test('findNutrientProductsMissingRates flags nutrient products without verified rates', () => {
    const missing = findNutrientProductsMissingRates([{
      product: {
        id: 'fert',
        name: 'LESCO 24-0-11',
        analysis_n: 24,
        analysis_p: 0,
        analysis_k: 11,
      },
      mix: { amount: null },
    }, {
      product: {
        id: 'herb',
        name: 'Celsius WG',
        analysis_n: 0,
        analysis_p: 0,
        analysis_k: 0,
      },
      mix: { amount: null },
    }]);

    expect(missing).toHaveLength(1);
    expect(missing[0].product.name).toBe('LESCO 24-0-11');
  });

  test('findNutrientProductsMissingConversions flags N/P volume rates without density', () => {
    const missing = findNutrientProductsMissingConversions([{
      product: {
        id: 'iron',
        name: 'LESCO 12-0-0 Chelated Iron Plus',
        analysis_n: 12,
        analysis_p: 0,
        analysis_k: 0,
        rate_unit: 'fl_oz',
      },
      mix: { amount: 3, amountUnit: 'fl_oz' },
    }, {
      product: {
        id: 'kflow',
        name: 'LESCO K-Flow 0-0-25',
        analysis_n: 0,
        analysis_p: 0,
        analysis_k: 25,
        rate_unit: 'fl_oz',
      },
      mix: { amount: 3, amountUnit: 'fl_oz' },
    }]);

    expect(missing).toHaveLength(1);
    expect(missing[0].product.name).toBe('LESCO 12-0-0 Chelated Iron Plus');
  });

  test('buildMixOrder preserves catalog mixing category and instructions', () => {
    const order = buildMixOrder([{
      raw: 'K-Flow 0-0-25 liquid K',
      product: {
        id: 'kflow',
        name: 'LESCO K-Flow 0-0-25',
        mixing_order_category: 'liquid_fertilizer',
        mixing_instructions: 'Add after flowables and before adjuvants.',
      },
    }]);

    expect(order[0]).toMatchObject({
      productName: 'LESCO K-Flow 0-0-25',
      category: 'liquid_fertilizer',
      instruction: 'Add after flowables and before adjuvants.',
    });
  });
});
