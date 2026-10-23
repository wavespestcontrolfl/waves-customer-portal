// Lawn protocol v13 December potassium bag for a mapped large patch: LESCO Black Out 0-0-24 AM Spar-TECH, migration
// 20261023121000, owner 2026-10-23. Real PostgreSQL schema clone; synthetic data only.
//
// Pinned: the catalog row is inserted once (a row that matches in any state, or by alias, makes up throw and write nothing) with NO
// price written; every v13 December window gains ONE non-default lb_k row and its 10-0-22 row, the other windows and every other row are
// untouched; the plan derives 4.125 lb from the stored row, the stored analysis and the 0.99 lb K2O target; down is all or nothing: a full
// no-op when any v13 protocol is referenced, any December row was edited or an actual uses it, an exact restore otherwise, and the
// catalog row goes only when unchanged, unpriced and unused.
const { createLawnHistoryDb } = require('./helpers/lawn-history-db');
const engine = require('../services/waveguard-plan-engine');
const v13Recipe = require('../config/lawn-protocol-v13.json');
const migration = require('../models/migrations/20261023121000_lawn_v13_dec_large_patch_potassium_v2');
const staged = require('../models/migrations/20261005120000_lawn_protocol_v13_staged');
const { validateRule } = require('../services/service-report/lawn-watering-rule');
const { approvedReportProductFacts } = require('../services/service-report/report-data');

const TEN = migration.FROM_NAME;
const BO = migration.NEW_NAME;
const V13 = staged.V13_VERSION;
const KEYS = ['fixture_dec_a', 'fixture_dec_b'];
const DEC = migration.DEC_WINDOW;
const NOV = 'nov_v13_spreader_feeding';
const DEC_GATES = { targetN: '0.45 lb N/1000', targetK2O: '0.99 lb K2O/1000', blackoutSensitive: true, fertilizerSafety: true };
const EXPECTED_GATES = { fertilizerSafety: true, targetK: '0.99 lb K2O/1000', trigger: 'active_large_patch_mapped' };
const CATALOG_TABLES = ['products_catalog', 'product_aliases', 'lawn_protocols', 'lawn_protocol_windows', 'lawn_protocol_products',
  'lawn_protocol_audit_log', 'lawn_protocol_service_completions', 'lawn_protocol_product_actuals', 'product_limits'];
const PRICES = ['best_price', 'best_vendor', 'cost_per_unit', 'cost_unit', 'best_vendor_pricing_id', 'best_price_amount_cached'];
const decVisit = () => v13Recipe.st_augustine.visits.find((v) => v.month === 'Dec');

describe('December 0-0-24: the catalog spec (no database)', () => {
  const { CATALOG } = migration;

  test('the catalog spec: a granular potassium fertilizer with no N or P, no EPA number, no price field, approved with plain copy', () => {
    expect(CATALOG).toMatchObject({
      name: BO, category: 'fertilizer', product_type: 'fertilizer', formulation: 'granular', container_size: '50 lb', unit_size_oz: 800,
      siteone_sku: '511512', epa_reg_number: 'N/A', analysis_n: 0, analysis_p: 0, analysis_k: 24, default_rate_per_1000: 4.1, rate_unit: 'lb',
      approved_for_service_report: true,
    });
    for (const field of ['best_price', 'best_vendor', 'cost_per_unit', 'cost_unit', 'needs_pricing', 'label_verified_at', 'label_version', 'slow_release_n_pct']) expect(CATALOG).not.toHaveProperty(field);
    expect(migration.INSERT_DEFAULTS).toEqual({ active: true, needs_pricing: true, content_status: 'draft', customer_visibility: 'internal_only' });
    expect(CATALOG.name.length).toBeLessThanOrEqual(150);
    expect(CATALOG.display_name.length).toBeLessThanOrEqual(80);
    expect(CATALOG.label_source_note).toMatch(/not read/);
    expect(CATALOG.label_source_note).toMatch(/\$30\.06/);
    expect(CATALOG.service_report_summary).toBe(migration.SUMMARY);
  });

  test('the bundled pricing import has the row under the catalog name with the SiteOne $30.06 / 50 lb figure', () => {
    const { parse } = require('csv-parse/sync');
    const rows = parse(require('fs').readFileSync(require('path').join(__dirname, '../data/pricing.csv'), 'utf8'), { columns: true, skip_empty_lines: true, relax_column_count: true });
    const hits = rows.filter((row) => /0-0-24/.test(row.Product));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ Product: BO, Vendor: 'SiteOne', Size: '50 lb', Price: '$30.06', Category: 'Fertilizer' });
  });

  test('the readiness list and the expectation class name it (a potassium feed, not a nitrogen feed)', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../routes/admin-inventory.js'), 'utf8');
    expect(src).toContain(`'${BO}', 'fertilizer', 'fertilizer'`);
    const { PRODUCT_CLASS_ENTRIES, FAMILY } = require('../config/lawn-expectations');
    expect(PRODUCT_CLASS_ENTRIES.find(([name]) => name === BO)[1]).toBe(FAMILY.POTASSIUM);
  });

  test('the recipe file is untouched by this change: the December line is the 10-0-22 and the gate-off visit text is the old one', () => {
    expect(decVisit().primary).toBe(`${TEN} — 4.5 lb per 1,000 sq ft (0.45 lb N, 0.99 lb K2O), spreader`);
    expect(engine.parseVisitNutrientTargets(decVisit().notes)).toEqual({ targetNPer1000: 0.45, targetKPer1000: 0.99 });
  });
});

describe('the first file name stays as an inert migration', () => {
  const inert = require('../models/migrations/20261023120000_lawn_v13_dec_large_patch_potassium');

  test('20261023120000 is kept (a database that recorded it needs the file) and does nothing in either direction', async () => {
    const knex = jest.fn(() => { throw new Error('the inert migration must not touch the database'); });
    knex.schema = { hasTable: jest.fn(() => { throw new Error('the inert migration must not touch the database'); }) };
    await expect(inert.up(knex)).resolves.toBeUndefined();
    await expect(inert.down(knex)).resolves.toBeUndefined();
    expect(knex).not.toHaveBeenCalled();
    expect(knex.schema.hasTable).not.toHaveBeenCalled();
    expect(Object.keys(inert).sort()).toEqual(['down', 'up']);
    expect(require('fs').readFileSync(require('path').join(__dirname, '../models/migrations/20261023120000_lawn_v13_dec_large_patch_potassium.js'), 'utf8')).toMatch(/Superseded by 20261023121000/i);
  });

  test('the real migration is the later file, and exactly these two share the name', () => {
    const files = require('fs').readdirSync(require('path').join(__dirname, '../models/migrations')).filter((name) => /dec_large_patch_potassium/.test(name)).sort();
    expect(files).toEqual(['20261023120000_lawn_v13_dec_large_patch_potassium.js', '20261023121000_lawn_v13_dec_large_patch_potassium_v2.js']);
  });
});

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

describeDb('v13 December 0-0-24 migration through PostgreSQL', () => {
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
  }, 120000);
  afterAll(async () => { if (owned) await owned.dispose(); });

  const newRow = () => knex('products_catalog').where({ name: BO }).first();
  const decRows = (name) => knex('lawn_protocol_products as p')
    .join('lawn_protocol_windows as w', 'p.lawn_protocol_window_id', 'w.id')
    .join('lawn_protocols as l', 'w.lawn_protocol_id', 'l.id')
    .where({ 'w.window_key': DEC, 'p.product_name': name })
    .orderBy('l.protocol_key').select('p.*', 'l.protocol_key');
  const ours = () => knex('lawn_protocol_audit_log').whereIn('action', [migration.ACTION, migration.CATALOG_ACTION]);
  const strip = (rows) => rows.map(({ updated_at: _u, ...rest }) => rest);
  const snapshot = async () => ({
    products: strip(await knex('lawn_protocol_products').orderBy('id')),
    catalog: strip(await knex('products_catalog').orderBy('id')),
    audit: (await knex('lawn_protocol_audit_log').orderBy('id')).map(({ id: _i, created_at: _c, ...rest }) => rest),
  });

  // A clean fixture: the catalog as main leaves it (the 10-0-22), two v13 protocols with their December windows and a November decoy.
  async function reset() {
    for (const table of ['lawn_protocol_product_actuals', 'service_products', 'product_limits', 'lawn_protocol_audit_log', 'lawn_protocol_products', 'lawn_protocol_windows',
      'lawn_protocol_service_completions', 'lawn_protocols', 'product_aliases', 'products_catalog']) await knex(table).del();
    await knex('scheduled_services').update({ lawn_protocol_key: null, lawn_protocol_version: null });
    const [ten] = await knex('products_catalog').insert({ name: TEN, category: 'fertilizer', formulation: 'granular', analysis_n: 10, analysis_p: 0, analysis_k: 22, slow_release_n_pct: 50, default_rate_per_1000: 4.5, rate_unit: 'lb', unit_size_oz: 800, active: true }).returning('*');
    ids.ten = ten.id;
    for (const key of KEYS) {
      await knex('lawn_protocols').insert({ protocol_key: key, version: '2026.06', name: 'Fixture old', status: 'active', grass_track: 'bermuda', region: 'swfl' });
      const [protocol] = await knex('lawn_protocols').insert({ protocol_key: key, version: V13, name: 'Fixture v13', status: 'staged', grass_track: 'bermuda', region: 'swfl', effective_from: '2000-01-01' }).returning('*');
      const [dec] = await knex('lawn_protocol_windows').insert({ lawn_protocol_id: protocol.id, month: 12, window_key: DEC, title: DEC, visit_type: 'granular_production_plus_spots', production_mode: 'spreader_plus_spot_backpack', goal: 'One spreader feeding.' }).returning('*');
      const [nov] = await knex('lawn_protocol_windows').insert({ lawn_protocol_id: protocol.id, month: 11, window_key: NOV, title: NOV, visit_type: 'fixture', production_mode: 'spreader_plus_spot_backpack', goal: 'November fixture' }).returning('*');
      await knex('lawn_protocol_products').insert([
        { lawn_protocol_window_id: dec.id, product_id: ten.id, product_name: TEN, role: 'nutrition', application_mode: 'broadcast', rate_unit: 'lb_n', default_in_plan: true, sort_order: 30, gates: JSON.stringify(DEC_GATES) },
        // November carries a 10-0-22 row too (a fixture decoy): the migration reads the December window only.
        { lawn_protocol_window_id: nov.id, product_id: ten.id, product_name: TEN, role: 'nutrition', application_mode: 'broadcast', rate_unit: 'lb_n', default_in_plan: true, sort_order: 40, gates: JSON.stringify({ targetN: '0.75 lb N/1000' }) },
      ]);
    }
  }

  describe('fresh path: the catalog has no 0-0-24 row', () => {
    beforeAll(async () => { await reset(); await migration.up(knex); });

    test('one catalog row is inserted, with no price field, pending pricing, and approved for the report', async () => {
      const rows = await knex('products_catalog').where({ name: BO });
      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row).toMatchObject({
        category: 'fertilizer', product_type: 'fertilizer', formulation: 'granular', container_size: '50 lb', siteone_sku: '511512', epa_reg_number: 'N/A',
        rate_unit: 'lb', active: true, needs_pricing: true, content_status: 'draft', customer_visibility: 'internal_only',
        approved_for_service_report: true, public_summary: migration.SUMMARY, service_report_summary: migration.SUMMARY, customer_precaution_summary: migration.PRECAUTION,
        display_name: 'LESCO Black Out 0-0-24 Potash',
      });
      expect([row.analysis_n, row.analysis_p, row.analysis_k, row.default_rate_per_1000, row.unit_size_oz].map(Number)).toEqual([0, 0, 24, 4.1, 800]);
      expect(PRICES.map((column) => row[column])).toEqual([null, null, null, null, null, null]);
      expect(row.post_application_watering).toEqual(migration.WATERING_RULE);
      expect(validateRule(row.post_application_watering).valid).toBe(true);
    });

    test('the stored row freezes into report facts as a fertilizer with the 0.25 inch water-in and the customer copy (the customer watering text goes out)', async () => {
      const facts = approvedReportProductFacts(await newRow());
      expect(facts).toMatchObject({ productType: 'fertilizer', serviceReportSummary: migration.SUMMARY, precautionSummary: migration.PRECAUTION, epaRegNumber: null });
      expect(facts.wateringRule).toMatchObject({ mode: 'water_in', water_in_inches: 0.25, water_in_by_hours: 24, source: 'owner' });
    });

    test('every v13 protocol\'s December window gains ONE lb_k row: not a default, K target and trigger, the 10-0-22 row\'s safety gate copied, its nitrogen keys not', async () => {
      const row = await newRow();
      const rows = await decRows(BO);
      expect(rows).toHaveLength(KEYS.length);
      for (const dec of rows) {
        expect(dec).toMatchObject({ product_name: BO, product_id: row.id, role: 'nutrition', rate_unit: 'lb_k', rate_per_1000: null, default_in_plan: false, sort_order: 31, application_mode: 'broadcast', carrier_gal_per_1000: null });
        expect(dec.gates).toEqual(EXPECTED_GATES);
        expect(Object.keys(dec.gates)).not.toEqual(expect.arrayContaining(['targetN']));
      }
    });

    test('the 10-0-22 rows and the November rows are exactly as they were', async () => {
      for (const dec of await decRows(TEN)) expect(dec).toMatchObject({ product_id: ids.ten, gates: DEC_GATES, rate_unit: 'lb_n', default_in_plan: true, sort_order: 30 });
      expect((await decRows(TEN)).length).toBe(KEYS.length);
      const november = await knex('lawn_protocol_products as p').join('lawn_protocol_windows as w', 'p.lawn_protocol_window_id', 'w.id').where({ 'w.window_key': NOV }).select('p.*');
      expect(november).toHaveLength(KEYS.length);
      for (const nov of november) expect(nov).toMatchObject({ product_name: TEN, gates: { targetN: '0.75 lb N/1000' } });
      const goals = await knex('lawn_protocol_windows').where({ window_key: DEC }).pluck('goal');
      expect(new Set(goals)).toEqual(new Set(['One spreader feeding.']));
    });

    test('the plan derives 4.125 lb per 1,000 from the 0.99 lb K2O target and the stored analysis: 41.25 lb on 10,000 sq ft, 0 lb N, no cost while unpriced', async () => {
      const product = await newRow();
      const [dec] = await decRows(BO);
      const row = { ratePer1000: dec.rate_per_1000, rateUnit: dec.rate_unit, gates: dec.gates };
      expect(engine.v13RowCalculates({ applicationMode: dec.application_mode, ...row })).toBe(true);
      const mix = engine.calculateProductAmount({ product, lawnSqft: 10000, areaFactor: 1, targetNPer1000: 0, targetKPer1000: 0.99, ...engine.v13RateOptions(row) });
      expect(mix).toMatchObject({ rateSource: 'target_k_analysis', rateUnit: 'lb', targetKPer1000: 0.99, materialCost: null, materialCostSource: null });
      expect(mix.ratePer1000).toBeCloseTo(4.125, 3);
      expect(mix.amount).toBeCloseTo(41.25, 2);
      expect(mix.ratePer1000 * Number(product.analysis_k) / 100).toBeCloseTo(0.99, 3);
      expect(mix.ratePer1000 * Number(product.analysis_n) / 100).toBe(0);
      const summary = engine.summarizeMaterialCost([{ selected: true, product, mix }]);
      expect(summary).toMatchObject({ pricedLineCount: 0, total: 0, missingPriceCount: 1, source: 'unavailable' });
      // Priced the way Inventory prices it (SiteOne $30.06 for the 50 lb bag, 800 oz): the same plan has a cost line.
      const priced = engine.calculateProductAmount({ product: { ...product, best_price: 30.06 }, lawnSqft: 10000, areaFactor: 1, targetNPer1000: 0, targetKPer1000: 0.99, ...engine.v13RateOptions(row) });
      expect(priced.materialCost).toBeCloseTo(24.8, 1);
      // Without the target (a row that lost it) the catalog default rate still plans 4.1 lb.
      expect(engine.calculateProductAmount({ product, lawnSqft: 1000, areaFactor: 1 })).toMatchObject({ rateSource: 'catalog_default_rate', amount: 4.1 });
    });

    test('audit: one row per protocol with the row as written, and one catalog row naming the inserted product', async () => {
      const protocolLogs = await knex('lawn_protocol_audit_log').where({ action: migration.ACTION });
      expect(protocolLogs).toHaveLength(KEYS.length);
      const productId = (await newRow()).id;
      for (const log of protocolLogs) {
        expect(log.after_snapshot.rows).toHaveLength(1);
        // The whole row as written (down() compares every one of these columns), the window link included.
        const stored = log.after_snapshot.rows[0];
        expect(stored.after).toEqual({
          lawn_protocol_window_id: expect.any(String), product_id: productId, product_name: BO, role: 'nutrition', application_mode: 'broadcast', rate_per_1000: null,
          rate_unit: 'lb_k', carrier_gal_per_1000: null, default_in_plan: false, gates: EXPECTED_GATES, annual_counter: {}, mixing: {}, report_copy: { role: 'nutrition' }, sort_order: 31,
        });
        const written = await knex('lawn_protocol_products').where({ id: stored.rowId }).first();
        expect(written.lawn_protocol_window_id).toBe(stored.after.lawn_protocol_window_id);
      }
      const catalogLogs = await knex('lawn_protocol_audit_log').where({ action: migration.CATALOG_ACTION });
      expect(catalogLogs).toHaveLength(1);
      expect(catalogLogs[0].lawn_protocol_id).toBeNull();
      expect(catalogLogs[0].after_snapshot).toMatchObject({ productId });
      expect(catalogLogs[0].after_snapshot.inserted).toMatchObject({ name: BO, ...migration.INSERT_DEFAULTS });
    });
  });

  describe('a catalog row that already matches, in ANY state: up throws and writes nothing', () => {
    beforeEach(async () => { await reset(); });
    const GOOD = { name: BO, category: 'fertilizer', active: true, analysis_n: 0, analysis_p: 0, analysis_k: 24 };
    const everything = async () => ({ catalog: strip(await knex('products_catalog').orderBy('id')), products: strip(await knex('lawn_protocol_products').orderBy('id')), audit: await knex('lawn_protocol_audit_log') });

    test.each([
      ['a correct active row', {}],
      ['an inactive row', { active: false }],
      ['an active-unset row', { active: null }],
      ['analysis_k 22', { analysis_k: 22 }],
      ['analysis empty', { analysis_n: null, analysis_p: null, analysis_k: null }],
    ])('%s: throws, nothing linked, nothing changed, no audit row', async (_label, change) => {
      await knex('products_catalog').insert({ ...GOOD, ...change });
      const before = await everything();
      await expect(migration.up(knex)).rejects.toThrow(/already exists; this migration only inserts/);
      expect(await everything()).toEqual(before);
      expect(await decRows(BO)).toEqual([]);
      expect((await decRows(TEN)).length).toBe(KEYS.length);
    });

    test('an alias-only match (even a correct row under another name) throws', async () => {
      const [other] = await knex('products_catalog').insert({ ...GOOD, name: 'LESCO Black Out Potash 0-0-24' }).returning('*');
      await knex('product_aliases').insert({ product_id: other.id, alias_name: BO });
      const before = await everything();
      await expect(migration.up(knex)).rejects.toThrow(/already exists/);
      expect(await everything()).toEqual(before);
    });

    test('a row whose name differs only in case or spacing still throws', async () => {
      await knex('products_catalog').insert({ ...GOOD, name: BO.toUpperCase().replace(/ /g, '  ') });
      await expect(migration.up(knex)).rejects.toThrow(/already exists/);
    });

    test('a failed up leaves the database as it was, and a second try after the row is removed inserts normally', async () => {
      const [stray] = await knex('products_catalog').insert({ ...GOOD, active: false }).returning('*');
      await expect(migration.up(knex)).rejects.toThrow();
      await knex('products_catalog').where({ id: stray.id }).del();
      await migration.up(knex);
      expect((await decRows(BO)).length).toBe(KEYS.length);
    });
  });

  describe('re-running', () => {
    beforeEach(async () => { await reset(); });

    test('a second plain up changes nothing and writes no second audit row', async () => {
      await migration.up(knex);
      const once = await snapshot();
      await migration.up(knex);
      expect(await snapshot()).toEqual(once);
    });

    test('after a rollback that did nothing the migration finds its own inserted row and carries on without a second insert or a throw', async () => {
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

    test('clean up then down is the starting state exactly; up again is the first up (new ids aside)', async () => {
      const start = await snapshot();
      await migration.up(knex);
      const upped = await snapshot();
      await migration.down(knex);
      expect(await snapshot()).toEqual(start);
      await migration.up(knex);
      const again = await snapshot();
      const [row] = again.catalog.filter((c) => c.name === BO);
      expect(again.products.filter((p) => p.product_name === BO).every((p) => p.product_id === row.id)).toBe(true);
      const bare = (rows) => rows.map(({ id: _i, product_id: _p, created_at: _c, ...rest }) => JSON.stringify(rest)).sort();
      expect(bare(again.products)).toEqual(bare(upped.products));
      const byName = (rows) => rows.map(({ id: _i, created_at: _c, ...rest }) => rest).sort((x, y) => x.name.localeCompare(y.name));
      expect(byName(again.catalog)).toEqual(byName(upped.catalog));
      expect(await ours()).toHaveLength(KEYS.length + 1);
    });

    test('a visit pinned to ANY v13 protocol makes down a full no-op: every December row, the catalog row and every audit row stay', async () => {
      await migration.up(knex);
      const upped = await snapshot();
      await pin(KEYS[0]); // pinned to one protocol only: the other protocol is NOT reverted either
      await migration.down(knex);
      expect(await snapshot()).toEqual(upped);
      expect((await decRows(BO)).length).toBe(KEYS.length);
    });

    test('a completion that references a v13 protocol makes down a full no-op', async () => {
      await migration.up(knex);
      const upped = await snapshot();
      const [protocol] = await knex('lawn_protocols').where({ version: V13, protocol_key: KEYS[1] });
      const completionColumns = await knex('lawn_protocol_service_completions').columnInfo();
      const row = { lawn_protocol_id: protocol.id, protocol_key: KEYS[1], protocol_version: V13 };
      for (const [column, info] of Object.entries(completionColumns)) {
        if (column in row || column === 'id' || info.nullable || info.defaultValue != null) continue;
        row[column] = info.type.includes('uuid') ? require('crypto').randomUUID() : info.type.includes('int') ? 1 : info.type.includes('timestamp') ? new Date() : info.type === 'date' ? '2026-12-15' : info.type.includes('json') ? '{}' : 'fixture';
      }
      await knex('lawn_protocol_service_completions').insert(row);
      await migration.down(knex);
      expect(await snapshot()).toEqual(upped);
    });

    test.each([
      ['renamed', () => ({ product_name: 'Fixture renamed by staff' })],
      ['re-linked to another product', () => ({ product_id: ids.ten })],
      ['re-gated (a gate value)', (a) => ({ gates: JSON.stringify({ ...a.gates, targetK: '1.2 lb K2O/1000' }) })],
      ['given an extra gate', (a) => ({ gates: JSON.stringify({ ...a.gates, extra: true }) })],
      ['stripped of a gate', (a) => ({ gates: JSON.stringify({ targetK: a.gates.targetK }) })],
      ['made a default of the plan', () => ({ default_in_plan: true })],
      ['changed to a nitrogen row', () => ({ rate_unit: 'lb_n' })],
      ['given a stated rate', () => ({ rate_per_1000: 4.1 })],
      ['switched to spot mode', () => ({ application_mode: 'spot' })],
      ['given another role', () => ({ role: 'fungicide_spot' })],
      ['given a carrier', () => ({ carrier_gal_per_1000: 2 })],
      ['reordered', () => ({ sort_order: 5 })],
      ['given an annual counter', () => ({ annual_counter: JSON.stringify({ perYear: 1 }) })],
      ['given mixing notes', () => ({ mixing: JSON.stringify({ with: 'x' }) })],
      ['given other report copy', () => ({ report_copy: JSON.stringify({ role: 'x' }) })],
    ])('one December row %s by staff makes down a full no-op: the other protocol is NOT reverted, the catalog row stays', async (_label, change) => {
      await migration.up(knex);
      const upped = await snapshot();
      const [a] = await decRows(BO);
      await knex('lawn_protocol_products').where({ id: a.id }).update(change(a));
      const edited = await snapshot();
      await migration.down(knex);
      expect(await snapshot()).toEqual(edited);
      expect(edited.audit).toEqual(upped.audit);
      const logged = (await knex('lawn_protocol_audit_log').where({ action: migration.ACTION })).flatMap((log) => log.after_snapshot.rows.map((row) => row.rowId));
      expect(await knex('lawn_protocol_products').whereIn('id', logged)).toHaveLength(KEYS.length);
      expect(await newRow()).toBeTruthy();
    });

    test('a December row moved to another window (the window link changed) makes down a full no-op', async () => {
      await migration.up(knex);
      const upped = await snapshot();
      const [a] = await decRows(BO);
      const [other] = await knex('lawn_protocol_windows').where({ window_key: NOV }).whereNot({ id: a.lawn_protocol_window_id }).select('id');
      await knex('lawn_protocol_products').where({ id: a.id }).update({ lawn_protocol_window_id: other.id });
      const edited = await snapshot();
      await migration.down(knex);
      expect(await snapshot()).toEqual(edited);
      expect(edited.audit).toEqual(upped.audit);
      expect(await newRow()).toBeTruthy();
    });

    test('a December row moved to the same protocol\'s November window also makes down a full no-op', async () => {
      await migration.up(knex);
      const [a] = await decRows(BO);
      const protocolId = (await knex('lawn_protocol_windows').where({ id: a.lawn_protocol_window_id }).first('lawn_protocol_id')).lawn_protocol_id;
      const nov = await knex('lawn_protocol_windows').where({ lawn_protocol_id: protocolId, window_key: NOV }).first('id');
      await knex('lawn_protocol_products').where({ id: a.id }).update({ lawn_protocol_window_id: nov.id });
      const edited = await snapshot();
      await migration.down(knex);
      expect(await snapshot()).toEqual(edited);
    });

    test('the audit record lost or cut down to the old partial snapshot (as the first file left it) makes down a full no-op', async () => {
      await migration.up(knex);
      const logs = await knex('lawn_protocol_audit_log').where({ action: migration.ACTION });
      const first = logs[0].after_snapshot.rows[0];
      await knex('lawn_protocol_audit_log').where({ id: logs[0].id }).update({ after_snapshot: JSON.stringify({ rows: [{ rowId: first.rowId, after: { product_name: first.after.product_name, product_id: first.after.product_id, gates: first.after.gates } }] }) });
      const edited = await snapshot();
      await migration.down(knex);
      expect(await snapshot()).toEqual(edited);
    });

    test('a December row a completion actual references makes down a full no-op (the actual keeps its link)', async () => {
      await migration.up(knex);
      const upped = await snapshot();
      const [a] = await decRows(BO);
      await knex('lawn_protocol_product_actuals').insert({ lawn_protocol_service_completion_id: require('crypto').randomUUID(), protocol_product_id: a.id, product_name: BO, status: 'applied' });
      await migration.down(knex);
      expect(await snapshot()).toEqual(upped);
      expect((await decRows(BO)).length).toBe(KEYS.length);
    });

    test('a December row staff deleted makes down a full no-op', async () => {
      await migration.up(knex);
      const [a] = await decRows(BO);
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
      ['re-rated', { default_rate_per_1000: 4.2 }],
      ['given a stray analysis', { analysis_n: 3 }],
      ['given another SKU', { siteone_sku: '999' }],
      ['given another container size', { container_size: '25 lb' }],
      ['given another watering rule', { post_application_watering: JSON.stringify({ mode: 'none', source: 'owner' }) }],
      ['given other report copy', { service_report_summary: 'Changed by staff.' }],
      ['deactivated', { active: false }],
    ])('a catalog row staff %s makes down a full no-op: the December rows stay too', async (_label, change) => {
      await migration.up(knex);
      const upped = await snapshot();
      await knex('products_catalog').where({ name: BO }).update(change);
      const edited = await snapshot();
      await migration.down(knex);
      expect(await snapshot()).toEqual(edited);
      expect(edited.audit).toEqual(upped.audit);
      expect((await decRows(BO)).length).toBe(KEYS.length);
    });

    test('a catalog row something else references (an application limit) makes down a full no-op: the December rows stay', async () => {
      await migration.up(knex);
      const upped = await snapshot();
      const product = await newRow();
      await knex('product_limits').insert({ product_id: product.id, limit_type: 'annual_max_apps', limit_value: 2, limit_unit: 'applications', severity: 'warning' });
      await migration.down(knex);
      expect((await decRows(BO)).length).toBe(KEYS.length);
      expect(await newRow()).toBeTruthy();
      expect((await snapshot()).audit).toEqual(upped.audit);
    });

    test('a catalog row an unrelated column was touched on (updated_at only) still rolls back: only the written columns are compared', async () => {
      await migration.up(knex);
      await knex('products_catalog').where({ name: BO }).update({ updated_at: new Date('2030-01-01T00:00:00Z') });
      await migration.down(knex);
      expect(await decRows(BO)).toEqual([]);
      expect(await newRow()).toBeUndefined();
      expect(await ours()).toHaveLength(0);
    });
  });

  describe('protocols the migration skips', () => {
    beforeEach(async () => { await reset(); });

    test('a December window with no 10-0-22 row is skipped (the catalog row is still inserted); without a v13 protocol nothing is written', async () => {
      await knex('lawn_protocol_products').where({ product_name: TEN }).whereIn('lawn_protocol_window_id', knex('lawn_protocol_windows').where({ window_key: DEC }).select('id')).del();
      await migration.up(knex);
      expect(await decRows(BO)).toEqual([]);
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

    test('a window that already has the product is skipped, so a half-applied state is completed without a duplicate', async () => {
      await migration.up(knex);
      const [a] = await decRows(BO);
      await knex('lawn_protocol_products').where({ id: a.id }).del();
      await knex('lawn_protocol_audit_log').where({ action: migration.ACTION }).whereRaw("after_snapshot::text like ?", [`%${a.id}%`]).del();
      await migration.up(knex);
      expect((await decRows(BO)).length).toBe(KEYS.length);
    });
  });
});
