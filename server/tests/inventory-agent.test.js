/**
 * purchase-receipts/inventory-agent.js — deterministic validation of an LLM
 * proposal (validateReading, containerAgreement, classifyDecision) and the
 * one small DB-touching unit (recordAttemptFailure). These are pure
 * functions (no I/O) except recordAttemptFailure, which gets a minimal
 * hand-rolled transaction mock rather than the full Postgres fixture — the
 * actual apply-transaction behavior (new product + alias + movement + bell,
 * needs_size container-set, the duplicate guard, concurrent runs, the
 * new-product collision re-check, an apply-time throw) is covered
 * end-to-end in inventory-agent-postgres.test.js, matching how
 * purchase-receipts-postgres.test.js splits from
 * purchase-receipts-processor.test.js.
 */
const {
  validateReading, containerAgreement, classifyDecision, extractEpaRegNumber,
  canonicalSizeText, inventoryUnitForNewProduct, recordAttemptFailure,
} = require('../services/purchase-receipts/inventory-agent');

const ctx = (overrides = {}) => ({
  rawTitle: '', lineQuantity: 1, candidates: [], allActiveProducts: [], allowedCategories: new Set(), matchedProductId: null, ...overrides,
});

describe('validateReading — grounded vs invented numbers (complete title tokens only)', () => {
  const title = 'Control Solutions Taurus SC Termiticide 78 oz';

  test('a reading that reproduces the title\'s own size validates', () => {
    const result = validateReading({ size_text: '78 oz', size_number: 78, size_unit: 'oz', pack_text: null, pack_count: 1 }, { rawTitle: title, lineQuantity: 2 });
    expect(result).toMatchObject({ ok: true, sizeNumber: 78, unit: 'oz', packCount: 1, amount: 156 });
  });

  test('a size not present in the title at all is rejected, even with a size_text hint that IS a substring', () => {
    // size_text "96 oz" is nowhere in the title — but even a hint that WAS a
    // real substring would no longer matter: size_text is never checked.
    expect(validateReading({ size_text: '96 oz', size_number: 96, size_unit: 'oz', pack_count: 1 }, { rawTitle: title, lineQuantity: 1 }))
      .toMatchObject({ ok: false, reason: 'size_not_a_full_title_claim' });
  });

  test('an invented size_number is rejected even though the substring-only size_text hint would have passed the old check', () => {
    expect(validateReading({ size_text: '78 oz', size_number: 96, size_unit: 'oz', pack_count: 1 }, { rawTitle: title, lineQuantity: 1 }))
      .toMatchObject({ ok: false, reason: 'size_not_a_full_title_claim' });
  });

  test('plural containers with no pack marker never validate a single container', () => {
    expect(validateReading({ size_number: 30, size_unit: 'g', pack_count: 1 }, { rawTitle: 'Advion Cockroach Gel Bait 4 tubes / 30 g', lineQuantity: 1 }))
      .toMatchObject({ ok: false, reason: 'plural_containers_without_pack_marker' });
    expect(validateReading({ size_number: 30, size_unit: 'g', pack_count: 4 }, { rawTitle: 'Advion Cockroach Gel Bait 4 x 30 g Tubes', lineQuantity: 1 }))
      .toMatchObject({ ok: true, sizeNumber: 30, unit: 'g', packCount: 4, amount: 120 });
    expect(validateReading({ size_number: 25, size_unit: 'each', pack_count: 1 }, { rawTitle: 'Trelona Compressed Termite Bait Cartridges 25 cartridges', lineQuantity: 1 }))
      .toMatchObject({ ok: true, sizeNumber: 25, unit: 'each' });
  });

  test('a title stating two different sizes of one kind is ambiguous and never validates', () => {
    expect(validateReading({ size_number: 1, size_unit: 'gal', pack_count: 1 }, { rawTitle: 'Bifen XTS Insecticide 1 gal / 2.5 gal', lineQuantity: 1 }))
      .toMatchObject({ ok: false, reason: 'conflicting_size_claims' });
    expect(validateReading({ size_number: 12, size_unit: 'each', pack_count: 1 }, { rawTitle: 'Rat Snap Trap 12 Count Refill 2 Count', lineQuantity: 1 }))
      .toMatchObject({ ok: false, reason: 'conflicting_size_claims' });
  });

  test('a restated size, or a size of another kind beside it, is not a conflict', () => {
    expect(validateReading({ size_number: 1, size_unit: 'gal', pack_count: 1 }, { rawTitle: 'Bifen XTS Insecticide 1 Gallon (128 fl oz)', lineQuantity: 1 }))
      .toMatchObject({ ok: true, sizeNumber: 1, unit: 'gal' });
    expect(validateReading({ size_number: 20, size_unit: 'each', pack_count: 1 }, { rawTitle: 'Summit Mosquito Dunks 20 Count 1.3 oz', lineQuantity: 1 }))
      .toMatchObject({ ok: true, sizeNumber: 20, unit: 'each' });
  });

  test('an invented size_unit is rejected the same way', () => {
    expect(validateReading({ size_text: '78 oz', size_number: 78, size_unit: 'gal', pack_count: 1 }, { rawTitle: title, lineQuantity: 1 }))
      .toMatchObject({ ok: false, reason: 'size_not_a_full_title_claim' });
  });

  test('no reading at all never validates (so it can never become an alias — see the header)', () => {
    expect(validateReading(null, { rawTitle: title, lineQuantity: 1 })).toMatchObject({ ok: false, reason: 'no_reading' });
  });

  test('size_text is a HINT only — a blank or wrong size_text no longer matters when size_number/size_unit are correct', () => {
    expect(validateReading({ size_text: '', size_number: 78, size_unit: 'oz', pack_count: 1 }, { rawTitle: title, lineQuantity: 1 }))
      .toMatchObject({ ok: true, sizeNumber: 78 });
  });

  test('"2 Count" against a title that actually reads "12 Count" is rejected — a claim can never start mid-number', () => {
    const trapTitle = 'Victor M326 Rat Trap 12 Count';
    expect(validateReading({ size_text: '2 Count', size_number: 2, size_unit: 'each', pack_count: 1 }, { rawTitle: trapTitle, lineQuantity: 1 }))
      .toMatchObject({ ok: false, reason: 'size_not_a_full_title_claim' });
  });
});

describe('validateReading — pack_count must come from recognized pack syntax, not digit presence', () => {
  test('"2 x 78 oz" with pack_count 2 validates (the recognized "N x" marker)', () => {
    const title = 'Taurus SC 2 x 78 oz';
    const result = validateReading({ size_number: 78, size_unit: 'oz', pack_count: 2 }, { rawTitle: title, lineQuantity: 1 });
    expect(result).toMatchObject({ ok: true, sizeNumber: 78, packCount: 2, amount: 156 });
  });

  test('"4 x 500 g Case" reads the per-unit size and the leading multiplier separately', () => {
    const title = 'Advion Cockroach Gel Bait 4 x 500 g Case';
    const result = validateReading({ size_number: 500, size_unit: 'g', pack_count: 4 }, { rawTitle: title, lineQuantity: 1 });
    expect(result).toMatchObject({ ok: true, sizeNumber: 500, unit: 'g', packCount: 4, amount: 2000 });
  });

  test('"Pack of 12" with pack_count claimed as 2 (a digit inside the title, not the marker\'s own count) -> unsure', () => {
    const title = 'Taurus SC Termiticide 78 oz (Pack of 12)';
    expect(validateReading({ size_text: '78 oz', size_number: 78, size_unit: 'oz', pack_text: '2', pack_count: 2 }, { rawTitle: title, lineQuantity: 1 }))
      .toMatchObject({ ok: false, reason: 'pack_count_mismatch' });
  });

  test('"(Pack of 2)" with pack_count claimed as 1 (ignoring the real marker) -> unsure', () => {
    const title = 'Taurus SC Termiticide 78 oz (Pack of 2)';
    expect(validateReading({ size_text: '78 oz', size_number: 78, size_unit: 'oz', pack_count: 1 }, { rawTitle: title, lineQuantity: 1 }))
      .toMatchObject({ ok: false, reason: 'pack_count_mismatch' });
  });

  test('"12 Count" is a SIZE, never a pack marker: claiming pack_count 2 against it -> unsure (no marker at all in the title)', () => {
    const title = 'Victor M326 Rat Trap 12 Count';
    expect(validateReading({ size_number: 12, size_unit: 'each', pack_count: 2 }, { rawTitle: title, lineQuantity: 1 }))
      .toMatchObject({ ok: false, reason: 'pack_count_without_marker' });
  });

  test('a digit inside an unrelated word (a model number) is never read as a pack: "Model 2000 Sprayer 1 gal" claimed as pack 2 -> unsure', () => {
    const title = 'Acme Model 2000 Sprayer 1 gal';
    expect(validateReading({ size_number: 1, size_unit: 'gal', pack_count: 2 }, { rawTitle: title, lineQuantity: 1 }))
      .toMatchObject({ ok: false, reason: 'pack_count_without_marker' });
  });

  test('pack_count without ANY recognized marker in the title must be 1', () => {
    const title = 'Taurus SC Termiticide 78 oz';
    expect(validateReading({ size_number: 78, size_unit: 'oz', pack_count: 3 }, { rawTitle: title, lineQuantity: 1 }))
      .toMatchObject({ ok: false, reason: 'pack_count_without_marker' });
  });

  test('pack_count out of 1..100 is rejected', () => {
    const title = 'Taurus SC Termiticide 78 oz (Pack of 200)';
    expect(validateReading({ size_number: 78, size_unit: 'oz', pack_count: 200 }, { rawTitle: title, lineQuantity: 1 }))
      .toMatchObject({ ok: false, reason: 'pack_count_range' });
    expect(validateReading({ size_number: 78, size_unit: 'oz', pack_count: 0 }, { rawTitle: title, lineQuantity: 1 }))
      .toMatchObject({ ok: false, reason: 'pack_count_range' });
  });

  test('a SECOND, unrecognized pack marker left over after the first is stripped -> unsure (never picks one)', () => {
    const title = 'Taurus SC 2 x 78 oz (Pack of 2)';
    expect(validateReading({ size_number: 78, size_unit: 'oz', pack_count: 2 }, { rawTitle: title, lineQuantity: 1 }))
      .toMatchObject({ ok: false, reason: 'leftover_pack_wording' });
  });

  test('leftover unreadable pack wording ("Twin Pack") after the size is stripped -> unsure', () => {
    const title = 'Taurus SC Termiticide 78 oz, Twin Pack';
    expect(validateReading({ size_number: 78, size_unit: 'oz', pack_count: 1 }, { rawTitle: title, lineQuantity: 1 }))
      .toMatchObject({ ok: false, reason: 'leftover_pack_wording' });
  });
});

describe('validateReading — count items', () => {
  test('"12 Count" reads as 12 each', () => {
    const title = 'Victor M326 Rat Trap 12 Count';
    const result = validateReading({ size_text: '12 Count', size_number: 12, size_unit: 'each', pack_text: null, pack_count: 1 }, { rawTitle: title, lineQuantity: 3 });
    expect(result).toMatchObject({ ok: true, sizeNumber: 12, unit: 'each', amount: 36 });
  });

  test('other count nouns (stations, cartridges, tablets, dunks, briquets) all normalize to each', () => {
    const cases = ['1 Station', '25 Cartridges', '6 Tablets', '2 Dunks', '10 Briquettes'];
    for (const text of cases) {
      const [, numberText] = text.match(/^(\d+)\s+/);
      const result = validateReading({ size_number: Number(numberText), size_unit: 'each', pack_count: 1 }, { rawTitle: `Some Product ${text}`, lineQuantity: 1 });
      expect(result).toMatchObject({ ok: true, unit: 'each' });
    }
  });
});

describe('containerAgreement — measured and count containers', () => {
  test('the per-unit size equals the container: the pack multiplies containers', () => {
    expect(containerAgreement(78, 2, 78)).toBe(156);
  });

  test('the whole pack together equals the container: the container is not multiplied again', () => {
    expect(containerAgreement(30, 4, 120)).toBe(120);
  });

  test('a count container ("12 count") agrees the same way a measured one does', () => {
    expect(containerAgreement(12, 1, 12)).toBe(12);
    expect(containerAgreement(6, 2, 12)).toBe(12); // 2 packs of 6 = one 12-count container... reversed direction still agrees
  });

  test('neither reading matches the container -> null (unsure)', () => {
    expect(containerAgreement(32, 1, 78)).toBeNull();
  });
});

describe('validateReading + conversions — "1.1 lb" and "17.6 oz" both agree with a "500 g" container within 1%', () => {
  const { convertInventoryQuantity } = require('../services/inventory-units');
  const CONTAINER_G = 500;

  test('1.1 lb converts to within 1% of 500 g', () => {
    const grams = convertInventoryQuantity(1.1, 'lb', 'g');
    expect(Math.abs(grams - CONTAINER_G) / CONTAINER_G).toBeLessThan(0.01);
  });

  test('17.6 oz converts to within 1% of 500 g', () => {
    const grams = convertInventoryQuantity(17.6, 'oz', 'g');
    expect(Math.abs(grams - CONTAINER_G) / CONTAINER_G).toBeLessThan(0.01);
  });
});

describe('classifyDecision — existing product', () => {
  const taurus = { id: 'p-taurus', name: 'Taurus SC', category: 'insecticide', container_size: '78 fl oz', inventory_unit: 'fl_oz' };

  test('a validated existing-product proposal logs the computed amount', () => {
    const raw = { kind: 'existing', product_id: 'p-taurus', reason: 'matches the candidate', reading: { size_text: '78 oz', size_number: 78, size_unit: 'oz', pack_count: 1 } };
    const decision = classifyDecision(raw, ctx({ rawTitle: 'Control Solutions Taurus SC Termiticide 78 oz', lineQuantity: 2, candidates: [taurus] }));
    expect(decision).toMatchObject({ kind: 'existing', status: 'logged', amount: 156, unit: 'fl_oz' });
  });

  test('a catalog container that counts boxes or packs never takes a single-item count', () => {
    const boxes = { id: 'p-boxes', name: 'Glue Board Refill', category: 'supplies', container_size: '12 boxes', inventory_unit: null };
    const raw = { kind: 'existing', product_id: 'p-boxes', reading: { size_text: '12 Count', size_number: 12, size_unit: 'each', pack_count: 1 } };
    const decision = classifyDecision(raw, ctx({ rawTitle: 'Glue Board Refill 12 Count', lineQuantity: 1, candidates: [boxes] }));
    expect(decision).toMatchObject({ kind: 'unsure', status: 'agent_unsure' });
    expect(decision.reason).toMatch(/counts box/);
  });

  test('container disagreement -> agent_unsure, never a guessed amount', () => {
    const raw = { kind: 'existing', product_id: 'p-taurus', reading: { size_text: '32 oz', size_number: 32, size_unit: 'oz', pack_count: 1 } };
    const decision = classifyDecision(raw, ctx({ rawTitle: 'Control Solutions Taurus SC Termiticide 32 oz', lineQuantity: 1, candidates: [taurus] }));
    expect(decision).toMatchObject({ kind: 'unsure', status: 'agent_unsure' });
  });

  test('a product_id outside the offered candidates is refused', () => {
    const raw = { kind: 'existing', product_id: 'p-other', reading: { size_text: '78 oz', size_number: 78, size_unit: 'oz', pack_count: 1 } };
    const decision = classifyDecision(raw, ctx({ rawTitle: 'Taurus SC 78 oz', candidates: [taurus] }));
    expect(decision).toMatchObject({ kind: 'unsure', status: 'agent_unsure' });
  });

  test('a count-container product ("12 count") applies the same agreement rule', () => {
    const trapProduct = { id: 'p-trap', name: 'Rat Trap', container_size: '12 count', inventory_unit: null };
    const raw = { kind: 'existing', product_id: 'p-trap', reading: { size_text: '12 Count', size_number: 12, size_unit: 'each', pack_count: 1 } };
    const decision = classifyDecision(raw, ctx({ rawTitle: 'Victor Rat Trap 12 Count', lineQuantity: 5, candidates: [trapProduct] }));
    expect(decision).toMatchObject({ kind: 'existing', status: 'logged', amount: 60, unit: 'each' });
  });

  test('no readable container_size at all: pack_count 1 sets a canonical container_size; a multi-pack is unsure instead', () => {
    const bare = { id: 'p-bare', name: 'No Size Product', container_size: null, inventory_unit: null };
    const single = classifyDecision(
      { kind: 'existing', product_id: 'p-bare', reading: { size_text: '78 oz', size_number: 78, size_unit: 'oz', pack_count: 1 } },
      ctx({ rawTitle: 'No Size Product 78 oz', lineQuantity: 1, candidates: [bare] }),
    );
    expect(single).toMatchObject({ kind: 'existing', status: 'logged', setContainerSize: '78 oz' });

    const multi = classifyDecision(
      { kind: 'existing', product_id: 'p-bare', reading: { size_text: '78 oz', size_number: 78, size_unit: 'oz', pack_text: 'Pack of 2', pack_count: 2 } },
      ctx({ rawTitle: 'No Size Product 78 oz (Pack of 2)', lineQuantity: 1, candidates: [bare] }),
    );
    expect(multi).toMatchObject({ kind: 'unsure', status: 'agent_unsure' });
  });

  test('no size in the title at all -> unsure (never a guessed amount, and never an alias)', () => {
    const decision = classifyDecision({ kind: 'existing', product_id: 'p-taurus', reading: null }, ctx({ rawTitle: 'Taurus SC Termiticide', candidates: [taurus] }));
    expect(decision).toMatchObject({ kind: 'unsure', status: 'agent_unsure' });
  });
});

describe('classifyDecision — new_product', () => {
  const allowedCategories = new Set(['insecticide', 'rodenticide']);

  test('a validated new-product proposal computes the container size, inventory unit and amount', () => {
    const raw = {
      kind: 'new_product', reason: 'not in the catalog',
      new_product: { name: 'Bifen XTS', category: 'insecticide', active_ingredient: 'Bifenthrin', epa_reg_no: null },
      reading: { size_text: '96 oz', size_number: 96, size_unit: 'oz', pack_count: 1 },
    };
    const decision = classifyDecision(raw, ctx({
      rawTitle: 'Control Solutions Bifen XTS Insecticide 96 oz', lineQuantity: 1, allActiveProducts: [], allowedCategories,
    }));
    expect(decision).toMatchObject({
      kind: 'new_product', status: 'logged', amount: 96, unit: 'oz',
      newProduct: { name: 'Bifen XTS', category: 'insecticide', containerSize: '96 oz', inventoryUnit: 'oz', activeIngredient: 'Bifenthrin' },
    });
  });

  test('a liquid size derives inventory_unit fl_oz even when the title reads gallons', () => {
    const raw = { kind: 'new_product', new_product: { name: 'New Liquid', category: 'insecticide', active_ingredient: null, epa_reg_no: null },
      reading: { size_text: '1 gal', size_number: 1, size_unit: 'gal', pack_count: 1 } };
    const decision = classifyDecision(raw, ctx({ rawTitle: 'New Liquid 1 gal', allowedCategories }));
    expect(decision).toMatchObject({ newProduct: { inventoryUnit: 'fl_oz' } });
  });

  test('a name that equals, contains, or is contained by an existing active product\'s name -> unsure', () => {
    const raw = { kind: 'new_product', new_product: { name: 'Taurus SC Termiticide', category: 'insecticide', active_ingredient: null, epa_reg_no: null },
      reading: { size_text: '78 oz', size_number: 78, size_unit: 'oz', pack_count: 1 } };
    const decision = classifyDecision(raw, ctx({
      rawTitle: 'Taurus SC Termiticide 78 oz', allowedCategories, allActiveProducts: [{ id: 'p-taurus', name: 'Taurus SC' }],
    }));
    expect(decision).toMatchObject({ kind: 'unsure', status: 'agent_unsure' });
  });

  test('the title containing an active product\'s name as whole words -> unsure, even with a differently-named proposal', () => {
    const raw = { kind: 'new_product', new_product: { name: 'Bug-B-Gon Ready Spray', category: 'insecticide', active_ingredient: null, epa_reg_no: null },
      reading: { size_text: '32 oz', size_number: 32, size_unit: 'oz', pack_count: 1 } };
    const decision = classifyDecision(raw, ctx({
      rawTitle: 'Ortho Bug-B-Gon Ready Spray 32 oz', allowedCategories, allActiveProducts: [{ id: 'p-ortho', name: 'Ortho' }],
    }));
    expect(decision).toMatchObject({ kind: 'unsure', status: 'agent_unsure' });
  });

  test('a category outside the allowed set -> unsure', () => {
    const raw = { kind: 'new_product', new_product: { name: 'New Chemical', category: 'made up category', active_ingredient: null, epa_reg_no: null },
      reading: { size_text: '32 oz', size_number: 32, size_unit: 'oz', pack_count: 1 } };
    const decision = classifyDecision(raw, ctx({ rawTitle: 'New Chemical 32 oz', allowedCategories }));
    expect(decision).toMatchObject({ kind: 'unsure', status: 'agent_unsure' });
  });

  test('the EPA reg number is read from the TITLE by regex, never trusted from the model\'s own field', () => {
    const raw = { kind: 'new_product', new_product: { name: 'New Chemical', category: 'insecticide', active_ingredient: null, epa_reg_no: '99999-99999' },
      reading: { size_text: '78 oz', size_number: 78, size_unit: 'oz', pack_count: 1 } };
    // The model's echoed epa_reg_no ('99999-99999') is NOT in the title, so it's discarded.
    const decision = classifyDecision(raw, ctx({ rawTitle: 'New Chemical 78 oz. (QGCY) EPA# - 53883-279', allowedCategories }));
    expect(decision.newProduct.epaRegNumber).toBe('53883-279');
  });

  test('a matched line (needs_size/size_mismatch already found a real product) refuses new_product outright — never forks the catalog', () => {
    const raw = { kind: 'new_product', new_product: { name: 'Bifen XTS', category: 'insecticide', active_ingredient: null, epa_reg_no: null },
      reading: { size_text: '96 oz', size_number: 96, size_unit: 'oz', pack_count: 1 } };
    const decision = classifyDecision(raw, ctx({ rawTitle: 'Bifen XTS Insecticide 96 oz', allowedCategories, matchedProductId: 'p-existing' }));
    expect(decision).toMatchObject({ kind: 'unsure', status: 'agent_unsure' });
  });
});

describe('classifyDecision — the agent may only confirm the deterministic match, never substitute', () => {
  const taurus = { id: 'p-taurus', name: 'Taurus SC', container_size: '78 fl oz', inventory_unit: 'fl_oz' };
  const other = { id: 'p-other', name: 'Other Product', container_size: '78 fl oz', inventory_unit: 'fl_oz' };

  test('a needs_size/size_mismatch line whose LLM picks a DIFFERENT candidate than the catalog match -> unsure', () => {
    const raw = { kind: 'existing', product_id: 'p-other', reading: { size_text: '78 oz', size_number: 78, size_unit: 'oz', pack_count: 1 } };
    const decision = classifyDecision(raw, ctx({
      rawTitle: 'Taurus SC Termiticide 78 oz', lineQuantity: 1, candidates: [taurus, other], matchedProductId: 'p-taurus',
    }));
    expect(decision).toMatchObject({ kind: 'unsure', status: 'agent_unsure' });
  });

  test('naming the SAME matched product back still validates normally', () => {
    const raw = { kind: 'existing', product_id: 'p-taurus', reading: { size_text: '78 oz', size_number: 78, size_unit: 'oz', pack_count: 1 } };
    const decision = classifyDecision(raw, ctx({
      rawTitle: 'Taurus SC Termiticide 78 oz', lineQuantity: 1, candidates: [taurus, other], matchedProductId: 'p-taurus',
    }));
    expect(decision).toMatchObject({ kind: 'existing', status: 'logged', amount: 78 });
  });
});

describe('classifyDecision — equipment / not_stock / unsure routing', () => {
  test('not_stock -> agent_ignored (no bell — sweep.js\'s HELD_REASONS convention)', () => {
    expect(classifyDecision({ kind: 'not_stock', reason: 'a laptop, not stock' }, ctx())).toEqual({ kind: 'not_stock', status: 'agent_ignored', reason: 'a laptop, not stock' });
  });

  test('equipment -> agent_equipment', () => {
    expect(classifyDecision({ kind: 'equipment', reason: 'a backpack sprayer' }, ctx())).toEqual({ kind: 'equipment', status: 'agent_equipment', reason: 'a backpack sprayer' });
  });

  test('an explicit "unsure" kind, or an unrecognized kind, both land on agent_unsure', () => {
    expect(classifyDecision({ kind: 'unsure', reason: 'not confident' }, ctx())).toEqual({ kind: 'unsure', status: 'agent_unsure', reason: 'not confident' });
    expect(classifyDecision({ kind: 'something_else' }, ctx())).toMatchObject({ kind: 'unsure', status: 'agent_unsure' });
  });
});

describe('extractEpaRegNumber / canonicalSizeText / inventoryUnitForNewProduct', () => {
  test('extracts a real EPA# from vendor description text', () => {
    expect(extractEpaRegNumber('CSI-Pest Taurus SC 78 fl oz. Bottle (QGCY) UOM:EA EPA# - 53883-279')).toBe('53883-279');
    expect(extractEpaRegNumber('No EPA number here')).toBeNull();
  });

  test('canonicalSizeText formats a number + unit for display/storage', () => {
    expect(canonicalSizeText(78, 'fl_oz')).toBe('78 fl oz');
    expect(canonicalSizeText(1.5, 'lb')).toBe('1.5 lb');
  });

  test('inventoryUnitForNewProduct: volume -> fl_oz, weight -> its own unit, count -> each', () => {
    expect(inventoryUnitForNewProduct('gal')).toBe('fl_oz');
    expect(inventoryUnitForNewProduct('fl_oz')).toBe('fl_oz');
    expect(inventoryUnitForNewProduct('lb')).toBe('lb');
    expect(inventoryUnitForNewProduct('g')).toBe('g');
    expect(inventoryUnitForNewProduct('each')).toBe('each');
  });
});

describe('recordAttemptFailure — attempts, then hands off to a person (LLM failures AND apply-time throws alike)', () => {
  // A minimal hand-rolled transaction mock, scoped to exactly what
  // recordAttemptFailure touches (see the file header for why the full
  // apply path is a Postgres suite instead).
  function makeLineConn(initialLine) {
    let line = { ...initialLine };
    const trx = (table) => {
      expect(table).toBe('purchase_receipt_lines');
      const q = {};
      q.where = () => q;
      q.forUpdate = () => q;
      q.first = async () => ({ ...line });
      q.update = async (fields) => { line = { ...line, ...fields }; return 1; };
      return q;
    };
    trx.transaction = async (cb) => cb(trx);
    return { conn: trx, getLine: () => line };
  }

  test('the first two failures just increment agent_attempts, no bell', async () => {
    const { conn, getLine } = makeLineConn({ id: 'line-1', status: 'agent_pending', agent_attempts: 0, raw_title: 'Chromebook', email_id: 'email-1' });
    const notify = jest.fn(async () => {});
    expect(await recordAttemptFailure(conn, 'line-1', notify, 'llm_unavailable')).toEqual({ status: 'still_pending' });
    expect(getLine()).toMatchObject({ status: 'agent_pending', agent_attempts: 1 });
    expect(await recordAttemptFailure(conn, 'line-1', notify, 'llm_unavailable')).toEqual({ status: 'still_pending' });
    expect(getLine()).toMatchObject({ status: 'agent_pending', agent_attempts: 2 });
    expect(notify).not.toHaveBeenCalled();
  });

  test('the 3rd LLM failure hands the line to a person: agent_unsure + one bell', async () => {
    const { conn, getLine } = makeLineConn({ id: 'line-1', status: 'agent_pending', agent_attempts: 2, raw_title: 'Chromebook', email_id: 'email-1' });
    const notify = jest.fn(async () => {});
    const result = await recordAttemptFailure(conn, 'line-1', notify, 'llm_unavailable');
    expect(result).toEqual({ status: 'agent_unsure' });
    expect(getLine()).toMatchObject({ status: 'agent_unsure', agent_attempts: 3, agent_decision: { kind: 'unsure', reason: 'llm_unavailable' } });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toBe('inventory');
    expect(notify.mock.calls[0][3]).toMatchObject({ bell: true, dedupeKey: 'purchase-receipt:line-1' });
  });

  test('an apply-time throw (createCatalogProduct error, adjustStock conversion error, …) counts the SAME way: the 3rd hands off with the error as the reason', async () => {
    const { conn, getLine } = makeLineConn({ id: 'line-1', status: 'agent_pending', agent_attempts: 2, raw_title: 'Chromebook', email_id: 'email-1' });
    const notify = jest.fn(async () => {});
    // runInventoryAgent's own catch calls this with err.message — simulated
    // directly here since triggering a REAL applyDecision throw needs a
    // live Postgres transaction (covered in inventory-agent-postgres.test.js).
    const result = await recordAttemptFailure(conn, 'line-1', notify, 'Cannot convert fl_oz to inventory unit each');
    expect(result).toEqual({ status: 'agent_unsure' });
    expect(getLine()).toMatchObject({ agent_decision: { kind: 'unsure', reason: 'Cannot convert fl_oz to inventory unit each' } });
    expect(notify.mock.calls[0][2]).toMatch(/Cannot convert fl_oz to inventory unit each/);
  });

  test('a line no longer agent_pending (already resolved by another run) is left alone', async () => {
    const { conn, getLine } = makeLineConn({ id: 'line-1', status: 'logged', agent_attempts: 0 });
    const notify = jest.fn(async () => {});
    expect(await recordAttemptFailure(conn, 'line-1', notify, 'llm_unavailable')).toEqual({ status: 'no_longer_pending' });
    expect(getLine().status).toBe('logged');
    expect(notify).not.toHaveBeenCalled();
  });
});
