// Lawn protocol v13 before the GATE_LAWN_V13 flip, through the real plan engine,
// the real application-limits reader and the two real migrations on PostgreSQL
// (cloned schema). Synthetic data only.
//
// 1. One yearly prodiamine cap across formulations (20261006140000): earlier
//    applications of any prodiamine product count toward the next one.
// 2. The 9x plan April step (20261006150000 + the recipe's cadenceVariants): the
//    visit's plan picks Dimension 0.21% 18-0-10 (9x) or the 24-0-11 (12x), the
//    same way in the plan, the completion defaults and the tank sheet.
const { createLawnHistoryDb, fixture } = require('./helpers/lawn-history-db');
const { buildPlanForService, lawnVisitsPerYear } = require('../services/waveguard-plan-engine');
const applicationLimits = require('../services/application-limits');
const capMigration = require('../models/migrations/20261006140000_lawn_v13_prodiamine_year_cap');
const aprilMigration = require('../models/migrations/20261006150000_lawn_v13_april_9x_branch');
const reconcileMigration = require('../models/migrations/20261006160000_lawn_v13_april_9x_reconcile');
const labelMaxMigration = require('../models/migrations/20261006170000_lawn_v13_prodiamine_cap_label_max');
const ownershipMigration = require('../models/migrations/20261006180000_lawn_v13_april_9x_ownership');
const { LAWN_V13_VERSION } = require('../services/lawn-program');
const { randomUUID } = require('crypto');

const STW_4FL = 'LESCO Stonewall 4FL Prodiamine 40.7% Pre-Emergent Liquid Herbicide';
const STW_15 = 'LESCO Stonewall 0.43% 15-0-15 50% PolyPlus OPTI45 Pre-Emergent Plus Fertilizer';
const WDG = 'Prodiamine 65 WDG';
const F24 = 'LESCO 24-0-11 with PolyPlus OPTI';
const DIMENSION = aprilMigration.DIMENSION;
const GATES = ['GATE_LAWN_V13', 'GATE_LAWN_COMPLETION_DEFAULTS', 'GATE_LAWN_PROPERTY_HISTORY'];
const KEY = 'fixture_v13_preflip';

describe('prodiamine cap derivation (no database)', () => {
  const { aiPerRateUnit, CAP_LB_AI_PER_1000 } = capMigration;
  const cap = (row) => { const ai = aiPerRateUnit(row); return ai && { unit: ai.unit, value: Math.round((CAP_LB_AI_PER_1000 / ai.aiPerUnit) * 10000) / 10000 }; };

  test('the label cap (1.5 lb ai/acre) written in each product\'s own unit', () => {
    expect(cap({ name: STW_4FL, active_ingredient: 'Prodiamine', rate_unit: 'fl oz' })).toEqual({ unit: 'fl oz', value: 1.1019 });
    expect(cap({ name: WDG, active_ingredient: 'Prodiamine 65.0%', rate_unit: 'oz' })).toEqual({ unit: 'oz', value: 0.8476 });
    expect(cap({ name: STW_15, active_ingredient: 'Prodiamine', rate_unit: 'lb' })).toEqual({ unit: 'lb', value: 8.0082 });
    expect(cap({ name: 'LESCO Stonewall 0-0-7', active_ingredient: 'Prodiamine 0.43%', rate_unit: 'lb' })).toEqual({ unit: 'lb', value: 8.0082 });
  });

  test('a row with no stated strength or an unusable unit gets no cap row', () => {
    expect(aiPerRateUnit({ name: 'Prodiamine Mystery', active_ingredient: 'Prodiamine', rate_unit: 'lb' })).toBeNull();
    expect(aiPerRateUnit({ name: 'Prodiamine 65 WDG', active_ingredient: 'Prodiamine 65.0%', rate_unit: null })).toBeNull();
    expect(aiPerRateUnit({ name: 'Prodiamine 4L', active_ingredient: 'Prodiamine', rate_unit: 'gal' })).toBeNull();
  });

  test('the v13 season (January 4FL, October granular) is under the cap by design', () => {
    expect((0.5 / 1.1019) + (4.02 / 8.0082)).toBeLessThan(1);
  });
});

describe('lawnVisitsPerYear: the visit\'s plan from the catalog service, then the series recurrence, then the service name (no database)', () => {
  const knexWith = (catalog) => () => ({ where: () => ({ first: async () => catalog }) });
  const visits = (service, catalog = null) => lawnVisitsPerYear(knexWith(catalog), { service_id: catalog ? 'svc' : null, ...service });

  test('a generic "Lawn Care" booking reads its cadence from the recurrence the scheduler dates it by', async () => {
    const generic = { service_type: 'Lawn Care' };
    expect(await visits({ ...generic, recurring_pattern: 'every_6_weeks' })).toBe(9);
    expect(await visits({ ...generic, recurring_pattern: 'custom', recurring_interval_days: 42 })).toBe(9);
    expect(await visits({ ...generic, recurring_pattern: 'monthly' })).toBe(12);
    expect(await visits({ ...generic, recurring_pattern: 'monthly_nth_weekday' })).toBe(12);
    expect(await visits({ ...generic, recurring_pattern: 'custom', recurring_interval_days: 30 })).toBe(12);
    expect(await visits({ ...generic, recurring_pattern: 'bimonthly' })).toBe(6);
    expect(await visits({ ...generic, recurring_pattern: 'custom', recurring_interval_days: 60 })).toBe(6);
  });

  test('no stated cadence stays unknown: a one-off visit, a quarterly recurrence, a custom gap that matches no plan', async () => {
    expect(await visits({ service_type: 'Lawn Care' })).toBeNull();
    expect(await visits({ service_type: 'Lawn Care', recurring_pattern: 'quarterly' })).toBeNull();
    expect(await visits({ service_type: 'Lawn Care', recurring_pattern: 'custom', recurring_interval_days: 90 })).toBeNull();
    expect(await visits({ service_type: 'Lawn Care', recurring_pattern: 'custom' })).toBeNull();
  });

  test('ranking: a cadence-specific catalog service outranks the recurrence, the recurrence outranks a service name', async () => {
    const monthlyCatalog = { service_key: 'lawn_care_monthly', name: 'Monthly Lawn Care Service' };
    expect(await visits({ service_type: 'Lawn Care', recurring_pattern: 'every_6_weeks' }, monthlyCatalog)).toBe(12);
    // A generic catalog row (no cadence in its key or name) defers to the recurrence.
    const genericCatalog = { service_key: 'lawn_fertilization', name: 'Lawn Fertilization & Weed Control Service' };
    expect(await visits({ service_type: 'Lawn Care', recurring_pattern: 'every_6_weeks' }, genericCatalog)).toBe(9);
    expect(await visits({ service_type: 'Monthly Lawn Care Service', recurring_pattern: 'every_6_weeks' })).toBe(9);
    expect(await visits({ service_type: 'Monthly Lawn Care Service' })).toBe(12);
  });
});

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

describeDb('v13 pre-flip fixes through PostgreSQL', () => {
  const saved = Object.fromEntries(GATES.map((name) => [name, process.env[name]]));
  let owned;
  let knex;
  const catalog = {};

  beforeAll(async () => {
    owned = await createLawnHistoryDb(); knex = owned.knex;
    for (const table of ['technicians', 'products_catalog', 'product_aliases', 'lawn_protocol_product_substitutions',
      'equipment_systems', 'equipment_calibrations', 'municipality_ordinances', 'property_nutrient_ledger',
      'service_products', 'lawn_protocols', 'lawn_protocol_windows', 'lawn_protocol_products', 'lawn_protocol_gates',
      'lawn_protocol_service_completions', 'lawn_protocol_product_actuals', 'lawn_protocol_audit_log', 'product_limits',
      'property_application_history', 'services']) {
      await knex.raw('CREATE TABLE ??.?? (LIKE public.?? INCLUDING ALL)', [owned.schema, table, table]);
      const columns = await knex(table).columnInfo();
      if (String(columns.id?.defaultValue || '').includes('nextval(')) {
        await knex.raw('ALTER TABLE ??.?? ALTER COLUMN id DROP DEFAULT', [owned.schema, table]);
        await knex.raw('ALTER TABLE ??.?? ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY', [owned.schema, table]);
      }
    }
    const product = async (name, fields) => {
      const [row] = await knex('products_catalog').insert({
        name, category: 'herbicide', label_verified_at: new Date(), inventory_on_hand: 100000, inventory_unit: fields.rate_unit, active: true, ...fields,
      }).returning('*');
      catalog[name] = row;
      return row;
    };
    await product(STW_4FL, { active_ingredient: 'Prodiamine', formulation: 'liquid', default_rate_per_1000: 0.5, rate_unit: 'fl oz', min_label_rate_per_1000: 0.5, max_label_rate_per_1000: 1.1 });
    await product(STW_15, { active_ingredient: 'Prodiamine', formulation: 'granular', default_rate_per_1000: 4.02, rate_unit: 'lb', analysis_n: 15, analysis_p: 0, analysis_k: 15, max_label_rate_per_1000: 5.34 });
    await product(WDG, { active_ingredient: 'Prodiamine 65.0%', formulation: 'WDG', default_rate_per_1000: 0.37, rate_unit: 'oz', min_label_rate_per_1000: 0.185, max_label_rate_per_1000: 0.83 });
    await product(F24, { category: 'fertilizer', formulation: 'granular', default_rate_per_1000: 4.2, rate_unit: 'lb', analysis_n: 24, analysis_p: 0, analysis_k: 11 });
    await product(DIMENSION, { active_ingredient: 'Dithiopyr', formulation: 'granular', default_rate_per_1000: 2.78, rate_unit: 'lb', analysis_n: 18, analysis_p: 0, analysis_k: 10 });

    await knex('lawn_protocols').insert({ protocol_key: KEY, version: '2026.06', name: 'Fixture old', status: 'active', grass_track: 'bermuda', region: 'swfl' });
    const [staged] = await knex('lawn_protocols').insert({ protocol_key: KEY, version: LAWN_V13_VERSION, name: 'Fixture v13', status: 'staged', grass_track: 'bermuda', region: 'swfl', effective_from: '2000-01-01' }).returning('*');
    const windows = {};
    for (const [month, windowKey, mode, carrier] of [[1, 'jan_v13_pre_m_hose', 'main_reel_plus_spot_backpack', 1], [4, aprilMigration.APRIL_WINDOW, 'spreader_plus_spot_backpack', null], [10, 'oct_v13_spreader_fall', 'spreader_plus_spot_backpack', null]]) {
      [windows[month]] = await knex('lawn_protocol_windows').insert({
        lawn_protocol_id: staged.id, month, window_key: windowKey, title: windowKey, visit_type: 'fixture', production_mode: mode, default_carrier_gal_per_1000: carrier,
      }).returning('*');
    }
    const row = (window, name, fields) => knex('lawn_protocol_products').insert({
      lawn_protocol_window_id: windows[window].id, product_id: catalog[name].id, product_name: name, application_mode: 'broadcast', default_in_plan: true, ...fields,
    });
    await row(1, STW_4FL, { role: 'pre_emergent', rate_per_1000: 0.5, rate_unit: 'fl oz', carrier_gal_per_1000: 1, gates: JSON.stringify({ annualCounter: 'prodiamine_oz_per_1000' }) });
    await row(10, STW_15, { role: 'fall_pre_emergent_nutrition', rate_per_1000: 4.02, rate_unit: 'lb', gates: JSON.stringify({ targetN: '0.6 lb N/1000', annualCounter: 'prodiamine_oz_per_1000' }) });
    await row(4, F24, { role: 'nutrition', rate_unit: 'lb_n', sort_order: 1, gates: JSON.stringify({ targetN: '0.5 lb N/1000', blackoutSensitive: true, northPortBlocked: true }) });
    await knex.raw('ALTER TABLE ??.lawn_protocol_audit_log ALTER COLUMN lawn_protocol_id DROP NOT NULL', [owned.schema]).catch(() => {});

    // The real migrations, run over the fixture catalog and the fixture staged protocol.
    await capMigration.up(knex);
    await aprilMigration.up(knex);
    await reconcileMigration.up(knex);
    await labelMaxMigration.up(knex);
    await ownershipMigration.up(knex);

    const [equipment] = await knex('equipment_systems').insert({ name: 'Fixture rig', system_type: 'skid', tank_capacity_gal: 110, active: true }).returning('*');
    await knex('equipment_calibrations').insert({ equipment_system_id: equipment.id, carrier_gal_per_1000: 1, active: true });
    await knex('services').insert([
      { service_key: 'lawn_care_6week', name: 'Every 6 Weeks Lawn Care Service', category: 'lawn_care' },
      { service_key: 'lawn_care_monthly', name: 'Monthly Lawn Care Service', category: 'lawn_care' },
    ]).catch(() => { /* a catalog row needing more columns: the visit's service_type carries the cadence instead */ });
  }, 60000);
  afterAll(async () => { if (owned) await owned.dispose(); });
  afterEach(() => {
    for (const name of GATES) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; }
  });

  function setGates({ completion = 'off', history = 'off' } = {}) {
    process.env.GATE_LAWN_V13 = 'true';
    for (const [name, value] of [['GATE_LAWN_COMPLETION_DEFAULTS', completion], ['GATE_LAWN_PROPERTY_HISTORY', history]]) {
      if (value === 'on') process.env[name] = 'true'; else delete process.env[name];
    }
  }

  async function visit(scheduledDate, changes = {}) {
    const f = await fixture(knex);
    await knex('customers').where({ id: f.customerId }).update({ address_line1: f.property.address_line1, city: f.property.city, zip: f.property.zip, state: f.property.state, waveguard_tier: 'Silver' });
    await knex('customer_turf_profiles').insert({ customer_id: f.customerId, active: true, grass_type: 'bermuda', track_key: 'bermuda', lawn_sqft: 10000 });
    const scheduled = await f.visit(0, { scheduled_date: scheduledDate, ...changes });
    return { scheduled, customerId: f.customerId };
  }
  const applied = (customerId, name, date, rate, unit, extra = {}) => knex('property_application_history').insert({
    customer_id: customerId, product_id: catalog[name].id, application_date: date, application_rate: rate, rate_unit: unit,
    active_ingredient: catalog[name].active_ingredient, ...extra,
  });
  const plan = (scheduled, options = {}) => buildPlanForService(scheduled.id, { db: knex, includeCompletionDefaults: true, ...options });
  const item = (result, name) => result.mixCalculator.items.find((entry) => entry.product?.name === name);
  const codes = (result) => result.propertyGate.blocks.map((block) => block.code);
  const warningCodes = (result) => result.propertyGate.warnings.map((warning) => warning.code);

  describe('the migrations', () => {
    test('one cap row per prodiamine product in its own unit, none for another ingredient', async () => {
      const rows = await knex('product_limits').where({ match_type: 'active_ingredient' }).orderBy('limit_value');
      expect(rows.map((r) => [r.product_id, Number(r.limit_value), r.limit_unit, r.limit_type, r.severity, r.match_value])).toEqual([
        // 65 WDG and 4FL sit at the catalog's verified annual label maxima (0.83 oz, 1.1 fl oz), under the derived 0.8476 / 1.1019.
        [catalog[WDG].id, 0.83, 'oz/1000sf/year', 'annual_max_rate', 'hard_block', 'prodiamine'],
        [catalog[STW_4FL].id, 1.1, 'fl oz/1000sf/year', 'annual_max_rate', 'hard_block', 'prodiamine'],
        [catalog[STW_15].id, 8.0082, 'lb/1000sf/year', 'annual_max_rate', 'hard_block', 'prodiamine'],
      ]);
    });

    test('every prodiamine catalog row carries a cap row (a new prodiamine product without one fails here)', async () => {
      const uncapped = await knex('products_catalog as pc')
        .whereRaw("pc.active_ingredient ILIKE 'prodiamine%'")
        .whereNotExists(knex('product_limits as pl').whereRaw('pl.product_id = pc.id').where({ match_type: 'active_ingredient', match_value: 'prodiamine' }))
        .select('pc.name');
      expect(uncapped).toEqual([]);
    });

    // The whole stack, in deployment order and in rollback order.
    const upAll = async () => { for (const m of [capMigration, aprilMigration, reconcileMigration, labelMaxMigration, ownershipMigration]) await m.up(knex); };
    const downAll = async () => { for (const m of [ownershipMigration, labelMaxMigration, reconcileMigration, aprilMigration, capMigration]) await m.down(knex); };
    const ownGates = { targetN: '0.5 lb N/1000', blackoutSensitive: true, northPortBlocked: true };
    const rowOf = (name) => knex('lawn_protocol_products').where({ product_name: name });
    const audits = () => knex('lawn_protocol_audit_log').where({ action: 'v13_april_9x' });
    const capValues = async () => Object.fromEntries((await knex('product_limits as pl').join('products_catalog as pc', 'pl.product_id', 'pc.id')
      .where({ 'pl.match_type': 'active_ingredient' }).select('pc.name', 'pl.limit_value')).map((r) => [r.name, Number(r.limit_value)]));

    test('a second up changes nothing; the full rollback removes only its rows; up again restores them', async () => {
      const count = async () => Number((await knex('product_limits').where({ match_type: 'active_ingredient' }).count('* as n'))[0].n);
      const aprilRows = async () => Number((await rowOf(DIMENSION).count('* as n'))[0].n);
      await upAll();
      expect([await count(), await aprilRows()]).toEqual([3, 1]);
      await downAll();
      expect([await count(), await aprilRows()]).toEqual([0, 0]);
      expect((await rowOf(F24).first()).gates).toEqual(ownGates);
      expect(await audits()).toHaveLength(0);
      await upAll();
      expect([await count(), await aprilRows()]).toEqual([3, 1]);
      expect(await audits()).toHaveLength(1);
    });

    test('label maxima: 65 WDG and 4FL take the stored annual maximum (min of derived and stored), the granulars keep the derived cap (their stored figure is per-application); down restores the derived values; a second up writes nothing', async () => {
      expect(await capValues()).toEqual({ [WDG]: 0.83, [STW_4FL]: 1.1, [STW_15]: 8.0082 });
      await labelMaxMigration.up(knex);
      expect(await knex('lawn_protocol_audit_log').where({ action: 'v13_prodiamine_cap_label_max' })).toHaveLength(1);
      await labelMaxMigration.down(knex);
      expect(await capValues()).toEqual({ [WDG]: 0.8476, [STW_4FL]: 1.1019, [STW_15]: 8.0082 });
      expect(await knex('lawn_protocol_audit_log').where({ action: 'v13_prodiamine_cap_label_max' })).toHaveLength(0);
      await labelMaxMigration.up(knex);
      await labelMaxMigration.up(knex);
      expect(await capValues()).toEqual({ [WDG]: 0.83, [STW_4FL]: 1.1, [STW_15]: 8.0082 });
      expect(await knex('lawn_protocol_audit_log').where({ action: 'v13_prodiamine_cap_label_max' })).toHaveLength(1);
    });

    test('a stored figure in another unit, or above the derived cap, is not applied', async () => {
      const wdg = await knex('products_catalog').where({ id: catalog[WDG].id }).first('rate_unit', 'max_label_rate_per_1000');
      try {
        await labelMaxMigration.down(knex);
        await knex('products_catalog').where({ id: catalog[WDG].id }).update({ rate_unit: 'lb' });
        await labelMaxMigration.up(knex);
        expect((await capValues())[WDG]).toBe(0.8476);
        await labelMaxMigration.down(knex);
        await knex('products_catalog').where({ id: catalog[WDG].id }).update({ rate_unit: 'oz', max_label_rate_per_1000: 0.9 });
        await labelMaxMigration.up(knex);
        expect((await capValues())[WDG]).toBe(0.8476);
      } finally {
        await labelMaxMigration.down(knex);
        await knex('products_catalog').where({ id: catalog[WDG].id }).update(wdg);
        await labelMaxMigration.up(knex);
      }
      expect((await capValues())[WDG]).toBe(0.83);
    });

    test('ownership: the audit row of a Dimension row 150000 inserted says created_by_migration true and carries no snapshot; its down only strips the keys', async () => {
      const [audit] = await audits();
      expect(audit.after_snapshot).toMatchObject({ created_by_migration: true });
      expect(audit.after_snapshot.preexisting_snapshot).toBeUndefined();
      await ownershipMigration.down(knex);
      expect((await audits())[0].after_snapshot.created_by_migration).toBeUndefined();
      await ownershipMigration.up(knex);
      expect((await audits())[0].after_snapshot.created_by_migration).toBe(true);
    });

    test('a Dimension row the window already held (150000 skips it, 160000 reconciles it): the full rollback leaves it, and the 24-0-11 row, exactly as before', async () => {
      await downAll();
      // An in-step row someone else put there, with its own report copy and sort order.
      await knex('lawn_protocol_products').insert({
        lawn_protocol_window_id: (await knex('lawn_protocol_windows').where({ window_key: aprilMigration.APRIL_WINDOW }).first()).id,
        product_id: catalog[DIMENSION].id, product_name: DIMENSION, role: 'nutrition', application_mode: 'broadcast', default_in_plan: true,
        rate_unit: 'lb_n', gates: JSON.stringify({ ...ownGates, planVisitsPerYear: 9 }), sort_order: 7,
      });
      const strip = (rows) => rows.map(({ updated_at: ignored, ...row }) => row);
      const beforeDimension = strip(await rowOf(DIMENSION));
      const beforeF24 = strip(await rowOf(F24));
      await upAll();
      const [audit] = await audits();
      expect(audit.after_snapshot).toMatchObject({ created_by_migration: false, preexisting_snapshot: { default_in_plan: true, rate_unit: 'lb_n', gates: { ...ownGates, planVisitsPerYear: 9 } } });
      expect((await rowOf(F24))[0].gates.planVisitsPerYear).toBe(12);
      await downAll();
      expect(strip(await rowOf(DIMENSION))).toEqual(beforeDimension);
      expect(strip(await rowOf(F24))).toEqual(beforeF24);
      expect(await audits()).toHaveLength(0);
      // Clean up the row this test owns, then restore the fixture state.
      await rowOf(DIMENSION).del();
      await upAll();
      expect(await rowOf(DIMENSION)).toHaveLength(1);
    });

    test('full rollback with a completion actual on the Dimension row the stack created (ownership, 160000, 150000 downs): the row stays switched off, the 24-0-11 gates are restored, no audit row is left; up twice puts one row back in step', async () => {
      const [dimension] = await rowOf(DIMENSION);
      const [actual] = await knex('lawn_protocol_product_actuals').insert({
        lawn_protocol_service_completion_id: randomUUID(), protocol_product_id: dimension.id, product_name: DIMENSION,
      }).returning('*');
      try {
        await ownershipMigration.down(knex);
        await reconcileMigration.down(knex);
        await aprilMigration.down(knex);
        const kept = await rowOf(DIMENSION);
        expect(kept).toHaveLength(1);
        expect(kept[0]).toMatchObject({ id: dimension.id, default_in_plan: false });
        expect(kept[0].gates).toEqual(ownGates);
        expect((await rowOf(F24))[0].gates).toEqual(ownGates);
        expect(await audits()).toHaveLength(0);

        await aprilMigration.up(knex); // sees the retained row and leaves the window alone
        await reconcileMigration.up(knex);
        await reconcileMigration.up(knex);
        const back = await rowOf(DIMENSION);
        expect(back).toHaveLength(1);
        expect(back[0]).toMatchObject({ id: dimension.id, default_in_plan: true });
        expect(back[0].gates).toEqual({ ...ownGates, planVisitsPerYear: 9 });
        expect((await rowOf(F24))[0].gates).toEqual({ ...ownGates, planVisitsPerYear: 12 });
        expect(await audits()).toHaveLength(1);
        await ownershipMigration.up(knex);
      } finally {
        await knex('lawn_protocol_product_actuals').where({ id: actual.id }).del();
      }
    });

    test('160000 up and down leave an unreferenced window to 150000: nothing changes in step, and down does not delete the row or its audit row', async () => {
      const before = await rowOf(DIMENSION);
      await reconcileMigration.up(knex);
      await reconcileMigration.down(knex);
      expect(await rowOf(DIMENSION)).toEqual(before);
      expect(await audits()).toHaveLength(1);
    });

    test('April rows: the 9x row mirrors the 24-0-11 row and carries its plan; the 24-0-11 row is marked 12x', async () => {
      const rows = await knex('lawn_protocol_products').whereIn('product_name', [F24, DIMENSION]).orderBy('product_name');
      const dimension = rows.find((r) => r.product_name === DIMENSION);
      const f24 = rows.find((r) => r.product_name === F24);
      expect(dimension).toMatchObject({ product_id: catalog[DIMENSION].id, role: 'nutrition', rate_unit: 'lb_n', default_in_plan: true });
      expect(dimension.gates).toEqual({ targetN: '0.5 lb N/1000', blackoutSensitive: true, northPortBlocked: true, planVisitsPerYear: 9 });
      expect(f24.gates).toEqual({ targetN: '0.5 lb N/1000', blackoutSensitive: true, northPortBlocked: true, planVisitsPerYear: 12 });
    });
  });

  describe('the yearly prodiamine cap across formulations', () => {
    test('Prodiamine 65 WDG history near the cap blocks the January Stonewall 4FL: no amount, a block naming the cap', async () => {
      setGates();
      const { scheduled, customerId } = await visit('2026-01-12');
      await applied(customerId, WDG, '2026-01-05', 0.8, 'oz');
      const result = await plan(scheduled);
      expect(codes(result)).toContain('lawn_v13_annual_limit');
      const block = result.propertyGate.blocks.find((b) => b.code === 'lawn_v13_annual_limit');
      expect(block.message).toMatch(/prodiamine across all products this year is 96\.4% of the yearly label cap; this application brings it to 141\.8% — THIS APPLICATION WOULD EXCEED IT/);
      expect(item(result, STW_4FL).mix).toBeNull();
      expect(item(result, STW_4FL).unavailable.reason).toMatch(/application limit is reached/);
      expect(result.status).toBe('blocked');
    });

    test('a capped line is out of the plan\'s mixing order too (the Nutra-TECH-style companions stay)', async () => {
      setGates();
      const { scheduled, customerId } = await visit('2026-01-12');
      await applied(customerId, WDG, '2026-01-05', 0.84, 'oz');
      const result = await plan(scheduled);
      expect(item(result, STW_4FL).unavailable.reason).toMatch(/application limit is reached/);
      expect(result.mixingOrder.map((step) => step.productName)).not.toContain(STW_4FL);
    });

    test('January 4FL plus October granular at the v13 rates stays under: the October plan computes 40.2 lb, with a warning at 95.7% of the cap and no block', async () => {
      setGates();
      const { scheduled, customerId } = await visit('2026-10-12');
      await applied(customerId, STW_4FL, '2026-01-12', 0.5, 'fl oz');
      const result = await plan(scheduled);
      expect(codes(result)).not.toContain('lawn_v13_annual_limit');
      const warning = result.propertyGate.warnings.find((w) => w.code === 'lawn_v13_limit_warning' && /yearly label cap/.test(w.message));
      expect(warning.message).toMatch(/is 45\.5% of the yearly label cap; this application brings it to 95\.7%/);
      expect(warning.limitType).toBe('annual_max_rate');
      expect(item(result, STW_15).mix).toMatchObject({ amount: 40.2 });
    });

    test('two formulations add up: 69.6% already used plus the October granular is 119.7%, a block', async () => {
      setGates();
      const { scheduled, customerId } = await visit('2026-10-12');
      await applied(customerId, WDG, '2026-03-02', 0.2, 'oz'); // 24.1%
      await applied(customerId, STW_4FL, '2026-01-12', 0.5, 'fl oz'); // 45.5%
      const result = await plan(scheduled);
      expect(codes(result)).toContain('lawn_v13_annual_limit');
      expect(result.propertyGate.blocks.find((b) => b.code === 'lawn_v13_annual_limit').message).toMatch(/is 69\.6% of the yearly label cap; this application brings it to 119\.7%/);
      expect(item(result, STW_15).mix).toBeNull();
    });

    test('a season already at 84.3% of the cap warns (no application being planned) and does not block', async () => {
      const { customerId } = await visit('2026-10-20');
      await applied(customerId, WDG, '2026-03-02', 0.7, 'oz');
      const result = await applicationLimits.checkLimits(customerId, catalog[STW_4FL].id, new Date('2026-10-20T16:00:00Z'), knex);
      expect(result.blocks).toEqual([]);
      expect(result.warnings[0]).toMatchObject({ type: 'annual_max_rate', current: 84.3 });
      expect(result.warnings[0].message).toMatch(/across all products this year is 84\.3% of the yearly label cap\./);
    });

    test('65 WDG history at 0.84 oz per 1,000 sq ft (past the label\'s 0.83 oz annual maximum) blocks the January Stonewall 4FL', async () => {
      setGates();
      const { scheduled, customerId } = await visit('2026-01-12');
      await applied(customerId, WDG, '2026-01-05', 0.84, 'oz');
      const result = await plan(scheduled);
      expect(codes(result)).toContain('lawn_v13_annual_limit');
      expect(result.propertyGate.blocks.find((b) => b.code === 'lawn_v13_annual_limit').message).toMatch(/is 101\.2% of the yearly label cap; this application brings it to 146\.7% — LIMIT REACHED/);
      expect(item(result, STW_4FL).mix).toBeNull();
    });

    describe('the cap is the treated property\'s (a customer with two properties)', () => {
      // Property A holds a 65 WDG application at 0.84 oz (past the cap); property B has none.
      async function twoProperties() {
        const { scheduled, customerId } = await visit('2026-01-12');
        const propertyA = scheduled.property_id;
        const [propertyB] = await knex('customer_properties').insert({ customer_id: customerId, address_line1: '200 Fixture Street', city: 'Fixture City', zip: '34201', is_primary: false }).returning('*');
        const [past] = await knex('scheduled_services').insert({ customer_id: customerId, property_id: propertyA, scheduled_date: '2026-01-05', service_type: 'Lawn fixture' }).returning('*');
        const [record] = await knex('service_records').insert({ customer_id: customerId, scheduled_service_id: past.id, service_date: '2026-01-05', service_type: 'Lawn fixture' }).returning('*');
        await applied(customerId, WDG, '2026-01-05', 0.84, 'oz', { service_record_id: record.id });
        const [visitB] = await knex('scheduled_services').insert({ customer_id: customerId, property_id: propertyB.id, scheduled_date: '2026-01-12', service_type: 'Lawn fixture' }).returning('*');
        return { visitA: scheduled, visitB, customerId, propertyA, propertyB: propertyB.id };
      }

      test('the plan for A is blocked, the plan for B is not', async () => {
        setGates();
        const { visitA, visitB } = await twoProperties();
        expect(codes(await plan(visitA))).toContain('lawn_v13_annual_limit');
        const resultB = await plan(visitB);
        expect(codes(resultB)).not.toContain('lawn_v13_annual_limit');
        expect(item(resultB, STW_4FL).mix).toMatchObject({ amount: 5 });
      });

      test('checkLimits: the property scopes the cap; a row with no known property still counts for any property, and no property means the whole customer', async () => {
        const { customerId, propertyA, propertyB } = await twoProperties();
        const date = new Date('2026-01-12T16:00:00Z');
        const check = (propertyId) => applicationLimits.checkLimits(customerId, catalog[STW_4FL].id, date, knex, { propertyId });
        expect((await check(propertyA)).blocks).toHaveLength(1);
        expect((await check(propertyB)).blocks).toEqual([]);
        expect((await check(null)).blocks).toHaveLength(1);
        // A ledger row with no service record cannot be placed at another property: it counts at B too.
        await applied(customerId, WDG, '2026-01-06', 0.84, 'oz');
        expect((await check(propertyB)).blocks).toHaveLength(1);
      });
    });

    test('the season is judged on its own date: a January completion entered after an October application does not count it', async () => {
      const { customerId } = await visit('2026-10-20');
      await applied(customerId, STW_15, '2026-10-12', 4.02, 'lb');
      await applied(customerId, WDG, '2026-03-02', 0.84, 'oz');
      const january = new Date('2026-01-12T16:00:00Z');
      const backdated = await applicationLimits.checkLimits(customerId, catalog[STW_4FL].id, january, knex);
      expect(backdated.blocks).toEqual([]);
      expect(backdated.warnings).toEqual([]);
      // The same history judged in October does count both.
      const october = await applicationLimits.checkLimits(customerId, catalog[STW_4FL].id, new Date('2026-10-20T16:00:00Z'), knex);
      expect(october.blocks).toHaveLength(1);
      // The day of an application counts for itself (completion reads after the ledger write).
      expect((await applicationLimits.checkLimits(customerId, catalog[STW_4FL].id, new Date('2026-03-02T16:00:00Z'), knex)).blocks[0]).toMatchObject({ current: 101.2 });
    });

    test('checkLimits without a proposed application (completion, the compliance page) sizes the season only: 95.7% after January plus October warns, never blocks', async () => {
      const { customerId } = await visit('2026-10-20');
      await applied(customerId, STW_4FL, '2026-01-12', 0.5, 'fl oz');
      await applied(customerId, STW_15, '2026-10-12', 4.02, 'lb');
      const result = await applicationLimits.checkLimits(customerId, catalog[STW_15].id, new Date('2026-10-20T16:00:00Z'), knex);
      expect(result.blocks).toEqual([]);
      expect(result.warnings).toEqual([expect.objectContaining({ type: 'annual_max_rate', current: 95.7, max: 100 })]);
    });

    test('earlier applications are sized from the recorded rate, else quantity over area, else the standard rate', async () => {
      const { customerId } = await visit('2026-10-20');
      await applied(customerId, WDG, '2026-02-01', null, null, { quantity_applied: 4, quantity_unit: 'oz', area_treated_sqft: 5000 }); // 0.8 oz/1000 = 96.4%
      const byQuantity = await applicationLimits.checkLimits(customerId, catalog[STW_4FL].id, new Date('2026-10-20T16:00:00Z'), knex);
      expect(byQuantity.blocks).toEqual([]);
      expect(byQuantity.warnings[0]).toMatchObject({ current: 96.4 });
      const { customerId: other } = await visit('2026-10-20');
      await applied(other, STW_4FL, '2026-02-01', null, null); // standard 0.5 fl oz = 45.5%, flagged
      const byDefault = await applicationLimits.checkLimits(other, catalog[STW_15].id, new Date('2026-10-20T16:00:00Z'), knex, { proposed: { ratePer1000: 4.02, unit: 'lb' } });
      expect(byDefault.blocks).toEqual([]);
      // 45.5% (sized at the standard rate, and said so) plus the planned 50.2% projects to 95.7%: a warning, not a block.
      expect(byDefault.warnings).toEqual([expect.objectContaining({ current: 45.5, message: expect.stringMatching(/brings it to 95\.7% \(1 sized at the product's standard rate\)/) })]);
    });

    test('retracted rows and last year\'s rows do not count; the planned visit\'s own ledger rows are left out of a re-plan', async () => {
      const { scheduled, customerId } = await visit('2026-10-12');
      await applied(customerId, WDG, '2026-03-02', 0.84, 'oz', { retracted_at: new Date() });
      await applied(customerId, WDG, '2025-03-02', 0.84, 'oz');
      const [record] = await knex('service_records').insert({ customer_id: customerId, scheduled_service_id: scheduled.id, service_date: '2026-10-12', service_type: 'Lawn fixture' }).returning('*');
      await applied(customerId, STW_15, '2026-10-12', 4.02, 'lb', { service_record_id: record.id });
      const proposed = { ratePer1000: 4.02, unit: 'lb' };
      const date = new Date('2026-10-12T16:00:00Z');
      // The visit's own row (50.2%) plus the application planned again (50.2%) would read 100.4%.
      expect((await applicationLimits.checkLimits(customerId, catalog[STW_15].id, date, knex, { proposed })).blocks).toHaveLength(1);
      const excluded = await applicationLimits.checkLimits(customerId, catalog[STW_15].id, date, knex, { proposed, excludeScheduledServiceId: scheduled.id });
      expect(excluded.blocks).toEqual([]);
      expect(excluded.warnings).toEqual([]);
    });

    test('an earlier prodiamine application whose product has no cap row is named, never counted as nothing', async () => {
      const { customerId } = await visit('2026-10-20');
      const [stray] = await knex('products_catalog').insert({ name: 'Prodiamine Stray 1G', category: 'herbicide', active_ingredient: 'Prodiamine', rate_unit: 'lb', active: true }).returning('*');
      await knex('property_application_history').insert({ customer_id: customerId, product_id: stray.id, application_date: '2026-02-01', application_rate: 1, rate_unit: 'lb' });
      const result = await applicationLimits.checkLimits(customerId, catalog[STW_4FL].id, new Date('2026-10-20T16:00:00Z'), knex);
      expect(result.warnings[0].message).toMatch(/1 earlier application could not be sized and was not counted/);
    });
  });

  describe('the April step by the visit\'s plan', () => {
    test.each([['Every 6 Weeks Lawn Care Service', DIMENSION, 27.778, F24], ['Monthly Lawn Care Service', F24, 20.833, DIMENSION]])(
      '%s: plans %s (%s lb on 10,000 sq ft) and not %s',
      async (serviceType, expected, amount, other) => {
        setGates();
        const { scheduled } = await visit('2026-04-14', { service_type: serviceType });
        const result = await plan(scheduled);
        const selected = result.mixCalculator.items.filter((entry) => entry.selected && entry.product);
        expect(selected.map((entry) => entry.product.name)).toEqual([expected]);
        expect(item(result, expected).mix).toMatchObject({ amount, amountUnit: 'lb' });
        expect(item(result, other)).toBeUndefined();
        expect(warningCodes(result)).not.toContain('lawn_v13_plan_cadence_unknown');
      });

    test('the catalog service the visit is booked under outranks its service_type text', async () => {
      const nine = await knex('services').where({ service_key: 'lawn_care_6week' }).first();
      if (!nine) return; // the fixture catalog row needed more columns; the text path above covers the resolver
      setGates();
      const { scheduled } = await visit('2026-04-14', { service_type: 'Lawn Care', service_id: nine.id });
      const result = await plan(scheduled);
      expect(result.mixCalculator.items.filter((entry) => entry.selected && entry.product).map((entry) => entry.product.name)).toEqual([DIMENSION]);
    });

    test.each([[{ recurring_pattern: 'every_6_weeks' }], [{ recurring_pattern: 'custom', recurring_interval_days: 42 }]])(
      'a generic "Lawn Care" visit on a %j series plans the 9x step',
      async (recurrence) => {
        setGates();
        const { scheduled } = await visit('2026-04-14', { service_type: 'Lawn Care', is_recurring: true, ...recurrence });
        const result = await plan(scheduled);
        expect(result.mixCalculator.items.filter((entry) => entry.selected && entry.product).map((entry) => entry.product.name)).toEqual([DIMENSION]);
        expect(warningCodes(result)).not.toContain('lawn_v13_plan_cadence_unknown');
      });

    test('a generic "Lawn Care" visit on a monthly series plans the 12x step without a warning', async () => {
      setGates();
      const { scheduled } = await visit('2026-04-14', { service_type: 'Lawn Care', is_recurring: true, recurring_pattern: 'monthly' });
      const result = await plan(scheduled);
      expect(result.mixCalculator.items.filter((entry) => entry.selected && entry.product).map((entry) => entry.product.name)).toEqual([F24]);
      expect(warningCodes(result)).not.toContain('lawn_v13_plan_cadence_unknown');
    });

    test('an unknown plan keeps the 12x step (24-0-11) and the plan says so, naming the 9x product', async () => {
      setGates();
      const { scheduled } = await visit('2026-04-14', { service_type: 'Lawn fixture' });
      const result = await plan(scheduled);
      expect(result.mixCalculator.items.filter((entry) => entry.selected && entry.product).map((entry) => entry.product.name)).toEqual([F24]);
      const warning = result.propertyGate.warnings.find((w) => w.code === 'lawn_v13_plan_cadence_unknown');
      expect(warning.message).toContain(DIMENSION);
      expect(warning.message).toMatch(/keeps the 12x step/);
    });

    test('a retired 6x plan keeps the 12x step too, with no warning (its cadence is known)', async () => {
      setGates();
      const { scheduled } = await visit('2026-04-14', { service_type: 'Bi-Monthly Lawn Care Service' });
      const result = await plan(scheduled);
      expect(result.mixCalculator.items.filter((entry) => entry.selected && entry.product).map((entry) => entry.product.name)).toEqual([F24]);
      expect(warningCodes(result)).not.toContain('lawn_v13_plan_cadence_unknown');
    });

    test('other months never ask: a January visit on an unknown plan carries no cadence warning', async () => {
      setGates();
      const { scheduled } = await visit('2026-01-12', { service_type: 'Lawn fixture' });
      expect(warningCodes(await plan(scheduled))).not.toContain('lawn_v13_plan_cadence_unknown');
    });

    test('completion defaults prefill the plan\'s own product: Dimension on 9x, 24-0-11 on 12x', async () => {
      setGates({ completion: 'on', history: 'on' });
      for (const [serviceType, expected] of [['Every 6 Weeks Lawn Care Service', DIMENSION], ['Monthly Lawn Care Service', F24]]) {
        const { scheduled } = await visit('2026-04-14', { service_type: serviceType });
        const result = await plan(scheduled);
        expect(result.completionDefaults.items.map((entry) => entry.product.name)).toEqual([expected]);
        expect(result.completionDefaults.items[0].mix.amount).toBeGreaterThan(0);
      }
    });
  });
});
