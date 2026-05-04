const {
  amountToPounds,
  buildMixOrder,
  calculateNutrientLedgerFromRows,
  calculateNutrients,
  calculateProductAmount,
  findNutrientProductsMissingRates,
  findNutrientProductsMissingConversions,
  isConditionalSelected,
  isDateInWindow,
  matchCatalogProduct,
  parseProtocolLines,
  summarizeCalibration,
  summarizeOrdinanceStatus,
} = require('../services/waveguard-plan-engine');

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
