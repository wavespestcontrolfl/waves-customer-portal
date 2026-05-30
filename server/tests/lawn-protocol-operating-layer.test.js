const { summarizeProtocolContext } = require('../services/lawn-protocol-operating-layer');

describe('lawn protocol operating layer', () => {
  test('summarizes report, assessment, inventory, wiki, product, and gate bridges', () => {
    const context = summarizeProtocolContext({
      protocol: {
        protocol_key: 'swfl_st_augustine_10_10',
        version: '2026.05',
        name: '10/10 SWFL St. Augustine Lawn Protocol',
        grass_track: 'st_augustine',
        region: 'swfl',
        operating_sentence: 'Every stop must be legal.',
      },
      window: {
        window_key: 'jun_blackout_stress',
        month: 6,
        title: 'June Blackout Stress Program + Chinch Float Test #1',
        visit_type: 'blackout_liquid_production',
        goal: 'Color, stress tolerance, pest scouting; no N/P.',
        default_carrier_gal_per_1000: '1.000',
        production_mode: 'main_reel_plus_spot_backpack',
        required_tasks: ['chinch_float_test', 'blackout_zero_np'],
        service_report_context: { complianceSummary: true },
        assessment_bridge: { writeWatchItems: true },
        inventory_bridge: { forecastProducts: true },
        wiki_refs: ['protocols/lawn/chinch_float_test'],
        customer_note_templates: ['No N/P applied.'],
      },
      products: [{
        id: 'protocol-product-id',
        product_id: 'catalog-product-id',
        catalog_product_name: 'Talstar P',
        product_name: 'Talstar P',
        role: 'insect_curative',
        application_mode: 'broadcast',
        rate_per_1000: '1.0000',
        rate_unit: 'fl oz',
        carrier_gal_per_1000: '2.000',
        default_in_plan: false,
        gates: { trigger: 'confirmed_chinch_pressure' },
        annual_counter: {},
        frac_group: null,
        irac_group: '3A',
        hrac_group: null,
        moa_group: null,
        analysis_n: '0',
        analysis_p: '0',
        analysis_k: '0',
      }],
      gates: [{
        gate_key: 'north_port_blackout',
        gate_type: 'ordinance',
        severity: 'block',
        title: 'North Port fertilizer blackout',
        rule_text: 'No N or P fertilizer on turf April 1-Sept. 30.',
        logic: { ordinanceZone: 'north_port' },
        wiki_refs: ['compliance/north-port-fertilizer-blackout'],
      }],
    });

    expect(context.protocolKey).toBe('swfl_st_augustine_10_10');
    expect(context.window.key).toBe('jun_blackout_stress');
    expect(context.window.serviceReportContext.complianceSummary).toBe(true);
    expect(context.window.assessmentBridge.writeWatchItems).toBe(true);
    expect(context.window.inventoryBridge.forecastProducts).toBe(true);
    expect(context.window.wikiRefs).toContain('protocols/lawn/chinch_float_test');
    expect(context.products[0]).toEqual(expect.objectContaining({
      productName: 'Talstar P',
      role: 'insect_curative',
      ratePer1000: 1,
      carrierGalPer1000: 2,
    }));
    expect(context.gates[0]).toEqual(expect.objectContaining({
      key: 'north_port_blackout',
      severity: 'block',
    }));
  });
});
