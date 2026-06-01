const {
  inferTreeShrubOrdinanceZone,
  isSummerBlackoutForZone,
  productHasNpFertilizer,
  validateTreeShrubCloseout,
} = require('../services/tree-shrub-closeout');

function validCompletion(overrides = {}) {
  return {
    ordinanceZone: 'sarasota_venice',
    bedSqft: 2400,
    palmCount: 3,
    palmRootZoneSqft: 600,
    plantInventory: 'Palms, ixora, hibiscus, croton, clusia hedge',
    pollinatorStatus: 'no_blooms_or_no_bees',
    targetPestOrDisease: 'Scale crawlers',
    pestLifeStage: 'crawler',
    iracFracLogged: true,
    snapshotAppliedYtd: 2,
    fertilizerAppliedYtd: 'January palm fert, April ornamental fert',
    customerNote: 'Beds treated and palms inspected.',
    ...overrides,
  };
}

function validate(overrides = {}) {
  return validateTreeShrubCloseout({
    serviceLine: 'tree_shrub',
    service: {
      city: 'Venice',
      scheduled_date: '2026-07-15',
      customer_id: 'cust-1',
    },
    serviceDate: '2026-07-15',
    completion: validCompletion(overrides.completion || {}),
    products: overrides.products || [],
    productRows: overrides.productRows || [],
    completionPhotos: overrides.completionPhotos || [{ data: 'a' }, { data: 'b' }],
    customerRecap: 'Customer note.',
    technicianNotes: 'Tech note.',
  });
}

describe('Tree/Shrub closeout validation', () => {
  test('infers the route ordinance zones used by the SWFL protocol', () => {
    expect(inferTreeShrubOrdinanceZone({ city: 'North Port', county: 'Sarasota' })).toBe('north_port');
    expect(inferTreeShrubOrdinanceZone({ city: 'Venice' })).toBe('sarasota_venice');
    expect(inferTreeShrubOrdinanceZone({ city: 'Parrish' })).toBe('manatee_parrish');
    expect(inferTreeShrubOrdinanceZone({ city: 'Unknown' })).toBe('other_unknown');
  });

  test('blocks N/P fertilizer during Sarasota and Manatee landscape blackout', () => {
    const result = validate({
      products: [{ productId: 'fert-1', name: '8-2-12 Palm Fertilizer', totalAmount: 6, amountUnit: 'lb' }],
      productRows: [{ id: 'fert-1', name: '8-2-12 Palm Fertilizer', category: 'fertilizer', analysis_n: 8, analysis_p: 2 }],
    });

    expect(result.ok).toBe(false);
    expect(result.blocks.map((block) => block.code)).toContain('tree_shrub_np_blackout');
  });

  test('does not apply the Sarasota/Manatee landscape blackout to North Port landscape zone', () => {
    const result = validate({
      completion: { ordinanceZone: 'north_port' },
      products: [{ productId: 'fert-1', name: '8-2-12 Palm Fertilizer', totalAmount: 6, amountUnit: 'lb' }],
      productRows: [{ id: 'fert-1', name: '8-2-12 Palm Fertilizer', category: 'fertilizer', analysis_n: 8, analysis_p: 2 }],
    });

    expect(result.ok).toBe(true);
    expect(result.blocks.map((block) => block.code)).not.toContain('tree_shrub_np_blackout');
  });

  test('requires pest life stage, pollinator safety, and IRAC/FRAC logging for insect products', () => {
    const result = validate({
      completion: {
        pollinatorStatus: 'blooming_bees_active',
        targetPestOrDisease: 'none observed',
        pestLifeStage: 'none',
        iracFracLogged: false,
      },
      products: [{ productId: 'mainspring-1', name: 'Mainspring GNL', totalAmount: 8, amountUnit: 'fl_oz' }],
      productRows: [{ id: 'mainspring-1', name: 'Mainspring GNL', category: 'insecticide', irac_group: '28' }],
    });

    expect(result.ok).toBe(false);
    expect(result.blocks.map((block) => block.code)).toEqual(expect.arrayContaining([
      'tree_shrub_insect_target_required',
      'tree_shrub_insect_life_stage_required',
      'tree_shrub_pollinator_block',
      'tree_shrub_irac_frac_required',
    ]));
  });

  test('requires CRM closeout fields, photos, product actuals, and Snapshot YTD', () => {
    const result = validateTreeShrubCloseout({
      serviceLine: 'palm',
      service: { city: 'Parrish', scheduled_date: '2026-10-15' },
      serviceDate: '2026-10-15',
      completion: {
        ordinanceZone: 'manatee_parrish',
        palmCount: 1,
        snapshotAppliedYtd: 5,
      },
      products: [{ productId: 'snapshot-1', name: 'Snapshot 2.5TG', totalAmount: '', amountUnit: '' }],
      productRows: [{ id: 'snapshot-1', name: 'Snapshot 2.5TG', category: 'pre-emergent' }],
      completionPhotos: [{ data: 'a' }],
    });

    expect(result.ok).toBe(false);
    expect(result.blocks.map((block) => block.code)).toEqual(expect.arrayContaining([
      'tree_shrub_bed_sqft_required',
      'tree_shrub_palm_root_zone_required',
      'tree_shrub_plant_inventory_required',
      'tree_shrub_pollinator_status_required',
      'tree_shrub_pest_id_required',
      'tree_shrub_life_stage_required',
      'tree_shrub_snapshot_ytd_limit',
      'tree_shrub_fertilizer_ytd_required',
      'tree_shrub_customer_note_required',
      'tree_shrub_photos_required',
      'tree_shrub_product_actuals_required',
    ]));
  });

  test('requires complete injection records when injections are performed', () => {
    const result = validate({
      completion: {
        injectionPerformed: true,
        injectionRecord: {
          plantSpecies: 'Sabal palm',
          product: 'Palm-Jet Mg',
          dose: '20 mL',
        },
      },
    });

    expect(result.ok).toBe(false);
    expect(result.blocks.map((block) => block.code)).toEqual(expect.arrayContaining([
      'tree_shrub_injection_size_required',
      'tree_shrub_injection_ports_required',
      'tree_shrub_injection_target_required',
      'tree_shrub_injection_follow_up_required',
    ]));
  });

  test('classifies fertilizer and blackout dates conservatively', () => {
    expect(productHasNpFertilizer({ name: '13-0-13 Ornamental Fertilizer' })).toBe(true);
    expect(productHasNpFertilizer({ name: '0-0-22 Potassium Magnesium Corrective', category: 'fertilizer' })).toBe(false);
    expect(isSummerBlackoutForZone('2026-06-01', 'sarasota_venice')).toBe(true);
    expect(isSummerBlackoutForZone('2026-10-01', 'sarasota_venice')).toBe(false);
    expect(isSummerBlackoutForZone('2026-07-15', 'north_port')).toBe(false);
  });
});
