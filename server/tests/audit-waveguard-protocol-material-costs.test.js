jest.mock('../models/db', () => jest.fn(() => { throw new Error('Unexpected database access in calculation test'); }));

const { analyzeVisit, buildCadenceReport } = require('../scripts/audit-waveguard-protocol-material-costs');
const { LAWN_MATERIAL_BUDGETS } = require('@waves/lawn-cost-floor');

const product = {
  id: 'synthetic-fertilizer', name: 'Synthetic Fertilizer', aliases: [],
  default_rate_per_1000: 2, rate_unit: 'lb', cost_per_unit: 3, cost_unit: 'lb',
};
const visit = {
  visit: 1, month: 'Jan', primary: 'Synthetic Fertilizer', secondary: '',
  material_cost: 60, conditional_cost: 4,
  tiers: { bronze: true, enhanced: true, premium: true },
};

function reportFor(visits, products = [product]) {
  return buildCadenceReport(products, { st_augustine: { name: 'St. Augustine', visits } });
}

test('catalog quantity cost scales to 4500 sqft and annualizes the sold count, not flagged windows', () => {
  const before = JSON.stringify(LAWN_MATERIAL_BUDGETS);
  const result = reportFor(Array.from({ length: 12 }, (_, index) => ({ ...visit, visit: index + 1 })));
  const nine = result.rows.find((row) => row.applications === 9);
  // 2 lb/1K * 4.5K * $3/lb * 9 applications = $243.
  expect(nine.catalogSelectedAnnual).toBe(243);
  expect(nine.flaggedCalendarSlots).toBe(12);
  // Scheduled $60/10K * .45 + reserve $4/4.5K = $31 per application.
  expect(nine.reconstructedStaticAnnualAllowance).toBe(279);
  expect(nine.budgetMinusStaticAllowance).toBe(-97);
  expect(nine.catalogCalculationComplete).toBe(true);
  expect(result.supplierCostsVerified).toBe(false);
  expect(result.operatingLayerVerified).toBe(false);
  expect(JSON.stringify(LAWN_MATERIAL_BUDGETS)).toBe(before);
});

test('unmatched treatment without a dollar annotation makes the annual calculation incomplete', () => {
  const row = reportFor([{ ...visit, primary: 'Unlisted Nutrient Blend' }]).rows[0];
  expect(row.catalogSelectedAnnual).toBeNull();
  expect(row.catalogCalculationComplete).toBe(false);
  expect(row.issues).toContainEqual(expect.objectContaining({ reason: 'unmatched_product' }));
});

test.each([
  'Synthetic Fertilizer + Secondary Blend ($3+$1)',
  'Synthetic Fertilizer ($3) + Secondary Blend ($1)',
  'Synthetic Fertilizer + NIS',
])('a combined line remains incomplete even when the matcher finds a priced product: %s', (primary) => {
  const row = reportFor([{ ...visit, primary }], [product, { ...product, id: 'synthetic-secondary', name: 'Secondary Blend' }]).rows[0];
  expect(row.catalogSelectedSubtotal).toBeGreaterThan(0);
  expect(row.catalogSelectedAnnual).toBeNull();
  expect(row.issues).toContainEqual(expect.objectContaining({ reason: 'combined_products_unresolved', line: primary }));
});

test('a numeric combination inside a product annotation does not become a combined-material issue', () => {
  const row = reportFor([{ ...visit, primary: 'Synthetic Fertilizer (FRAC 11+3)' }]).rows[0];
  expect(row.catalogSelectedAnnual).toBe(162);
  expect(row.issues).toEqual([]);
});

test.each(['Synthetic Macro + Micro ($3)', 'MACRO + MICRO ($3)'])(
  'a plus belonging to the matched canonical name or alias is one product: %s', (primary) => {
    const combinedName = { ...product, name: 'Synthetic Macro + Micro', aliases: ['Macro', 'Macro + Micro'] };
    const row = reportFor([{ ...visit, primary }], [combinedName]).rows[0];
    expect(row.catalogSelectedAnnual).toBe(162);
    expect(row.issues).toEqual([]);
  },
);

test('a canonical plus name followed by another ingredient still remains incomplete', () => {
  const combinedName = { ...product, name: 'Synthetic Macro + Micro', aliases: ['Macro', 'Macro + Micro'] };
  const row = reportFor([{ ...visit, primary: 'Macro + Micro + NIS ($3)' }], [combinedName]).rows[0];
  expect(row.catalogSelectedAnnual).toBeNull();
  expect(row.issues).toContainEqual(expect.objectContaining({ reason: 'combined_products_unresolved' }));
});

test.each([
  [{ default_rate_per_1000: null }, 'missing_rate'],
  [{ cost_per_unit: null, best_price: null }, 'missing_cost'],
  [{ needs_pricing: true }, 'needs_pricing'],
  [{ cost_per_unit: 0 }, 'missing_inventory_price'],
  [{ cost_per_unit: 0, best_price: 30, container_size: '10 lb' }, 'missing_cost'],
  [{ cost_unit: null }, 'unverified_cost_units'],
  [{ cost_unit: 'gal' }, 'unverified_cost_units'],
  [{ rate_unit: 'g', cost_unit: 'lb bag' }, 'unverified_cost_units'],
  [{ rate_unit: 'lb bag', cost_unit: 'lb' }, 'unverified_cost_units'],
  [{ rate_unit: 'oz', cost_unit: 'oz' }, 'unverified_cost_units'],
])('does not turn missing rate or price evidence into a complete $0 budget: %j', (patch, reason) => {
  const row = reportFor([visit], [{ ...product, ...patch }]).rows[0];
  expect(row.catalogSelectedAnnual).toBeNull();
  expect(row.issues).toContainEqual(expect.objectContaining({ reason }));
});

test('a priced partial subtotal is retained for investigation but not presented as a complete annual cost', () => {
  const row = reportFor([{ ...visit, primary: 'Synthetic Fertilizer\nUnlisted Nutrient Blend' }]).rows[0];
  expect(row.catalogSelectedSubtotal).toBe(162);
  expect(row.catalogSelectedAnnual).toBeNull();
});

test('explicit fluid-ounce catalog units remain verified when stored with underscores', () => {
  const row = reportFor([visit], [{ ...product, rate_unit: 'fl_oz', cost_unit: 'fl_oz' }]).rows[0];
  expect(row.catalogSelectedAnnual).toBe(162);
  expect(row.issues).toEqual([]);
});

test('premium-only work is excluded from standard/enhanced and included only in premium', () => {
  const result = reportFor([{ ...visit, primary: 'Premium only Synthetic Fertilizer ($60)' }]);
  expect(result.rows.map((row) => row.catalogSelectedAnnual)).toEqual([0, 0, 324]);
});

test('unselected rescue products are not silently included in the annual selected subtotal', () => {
  const row = reportFor([{ ...visit, secondary: 'Rescue Fungicide if active disease ($80)' }]).rows[0];
  expect(row.catalogSelectedAnnual).toBe(162);
  expect(row.visits[0].items.find((item) => item.raw.includes('Rescue')).selected).toBe(false);
});

test('missing calendar and missing static allowance remain explicit', () => {
  const empty = reportFor([]).rows[0];
  expect(empty.catalogSelectedAnnual).toBeNull();
  expect(empty.reconstructedStaticAnnualAllowance).toBeNull();
  expect(empty.issues).toContainEqual({ reason: 'missing_calendar' });
  for (const field of ['material_cost', 'conditional_cost']) {
    const missing = reportFor([{ ...visit, [field]: null }]).rows[0];
    expect(missing.reconstructedStaticAnnualAllowance).toBeNull();
    expect(missing.budgetMinusStaticAllowance).toBeNull();
    expect(missing.catalogSelectedAnnual).toBeNull();
    expect(missing.catalogCalculationComplete).toBe(false);
    expect(missing.issues).toContainEqual({ reason: 'missing_static_allowance' });
  }
});

test('the legacy visit comparison scales both sides to the requested lawn size and preserves unknowns', () => {
  const result = analyzeVisit({ trackKey: 'st_augustine', track: {}, visit, products: [product],
    options: {}, lawnSqft: 4500 });
  expect(result.inventoryMaterialCost).toBe(27);
  expect(result.legacyMaterialCost).toBe(27);
  expect(result.variance).toBe(0);
  const missing = analyzeVisit({ trackKey: 'st_augustine', track: {}, visit: { ...visit, material_cost: null },
    products: [product], options: {}, lawnSqft: 4500 });
  expect(missing.legacyMaterialCost).toBeNull();
  expect(missing.variance).toBeNull();
});
