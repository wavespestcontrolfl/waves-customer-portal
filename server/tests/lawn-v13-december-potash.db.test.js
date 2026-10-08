// Lawn protocol v13 December step: LESCO 10-0-22 at 4.5 lb per 1,000 sq ft (migration 20261008130000,
// owner 2026-10-08), through the real migration on PostgreSQL (cloned schema). Synthetic data only.
//
// Pinned: the catalog row is inserted once (fresh path) or only has its empty fields filled (existing
// row, alias-only row), with no price written; the staged December row of every v13 protocol swaps
// from the 24-0-11 and keeps its other gates; the plan derives 4.5 lb from the 0.45 lb N target;
// a second up changes nothing; down restores exactly, leaves a protocol a visit is pinned to, leaves
// a changed or referenced catalog row, and never touches a row it did not write.
const { randomUUID } = require('crypto');
const { createLawnHistoryDb, fixture } = require('./helpers/lawn-history-db');
const engine = require('../services/waveguard-plan-engine');
const v13Recipe = require('../config/lawn-protocol-v13.json');
const migration = require('../models/migrations/20261008130000_lawn_v13_december_potash');
const staged = require('../models/migrations/20261005120000_lawn_protocol_v13_staged');
const { validateRule } = require('../services/service-report/lawn-watering-rule');
const { approvedReportProductFacts } = require('../services/service-report/report-data');
const { activeProtocolProducts } = require('../services/lawn-protocol-retired');

const F24 = migration.OLD_NAME;
const F10 = migration.NEW_NAME;
const V13 = staged.V13_VERSION;
const KEYS = ['fixture_dec_a', 'fixture_dec_b'];
const DEC = migration.DECEMBER_WINDOW;
const OCT = 'oct_v13_spreader_fall';
const DEC_GATES = { targetN: '0.5 lb N/1000', fertilizerSafety: true, blackoutSensitive: true };
const CATALOG_TABLES = ['products_catalog', 'product_aliases', 'lawn_protocols', 'lawn_protocol_windows', 'lawn_protocol_products',
  'lawn_protocol_audit_log', 'lawn_protocol_service_completions', 'product_limits'];
const asRetired = (gates) => (typeof gates === 'string' ? JSON.parse(gates) : gates).retired === true;
const FEB = 'feb_v13_spreader_green_up';
const MAY = 'may_v13_tetrino_hose';
const JAN = 'jan_v13_pre_m_hose';
const CER = staged.NAMES.CER;
const NIS = staged.NAMES.NIS;
const BLS = 'Blindside Herbicide';
const ARENA = staged.NAMES.ARE;
const ARENA_SE = 'Arena S.E. 50 WDG Insecticide 2.5 lb. (Florida Only)';
const ARENA_GATES = { trigger: 'chinch_20_to_25_per_sqft', annualMaxApps: 2 };
const CEL = 'Celsius WG';
const decNotes = () => v13Recipe.st_augustine.visits.find((v) => v.month === 'Dec').notes;

describe('December 10-0-22: the recipe and the catalog spec (no database)', () => {
  const { CATALOG } = migration;

  test('the label figures: 4.5 lb is 0.45 lb N and 0.99 lb K2O; slow-release N is exactly 50% of the 10% N', () => {
    expect(migration.DEC_RATE).toBe(4.5);
    expect(migration.DEC_RATE * (CATALOG.analysis_n / 100)).toBeCloseTo(0.45, 6);
    expect(migration.DEC_RATE * (CATALOG.analysis_k / 100)).toBeCloseTo(0.99, 6);
    // 5.00% polymer-coated urea of 10.00% total N; 2.39 + 2.61 + 5.00 = 10.00.
    expect(Math.round((5.0 / 10.0) * 100)).toBe(CATALOG.slow_release_n_pct);
    expect(2.39 + 2.61 + 5.0).toBeCloseTo(CATALOG.analysis_n, 6);
  });

  test('the county slow-release minimum is 50% and the row sits exactly on it (the ordinance rows are data, read as >=)', () => {
    // municipality_ordinances.slow_release_required_pct is 50.00 for the county rows; no service compares it
    // at plan time, so the catalog value is the whole proof: it must not fall below the minimum.
    expect(CATALOG.slow_release_n_pct).toBeGreaterThanOrEqual(50);
    expect(CATALOG.slow_release_n_pct - 50).toBe(0);
  });

  test('the catalog spec: a fertilizer with no EPA number, no price field, approved with plain copy', () => {
    expect(CATALOG).toMatchObject({
      category: 'fertilizer', product_type: 'fertilizer', formulation: 'granular', container_size: '50 lb', unit_size_oz: 800,
      siteone_sku: '511289', epa_reg_number: 'N/A', analysis_n: 10, analysis_p: 0, analysis_k: 22, default_rate_per_1000: 4.5, rate_unit: 'lb',
      approved_for_service_report: true,
    });
    for (const field of ['best_price', 'best_vendor', 'cost_per_unit', 'cost_unit', 'needs_pricing']) expect(CATALOG).not.toHaveProperty(field);
    expect(CATALOG.name.length).toBeLessThanOrEqual(150);
    expect(CATALOG.display_name.length).toBeLessThanOrEqual(80);
    expect(CATALOG.public_summary).toBe('A slow-release fertilizer with extra potassium. It feeds the lawn lightly and helps it handle cool, dry weather.');
    expect(CATALOG.customer_precaution_summary).toBe('Granules on sidewalks or driveways are swept back into the turf. Watering-in follows the visit notes. No re-entry wait once watered in and dry.');
  });

  test('the watering rule is valid, owner-sourced and the 24-0-11 amount (0.25 inch within 24 hours)', () => {
    const checked = validateRule(migration.WATERING_RULE);
    expect(checked.errors).toEqual([]);
    expect(checked.rule).toMatchObject({ mode: 'water_in', water_in_inches: 0.25, water_in_by_hours: 24, source: 'owner' });
  });

  test('the report freezes the product as a fertilizer with its watering rule and customer copy', () => {
    const facts = approvedReportProductFacts({ ...CATALOG, post_application_watering: migration.WATERING_RULE });
    expect(facts).toMatchObject({
      productType: 'fertilizer', name: F10, epaRegNumber: null, serviceReportSummary: CATALOG.service_report_summary,
      precautionSummary: CATALOG.customer_precaution_summary,
    });
    expect(facts.wateringRule).toMatchObject({ mode: 'water_in', water_in_inches: 0.25, water_in_by_hours: 24 });
  });

  test('customer-report wording treats it as a fertilizer, never a pre-emergent', () => {
    const { classifyProduct } = require('../services/service-report/lawn-report-v2');
    const { buildTreatmentSummary } = require('../services/service-report/treatment-summary');
    const app = { product: { name: F10, category: CATALOG.category, active_ingredient: CATALOG.active_ingredient } };
    expect(classifyProduct(app).kind).toBe('fertilizer');
    const summary = buildTreatmentSummary({ products: [{ name: F10, activeIngredient: CATALOG.active_ingredient, kind: 'fertilizer', method: 'broadcast' }] });
    expect(summary).toBe('Today we applied nitrogen and potash fertilizer.');
    expect(summary).not.toMatch(/pre-?emergent|prodiamine|dithiopyr/i);
  });

  test('the recipe Dec line names the catalog row exactly and derives from the N target', () => {
    const dec = v13Recipe.st_augustine.visits.find((v) => v.month === 'Dec');
    expect(dec.primary).toBe(`${F10} — 4.5 lb per 1,000 sq ft (0.45 lb N, 0.99 lb K2O), spreader`);
    expect(engine.parseVisitNutrientTargets(dec.notes)).toEqual({ targetNPer1000: 0.45, targetKPer1000: 0.99 });
  });
});

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

describeDb('v13 December 10-0-22 migration through PostgreSQL', () => {
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
    // LIKE copies no foreign keys; the product reference check reads them, so the two tables a row can be
    // pinned to the product through get theirs back.
    await knex.raw('ALTER TABLE ??.product_limits ADD CONSTRAINT fixture_limits_product FOREIGN KEY (product_id) REFERENCES ??.products_catalog (id)', [owned.schema, owned.schema]);
    await knex.raw('ALTER TABLE ??.service_products ADD CONSTRAINT fixture_sp_product FOREIGN KEY (product_id) REFERENCES ??.products_catalog (id) ON DELETE SET NULL', [owned.schema, owned.schema]);
    await knex.raw('ALTER TABLE ??.lawn_protocol_audit_log ALTER COLUMN lawn_protocol_id DROP NOT NULL', [owned.schema]).catch(() => {});
  }, 60000);
  afterAll(async () => { if (owned) await owned.dispose(); });

  const newRow = () => knex('products_catalog').where({ name: F10 }).first();
  const decemberRows = () => knex('lawn_protocol_products as p')
    .join('lawn_protocol_windows as w', 'p.lawn_protocol_window_id', 'w.id')
    .join('lawn_protocols as l', 'w.lawn_protocol_id', 'l.id')
    .where({ 'w.window_key': DEC, 'p.role': 'nutrition' })
    .orderBy('l.protocol_key').select('p.*', 'l.protocol_key');
  const octoberRows = () => knex('lawn_protocol_products as p').join('lawn_protocol_windows as w', 'p.lawn_protocol_window_id', 'w.id').where({ 'w.window_key': OCT, 'p.role': 'nutrition' }).select('p.*');
  // The weed rows by month: [window key, product name] -> row, for every protocol.
  const weedRows = (windowKey, name) => knex('lawn_protocol_products as p').join('lawn_protocol_windows as w', 'p.lawn_protocol_window_id', 'w.id')
    .where({ 'w.window_key': windowKey, 'p.product_name': name }).select('p.*');
  const isRetired = (row) => asRetired(row.gates);
  const ours = () => knex('lawn_protocol_audit_log').whereIn('action', [migration.ACTION, migration.CATALOG_ACTION, migration.WEED_ACTION, migration.ARENA_ACTION]);
  const arenaRows = () => knex('lawn_protocol_products').whereIn('product_name', [ARENA, ARENA_SE]).orderBy(['product_name', 'id']);
  const strip = (rows) => rows.map(({ updated_at: _u, ...rest }) => rest);

  const weedIds = {};
  async function insertWeedRows(windowId, set, next) {
    for (const [name, gates] of set) {
      weedIds[name] = weedIds[name] || (await knex('products_catalog').where({ name }).first('id'))?.id || (await knex('products_catalog').insert({ name, category: 'herbicide', active: true }).returning('id'))[0].id;
      await knex('lawn_protocol_products').insert({ lawn_protocol_window_id: windowId, product_id: weedIds[name], product_name: name, role: name === NIS ? 'adjuvant_spot' : 'post_emergent_spot', application_mode: 'spot', rate_unit: 'label_rate', default_in_plan: false, sort_order: next(), gates: JSON.stringify(gates) });
    }
  }

  // A clean fixture: the catalog as main leaves it (24-0-11 only), two v13 protocols with their windows.
  async function reset() {
    for (const table of ['service_products', 'product_limits', 'lawn_protocol_audit_log', 'lawn_protocol_products', 'lawn_protocol_windows',
      'lawn_protocol_service_completions', 'lawn_protocols', 'product_aliases', 'products_catalog']) await knex(table).del();
    await knex('scheduled_services').update({ lawn_protocol_key: null, lawn_protocol_version: null });
    for (const key of Object.keys(weedIds)) delete weedIds[key];
    const [f24] = await knex('products_catalog').insert({ name: F24, category: 'fertilizer', formulation: 'granular', analysis_n: 24, analysis_p: 0, analysis_k: 11, default_rate_per_1000: 4.2, rate_unit: 'lb', active: true }).returning('*');
    const [art] = await knex('products_catalog').insert({ name: 'Artavia 2 SC (Azoxy)', category: 'fungicide', active: true }).returning('*');
    ids.f24 = f24.id; ids.art = art.id;
    for (const key of KEYS) {
      await knex('lawn_protocols').insert({ protocol_key: key, version: '2026.06', name: 'Fixture old', status: 'active', grass_track: 'bermuda', region: 'swfl' });
      const [protocol] = await knex('lawn_protocols').insert({ protocol_key: key, version: V13, name: 'Fixture v13', status: 'staged', grass_track: 'bermuda', region: 'swfl', effective_from: '2000-01-01' }).returning('*');
      const [dec] = await knex('lawn_protocol_windows').insert({ lawn_protocol_id: protocol.id, month: 12, window_key: DEC, title: DEC, visit_type: 'granular_production_plus_spots', production_mode: 'spreader_plus_spot_backpack', goal: 'One spreader feeding; active large patch, weed and repeat sedge spots.' }).returning('*');
      const [oct] = await knex('lawn_protocol_windows').insert({ lawn_protocol_id: protocol.id, month: 10, window_key: OCT, title: OCT, visit_type: 'fixture', production_mode: 'spreader_plus_spot_backpack', goal: 'October fixture goal.' }).returning('*');
      const weedSet = [[CEL, { stressGate: true, annualCounter: 'celsius_oz_per_1000', annualMaxApps: 2 }], [CER, { tankMixWith: CEL, annualMaxApps: 2 }], [NIS, { tankMixWith: CEL, concentration: '0.25% v/v' }], [BLS, { trigger: 'celsius_annual_cap_reached', annualMaxApps: 2 }]];
      let order = 100;
      for (const [windowKey, month] of [[JAN, 1], [FEB, 2], [MAY, 5]]) {
        const [window] = await knex('lawn_protocol_windows').insert({ lawn_protocol_id: protocol.id, month, window_key: windowKey, title: windowKey, visit_type: 'fixture', production_mode: 'fixture' }).returning('*');
        await insertWeedRows(window.id, weedSet, () => (order += 1));
      }
      // Arena at the staged state: no rate, unit label_rate, 4 gal carrier; one row renamed to the S.E. title, as #6116 may leave it.
      const arenaWindow = (await knex('lawn_protocol_windows').where({ lawn_protocol_id: protocol.id, window_key: MAY }).first());
      const [jun] = await knex('lawn_protocol_windows').insert({ lawn_protocol_id: protocol.id, month: 6, window_key: 'jun_v13_hose_blackout', title: 'jun', visit_type: 'fixture', production_mode: 'fixture' }).returning('*');
      weedIds[ARENA] = (await knex('products_catalog').where({ name: ARENA }).first('id'))?.id || (await knex('products_catalog').insert({ name: ARENA, category: 'insecticide', active: true, default_rate_per_1000: 0.29, rate_unit: 'oz' }).returning('id'))[0].id;
      for (const [windowId, name] of [[arenaWindow.id, ARENA], [jun.id, ARENA_SE]]) {
        await knex('lawn_protocol_products').insert({ lawn_protocol_window_id: windowId, product_id: weedIds[ARENA], product_name: name, role: 'insecticide_spot', application_mode: 'spot', rate_unit: 'label_rate', carrier_gal_per_1000: 4, default_in_plan: false, sort_order: (order += 1), gates: JSON.stringify(ARENA_GATES) });
      }
      await insertWeedRows(oct.id, weedSet, () => (order += 1));
      await insertWeedRows(dec.id, weedSet, () => (order += 1));
      await knex('lawn_protocol_products').insert([
        { lawn_protocol_window_id: dec.id, product_id: f24.id, product_name: F24, role: 'nutrition', application_mode: 'broadcast', rate_unit: 'lb_n', default_in_plan: true, sort_order: 53, gates: JSON.stringify(DEC_GATES) },
        { lawn_protocol_window_id: dec.id, product_id: art.id, product_name: 'Artavia 2 SC (Azoxy)', role: 'fungicide_spot', application_mode: 'spot', rate_unit: 'label_rate', default_in_plan: false, sort_order: 54, gates: JSON.stringify({ trigger: 'active_large_patch' }) },
        // October carries a 24-0-11 row too (a fixture decoy): the migration reads the December window only.
        { lawn_protocol_window_id: oct.id, product_id: f24.id, product_name: F24, role: 'nutrition', application_mode: 'broadcast', rate_unit: 'lb_n', default_in_plan: true, sort_order: 40, gates: JSON.stringify({ targetN: '0.6 lb N/1000' }) },
      ]);
    }
  }

  describe('fresh path: the catalog has no 10-0-22 row', () => {
    beforeAll(async () => { await reset(); await migration.up(knex); });

    test('one catalog row is inserted from the label facts, with no price field, pending pricing, and approved for the report', async () => {
      const rows = await knex('products_catalog').where({ name: F10 });
      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row).toMatchObject({
        category: 'fertilizer', product_type: 'fertilizer', formulation: 'granular', container_size: '50 lb', siteone_sku: '511289', epa_reg_number: 'N/A',
        rate_unit: 'lb', active: true, needs_pricing: true, content_status: 'draft', customer_visibility: 'internal_only',
        approved_for_service_report: true, public_summary: migration.SUMMARY, service_report_summary: migration.SUMMARY, customer_precaution_summary: migration.PRECAUTION,
        display_name: 'LESCO 10-0-22 Turf Fertilizer', active_ingredient: 'Nitrogen and potash fertilizer',
      });
      expect([row.analysis_n, row.analysis_p, row.analysis_k, row.slow_release_n_pct, row.default_rate_per_1000, row.unit_size_oz].map(Number)).toEqual([10, 0, 22, 50, 4.5, 800]);
      expect([row.best_price, row.best_vendor, row.cost_per_unit, row.cost_unit, row.best_vendor_pricing_id]).toEqual([null, null, null, null, null]);
      expect(row.post_application_watering).toEqual(migration.WATERING_RULE);
      expect(validateRule(row.post_application_watering).valid).toBe(true);
      expect(row.label_source_note).toMatch(/511289/);
    });

    test('the stored row freezes into report facts as a fertilizer with the 0.25 inch water-in and the customer copy', async () => {
      const facts = approvedReportProductFacts(await newRow());
      expect(facts).toMatchObject({ productType: 'fertilizer', serviceReportSummary: migration.SUMMARY, precautionSummary: migration.PRECAUTION, epaRegNumber: null });
      expect(facts.wateringRule).toMatchObject({ mode: 'water_in', water_in_inches: 0.25, water_in_by_hours: 24, source: 'owner' });
    });

    test('every v13 protocol\'s December row is the 10-0-22: name, product id, N and K2O targets; its other gates, rate shape and order stay', async () => {
      const row = await newRow();
      const rows = await decemberRows();
      expect(rows).toHaveLength(KEYS.length);
      for (const dec of rows) {
        expect(dec).toMatchObject({ product_name: F10, product_id: row.id, role: 'nutrition', rate_unit: 'lb_n', rate_per_1000: null, default_in_plan: true, sort_order: 53, application_mode: 'broadcast' });
        expect(dec.gates).toEqual({ ...DEC_GATES, targetN: '0.45 lb N/1000', targetK2O: '0.99 lb K2O/1000' });
      }
    });

    test('nothing else moves: the December spot rows, the window goal and the October rows are as they were', async () => {
      const spots = await knex('lawn_protocol_products').where({ product_name: 'Artavia 2 SC (Azoxy)' });
      expect(spots).toHaveLength(KEYS.length);
      for (const spot of spots) expect(spot.gates).toEqual({ trigger: 'active_large_patch' });
      const goals = await knex('lawn_protocol_windows').where({ window_key: DEC }).pluck('goal');
      expect(new Set(goals)).toEqual(new Set(['One spreader feeding; active large patch, weed and repeat sedge spots.']));
      for (const oct of await octoberRows()) expect(oct).toMatchObject({ product_name: F24, product_id: ids.f24, gates: { targetN: '0.6 lb N/1000' } });
    });

    test('the plan derives 4.5 lb per 1,000 sq ft from the 0.45 lb N target and the stored analysis (0.45 lb N, 0.99 lb K2O)', async () => {
      const product = await newRow();
      const [dec] = await decemberRows();
      const mix = engine.calculateProductAmount({
        product, lawnSqft: 10000, areaFactor: 1, ...engine.parseVisitNutrientTargets(decNotes()),
        ...engine.v13RateOptions({ ratePer1000: dec.rate_per_1000, rateUnit: dec.rate_unit, gates: dec.gates }),
      });
      expect(mix).toMatchObject({ rateSource: 'target_n_analysis', rateUnit: 'lb' });
      expect(mix.ratePer1000).toBe(4.5);
      expect(mix.amount).toBeCloseTo(45, 6);
      expect(mix.ratePer1000 * Number(product.analysis_n) / 100).toBeCloseTo(0.45, 6);
      expect(mix.ratePer1000 * Number(product.analysis_k) / 100).toBeCloseTo(0.99, 6);
    });

    test('audit: one row per protocol with the row before and after, and one catalog row naming the inserted product', async () => {
      const protocolLogs = await knex('lawn_protocol_audit_log').where({ action: migration.ACTION });
      expect(protocolLogs).toHaveLength(KEYS.length);
      const [{ rows }] = protocolLogs.map((log) => log.after_snapshot);
      expect(rows).toHaveLength(1);
      expect(rows[0].columns).toEqual({ product_name: { before: F24, after: F10 }, product_id: { before: ids.f24, after: (await newRow()).id } });
      expect(rows[0].gates).toEqual({ targetN: { had: true, before: '0.5 lb N/1000', after: '0.45 lb N/1000' }, targetK2O: { had: false, before: null, after: '0.99 lb K2O/1000' } });
      const catalogLogs = await knex('lawn_protocol_audit_log').where({ action: migration.CATALOG_ACTION });
      expect(catalogLogs).toHaveLength(1);
      expect(catalogLogs[0].lawn_protocol_id).toBeNull();
      expect(catalogLogs[0].after_snapshot).toMatchObject({ productId: (await newRow()).id, filled: [] });
      expect(catalogLogs[0].after_snapshot.inserted.name).toBe(F10);
    });

    describe('weed season (owner 2026-10-08)', () => {
      const retiredNames = async (windowKey) => {
        const rows = (await Promise.all([CEL, CER, NIS, BLS].map((name) => weedRows(windowKey, name)))).flat();
        return rows.filter(isRetired).map((row) => row.product_name).sort();
      };

      test('February keeps Celsius alone: Certainty, the surfactant and Blindside are retired on every protocol', async () => {
        expect(await retiredNames(FEB)).toEqual([BLS, BLS, CER, CER, NIS, NIS]);
        for (const row of await weedRows(FEB, CEL)) expect(isRetired(row)).toBe(false);
      });

      test('Blindside is gone from May and October and stays in January and December; the rest of those windows is unchanged', async () => {
        expect(await retiredNames(MAY)).toEqual([BLS, BLS]);
        expect(await retiredNames(OCT)).toEqual([BLS, BLS]);
        expect(await retiredNames(JAN)).toEqual([]);
        expect(await retiredNames(DEC)).toEqual([]);
      });

      test('a retired row keeps its id, its place and its gates (plus retired: true), and the planning reader leaves it out', async () => {
        const [row] = await weedRows(FEB, BLS);
        expect(row.gates).toEqual({ trigger: 'celsius_annual_cap_reached', annualMaxApps: 2, retired: true });
        expect(row).toMatchObject({ product_name: BLS, role: 'post_emergent_spot', application_mode: 'spot' });
        const planned = await activeProtocolProducts(knex('lawn_protocol_products as p').join('lawn_protocol_windows as w', 'p.lawn_protocol_window_id', 'w.id').where({ 'w.window_key': FEB }), 'p').pluck('p.product_name');
        expect(planned.sort()).toEqual([CEL, CEL]);
      });

      test('audit: one weed-season row per protocol lists the five retired rows', async () => {
        const logs = await knex('lawn_protocol_audit_log').where({ action: migration.WEED_ACTION });
        expect(logs).toHaveLength(KEYS.length);
        for (const log of logs) {
          expect(log.after_snapshot.retired.map((r) => `${r.window}:${r.product_name}`).sort()).toEqual([
            `${FEB}:${BLS}`, `${FEB}:${CER}`, `${FEB}:${NIS}`, `${MAY}:${BLS}`, `${OCT}:${BLS}`,
          ].sort());
        }
      });
    });

    describe('Arena half rate (owner 2026-10-08)', () => {
      test('every staged Arena row (either name) states 0.147 oz and the 56-day interval; the trigger key, carrier and cap gate stay', async () => {
        const rows = await arenaRows();
        expect(rows).toHaveLength(KEYS.length * 2);
        for (const row of rows) {
          expect(row).toMatchObject({ rate_unit: 'oz', application_mode: 'spot', default_in_plan: false });
          expect(Number(row.carrier_gal_per_1000)).toBe(4);
          expect(Number(row.rate_per_1000)).toBe(0.147);
          expect(row.gates).toEqual({ ...ARENA_GATES, minIntervalDays: 56 });
        }
      });

      test('0.147 oz twice is the label\'s yearly limit: 0.294 oz per 1,000 sq ft = 12.8 oz per acre = 0.4 lb clothianidin per acre', () => {
        expect(migration.ARENA_RATE * 2).toBeCloseTo(0.294, 6);
        expect(migration.ARENA_RATE * 43.56).toBeCloseTo(6.4, 1);
        expect(migration.ARENA_RATE * 2 * 43.56 * 0.5 / 16).toBeCloseTo(0.4, 1); // oz of 50% product -> lb clothianidin
        expect(migration.ARENA_INTERVAL_DAYS).toBe(56);
      });

      test('audit: one arena row per protocol lists both rows', async () => {
        const logs = await knex('lawn_protocol_audit_log').where({ action: migration.ARENA_ACTION });
        expect(logs).toHaveLength(KEYS.length);
        for (const log of logs) expect(log.after_snapshot.rows.map((r) => r.product_name).sort()).toEqual([ARENA, ARENA_SE].sort());
      });
    });

    test('a second up changes nothing: one row, the same December rows, the same audit rows', async () => {
      const state = async () => JSON.stringify([strip(await decemberRows()), strip(await knex('lawn_protocol_products').orderBy('id')), await newRow(), await ours().orderBy('id')]);
      const before = await state();
      await migration.up(knex);
      expect(await knex('products_catalog').where({ name: F10 })).toHaveLength(1);
      expect(await state()).toBe(before);
    });
  });

  describe('down', () => {
    // Every row of the touched tables, updated_at left out (a restore stamps it).
    const clean = (state) => JSON.stringify(state, (key, value) => (key === 'updated_at' ? undefined : value));
    async function snapshot() {
      return clean([
        await knex('lawn_protocol_products').orderBy(['product_name', 'sort_order', 'id']), await knex('lawn_protocol_windows').orderBy('id'),
        await knex('products_catalog').orderBy('name'), await knex('lawn_protocol_audit_log').orderBy('id'),
      ]);
    }
    beforeEach(async () => { await reset(); });

    test('puts every December row back exactly (name, product id, gates), removes the inserted catalog row and every audit row', async () => {
      const before = await snapshot();
      await migration.up(knex);
      expect(await snapshot()).not.toBe(before);
      await migration.down(knex);
      const rows = await decemberRows();
      for (const row of rows) expect(row).toMatchObject({ product_name: F24, product_id: ids.f24, gates: DEC_GATES });
      expect(await newRow()).toBeUndefined();
      expect(await ours()).toEqual([]);
      // Everything but updated_at is byte-identical to the state before up.
      expect(await snapshot()).toBe(before);
    });

    test('up again after down puts the swap back; down again restores', async () => {
      await migration.up(knex);
      await migration.down(knex);
      await migration.up(knex);
      for (const row of await decemberRows()) expect(row).toMatchObject({ product_name: F10 });
      await migration.down(knex);
      for (const row of await decemberRows()) expect(row).toMatchObject({ product_name: F24 });
    });

    test('a visit pinned to one protocol leaves that protocol, its audit row and the catalog row; the other protocol goes back', async () => {
      const log = jest.spyOn(console, 'log').mockImplementation(() => {});
      await migration.up(knex);
      const f = await fixture(knex);
      const pinned = await f.visit(0, { lawn_protocol_key: KEYS[0], lawn_protocol_version: V13 });
      try {
        await migration.down(knex);
        const rows = await decemberRows();
        expect(rows.find((r) => r.protocol_key === KEYS[0])).toMatchObject({ product_name: F10 });
        expect(rows.find((r) => r.protocol_key === KEYS[1])).toMatchObject({ product_name: F24 });
        expect(await newRow()).toBeDefined();
        expect(await knex('lawn_protocol_audit_log').where({ action: migration.ACTION })).toHaveLength(1);
        expect(await knex('lawn_protocol_audit_log').where({ action: migration.CATALOG_ACTION })).toHaveLength(1);
        expect(log).toHaveBeenCalledWith(expect.stringContaining(`rollback skipped for protocol ${KEYS[0]}`));
        // Weed season: the pinned protocol keeps its five retired rows and its audit row; the other protocol's rows are back.
        expect(await knex('lawn_protocol_audit_log').where({ action: migration.WEED_ACTION })).toHaveLength(1);
        const febBlindside = await weedRows(FEB, BLS);
        expect(febBlindside.filter(isRetired)).toHaveLength(1);
      } finally {
        log.mockRestore();
        await knex('scheduled_services').where({ id: pinned.id }).update({ lawn_protocol_key: null, lawn_protocol_version: null });
      }
      await migration.down(knex);
      expect(await newRow()).toBeUndefined();
    });

    test('a completion on the protocol leaves it too', async () => {
      const log = jest.spyOn(console, 'log').mockImplementation(() => {});
      await migration.up(knex);
      const [protocol] = await knex('lawn_protocols').where({ protocol_key: KEYS[1], version: V13 });
      await knex('lawn_protocol_service_completions').insert({ service_record_id: randomUUID(), lawn_protocol_id: protocol.id, protocol_key: KEYS[1], protocol_version: V13 });
      try {
        await migration.down(knex);
        expect((await decemberRows()).find((r) => r.protocol_key === KEYS[1])).toMatchObject({ product_name: F10 });
        expect(await newRow()).toBeDefined();
      } finally {
        log.mockRestore();
        await knex('lawn_protocol_service_completions').del();
      }
    });

    test('a value changed since stays: a renamed row is not the 10-0-22 row, an edited target stays, and a gate someone added stays', async () => {
      await migration.up(knex);
      const [a, b] = await decemberRows();
      await knex('lawn_protocol_products').where({ id: a.id }).update({ product_name: 'Renamed by an admin' });
      await knex('lawn_protocol_products').where({ id: b.id }).update({ gates: JSON.stringify({ ...b.gates, targetN: '0.4 lb N/1000', extra: true }) });
      await migration.down(knex);
      const [afterA, afterB] = await decemberRows();
      expect(afterA).toMatchObject({ product_name: 'Renamed by an admin', product_id: a.product_id });
      expect(afterA.gates).toEqual(a.gates);
      expect(afterB).toMatchObject({ product_name: F24, product_id: ids.f24 });
      // targetN was edited (stays), targetK2O was still the written value (removed, it was absent before), extra is the admin's.
      expect(afterB.gates).toEqual({ ...DEC_GATES, targetN: '0.4 lb N/1000', extra: true });
    });

    test('an Arena row an admin has since changed (another rate) keeps its rate; the others go back to the staged state', async () => {
      await migration.up(knex);
      const [a] = await arenaRows();
      await knex('lawn_protocol_products').where({ id: a.id }).update({ rate_per_1000: 0.2 });
      await migration.down(knex);
      const rows = await arenaRows();
      expect(Number(rows.find((r) => r.id === a.id).rate_per_1000)).toBe(0.2);
      for (const row of rows.filter((r) => r.id !== a.id)) {
        expect(row).toMatchObject({ rate_per_1000: null, rate_unit: 'label_rate' });
        expect(row.gates).toEqual(ARENA_GATES);
      }
    });

    test('an Arena row that already has a rate (not the staged state) is never rewritten', async () => {
      const [a] = await arenaRows();
      await knex('lawn_protocol_products').where({ id: a.id }).update({ rate_per_1000: 0.29, rate_unit: 'oz' });
      await migration.up(knex);
      expect(Number((await knex('lawn_protocol_products').where({ id: a.id }).first()).rate_per_1000)).toBe(0.29);
    });

    test('a retired weed row that someone has since brought back (retired no longer true) is left as it is', async () => {
      await migration.up(knex);
      const [row] = await weedRows(FEB, BLS);
      await knex('lawn_protocol_products').where({ id: row.id }).update({ gates: JSON.stringify({ trigger: 'celsius_annual_cap_reached', annualMaxApps: 2, edited: true }) });
      await migration.down(knex);
      expect((await knex('lawn_protocol_products').where({ id: row.id }).first()).gates).toEqual({ trigger: 'celsius_annual_cap_reached', annualMaxApps: 2, edited: true });
      for (const other of await weedRows(MAY, BLS)) expect(isRetired(other)).toBe(false);
    });

    test('the catalog row is kept when something references it (a product limit, a service product), or when it was priced after the insert', async () => {
      for (const reference of [
        async (id) => knex('product_limits').insert({ product_id: id, match_type: 'product', limit_type: 'annual_max_apps', limit_value: 2, limit_unit: 'applications', severity: 'hard_block' }),
        async (id) => knex('service_products').insert({ service_record_id: (await (async () => { const f = await fixture(knex); return (await f.record(await f.visit(0))).id; })()), product_name: F10, product_id: id }),
        async (id) => knex('products_catalog').where({ id }).update({ best_price: 31.81 }),
      ]) {
        await reset();
        await migration.up(knex);
        await reference((await newRow()).id);
        await migration.down(knex);
        for (const row of await decemberRows()) expect(row).toMatchObject({ product_name: F24 });
        expect(await newRow()).toBeDefined();
        expect(await ours()).toEqual([]);
      }
    });

    test('a catalog field edited since the insert keeps the row', async () => {
      await migration.up(knex);
      await knex('products_catalog').where({ name: F10 }).update({ analysis_k: 21 });
      await migration.down(knex);
      expect(await newRow()).toBeDefined();
    });
  });

  describe('the catalog row already exists', () => {
    beforeEach(async () => { await reset(); });
    const existing = (fields = {}) => knex('products_catalog').insert({ name: F10, category: 'fertilizer', formulation: 'granular', active: true, needs_pricing: false, best_price: 31.81, ...fields }).returning('*');

    test('a bare row is not replaced: only its EMPTY analysis, slow-release and watering fields are filled; its price, copy and approval stay', async () => {
      const [row] = await existing({ public_summary: 'Hand-written copy.', approved_for_service_report: false, analysis_p: 0 });
      await migration.up(knex);
      expect(await knex('products_catalog').where({ name: F10 })).toHaveLength(1);
      const after = await newRow();
      expect(after).toMatchObject({ id: row.id, public_summary: 'Hand-written copy.', approved_for_service_report: false, needs_pricing: false, content_status: 'draft' });
      expect(Number(after.best_price)).toBe(31.81);
      expect([after.analysis_n, after.analysis_k, after.slow_release_n_pct].map(Number)).toEqual([10, 22, 50]);
      expect(after.post_application_watering).toEqual(migration.WATERING_RULE);
      for (const dec of await decemberRows()) expect(dec).toMatchObject({ product_name: F10, product_id: row.id });
      const [log] = await knex('lawn_protocol_audit_log').where({ action: migration.CATALOG_ACTION });
      expect(log.after_snapshot.inserted).toBeNull();
      expect(log.after_snapshot.filled.map((f) => f.column).sort()).toEqual(['analysis_k', 'analysis_n', 'post_application_watering', 'slow_release_n_pct']);
    });

    test('a complete row (the owner entered it) is not changed at all, not even its audit trail', async () => {
      const rule = { mode: 'water_in', water_in_inches: 0.5, water_in_by_hours: 12, source: 'owner', label_note: 'Owner edit.', verified_at: '2026-10-08T00:00:00.000Z', verified_by: 'owner' };
      await existing({ analysis_n: 10, analysis_p: 0, analysis_k: 22, slow_release_n_pct: 50, post_application_watering: JSON.stringify(rule) });
      const before = JSON.stringify(await newRow());
      await migration.up(knex);
      expect(JSON.stringify(await newRow())).toBe(before);
      expect(await knex('lawn_protocol_audit_log').where({ action: migration.CATALOG_ACTION })).toEqual([]);
      for (const dec of await decemberRows()) expect(dec).toMatchObject({ product_name: F10 });
    });

    test('down restores the filled fields only while they still hold the written value, and never deletes the row', async () => {
      await existing();
      await migration.up(knex);
      await knex('products_catalog').where({ name: F10 }).update({ analysis_k: 23 });
      await migration.down(knex);
      const after = await newRow();
      expect(after).toBeDefined();
      expect(Number(after.analysis_k)).toBe(23);
      expect([after.analysis_n, after.slow_release_n_pct, after.post_application_watering]).toEqual([null, null, null]);
      expect(Number(after.best_price)).toBe(31.81);
      for (const dec of await decemberRows()) expect(dec).toMatchObject({ product_name: F24, product_id: ids.f24 });
    });

    test('a row that exists only behind an alias is resolved, not duplicated', async () => {
      const [other] = await knex('products_catalog').insert({ name: 'LESCO 10-0-22 (SiteOne title)', category: 'fertilizer', active: true }).returning('*');
      await knex('product_aliases').insert({ product_id: other.id, alias_name: F10 });
      await migration.up(knex);
      expect(await knex('products_catalog').where({ name: F10 })).toEqual([]);
      for (const dec of await decemberRows()) expect(dec).toMatchObject({ product_name: F10, product_id: other.id });
    });
  });

  describe('protocols the migration does not own', () => {
    beforeEach(async () => { await reset(); });

    test('no v13 protocol: nothing is written, not even the catalog row', async () => {
      await knex('lawn_protocol_products').del(); await knex('lawn_protocol_windows').del(); await knex('lawn_protocols').where({ version: V13 }).del();
      await migration.up(knex);
      expect(await newRow()).toBeUndefined();
      expect(await ours()).toEqual([]);
    });

    test('a December window with no 24-0-11 row, or already on the 10-0-22, is skipped; the other protocol still swaps', async () => {
      const [a] = await decemberRows();
      await knex('lawn_protocol_products').where({ id: a.id }).update({ product_name: 'LESCO Dimension 0.21% 18-0-10 50% PolyPlus OPTI45 MOP Pre-Emergent Plus Fertilizer' });
      await migration.up(knex);
      const rows = await decemberRows();
      expect(rows.find((r) => r.id === a.id)).toMatchObject({ product_name: expect.stringMatching(/Dimension/), gates: DEC_GATES });
      expect(rows.find((r) => r.id !== a.id)).toMatchObject({ product_name: F10 });
      expect(await knex('lawn_protocol_audit_log').where({ action: migration.ACTION })).toHaveLength(1);
    });

    test('an older (non-v13) protocol version with the same window key is never touched', async () => {
      const [old] = await knex('lawn_protocols').where({ protocol_key: KEYS[0], version: '2026.06' });
      const [window] = await knex('lawn_protocol_windows').insert({ lawn_protocol_id: old.id, month: 12, window_key: DEC, title: DEC, visit_type: 'fixture', production_mode: 'spreader_plus_spot_backpack' }).returning('*');
      await knex('lawn_protocol_products').insert({ lawn_protocol_window_id: window.id, product_id: ids.f24, product_name: F24, role: 'nutrition', application_mode: 'broadcast', rate_unit: 'lb_n', gates: JSON.stringify(DEC_GATES) });
      await migration.up(knex);
      const rows = await decemberRows();
      expect(rows.filter((r) => r.product_name === F24)).toHaveLength(1);
      expect(rows.filter((r) => r.product_name === F10)).toHaveLength(KEYS.length);
    });
  });
});
