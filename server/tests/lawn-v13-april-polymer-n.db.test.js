// Lawn protocol v13 April step on the 12x plan: LESCO 44-0-0 100% PolyPlus OPTI120 at 2.27 lb per 1,000 sq ft
// (1.0 lb N), migration 20261022195000, owner 2026-10-22. Synthetic data only.
//
// Pinned: the recipe and the staged row agree; the 9x Dimension row and its 0.5 lb N target are untouched; the
// catalog row is inserted once (a row that matches in any state makes up throw and write nothing),
// with NO price written; the plan derives 2.2727 lb from the 1.0 lb N target and shows no cost while the bag is
// unpriced; North Port still blocks the nitrogen from April 1; down is all or nothing: a full no-op when any v13
// protocol is referenced or any April row was edited, an exact restore otherwise, and the catalog row goes only
// when unchanged, unpriced and unused.
const { createLawnHistoryDb } = require('./helpers/lawn-history-db');
const engine = require('../services/waveguard-plan-engine');
const v13Recipe = require('../config/lawn-protocol-v13.json');
const migration = require('../models/migrations/20261022195000_lawn_v13_april_polymer_n_v3');
const staged = require('../models/migrations/20261005120000_lawn_protocol_v13_staged');
const { visitForCadence } = require('../services/lawn-program');
const { validateRule } = require('../services/service-report/lawn-watering-rule');
const { approvedReportProductFacts } = require('../services/service-report/report-data');

const F24 = migration.OLD_NAME;
const F44 = migration.NEW_NAME;
const DIM = 'LESCO Dimension 0.21% 18-0-10 50% PolyPlus OPTI45 MOP Pre-Emergent Plus Fertilizer';
const V13 = staged.V13_VERSION;
const KEYS = ['fixture_apr_a', 'fixture_apr_b'];
const APR = migration.APRIL_WINDOW;
const NOV = 'nov_v13_spreader_feeding';
const APRIL_GATES = { targetN: '0.5 lb N/1000', blackoutSensitive: true, northPortBlocked: true, fertilizerSafety: true, planVisitsPerYear: 12 };
const NINE_GATES = { ...APRIL_GATES, planVisitsPerYear: 9 };
const CATALOG_TABLES = ['products_catalog', 'product_aliases', 'lawn_protocols', 'lawn_protocol_windows', 'lawn_protocol_products',
  'lawn_protocol_audit_log', 'lawn_protocol_service_completions', 'product_limits'];
const PRICES = ['best_price', 'best_vendor', 'cost_per_unit', 'cost_unit', 'best_vendor_pricing_id', 'best_price_amount_cached'];
const aprilVisit = () => v13Recipe.st_augustine.visits.find((v) => v.month === 'Apr');

describe('April 44-0-0 polymer bag: the recipe and the catalog spec (no database)', () => {
  const { CATALOG } = migration;

  test('the figures: 2.27 lb of a 44% bag is 1.0 lb N (0.9988); the plan derives 2.2727 lb; the 12x year gains 0.5 lb N and stays under 4', () => {
    expect(migration.APRIL_RATE).toBe(2.27);
    expect(migration.APRIL_RATE * (CATALOG.analysis_n / 100)).toBeCloseTo(1, 2);
    expect(1 / (CATALOG.analysis_n / 100)).toBeCloseTo(2.2727, 4);
    expect(CATALOG.analysis_p + CATALOG.analysis_k).toBe(0);
    // All of the nitrogen is polymer coated: above the 50% slow-release minimum of every county row.
    expect(CATALOG.slow_release_n_pct).toBe(100);
    const year = [0, 0.75, 0, 1.0, 0, 0, 0, 0, 0, 0.73, 0.75, 0.45].reduce((a, b) => a + b, 0);
    expect(Number(year.toFixed(2))).toBe(3.68);
    expect(year).toBeLessThan(4);
  });

  test('the catalog spec: a fertilizer with no EPA number and no price field, approved with plain copy', () => {
    expect(CATALOG).toMatchObject({
      name: F44, category: 'fertilizer', product_type: 'fertilizer', formulation: 'granular', container_size: '50 lb', unit_size_oz: 800,
      siteone_sku: '511333', epa_reg_number: 'N/A', analysis_n: 44, analysis_p: 0, analysis_k: 0, default_rate_per_1000: 2.27, rate_unit: 'lb',
      approved_for_service_report: true,
    });
    for (const field of ['best_price', 'best_vendor', 'cost_per_unit', 'cost_unit', 'needs_pricing', 'label_verified_at', 'label_version']) expect(CATALOG).not.toHaveProperty(field);
    expect(migration.INSERT_DEFAULTS).toEqual({ active: true, needs_pricing: true, content_status: 'draft', customer_visibility: 'internal_only' });
    expect(CATALOG.name.length).toBeLessThanOrEqual(150);
    expect(CATALOG.display_name.length).toBeLessThanOrEqual(80);
    expect(CATALOG.label_source_note).toMatch(/not read/);
    expect(CATALOG.service_report_summary).toBe(migration.SUMMARY);
  });

  test('the watering rule is valid, owner-sourced and the 24-0-11 amount (0.25 inch within 24 hours)', () => {
    const checked = validateRule(migration.WATERING_RULE);
    expect(checked.errors).toEqual([]);
    expect(checked.rule).toMatchObject({ mode: 'water_in', water_in_inches: 0.25, water_in_by_hours: 24, source: 'owner' });
    expect(migration.WATERING).toEqual([{ name: F44, rule: migration.WATERING_RULE }]);
    // The watering-coverage fixture (every program mix gets a text) carries the same rule for the new name.
    const { mode, water_in_inches: inches, water_in_by_hours: hours, source } = migration.WATERING_RULE;
    expect(require('./fixtures/lawn-watering-rules-v13-2026-10-22.json')[F44]).toEqual({ mode, water_in_inches: inches, water_in_by_hours: hours, source });
  });

  test('the report freezes the product as a fertilizer with its watering rule and customer copy', () => {
    const facts = approvedReportProductFacts({ ...CATALOG, post_application_watering: migration.WATERING_RULE });
    expect(facts).toMatchObject({ productType: 'fertilizer', name: F44, epaRegNumber: null, serviceReportSummary: migration.SUMMARY, precautionSummary: migration.PRECAUTION });
    expect(facts.wateringRule).toMatchObject({ mode: 'water_in', water_in_inches: 0.25, water_in_by_hours: 24 });
  });

  test('customer-report wording treats it as a fertilizer, never a pre-emergent', () => {
    const { classifyProduct } = require('../services/service-report/lawn-report-v2');
    const { buildTreatmentSummary } = require('../services/service-report/treatment-summary');
    expect(classifyProduct({ product: { name: F44, category: CATALOG.category, active_ingredient: CATALOG.active_ingredient } }).kind).toBe('fertilizer');
    const summary = buildTreatmentSummary({ products: [{ name: F44, activeIngredient: CATALOG.active_ingredient, kind: 'fertilizer', method: 'broadcast' }] });
    expect(summary).toBe('Today we applied polymer-coated nitrogen fertilizer.');
    expect(summary).not.toMatch(/pre-?emergent|prodiamine|dithiopyr/i);
  });

  test('the bundled pricing import has the row under the catalog name with no price, and nothing else spells it', () => {
    const { parse } = require('csv-parse/sync');
    const rows = parse(require('fs').readFileSync(require('path').join(__dirname, '../data/pricing.csv'), 'utf8'), { columns: true, skip_empty_lines: true, relax_column_count: true });
    const hits = rows.filter((row) => /44-0-0/.test(row.Product));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ Product: F44, Vendor: 'SiteOne', Size: '50 lb', Price: '', 'Unit Price': '', Category: 'Fertilizer' });
  });

  test('every track: the April line names the catalog row exactly, states 2.27 lb and 1.0 lb N, and the notes say it lasts into July', () => {
    for (const grass of Object.keys(v13Recipe)) {
      const april = v13Recipe[grass].visits.find((v) => v.month === 'Apr');
      expect(april.primary).toBe(`${F44} — 2.27 lb per 1,000 sq ft (1.0 lb N), spreader`);
      expect(engine.parseVisitNutrientTargets(april.notes).targetNPer1000).toBe(1);
      expect(april.notes).toMatch(/100% polymer-coated/);
      expect(april.notes).toMatch(/releases over about 3 to 4 months/);
      expect(april.notes).toMatch(/June 1 to Sept 30 nitrogen ban/);
      expect(april.notes).toMatch(/Fertilizer safety: deflector on, 10 ft water band kept/);
      expect(april.notes).not.toMatch(/24-0-11/);
    }
  });

  test('the 9x plan April step is unchanged: Dimension 18-0-10, 2.78 lb, 0.5 lb N, read from its own notes', () => {
    for (const grass of Object.keys(v13Recipe)) {
      const april = v13Recipe[grass].visits.find((v) => v.month === 'Apr');
      expect(Object.keys(april.cadenceVariants)).toEqual(['9']);
      expect(april.cadenceVariants['9'].primary).toBe(`${DIM} — 2.78 lb per 1,000 sq ft (0.5 lb N), spreader`);
      const nine = visitForCadence(april, 9).visit;
      expect(engine.parseVisitNutrientTargets(nine.notes).targetNPer1000).toBe(0.5);
      expect(engine.parseVisitNutrientTargets(visitForCadence(april, 12).visit.notes).targetNPer1000).toBe(1);
    }
  });

  test('February and November keep the 24-0-11 at 0.75 lb N', () => {
    for (const month of ['Feb', 'Nov']) {
      const visit = v13Recipe.st_augustine.visits.find((v) => v.month === month);
      expect(visit.primary).toBe('LESCO 24-0-11 with PolyPlus OPTI — 3.1 lb per 1,000 sq ft (0.75 lb N), spreader');
    }
  });

  test('North Port: the nitrogen block (N from April 1) reads the new bag as it read the 24-0-11; the county window opens June 1; the row keeps its northPortBlocked gate', () => {
    const northPort = { jurisdiction_name: 'North Port', restricted_nitrogen: true, restricted_phosphorus: true, restricted_start_month: 4, restricted_start_day: 1, restricted_end_month: 9, restricted_end_day: 30 };
    const county = { jurisdiction_name: 'Sarasota County', restricted_nitrogen: true, restricted_phosphorus: true, restricted_start_month: 6, restricted_start_day: 1, restricted_end_month: 9, restricted_end_day: 30 };
    const bag = { product: { id: 'f44', name: F44, analysis_n: CATALOG.analysis_n, analysis_p: 0, analysis_k: 0 } };
    const old = { product: { id: 'f24', name: F24, analysis_n: 24, analysis_p: 0, analysis_k: 11 } };
    const april = new Date('2027-04-15T16:00:00Z');
    for (const item of [bag, old]) {
      expect(engine.summarizeOrdinanceStatus({ date: april, ordinances: [northPort], candidateItems: [item] }).blocks.map((b) => b.code)).toEqual(['nitrogen_blackout']);
      expect(engine.summarizeOrdinanceStatus({ date: april, ordinances: [county], candidateItems: [item] }).blocks).toEqual([]);
    }
    expect(engine.v13GateNotes(APRIL_GATES, { municipality: 'North Port' }).map((n) => n.key)).toContain('northPortBlocked');
    expect(engine.v13GateNotes(APRIL_GATES, { municipality: 'Parrish' }).map((n) => n.key)).not.toContain('northPortBlocked');
  });
});

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

describeDb('v13 April 44-0-0 migration through PostgreSQL', () => {
  let owned;
  let knex;
  const ids = {};

  beforeAll(async () => {
    owned = await createLawnHistoryDb(); knex = owned.knex;
    for (const table of [...CATALOG_TABLES, 'service_products']) {
      await knex.raw('CREATE TABLE ??.?? (LIKE public.?? INCLUDING ALL)', [owned.schema, table, table]);
      const columns = await knex(table).columnInfo();
      if (String(columns.id?.defaultValue || '').includes('nextval(')) {
        await knex.raw('ALTER TABLE ??.?? ALTER COLUMN id DROP DEFAULT', [owned.schema, table]);
        await knex.raw('ALTER TABLE ??.?? ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY', [owned.schema, table]);
      }
    }
    // LIKE copies no foreign keys; the product reference check reads them.
    await knex.raw('ALTER TABLE ??.product_limits ADD CONSTRAINT fixture_limits_product FOREIGN KEY (product_id) REFERENCES ??.products_catalog (id)', [owned.schema, owned.schema]);
    await knex.raw('ALTER TABLE ??.service_products ADD CONSTRAINT fixture_sp_product FOREIGN KEY (product_id) REFERENCES ??.products_catalog (id) ON DELETE SET NULL', [owned.schema, owned.schema]);
    await knex.raw('ALTER TABLE ??.lawn_protocol_audit_log ALTER COLUMN lawn_protocol_id DROP NOT NULL', [owned.schema]).catch(() => {});
  }, 60000);
  afterAll(async () => { if (owned) await owned.dispose(); });

  const newRow = () => knex('products_catalog').where({ name: F44 }).first();
  const aprilRows = (name) => knex('lawn_protocol_products as p')
    .join('lawn_protocol_windows as w', 'p.lawn_protocol_window_id', 'w.id')
    .join('lawn_protocols as l', 'w.lawn_protocol_id', 'l.id')
    .where({ 'w.window_key': APR, 'p.product_name': name })
    .orderBy('l.protocol_key').select('p.*', 'l.protocol_key');
  const novemberRows = () => knex('lawn_protocol_products as p').join('lawn_protocol_windows as w', 'p.lawn_protocol_window_id', 'w.id').where({ 'w.window_key': NOV }).select('p.*');
  const ours = () => knex('lawn_protocol_audit_log').whereIn('action', [migration.ACTION, migration.CATALOG_ACTION]);
  const strip = (rows) => rows.map(({ updated_at: _u, ...rest }) => rest);
  const snapshot = async () => ({
    products: strip(await knex('lawn_protocol_products').orderBy('id')),
    catalog: strip(await knex('products_catalog').orderBy('id')),
    audit: (await knex('lawn_protocol_audit_log').orderBy('id')).map(({ id: _i, created_at: _c, ...rest }) => rest),
  });

  // A clean fixture: the catalog as main leaves it (24-0-11 and Dimension), two v13 protocols with their April windows.
  async function reset() {
    for (const table of ['service_products', 'product_limits', 'lawn_protocol_audit_log', 'lawn_protocol_products', 'lawn_protocol_windows',
      'lawn_protocol_service_completions', 'lawn_protocols', 'product_aliases', 'products_catalog']) await knex(table).del();
    await knex('scheduled_services').update({ lawn_protocol_key: null, lawn_protocol_version: null });
    const [f24] = await knex('products_catalog').insert({ name: F24, category: 'fertilizer', formulation: 'granular', analysis_n: 24, analysis_p: 0, analysis_k: 11, default_rate_per_1000: 4.2, rate_unit: 'lb', active: true }).returning('*');
    const [dim] = await knex('products_catalog').insert({ name: DIM, category: 'herbicide', formulation: 'granular', analysis_n: 18, analysis_p: 0, analysis_k: 10, active: true }).returning('*');
    ids.f24 = f24.id; ids.dim = dim.id;
    for (const key of KEYS) {
      await knex('lawn_protocols').insert({ protocol_key: key, version: '2026.06', name: 'Fixture old', status: 'active', grass_track: 'bermuda', region: 'swfl' });
      const [protocol] = await knex('lawn_protocols').insert({ protocol_key: key, version: V13, name: 'Fixture v13', status: 'staged', grass_track: 'bermuda', region: 'swfl', effective_from: '2000-01-01' }).returning('*');
      const [apr] = await knex('lawn_protocol_windows').insert({ lawn_protocol_id: protocol.id, month: 4, window_key: APR, title: APR, visit_type: 'granular_production_plus_spots', production_mode: 'spreader_plus_spot_backpack', goal: 'One spreader feeding.' }).returning('*');
      const [nov] = await knex('lawn_protocol_windows').insert({ lawn_protocol_id: protocol.id, month: 11, window_key: NOV, title: NOV, visit_type: 'fixture', production_mode: 'spreader_plus_spot_backpack', goal: 'November fixture' }).returning('*');
      await knex('lawn_protocol_products').insert([
        { lawn_protocol_window_id: apr.id, product_id: f24.id, product_name: F24, role: 'nutrition', application_mode: 'broadcast', rate_unit: 'lb_n', default_in_plan: true, sort_order: 30, gates: JSON.stringify(APRIL_GATES) },
        { lawn_protocol_window_id: apr.id, product_id: dim.id, product_name: DIM, role: 'nutrition', application_mode: 'broadcast', rate_unit: 'lb_n', default_in_plan: true, sort_order: 31, gates: JSON.stringify(NINE_GATES) },
        // November carries a 24-0-11 row too (a fixture decoy): the migration reads the April window only.
        { lawn_protocol_window_id: nov.id, product_id: f24.id, product_name: F24, role: 'nutrition', application_mode: 'broadcast', rate_unit: 'lb_n', default_in_plan: true, sort_order: 40, gates: JSON.stringify({ targetN: '0.75 lb N/1000' }) },
      ]);
    }
  }

  describe('fresh path: the catalog has no 44-0-0 row', () => {
    beforeAll(async () => { await reset(); await migration.up(knex); });

    test('one catalog row is inserted, with no price field, pending pricing, and approved for the report', async () => {
      const rows = await knex('products_catalog').where({ name: F44 });
      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row).toMatchObject({
        category: 'fertilizer', product_type: 'fertilizer', formulation: 'granular', container_size: '50 lb', siteone_sku: '511333', epa_reg_number: 'N/A',
        rate_unit: 'lb', active: true, needs_pricing: true, content_status: 'draft', customer_visibility: 'internal_only',
        approved_for_service_report: true, public_summary: migration.SUMMARY, service_report_summary: migration.SUMMARY, customer_precaution_summary: migration.PRECAUTION,
        display_name: 'LESCO 44-0-0 Turf Fertilizer',
      });
      expect([row.analysis_n, row.analysis_p, row.analysis_k, row.slow_release_n_pct, row.default_rate_per_1000, row.unit_size_oz].map(Number)).toEqual([44, 0, 0, 100, 2.27, 800]);
      expect([row.best_price, row.best_vendor, row.cost_per_unit, row.cost_unit, row.best_vendor_pricing_id]).toEqual([null, null, null, null, null]);
      expect(row.post_application_watering).toEqual(migration.WATERING_RULE);
      expect(validateRule(row.post_application_watering).valid).toBe(true);
    });

    test('the stored row freezes into report facts as a fertilizer with the 0.25 inch water-in and the customer copy', async () => {
      const facts = approvedReportProductFacts(await newRow());
      expect(facts).toMatchObject({ productType: 'fertilizer', serviceReportSummary: migration.SUMMARY, precautionSummary: migration.PRECAUTION, epaRegNumber: null });
      expect(facts.wateringRule).toMatchObject({ mode: 'water_in', water_in_inches: 0.25, water_in_by_hours: 24, source: 'owner' });
    });

    test('every v13 protocol\'s 12x April row is the 44-0-0: name, product id, 1.0 lb N target; its other gates, rate shape and order stay', async () => {
      const row = await newRow();
      const rows = await aprilRows(F44);
      expect(rows).toHaveLength(KEYS.length);
      for (const apr of rows) {
        expect(apr).toMatchObject({ product_name: F44, product_id: row.id, role: 'nutrition', rate_unit: 'lb_n', rate_per_1000: null, default_in_plan: true, sort_order: 30, application_mode: 'broadcast' });
        expect(apr.gates).toEqual({ ...APRIL_GATES, targetN: '1.0 lb N/1000' });
      }
      expect(await aprilRows(F24)).toEqual([]);
    });

    test('the 9x Dimension row and the November 24-0-11 row are exactly as they were', async () => {
      const dims = await aprilRows(DIM);
      expect(dims).toHaveLength(KEYS.length);
      for (const dim of dims) expect(dim).toMatchObject({ product_id: ids.dim, gates: NINE_GATES, rate_unit: 'lb_n', sort_order: 31 });
      for (const nov of await novemberRows()) expect(nov).toMatchObject({ product_name: F24, product_id: ids.f24, gates: { targetN: '0.75 lb N/1000' } });
      const goals = await knex('lawn_protocol_windows').where({ window_key: APR }).pluck('goal');
      expect(new Set(goals)).toEqual(new Set(['One spreader feeding.']));
    });

    test('the plan derives 2.2727 lb per 1,000 sq ft from the 1.0 lb N target and the stored analysis, and the unpriced bag has no cost', async () => {
      const product = await newRow();
      const [apr] = await aprilRows(F44);
      const mix = engine.calculateProductAmount({
        product, lawnSqft: 10000, areaFactor: 1, ...engine.parseVisitNutrientTargets(aprilVisit().notes),
        ...engine.v13RateOptions({ ratePer1000: apr.rate_per_1000, rateUnit: apr.rate_unit, gates: apr.gates }),
      });
      expect(mix).toMatchObject({ rateSource: 'target_n_analysis', rateUnit: 'lb', targetNPer1000: 1, materialCost: null, materialCostSource: null });
      expect(mix.ratePer1000).toBeCloseTo(2.2727, 3);
      expect(mix.amount).toBeCloseTo(22.727, 2);
      expect(mix.ratePer1000 * Number(product.analysis_n) / 100).toBeCloseTo(1, 4);
      // A summary of one unpriced line: nothing priced, the line counted as missing.
      const summary = engine.summarizeMaterialCost([{ selected: true, product, mix }]);
      expect(summary).toMatchObject({ pricedLineCount: 0, total: 0, missingPriceCount: 1, source: 'unavailable' });
      expect(summary.missingPriceProducts).toEqual([{ productId: product.id, productName: F44 }]);
      // Without the target (a row that lost it) the catalog default rate still plans 2.27 lb.
      expect(engine.calculateProductAmount({ product, lawnSqft: 1000, areaFactor: 1 })).toMatchObject({ rateSource: 'catalog_default_rate', amount: 2.27 });
    });

    test('audit: one row per protocol with the row before and after, and one catalog row naming the inserted product', async () => {
      const protocolLogs = await knex('lawn_protocol_audit_log').where({ action: migration.ACTION });
      expect(protocolLogs).toHaveLength(KEYS.length);
      const [{ rows }] = protocolLogs.map((log) => log.after_snapshot);
      expect(rows).toHaveLength(1);
      const productId = (await newRow()).id;
      expect(rows[0].before).toEqual({ product_name: F24, product_id: ids.f24, gates: APRIL_GATES });
      expect(rows[0].after).toEqual({ product_name: F44, product_id: productId, gates: { ...APRIL_GATES, targetN: '1.0 lb N/1000' } });
      const catalogLogs = await knex('lawn_protocol_audit_log').where({ action: migration.CATALOG_ACTION });
      expect(catalogLogs).toHaveLength(1);
      expect(catalogLogs[0].lawn_protocol_id).toBeNull();
      expect(catalogLogs[0].after_snapshot).toMatchObject({ productId });
      expect(catalogLogs[0].after_snapshot.inserted).toMatchObject({ name: F44, ...migration.INSERT_DEFAULTS });
    });

    test('the inserted row is complete: rate, unit, analysis, slow release, report approval and copy, the watering rule; no price', async () => {
      const row = await newRow();
      expect(Number(row.default_rate_per_1000)).toBe(2.27);
      expect(row).toMatchObject({ rate_unit: 'lb', approved_for_service_report: true, product_type: 'fertilizer' });
      expect(Number(row.slow_release_n_pct)).toBe(100);
      expect(row.post_application_watering).toEqual(migration.WATERING_RULE);
      expect(approvedReportProductFacts(row)).toMatchObject({ productType: 'fertilizer', name: F44 });
      expect(PRICES.map((column) => row[column])).toEqual([null, null, null, null, null, null]);
    });
  });

  describe('a catalog row that already matches, in ANY state: up throws and writes nothing', () => {
    beforeEach(async () => { await reset(); });
    const GOOD = { name: F44, category: 'fertilizer', active: true, analysis_n: 44, analysis_p: 0, analysis_k: 0, slow_release_n_pct: 100 };
    const everything = async () => ({ catalog: strip(await knex('products_catalog').orderBy('id')), products: strip(await knex('lawn_protocol_products').orderBy('id')), audit: await knex('lawn_protocol_audit_log') });

    test.each([
      ['a correct active row', {}],
      ['an inactive row', { active: false }],
      ['an active-unset row', { active: null }],
      ['analysis_n 0', { analysis_n: 0 }],
      ['analysis_n empty', { analysis_n: null }],
      ['slow release 50', { slow_release_n_pct: 50 }],
      ['a bare name-only row', { analysis_n: null, analysis_p: null, analysis_k: null, slow_release_n_pct: null }],
    ])('%s: throws, nothing linked, nothing changed, no audit row', async (_label, change) => {
      await knex('products_catalog').insert({ ...GOOD, ...change });
      const before = await everything();
      await expect(migration.up(knex)).rejects.toThrow(/already exists; this migration only inserts/);
      expect(await everything()).toEqual(before);
      expect((await aprilRows(F24)).length).toBe(KEYS.length);
    });

    test('an alias-only match (even a correct row under another name) throws', async () => {
      const [other] = await knex('products_catalog').insert({ ...GOOD, name: 'LESCO 44-0-0 Polymer Turf Fertilizer' }).returning('*');
      await knex('product_aliases').insert({ product_id: other.id, alias_name: F44 });
      const before = await everything();
      await expect(migration.up(knex)).rejects.toThrow(/already exists/);
      expect(await everything()).toEqual(before);
    });

    test('a row whose name differs only in case or spacing still throws', async () => {
      await knex('products_catalog').insert({ ...GOOD, name: F44.toUpperCase().replace(/ /g, '  ') });
      await expect(migration.up(knex)).rejects.toThrow(/already exists/);
    });

    test('a failed up leaves the database as it was, and a second try after the row is removed inserts normally', async () => {
      const [stray] = await knex('products_catalog').insert({ ...GOOD, active: false }).returning('*');
      await expect(migration.up(knex)).rejects.toThrow();
      await knex('products_catalog').where({ id: stray.id }).del();
      await migration.up(knex);
      expect((await aprilRows(F44)).length).toBe(KEYS.length);
    });
  });

  describe('re-running after a rollback that did nothing', () => {
    beforeEach(async () => { await reset(); });

    test('the migration finds its own inserted row and carries on without a second insert or a throw; a second plain up is also quiet', async () => {
      await migration.up(knex);
      const once = await snapshot();
      await pin(KEYS[0]);
      await migration.down(knex); // a no-op: a visit references v13
      expect(await snapshot()).toEqual(once);
      await migration.up(knex);
      expect(await snapshot()).toEqual(once);
    });
  });

  // A visit pinned to a v13 protocol (the references down() refuses to roll back over).
  async function pin(key) {
    const { fixture } = require('./helpers/lawn-history-db');
    const f = await fixture(knex);
    const row = await f.visit(1, {});
    await knex('scheduled_services').where({ id: row.id }).update({ lawn_protocol_key: key, lawn_protocol_version: V13 });
  }

  describe('down: all or nothing', () => {
    beforeEach(async () => { await reset(); });

    test('clean up then down is the starting state exactly; up again is the first up (new catalog id aside)', async () => {
      const start = await snapshot();
      await migration.up(knex);
      const upped = await snapshot();
      await migration.down(knex);
      expect(await snapshot()).toEqual(start);
      await migration.up(knex);
      const again = await snapshot();
      const [row] = again.catalog.filter((c) => c.name === F44);
      expect(again.products.filter((p) => p.product_name === F44).every((p) => p.product_id === row.id)).toBe(true);
      const unlinked = (rows) => rows.map(({ product_id: _p, ...rest }) => rest);
      expect(unlinked(again.products)).toEqual(unlinked(upped.products));
      const byName = (rows) => rows.map(({ id: _i, created_at: _c, ...rest }) => rest).sort((x, y) => x.name.localeCompare(y.name));
      expect(byName(again.catalog)).toEqual(byName(upped.catalog));
      expect(await ours()).toHaveLength(KEYS.length + 1);
    });

    test('a visit pinned to ANY v13 protocol makes down a full no-op: every April row, the catalog row and every audit row stay', async () => {
      await migration.up(knex);
      const upped = await snapshot();
      await pin(KEYS[0]); // pinned to one protocol only: the other protocol is NOT reverted either
      await migration.down(knex);
      const after = await snapshot();
      const { audit: _a, ...rest } = upped;
      expect({ products: after.products, catalog: after.catalog }).toEqual({ products: rest.products, catalog: rest.catalog });
      expect(after.audit).toEqual(upped.audit);
      expect((await aprilRows(F44)).length).toBe(KEYS.length);
      expect(await aprilRows(F24)).toEqual([]);
    });

    test('a completion that references a v13 protocol makes down a full no-op', async () => {
      await migration.up(knex);
      const upped = await snapshot();
      const [protocol] = await knex('lawn_protocols').where({ version: V13, protocol_key: KEYS[1] });
      const completionColumns = await knex('lawn_protocol_service_completions').columnInfo();
      const row = { lawn_protocol_id: protocol.id, protocol_key: KEYS[1], protocol_version: V13 };
      for (const [column, info] of Object.entries(completionColumns)) {
        if (column in row || column === 'id' || info.nullable || info.defaultValue != null) continue;
        row[column] = info.type.includes('uuid') ? require('crypto').randomUUID() : info.type.includes('int') ? 1 : info.type.includes('timestamp') ? new Date() : info.type === 'date' ? '2027-04-15' : info.type.includes('json') ? '{}' : 'fixture';
      }
      await knex('lawn_protocol_service_completions').insert(row);
      await migration.down(knex);
      const after = await snapshot();
      expect({ products: after.products, catalog: after.catalog, audit: after.audit }).toEqual({ products: upped.products, catalog: upped.catalog, audit: upped.audit });
    });

    test.each([
      ['renamed', (a) => ({ product_name: 'Fixture renamed by staff' })],
      ['re-linked to another product', () => ({ product_id: ids.dim })],
      ['re-gated', (a) => ({ gates: JSON.stringify({ ...a.gates, targetN: '1.2 lb N/1000' }) })],
      ['given an extra gate', (a) => ({ gates: JSON.stringify({ ...a.gates, extra: true }) })],
    ])('one April row %s by staff makes down a full no-op: the other protocol is NOT reverted, the catalog row stays', async (_label, change) => {
      await migration.up(knex);
      const upped = await snapshot();
      const [a] = await aprilRows(F44);
      await knex('lawn_protocol_products').where({ id: a.id }).update(change(a));
      const edited = await snapshot();
      await migration.down(knex);
      expect(await snapshot()).toEqual(edited);
      expect(edited.audit).toEqual(upped.audit);
      expect((await aprilRows(F44)).length).toBeGreaterThanOrEqual(KEYS.length - 1);
      expect(await newRow()).toBeTruthy();
    });

    test('an April row staff deleted makes down a full no-op', async () => {
      await migration.up(knex);
      const [a] = await aprilRows(F44);
      await knex('lawn_protocol_products').where({ id: a.id }).del();
      const edited = await snapshot();
      await migration.down(knex);
      expect(await snapshot()).toEqual(edited);
    });

    test.each([
      ['priced', { best_price: 41 }],
      ['marked priced', { needs_pricing: false }],
      ['published', { content_status: 'approved_for_portal' }],
      ['made public', { customer_visibility: 'public' }],
      ['re-rated', { default_rate_per_1000: 2.3 }],
      ['given a stray analysis', { analysis_n: 43 }],
    ])('a catalog row staff %s is kept; the April rows still go back', async (_label, change) => {
      await migration.up(knex);
      await knex('products_catalog').where({ name: F44 }).update(change);
      await migration.down(knex);
      expect(await aprilRows(F44)).toEqual([]);
      expect((await aprilRows(F24)).length).toBe(KEYS.length);
      expect(await newRow()).toBeTruthy();
      expect(await ours()).toHaveLength(0);
    });

    test('a catalog row something references (an application limit) is kept; the April rows still go back', async () => {
      await migration.up(knex);
      const product = await newRow();
      await knex('product_limits').insert({ product_id: product.id, limit_type: 'annual_max_apps', limit_value: 2, limit_unit: 'applications', severity: 'warning' });
      await migration.down(knex);
      expect((await aprilRows(F24)).length).toBe(KEYS.length);
      expect(await newRow()).toBeTruthy();
    });
  });

  describe('protocols the migration skips', () => {
    beforeEach(async () => { await reset(); });

    test('an April window with no 24-0-11 row is skipped (the catalog row is still inserted); without a v13 protocol nothing is written', async () => {
      await knex('lawn_protocol_products').where({ product_name: F24 }).whereIn('lawn_protocol_window_id', knex('lawn_protocol_windows').where({ window_key: APR }).select('id')).del();
      await migration.up(knex);
      expect(await aprilRows(F44)).toEqual([]);
      expect(await ours()).toHaveLength(1);
      await reset();
      await knex('lawn_protocol_audit_log').del();
      await knex('lawn_protocol_products').del();
      await knex('lawn_protocol_windows').del();
      await knex('lawn_protocols').where({ version: V13 }).del();
      const before = await snapshot();
      await migration.up(knex);
      expect(await snapshot()).toEqual(before);
    });
  });
});
