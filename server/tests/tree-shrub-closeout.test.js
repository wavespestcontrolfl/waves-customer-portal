const {
  inferTreeShrubOrdinanceZone,
  isSummerBlackoutForZone,
  normalizeTreeShrubCloseout,
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

  test('refuses an injection dose stated in mL; tsp and fl oz doses pass', () => {
    // Owner ruling 2026-09-29: nothing a tech records is in mL.
    const codes = (dose) => validate({
      completion: {
        injectionPerformed: true,
        injectionRecord: {
          plantSpecies: 'Sabal palm',
          sizeClassOrDbh: '12 in DBH',
          product: 'Palm-Jet Mg',
          dose,
          numberOfPorts: 4,
          targetIssue: 'Magnesium deficiency',
          followUpDate: '2026-10-15',
        },
      },
    }).blocks.map((block) => block.code);

    for (const dose of ['20 mL', '20ml', '5 cc', '2 milliliters', '10 mL per inch DBH']) {
      expect(codes(dose)).toContain('tree_shrub_injection_dose_ml');
    }
    for (const dose of ['½ fl oz', '4 tsp', '1.5 oz']) {
      expect(codes(dose)).not.toContain('tree_shrub_injection_dose_ml');
      expect(codes(dose)).not.toContain('tree_shrub_injection_dose_required');
    }
  });

  test('server enforces a readable tsp or fl oz dose, mirroring the client parser', () => {
    // A stale native client or direct API call can submit any text; the dose
    // must still read as a positive number of tsp or fl oz.
    const blocksFor = (dose) => validate({
      completion: {
        injectionPerformed: true,
        injectionRecord: {
          plantSpecies: 'Sabal palm',
          sizeClassOrDbh: '12 in DBH',
          product: 'Palm-Jet Mg',
          dose,
          numberOfPorts: 4,
          targetIssue: 'Magnesium deficiency',
          followUpDate: '2026-10-15',
        },
      },
    }).blocks;

    for (const dose of ['1 fl oz', '1.5 tsp', '½ fl oz', '1½ tsp', '1 1/2 tsp', '1/2 tsp', '2 teaspoons', '2 oz', '.5 tsp', '1 fluid ounce', '2 fl. oz.', '2floz']) {
      expect(blocksFor(dose)).toEqual([]);
    }
    for (const dose of ['a squirt', '2 gallons', '0 tsp', '. tsp', '1/0 tsp', '0/2 tsp', '2', 'tsp', '1 tbsp']) {
      const blocks = blocksFor(dose);
      expect(blocks.map((block) => block.code)).toEqual(['tree_shrub_injection_dose_unreadable']);
      expect(blocks[0]).toMatchObject({
        message: 'Enter the injection dose as a number of tsp or fl oz.',
        field: 'injectionRecord.dose',
      });
    }
    // mL keeps its own code and takes precedence over the unreadable block.
    expect(blocksFor('20 mL').map((block) => block.code)).toEqual(['tree_shrub_injection_dose_ml']);
    expect(blocksFor('').map((block) => block.code)).toEqual(['tree_shrub_injection_dose_required']);
  });

  test('a catalog row injection method or label unit requires the injection record', () => {
    // "Arborjet PHOSPHO-Jet Systemic Fungicide" names no injection word; only
    // the catalog's application_method / default_unit (seeded by the per-basis
    // rate migration) marks it.
    const codesFor = (row) => validate({
      products: [{ productId: 'pj-1', name: 'Arborjet PHOSPHO-Jet Systemic Fungicide', totalAmount: 2, amountUnit: 'tsp' }],
      productRows: [{ id: 'pj-1', name: 'Arborjet PHOSPHO-Jet Systemic Fungicide', category: 'fungicide', ...row }],
    }).blocks.map((block) => block.code);

    expect(codesFor({})).not.toContain('tree_shrub_injection_species_required');
    for (const row of [
      { default_unit: 'ml/inch dbh' },
      { default_unit: 'ml/palm' },
      { default_unit: 'g/inch dbh' },
      { default_unit: 'mL / in DBH' },
      { application_method: 'trunk_injection' },
    ]) {
      expect(codesFor(row)).toEqual(expect.arrayContaining([
        'tree_shrub_injection_species_required',
        'tree_shrub_injection_dose_required',
      ]));
    }
    // Other label units and methods stay out.
    for (const row of [{ default_unit: 'oz/1000 sq ft' }, { default_unit: 'ml/gal' }, { application_method: 'foliar_spray' }]) {
      expect(codesFor(row)).not.toContain('tree_shrub_injection_species_required');
    }
  });

  test('classifies fertilizer and blackout dates conservatively', () => {
    expect(productHasNpFertilizer({ name: '13-0-13 Ornamental Fertilizer' })).toBe(true);
    expect(productHasNpFertilizer({ name: '0-0-22 Potassium Magnesium Corrective', category: 'fertilizer' })).toBe(false);
    expect(isSummerBlackoutForZone('2026-06-01', 'sarasota_venice')).toBe(true);
    expect(isSummerBlackoutForZone('2026-10-01', 'sarasota_venice')).toBe(false);
    expect(isSummerBlackoutForZone('2026-07-15', 'north_port')).toBe(false);
  });
});

describe('injection label band', () => {
  it('keeps the band the dose was worked out from with the record', () => {
    const normalized = normalizeTreeShrubCloseout({
      injectionRecord: { product: 'Arborjet PHOSPHO-Jet Systemic Fungicide', labelBand: { product: 'Arborjet PHOSPHO-Jet Systemic Fungicide', key: 'tree' } },
    });
    expect(normalized.injectionRecord.labelBand).toEqual({ product: 'Arborjet PHOSPHO-Jet Systemic Fungicide', key: 'tree' });
    expect(normalizeTreeShrubCloseout({ injectionRecord: { labelBand: { product: 'Mn-Jet', key: 'tree_late' } } }).injectionRecord.labelBand)
      .toEqual({ product: 'Mn-Jet', key: 'tree_late' });
  });

  it('keeps the catalog id the form recorded with the record', () => {
    expect(normalizeTreeShrubCloseout({ injectionRecord: { product: 'PHOSPHO-Jet', productId: 'pj-1' } }).injectionRecord.productId).toBe('pj-1');
  });

  it('reads anything else as no band', () => {
    for (const labelBand of [undefined, null, 'low', { key: '' }, { key: 'Low Rate!' }, { key: 'x'.repeat(41) }]) {
      expect(normalizeTreeShrubCloseout({ injectionRecord: { labelBand } }).injectionRecord.labelBand).toBeNull();
    }
  });
});

describe('injection record against the product label', () => {
  const IMA_JET = { id: 'ij-1', name: 'Arborjet Ima-Jet Systemic Insecticide', category: 'insecticide', default_rate: '2-8', default_unit: 'ml/inch dbh', application_method: 'trunk_injection' };
  const IMA_JET_10 = { id: 'ij-10', name: 'Arborjet Ima-Jet 10', category: 'insecticide', default_rate: '1-6', default_unit: 'ml/inch dbh', application_method: 'trunk_injection' };
  const PHOSPHO = { id: 'pj-1', name: 'Arborjet PHOSPHO-Jet Systemic Fungicide', category: 'fungicide', default_rate: '3.5-7', default_unit: 'ml/inch dbh', application_method: 'trunk_injection' };
  const MN_JET = { id: 'mn-1', name: 'ArborJet Mn-Jet Fe Micros', category: 'fertilizer', default_rate: '5-15', default_unit: 'ml/inch dbh', application_method: 'trunk_injection' };
  const PALM_JET = { id: 'pm-1', name: 'Arborjet Palm-Jet Palm Nutrition', category: 'fertilizer', default_rate: '5-30', default_unit: 'ml/palm', application_method: 'trunk_injection' };
  const PROPIZOL = { id: 'pz-1', name: 'Arborjet Propizol Injectable Fungicide', category: 'fungicide', default_rate: '10-20', default_unit: 'ml/inch dbh', application_method: 'trunk_injection' };
  const injectionBlocks = (row, record) => validate({
    products: [{ productId: row.id, name: row.name, totalAmount: 2, amountUnit: 'tsp' }],
    productRows: [row],
    completion: {
      injectionRecord: {
        plantSpecies: 'Live oak', product: row.name, dose: '3 tsp', numberOfPorts: 4,
        targetIssue: 'Scale', followUpDate: '2026-10-15', sizeClassOrDbh: '10 in DBH', ...record,
      },
    },
  }).blocks.filter((block) => block.code.startsWith('tree_shrub_injection'));
  const injectionCodes = (row, record) => injectionBlocks(row, record).map((block) => block.code);

  test('PHOSPHO-jet needs the plant picked for this product; the trunk alone settles nothing', () => {
    expect(injectionCodes(PHOSPHO, {})).toEqual(['tree_shrub_injection_band_required']);
    expect(injectionBlocks(PHOSPHO, {})[0]).toMatchObject({ message: 'Pick the plant for the injection dose.', field: 'injectionRecord.labelBand' });
    // A pick made for another product, or a key not in this label's table, is no pick.
    expect(injectionCodes(PHOSPHO, { labelBand: { product: 'Other', key: 'tree' } })).toEqual(['tree_shrub_injection_band_required']);
    expect(injectionCodes(PHOSPHO, { labelBand: { product: PHOSPHO.name, key: 'tree_low' } })).toEqual(['tree_shrub_injection_band_required']);
    expect(injectionCodes(PHOSPHO, { labelBand: { product: PHOSPHO.name, key: 'tree' } })).toEqual([]);
  });

  test('Mn-jet needs the plant and season picked for this product', () => {
    expect(injectionCodes(MN_JET, {})).toEqual(['tree_shrub_injection_band_required']);
    expect(injectionBlocks(MN_JET, {})[0].message).toBe('Pick the plant and season for the injection dose.');
    expect(injectionCodes(MN_JET, { labelBand: { product: PHOSPHO.name, key: 'tree_low' } })).toEqual(['tree_shrub_injection_band_required']);
    expect(injectionCodes(MN_JET, { labelBand: { product: MN_JET.name, key: 'tree' } })).toEqual(['tree_shrub_injection_band_required']);
    for (const key of ['tree_low', 'tree_late', 'palm']) {
      expect(injectionCodes(MN_JET, { labelBand: { product: MN_JET.name, key } })).toEqual([]);
    }
  });

  test('IMA-jet, IMA-jet 10, Palm-jet and Propizol have no band table: no band is required', () => {
    expect(injectionCodes(IMA_JET, {})).toEqual([]);
    expect(injectionCodes(IMA_JET_10, {})).toEqual([]);
    expect(injectionCodes(PROPIZOL, {})).toEqual([]);
    expect(injectionCodes(PALM_JET, { sizeClassOrDbh: 'Large palm' })).toEqual([]);
    // A band left over from an old record is not checked either.
    expect(injectionCodes(IMA_JET, { labelBand: { product: IMA_JET.name, key: 'sap_feeders' } })).toEqual([]);
  });

  test('a catalog rate the client cannot read asks for no band (the form shows no picker)', () => {
    for (const default_rate of ['', 'see label', '0-4']) {
      expect(injectionCodes({ ...PHOSPHO, default_rate }, {})).toEqual([]);
      expect(injectionCodes({ ...MN_JET, default_rate }, {})).toEqual([]);
    }
  });

  test('a palm pick needs no trunk in inches, and takes a size that is not inches', () => {
    const palm = { labelBand: { product: PHOSPHO.name, key: 'palm' } };
    expect(injectionCodes(PHOSPHO, { ...palm, sizeClassOrDbh: 'Large palm' })).toEqual([]);
    expect(injectionCodes(PHOSPHO, { ...palm, sizeClassOrDbh: '30 cm DBH' })).toEqual([]);
    expect(injectionCodes(MN_JET, { labelBand: { product: MN_JET.name, key: 'palm' }, sizeClassOrDbh: 'Large palm' })).toEqual([]);
    // The size is still required.
    expect(injectionCodes(PHOSPHO, { ...palm, sizeClassOrDbh: '' })).toEqual(['tree_shrub_injection_size_required']);
    // A tree pick with the same size is not a trunk in inches.
    expect(injectionCodes(PHOSPHO, { labelBand: { product: PHOSPHO.name, key: 'tree' }, sizeClassOrDbh: 'Large palm' })).toEqual(['tree_shrub_injection_dbh_inches']);
    // A palm pick made for another product does not waive the trunk (it also lacks a pick).
    expect(injectionCodes(PHOSPHO, { labelBand: { product: 'Other', key: 'palm' }, sizeClassOrDbh: 'Large palm' }))
      .toEqual(['tree_shrub_injection_band_required', 'tree_shrub_injection_dbh_inches']);
  });

  test('the old band-mismatch check is gone: the picked band no longer decides the target issue or size text', () => {
    expect(injectionCodes(PHOSPHO, { labelBand: { product: PHOSPHO.name, key: 'tree' }, targetIssue: 'Anything the tech typed' })).toEqual([]);
    expect(injectionCodes(PALM_JET, { labelBand: { product: PALM_JET.name, key: 'small' }, sizeClassOrDbh: 'Large palm' })).toEqual([]);
  });

  test('a trunk_injection method recorded on the visit requires the injection record', () => {
    const PLAIN = { id: 'pl-1', name: 'Some Systemic', category: 'insecticide', default_unit: 'oz/gal', application_method: 'foliar_spray' };
    const codes = (applicationMethod) => validate({
      products: [{ productId: PLAIN.id, name: PLAIN.name, totalAmount: 2, amountUnit: 'tsp', applicationMethod }],
      productRows: [PLAIN],
      completion: { injectionPerformed: false, injectionRecord: {} },
    }).blocks.map((block) => block.code);
    expect(codes('trunk_injection')).toContain('tree_shrub_injection_dose_required');
    expect(codes('foliar_spray')).not.toContain('tree_shrub_injection_dose_required');
  });

  test('a per-inch label in grams (Arbor-OTC) needs the trunk in inches too', () => {
    const ARBOR_OTC = { id: 'otc-1', name: 'Arborjet Arbor OTC Fungicide 1 oz', category: 'fungicide', default_rate: '0.28', default_unit: 'g/inch dbh', application_method: 'trunk_injection' };
    expect(injectionCodes(ARBOR_OTC, { sizeClassOrDbh: 'Large' })).toEqual(['tree_shrub_injection_dbh_inches']);
    expect(injectionCodes(ARBOR_OTC, { sizeClassOrDbh: '8 in DBH' })).toEqual([]);
    // The basis is the unit's, whatever the rate field holds.
    expect(injectionCodes({ ...IMA_JET, default_rate: '' }, { sizeClassOrDbh: 'Large' })).toEqual(['tree_shrub_injection_dbh_inches']);
    // IMA-jet is still per inch, with no band to pick.
    expect(injectionCodes(IMA_JET, { sizeClassOrDbh: 'Large' })).toEqual(['tree_shrub_injection_dbh_inches']);
  });

  test('matches the label by the catalog id the form recorded, even after a rename', () => {
    const renamed = { product: 'PHOSPHO old name', productId: PHOSPHO.id, sizeClassOrDbh: '30 cm DBH' };
    // The pick belongs to the name the record holds, so the renamed record needs its own.
    expect(injectionCodes(PHOSPHO, { ...renamed, labelBand: { product: 'PHOSPHO old name', key: 'tree' } })).toEqual(['tree_shrub_injection_dbh_inches']);
    expect(injectionCodes(PHOSPHO, renamed)).toEqual(['tree_shrub_injection_band_required', 'tree_shrub_injection_dbh_inches']);
    // A palm pick by the renamed record waives the trunk, found by id.
    expect(injectionCodes(PHOSPHO, { ...renamed, labelBand: { product: 'PHOSPHO old name', key: 'palm' } })).toEqual([]);
  });

  test('a per-inch label needs the trunk in inches above zero', () => {
    const tree = { labelBand: { product: PHOSPHO.name, key: 'tree' } };
    for (const sizeClassOrDbh of ['0 in DBH', '. in DBH', '30 cm DBH', 'Large']) {
      expect(injectionCodes(PHOSPHO, { ...tree, sizeClassOrDbh })).toEqual(['tree_shrub_injection_dbh_inches']);
    }
    for (const sizeClassOrDbh of ['10 in DBH', '10', '12.5 inches']) {
      expect(injectionCodes(PHOSPHO, { ...tree, sizeClassOrDbh })).toEqual([]);
    }
    // A product typed by name, not on the visit, has no label to check against.
    expect(injectionCodes(PHOSPHO, { product: 'Tree-age', sizeClassOrDbh: 'Large' })).toEqual([]);
  });
});
