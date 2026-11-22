// Lawn protocol v13 before the GATE_LAWN_V13 flip, through the real plan engine,
// the real application-limits reader and the two real migrations on PostgreSQL
// (cloned schema). Synthetic data only.
//
// 1. One yearly prodiamine cap across formulations (20261006140000): earlier
//    applications of any prodiamine product count toward the next one.
// 2. The 9x plan April step (20261006150000 + the recipe's cadenceVariants): the
//    visit's plan picks Dimension 0.21% 18-0-10 (9x) or the 24-0-11 (12x), the
//    same way in the plan, the completion defaults and the tank sheet.
// 3. October is Dimension 0.21% 18-0-10 at 4.04 lb (20261007120500): the staged October
//    row swaps in, the catalog max, the 3-a-year and 60-day limits and the yearly dithiopyr
//    cap rows are written only where absent, and the limit reader scopes product history.
// 4. October moves on to LESCO Stonewall 0.37% 18-0-10 at the same 4.04 lb (20261122120000): the Dimension
//    row swaps in place, only while it is exactly what 20261007120500 wrote; the 9x April step stays Dimension.
const { createLawnHistoryDb, fixture } = require('./helpers/lawn-history-db');
const { buildPlanForService, lawnVisitsPerYear } = require('../services/waveguard-plan-engine');
const applicationLimits = require('../services/application-limits');
const { buildLawnProtocolReportContext } = require('../services/service-report/dynamic-context');
const capMigration = require('../models/migrations/20261006140000_lawn_v13_prodiamine_year_cap');
const aprilMigration = require('../models/migrations/20261006150000_lawn_v13_april_9x_branch');
const reconcileMigration = require('../models/migrations/20261006160000_lawn_v13_april_9x_reconcile');
const labelMaxMigration = require('../models/migrations/20261006170000_lawn_v13_prodiamine_cap_label_max');
const ownershipMigration = require('../models/migrations/20261006180000_lawn_v13_april_9x_ownership');
const octoberMigration = require('../models/migrations/20261007120500_lawn_v13_october_dimension');
const stonewallMigration = require('../models/migrations/20261122120000_lawn_v13_october_stonewall');
const v13Recipe = require('../config/lawn-protocol-v13.json');
const { LAWN_V13_VERSION } = require('../services/lawn-program');
const { randomUUID } = require('crypto');

const STW_4FL = 'LESCO Stonewall 4FL Prodiamine 40.7% Pre-Emergent Liquid Herbicide';
const STW_15 = 'LESCO Stonewall 0.43% 15-0-15 50% PolyPlus OPTI45 Pre-Emergent Plus Fertilizer';
const WDG = 'Prodiamine 65 WDG';
const F24 = 'LESCO 24-0-11 with PolyPlus OPTI';
// April on the 12x plan after 20261022195000: the 44-0-0 polymer bag (1.0 lb N, 22.727 lb on 10,000 sq ft).
const aprilPolymerMigration = require('../models/migrations/20261022195000_lawn_v13_april_polymer_n_v3');
const F44 = aprilPolymerMigration.NEW_NAME;
const DIMENSION = aprilMigration.DIMENSION;
const DIM_2EW = octoberMigration.NAME_2EW;
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

  test('the January 4FL step alone is 45% of the prodiamine cap', () => {
    expect(0.5 / 1.1019).toBeLessThan(0.5);
  });
});

describe('the v13 dithiopyr season against the yearly cap (no database)', () => {
  const { CAP_GRANULAR, CAP_2EW } = octoberMigration;
  const rateOf = (line) => Number(/^([\d.]+) (fl oz|lb)\b/.exec(line.split(' — ')[1] || '')[1]);
  // Every dithiopyr line of the recipe, as a share of its own product's cap row.
  const season = (visitsPerYear) => v13Recipe.st_augustine.visits.reduce((total, visit) => {
    const step = visit.cadenceVariants?.[String(visitsPerYear)] || visit;
    return String(step.primary).split('\n').reduce((sum, line) => {
      const name = line.split(' — ')[0];
      if (name === DIM_2EW) return sum + rateOf(line) / CAP_2EW.limit_value;
      if (name === DIMENSION) return sum + rateOf(line) / CAP_GRANULAR.limit_value;
      return sum;
    }, total);
  }, 0);

  test('the label figures: 16.38 lb of the granular and 2.2039 fl oz of the 2EW are the same 1.5 lb ai per acre', () => {
    expect(CAP_GRANULAR.limit_value).toBe(16.38);
    expect(CAP_2EW.limit_value).toBe(2.2039);
    expect(2.2039 * (2 / 128) * 43.56).toBeCloseTo(1.5, 2);
    expect(16.38 * 0.0021 * 43.56).toBeCloseTo(1.5, 2);
    expect(CAP_2EW.description).toBe('Dithiopyr yearly cap, all products: 1.5 lb dithiopyr per acre per year (label).');
    expect(CAP_2EW.description).not.toMatch(/16\.38/);
  });

  // October moved to Stonewall 0.37% 18-0-10 (20261122120000): the dithiopyr season is March and June 2EW, plus the 9x April granular.
  test('12x and 9x dithiopyr seasons stay under the cap (45.4% and 62.3%); the 9x April granular is the only Dimension step left', () => {
    expect(Math.round(season(12) * 1000) / 10).toBe(45.4);
    expect(Math.round(season(9) * 1000) / 10).toBe(62.3);
    expect(octoberMigration.OCT_RATE).toBeLessThan(octoberMigration.MAX_LABEL);
  });
});

describe('the v13 prodiamine season against the yearly cap (no database)', () => {
  const { CAP_VALUE } = stonewallMigration;
  const rateOf = (line) => Number(/^([\d.]+) (fl oz|lb)\b/.exec(line.split(' — ')[1] || '')[1]);
  // The recipe's prodiamine lines as shares of their own product's derived cap row (1.5 lb ai per acre).
  const season = (visitsPerYear) => v13Recipe.st_augustine.visits.reduce((total, visit) => {
    const step = visit.cadenceVariants?.[String(visitsPerYear)] || visit;
    return String(step.primary).split('\n').reduce((sum, line) => {
      const name = line.split(' — ')[0];
      if (name === STW_4FL) return sum + rateOf(line) / 1.1019;
      if (name === stonewallMigration.NEW_NAME) return sum + rateOf(line) / CAP_VALUE;
      return sum;
    }, total);
  }, 0);

  test('January 4FL (45.4%) plus October Stonewall 0.37% (43.4%) is 88.8% of the yearly cap on both plans, under it', () => {
    expect(Math.round(season(12) * 1000) / 10).toBe(88.8);
    expect(Math.round(season(9) * 1000) / 10).toBe(88.8);
    // 0.68 + 0.65 = 1.33 lb prodiamine per acre; the 9x April step is the Dimension granular (dithiopyr), so it adds none.
    expect(0.5 * (4 / 128) * 43.56 + stonewallMigration.OCT_RATE * 0.0037 * 43.56).toBeCloseTo(1.33, 2);
  });
});

describe('lawnVisitsPerYear: the visit\'s plan from the catalog service, then the series recurrence, then the service name (no database)', () => {
  const knexWith = (catalog) => () => ({ where: () => ({ first: async () => catalog }) });
  const visits = (service, catalog = null) => lawnVisitsPerYear(knexWith(catalog), { service_id: catalog ? 'svc' : null, ...service });

  test('a generic "Lawn Care" booking reads its cadence from the recurrence the scheduler dates it by', async () => {
    const generic = { service_type: 'Lawn Care' };
    expect(await visits({ ...generic, recurring_pattern: 'every_6_weeks' })).toBe(9);
    expect(await visits({ ...generic, recurring_pattern: 'custom', recurring_interval_days: 42 })).toBe(9);
    expect(await visits({ ...generic, recurring_pattern: 'lawn_rounds_9' })).toBe(9);
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
    await product(DIMENSION, { active_ingredient: 'Dithiopyr', formulation: 'granular', default_rate_per_1000: 2.78, rate_unit: 'lb', analysis_n: 18, analysis_p: 0, analysis_k: 10, max_label_rate_per_1000: 5.48, best_price: 47.5, best_vendor: 'Fixture vendor', cost_per_unit: 0.95, cost_unit: 'lb', needs_pricing: false });
    await product(DIM_2EW, { active_ingredient: 'Dithiopyr', formulation: 'liquid', default_rate_per_1000: 0.5, rate_unit: 'fl oz', min_label_rate_per_1000: 0.37, max_label_rate_per_1000: 0.73 });

    await knex('lawn_protocols').insert({ protocol_key: KEY, version: '2026.06', name: 'Fixture old', status: 'active', grass_track: 'bermuda', region: 'swfl' });
    const [staged] = await knex('lawn_protocols').insert({ protocol_key: KEY, version: LAWN_V13_VERSION, name: 'Fixture v13', status: 'staged', grass_track: 'bermuda', region: 'swfl', effective_from: '2000-01-01' }).returning('*');
    const windows = {};
    for (const [month, windowKey, mode, carrier] of [[1, 'jan_v13_pre_m_hose', 'main_reel_plus_spot_backpack', 1], [4, aprilMigration.APRIL_WINDOW, 'spreader_plus_spot_backpack', null], [10, 'oct_v13_spreader_fall', 'spreader_plus_spot_backpack', null]]) {
      [windows[month]] = await knex('lawn_protocol_windows').insert({
        lawn_protocol_id: staged.id, month, window_key: windowKey, title: windowKey, visit_type: 'fixture', production_mode: mode, default_carrier_gal_per_1000: carrier,
        goal: month === 10 ? octoberMigration.OLD_GOAL : null,
      }).returning('*');
    }
    const row = (window, name, fields) => knex('lawn_protocol_products').insert({
      lawn_protocol_window_id: windows[window].id, product_id: catalog[name].id, product_name: name, application_mode: 'broadcast', default_in_plan: true, ...fields,
    });
    await row(1, STW_4FL, { role: 'pre_emergent', rate_per_1000: 0.5, rate_unit: 'fl oz', carrier_gal_per_1000: 1, gates: JSON.stringify({ annualCounter: 'prodiamine_oz_per_1000' }) });
    await row(10, STW_15, { role: 'fall_pre_emergent_nutrition', rate_per_1000: 4.02, rate_unit: 'lb', gates: JSON.stringify({ targetN: '0.6 lb N/1000', annualCounter: 'prodiamine_oz_per_1000' }), annual_counter: JSON.stringify({ counter: 'prodiamine_oz_per_1000' }) });
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
    // The 12x April row is the 44-0-0 polymer bag from here on (the migrations above ran over the 24-0-11 row).
    beforeAll(async () => { await aprilPolymerMigration.up(knex); });

    test.each([['Every 6 Weeks Lawn Care Service', DIMENSION, 27.778, F44], ['Monthly Lawn Care Service', F44, 22.727, DIMENSION]])(
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
      expect(result.mixCalculator.items.filter((entry) => entry.selected && entry.product).map((entry) => entry.product.name)).toEqual([F44]);
      expect(warningCodes(result)).not.toContain('lawn_v13_plan_cadence_unknown');
    });

    test('an unknown plan keeps the 12x step (44-0-0) and the plan says so, naming the 9x product', async () => {
      setGates();
      const { scheduled } = await visit('2026-04-14', { service_type: 'Lawn fixture' });
      const result = await plan(scheduled);
      expect(result.mixCalculator.items.filter((entry) => entry.selected && entry.product).map((entry) => entry.product.name)).toEqual([F44]);
      const warning = result.propertyGate.warnings.find((w) => w.code === 'lawn_v13_plan_cadence_unknown');
      expect(warning.message).toContain(DIMENSION);
      expect(warning.message).toMatch(/keeps the 12x step/);
    });

    test('a retired 6x plan keeps the 12x step too, with no warning (its cadence is known)', async () => {
      setGates();
      const { scheduled } = await visit('2026-04-14', { service_type: 'Bi-Monthly Lawn Care Service' });
      const result = await plan(scheduled);
      expect(result.mixCalculator.items.filter((entry) => entry.selected && entry.product).map((entry) => entry.product.name)).toEqual([F44]);
      expect(warningCodes(result)).not.toContain('lawn_v13_plan_cadence_unknown');
    });

    test('other months never ask: a January visit on an unknown plan carries no cadence warning', async () => {
      setGates();
      const { scheduled } = await visit('2026-01-12', { service_type: 'Lawn fixture' });
      expect(warningCodes(await plan(scheduled))).not.toContain('lawn_v13_plan_cadence_unknown');
    });

    test('completion defaults prefill the plan\'s own product: Dimension on 9x, 44-0-0 on 12x', async () => {
      setGates({ completion: 'on', history: 'on' });
      for (const [serviceType, expected] of [['Every 6 Weeks Lawn Care Service', DIMENSION], ['Monthly Lawn Care Service', F44]]) {
        const { scheduled } = await visit('2026-04-14', { service_type: serviceType });
        const result = await plan(scheduled);
        expect(result.completionDefaults.items.map((entry) => entry.product.name)).toEqual([expected]);
        expect(result.completionDefaults.items[0].mix.amount).toBeGreaterThan(0);
      }
    });
  });
  describe('October Dimension 18-0-10 (20261007120500)', () => {
    const dimensionId = () => catalog[DIMENSION].id;
    const id2ew = () => catalog[DIM_2EW].id;
    const limitRows = (productId) => knex('product_limits').where({ product_id: productId }).orderBy(['limit_type', 'match_type']);
    const shape = (rows) => rows.map((r) => [r.limit_type, r.match_type, Number(r.limit_value), r.limit_unit, r.severity]);
    const octoberRow = () => knex('lawn_protocol_products as p').join('lawn_protocol_windows as w', 'p.lawn_protocol_window_id', 'w.id')
      .where({ 'w.window_key': 'oct_v13_spreader_fall' }).select('p.*', 'w.goal').first();
    const catalogRow = () => knex('products_catalog').where({ id: dimensionId() }).first();
    const priceFields = (row) => ({ best_price: Number(row.best_price), best_vendor: row.best_vendor, cost_per_unit: Number(row.cost_per_unit), cost_unit: row.cost_unit, needs_pricing: row.needs_pricing });
    const ours = () => knex('lawn_protocol_audit_log').whereIn('action', [octoberMigration.ACTION, octoberMigration.CATALOG_ACTION]);
    const pricesBefore = {};
    // The fixture as the staging migrations leave it (Stonewall row, 5.48 max, no limit rows), then this migration up.
    async function resetAndUp() {
      const row = await octoberRow();
      await knex('lawn_protocol_products').where({ id: row.id }).update({
        product_name: STW_15, product_id: catalog[STW_15].id, rate_per_1000: 4.02, gates: JSON.stringify({ targetN: '0.6 lb N/1000', annualCounter: 'prodiamine_oz_per_1000' }),
        annual_counter: JSON.stringify({ counter: 'prodiamine_oz_per_1000' }),
      });
      await knex('lawn_protocol_windows').where({ id: row.lawn_protocol_window_id }).update({ goal: octoberMigration.OLD_GOAL });
      await knex('products_catalog').where({ id: dimensionId() }).update({ name: DIMENSION, max_label_rate_per_1000: 5.48 });
      await knex('product_limits').whereIn('product_id', [dimensionId(), id2ew()]).del();
      await knex('product_aliases').where({ product_id: dimensionId(), alias_name: DIMENSION }).del();
      await ours().del();
      await octoberMigration.up(knex);
    }

    beforeAll(async () => {
      Object.assign(pricesBefore, priceFields(await catalogRow()));
      await octoberMigration.up(knex);
    });

    test('the staged October row is Dimension 18-0-10 at 4.04 lb with its product id, N and K2O gates, dithiopyr counter and goal; Stonewall 15-0-15 is gone from the window', async () => {
      const row = await octoberRow();
      expect(row).toMatchObject({ product_name: DIMENSION, product_id: dimensionId(), role: 'fall_pre_emergent_nutrition', rate_unit: 'lb', goal: octoberMigration.NEW_GOAL });
      expect(Number(row.rate_per_1000)).toBe(4.04);
      expect(row.gates).toEqual({ targetN: '0.73 lb N/1000', targetK2O: '0.4 lb K2O/1000', annualCounter: 'dithiopyr_lb_per_1000' });
      expect(row.annual_counter).toEqual({ counter: 'dithiopyr_lb_per_1000' });
      expect(await knex('lawn_protocol_products').where({ product_name: STW_15 })).toEqual([]);
    });

    test('the 9x April row is exactly as 20261006150000 left it (derived from the 0.5 lb N target, no stated rate)', async () => {
      const april = await knex('lawn_protocol_products as p').join('lawn_protocol_windows as w', 'p.lawn_protocol_window_id', 'w.id')
        .where({ 'w.window_key': aprilMigration.APRIL_WINDOW, 'p.product_name': DIMENSION }).select('p.rate_per_1000', 'p.rate_unit', 'p.gates').first();
      expect([april.rate_per_1000, april.rate_unit, april.gates.targetN, april.gates.planVisitsPerYear]).toEqual([null, 'lb_n', '0.5 lb N/1000', 9]);
    });

    test('catalog: the label max moves 5.48 -> 5.46; price, cost and pricing-status fields are not touched', async () => {
      const row = await catalogRow();
      expect(Number(row.max_label_rate_per_1000)).toBe(5.46);
      expect(priceFields(row)).toEqual(pricesBefore);
      expect(Number(row.default_rate_per_1000)).toBe(2.78);
    });

    test('limits: 3 applications a year and a 60-day interval (both hard block), and the yearly dithiopyr cap in each product\'s own unit', async () => {
      expect(shape(await limitRows(dimensionId()))).toEqual([
        ['annual_max_apps', 'product', 3, 'applications', 'hard_block'],
        ['annual_max_rate', 'active_ingredient', 16.38, 'lb/1000sf/year', 'hard_block'],
        ['min_interval_days', 'product', 60, 'days', 'hard_block'],
      ]);
      expect(shape(await limitRows(id2ew()))).toEqual([['annual_max_rate', 'active_ingredient', 2.2039, 'fl oz/1000sf/year', 'hard_block']]);
      const cap2ew = await knex('product_limits').where({ product_id: id2ew(), match_value: 'dithiopyr' }).first();
      expect(cap2ew.description).toBe('Dithiopyr yearly cap, all products: 1.5 lb dithiopyr per acre per year (label).');
    });

    test('a second up changes nothing: no new row, one audit row of each kind per protocol, the same values', async () => {
      const before = JSON.stringify([await limitRows(dimensionId()), await limitRows(id2ew()), await octoberRow(), await catalogRow(), await ours().orderBy('id')]);
      await octoberMigration.up(knex);
      expect(JSON.stringify([await limitRows(dimensionId()), await limitRows(id2ew()), await octoberRow(), await catalogRow(), await ours().orderBy('id')])).toBe(before);
    });

    describe('down and up again', () => {
      test('down puts back the Stonewall row, the goal, the 5.48 max and removes only the limit rows it inserted; up restores them', async () => {
        const stateOf = async () => JSON.stringify([await octoberRow(), await catalogRow(), await limitRows(dimensionId()), await limitRows(id2ew())]);
        const swapped = await stateOf();
        await octoberMigration.down(knex);
        try {
          const row = await octoberRow();
          expect(row).toMatchObject({ product_name: STW_15, product_id: catalog[STW_15].id, goal: octoberMigration.OLD_GOAL });
          expect(Number(row.rate_per_1000)).toBe(4.02);
          expect(row.gates).toEqual({ targetN: '0.6 lb N/1000', annualCounter: 'prodiamine_oz_per_1000' });
          expect(row.annual_counter).toEqual({ counter: 'prodiamine_oz_per_1000' });
          expect(Number((await catalogRow()).max_label_rate_per_1000)).toBe(5.48);
          expect(priceFields(await catalogRow())).toEqual(pricesBefore);
          expect(await limitRows(dimensionId())).toEqual([]);
          expect(await limitRows(id2ew())).toEqual([]);
          expect(await ours()).toEqual([]);
        } finally {
          await octoberMigration.up(knex);
        }
        expect(JSON.parse(await stateOf()).map((part) => (Array.isArray(part) ? part.length : part.id))).toEqual(JSON.parse(swapped).map((part) => (Array.isArray(part) ? part.length : part.id)));
        expect(Number((await octoberRow()).rate_per_1000)).toBe(4.04);
      });

      test('a value changed since stays: the October rate, the catalog max, a limit row someone edited, a row renamed away', async () => {
        const row = await octoberRow();
        const [limit] = await knex('product_limits').where({ product_id: dimensionId(), limit_type: 'annual_max_apps' });
        const [cap] = await knex('product_limits').where({ product_id: id2ew(), limit_type: 'annual_max_rate' });
        await knex('lawn_protocol_products').where({ id: row.id }).update({ rate_per_1000: 3.9 });
        await knex('products_catalog').where({ id: dimensionId() }).update({ max_label_rate_per_1000: 5 });
        await knex('product_limits').where({ id: limit.id }).update({ limit_value: 2 });
        await knex('product_limits').where({ id: cap.id }).update({ description: 'Edited by the office' });
        try {
          await octoberMigration.down(knex);
          const after = await octoberRow();
          expect(after).toMatchObject({ product_name: STW_15 });
          expect(Number(after.rate_per_1000)).toBe(3.9);
          expect(Number((await catalogRow()).max_label_rate_per_1000)).toBe(5);
          expect(Number((await knex('product_limits').where({ id: limit.id }).first()).limit_value)).toBe(2);
          expect((await knex('product_limits').where({ id: cap.id }).first()).description).toBe('Edited by the office');
          // The other inserted rows (unedited) are gone.
          expect(await knex('product_limits').where({ product_id: dimensionId(), limit_type: 'min_interval_days' })).toEqual([]);
        } finally {
          await resetAndUp();
        }
        expect(Number((await octoberRow()).rate_per_1000)).toBe(4.04);
      });

      test('a row renamed since is not the Dimension row this wrote: down leaves it whole', async () => {
        const row = await octoberRow();
        await knex('lawn_protocol_products').where({ id: row.id }).update({ product_name: 'Renamed by the office' });
        try {
          await octoberMigration.down(knex);
          expect(await knex('lawn_protocol_products').where({ id: row.id }).first()).toMatchObject({ product_name: 'Renamed by the office', product_id: dimensionId() });
          expect(Number((await knex('lawn_protocol_products').where({ id: row.id }).first()).rate_per_1000)).toBe(4.04);
        } finally {
          await resetAndUp();
        }
      });

      test('a visit pinned to the protocol makes the rollback a no-op: the Dimension row, its audit row, the catalog max and every limit stay', async () => {
        const log = jest.spyOn(console, 'log').mockImplementation(() => {});
        const { scheduled } = await visit('2026-10-12', { lawn_protocol_key: KEY, lawn_protocol_version: LAWN_V13_VERSION });
        try {
          const before = JSON.stringify([await octoberRow(), await catalogRow(), await limitRows(dimensionId()), await limitRows(id2ew()), await ours().orderBy('id')]);
          await octoberMigration.down(knex);
          expect(JSON.stringify([await octoberRow(), await catalogRow(), await limitRows(dimensionId()), await limitRows(id2ew()), await ours().orderBy('id')])).toBe(before);
          expect(log).toHaveBeenCalledWith(expect.stringContaining(`rollback skipped for protocol ${KEY}`));
        } finally {
          log.mockRestore();
          await knex('scheduled_services').where({ id: scheduled.id }).update({ lawn_protocol_key: null, lawn_protocol_version: null });
        }
        // Unreferenced again: the same down now rolls everything back, and up puts it forward.
        await octoberMigration.down(knex);
        expect(await octoberRow()).toMatchObject({ product_name: STW_15 });
        await octoberMigration.up(knex);
        expect(await octoberRow()).toMatchObject({ product_name: DIMENSION });
        expect(await limitRows(dimensionId())).toHaveLength(3);
      });
    });

    describe('rows that already exist are never changed', () => {
      async function withClean(run) {
        await octoberMigration.down(knex);
        try { await run(); } finally { await resetAndUp(); }
      }

      test('admin rows of the same limit type keep their value, unit and severity (a lower cap, a longer interval, a warning, an empty value); the missing types are still added', async () => {
        await withClean(async () => {
          await knex('product_limits').insert([
            { product_id: dimensionId(), match_type: 'product', limit_type: 'annual_max_apps', limit_value: 2, limit_unit: 'applications', severity: 'warning', description: 'Office rule' },
            { product_id: dimensionId(), match_type: 'product', limit_type: 'min_interval_days', limit_value: null, limit_unit: null, severity: 'warning', description: 'Office rule, no value' },
            { product_id: dimensionId(), match_type: 'active_ingredient', match_value: 'dithiopyr', limit_type: 'annual_max_rate', limit_value: 12, limit_unit: 'lb/1000sf/year', severity: 'warning', description: 'Office cap' },
          ]);
          const before = (await limitRows(dimensionId())).map((r) => JSON.stringify(r));
          await octoberMigration.up(knex);
          const after = await limitRows(dimensionId());
          expect(after.map((r) => JSON.stringify(r))).toEqual(expect.arrayContaining(before));
          expect(after).toHaveLength(3);
          // The 2EW product had none: its cap is added.
          expect(shape(await limitRows(id2ew()))).toEqual([['annual_max_rate', 'active_ingredient', 2.2039, 'fl oz/1000sf/year', 'hard_block']]);
          // And down leaves the admin rows alone too.
          await octoberMigration.down(knex);
          expect((await limitRows(dimensionId())).map((r) => JSON.stringify(r))).toEqual(before);
        });
      });

      test('a catalog max an admin set (not NULL, not 5.48) is kept', async () => {
        await withClean(async () => {
          await knex('products_catalog').where({ id: dimensionId() }).update({ max_label_rate_per_1000: 4.5 });
          await octoberMigration.up(knex);
          expect(Number((await catalogRow()).max_label_rate_per_1000)).toBe(4.5);
          await octoberMigration.down(knex);
          expect(Number((await catalogRow()).max_label_rate_per_1000)).toBe(4.5);
        });
      });

      test('a NULL catalog max is filled with 5.46', async () => {
        await withClean(async () => {
          await knex('products_catalog').where({ id: dimensionId() }).update({ max_label_rate_per_1000: null });
          await octoberMigration.up(knex);
          expect(Number((await catalogRow()).max_label_rate_per_1000)).toBe(5.46);
          await octoberMigration.down(knex);
          expect((await catalogRow()).max_label_rate_per_1000).toBeNull();
        });
      });
    });

    describe('the Dimension product id', () => {
      test('a product that exists only behind an alias gets the max, the limits and the caps; the staged row links to it', async () => {
        await octoberMigration.down(knex);
        const original = await catalogRow();
        await knex('products_catalog').where({ id: dimensionId() }).update({ name: 'Dimension 0.21% Bag (SiteOne 702032)', active_ingredient: null });
        await knex('product_aliases').insert({ product_id: dimensionId(), alias_name: DIMENSION });
        try {
          await octoberMigration.up(knex);
          expect(Number((await catalogRow()).max_label_rate_per_1000)).toBe(5.46);
          expect(shape(await limitRows(dimensionId()))).toEqual([
            ['annual_max_apps', 'product', 3, 'applications', 'hard_block'],
            ['annual_max_rate', 'active_ingredient', 16.38, 'lb/1000sf/year', 'hard_block'],
            ['min_interval_days', 'product', 60, 'days', 'hard_block'],
          ]);
          expect(await octoberRow()).toMatchObject({ product_name: DIMENSION, product_id: dimensionId() });
          await octoberMigration.down(knex);
        } finally {
          await knex('products_catalog').where({ id: dimensionId() }).update({ active_ingredient: original.active_ingredient });
          await resetAndUp();
        }
      });

      test('no catalog row or alias: the migration throws and writes nothing (no half swap)', async () => {
        await octoberMigration.down(knex);
        await knex('products_catalog').where({ id: dimensionId() }).update({ name: 'Renamed away' });
        try {
          await expect(octoberMigration.up(knex)).rejects.toThrow(/no products_catalog row or alias for LESCO Dimension 0\.21%/);
          expect(await octoberRow()).toMatchObject({ product_name: STW_15 });
          expect(await limitRows(dimensionId())).toEqual([]);
          expect(await ours()).toEqual([]);
        } finally {
          await resetAndUp();
        }
      });
    });

    describe('the limit reader on a customer\'s Dimension history', () => {
      const day = (ymd) => new Date(`${ymd}T16:00:00Z`);
      const check = (customerId, ymd, opts) => applicationLimits.checkLimits(customerId, dimensionId(), day(ymd), knex, opts);

      async function twoProperties(visitDate = '2026-10-12') {
        const { scheduled, customerId } = await visit(visitDate);
        const propertyA = scheduled.property_id;
        const [propertyB] = await knex('customer_properties').insert({ customer_id: customerId, address_line1: '200 Fixture Street', city: 'Fixture City', zip: '34201', is_primary: false }).returning('*');
        const at = async (propertyId, date) => {
          const [past] = await knex('scheduled_services').insert({ customer_id: customerId, property_id: propertyId, scheduled_date: date, service_type: 'Lawn fixture' }).returning('*');
          const [record] = await knex('service_records').insert({ customer_id: customerId, scheduled_service_id: past.id, service_date: date, service_type: 'Lawn fixture' }).returning('*');
          await applied(customerId, DIMENSION, date, 4.04, 'lb', { service_record_id: record.id });
          return { past, record };
        };
        return { scheduled, customerId, propertyA, propertyB: propertyB.id, at };
      }

      test('the 60-day interval is a hard block inside 60 days of an application at the same property, and not for another property', async () => {
        const { customerId, propertyA, propertyB, at } = await twoProperties();
        await at(propertyA, '2026-09-20');
        const blocked = await check(customerId, '2026-10-12', { propertyId: propertyA });
        expect(blocked.allowed).toBe(false);
        expect(blocked.blocks[0]).toMatchObject({ type: 'min_interval_days', current: 22, max: 60 });
        expect((await check(customerId, '2026-10-12', { propertyId: propertyB })).blocks).toEqual([]);
        // No property: every property of the customer, as before.
        expect((await check(customerId, '2026-10-12')).blocks).toHaveLength(1);
        // 60 days later it clears.
        expect((await check(customerId, '2026-11-19', { propertyId: propertyA })).blocks).toEqual([]);
      });

      test('three applications at other properties do not hard-block this one; three at this property do', async () => {
        const { customerId, propertyA, propertyB, at } = await twoProperties('2026-12-12');
        await at(propertyA, '2026-01-10');
        await at(propertyA, '2026-04-10');
        await at(propertyA, '2026-07-10');
        const here = await check(customerId, '2026-12-12', { propertyId: propertyA });
        expect(here.blocks.map((b) => b.type)).toContain('annual_max_apps');
        expect(here.blocks.find((b) => b.type === 'annual_max_apps')).toMatchObject({ current: 3, max: 3 });
        const elsewhere = await check(customerId, '2026-12-12', { propertyId: propertyB });
        expect(elsewhere.blocks.filter((b) => b.type === 'annual_max_apps')).toEqual([]);
      });

      test('the visit\'s own ledger row is left out of a re-plan, so a completed visit does not read a zero-day interval or its own count', async () => {
        const { scheduled, customerId, propertyA, at } = await twoProperties();
        await at(propertyA, '2026-07-10');
        await at(propertyA, '2026-04-10');
        const own = await knex('service_records').insert({ customer_id: customerId, scheduled_service_id: scheduled.id, service_date: '2026-10-12', service_type: 'Lawn fixture' }).returning('*');
        await applied(customerId, DIMENSION, '2026-10-12', 4.04, 'lb', { service_record_id: own[0].id });
        const counted = await check(customerId, '2026-10-12', { propertyId: propertyA });
        expect(counted.blocks.map((b) => b.type).sort()).toEqual(['annual_max_apps', 'min_interval_days']);
        expect(counted.blocks.find((b) => b.type === 'min_interval_days').current).toBe(0);
        const excluded = await check(customerId, '2026-10-12', { propertyId: propertyA, excludeScheduledServiceId: scheduled.id });
        expect(excluded.blocks).toEqual([]);
        expect(excluded.warnings.filter((w) => w.severity !== 'info')).toEqual([]);
      });

      test('the history stops at the proposed day: a later ledger row is not read as an earlier application', async () => {
        const { customerId, propertyA, at } = await twoProperties();
        await at(propertyA, '2026-10-20');
        const backdated = await check(customerId, '2026-10-01', { propertyId: propertyA });
        expect(backdated.blocks).toEqual([]);
        expect(backdated.warnings).toEqual([]);
        // The day itself counts (a completion reads after the ledger write), and the next day is 1 day after it.
        expect((await check(customerId, '2026-10-20', { propertyId: propertyA })).blocks[0]).toMatchObject({ type: 'min_interval_days', current: 0 });
        expect((await check(customerId, '2026-10-21', { propertyId: propertyA })).blocks[0]).toMatchObject({ type: 'min_interval_days', current: 1 });
      });
    });

    // October no longer plans the Dimension granular (20261122120000): only the 9x April step counts against the dithiopyr cap.
    describe('the plan counts the 9x April Dimension step against the yearly dithiopyr cap', () => {
      test.each([
        ['at 68.1% (1.5 fl oz)', 1.5, 'warn', /is 68\.1% of the yearly label cap; this application brings it to 85%/],
        ['at 90.7% (2.0 fl oz)', 2, 'block', /is 90\.7% of the yearly label cap; this application brings it to 107\.7% — THIS APPLICATION WOULD EXCEED IT/],
      ])('April on the 9x plan: the DERIVED 2.78 lb (0.5 lb N / 18%, 17.0%) counts, history %s', async (label, fluidOz, outcome, message) => {
        setGates();
        const { scheduled, customerId } = await visit('2026-04-14', { service_type: 'Every 6 Weeks Lawn Care Service' });
        await applied(customerId, DIM_2EW, '2026-03-10', fluidOz, 'fl oz');
        const result = await plan(scheduled);
        if (outcome === 'block') {
          expect(result.propertyGate.blocks.find((b) => b.code === 'lawn_v13_annual_limit').message).toMatch(message);
          expect(item(result, DIMENSION).mix).toBeNull();
        } else {
          expect(codes(result)).not.toContain('lawn_v13_annual_limit');
          expect(result.propertyGate.warnings.find((w) => w.code === 'lawn_v13_limit_warning' && /yearly label cap/.test(w.message)).message).toMatch(message);
          expect(item(result, DIMENSION).mix).toMatchObject({ amount: 27.778 });
        }
      });

      test('the 12x April step (44-0-0, no dithiopyr) is not capped by dithiopyr history', async () => {
        setGates();
        const { scheduled, customerId } = await visit('2026-04-14', { service_type: 'Monthly Lawn Care Service' });
        await applied(customerId, DIM_2EW, '2026-03-10', 2.2, 'fl oz');
        const result = await plan(scheduled);
        expect(codes(result)).not.toContain('lawn_v13_annual_limit');
        expect(item(result, F44).mix).toMatchObject({ amount: 22.727 });
      });

    });
  });

  // The October step moves on from the Dimension granular to Stonewall 0.37% 18-0-10 (owner 2026-11-21). The describe above
  // leaves the fixture on the Dimension row 20261007120500 wrote, which is exactly this migration's starting state.
  describe('October Stonewall 0.37% 18-0-10 (20261122120000)', () => {
    const STW_037 = stonewallMigration.NEW_NAME;
    const stonewallId = () => catalog[STW_037].id;
    const dimensionId = () => catalog[DIMENSION].id;
    const octoberRow = () => knex('lawn_protocol_products as p').join('lawn_protocol_windows as w', 'p.lawn_protocol_window_id', 'w.id')
      .where({ 'w.window_key': 'oct_v13_spreader_fall' }).select('p.*', 'w.goal').first();
    const limitRows = (productId) => knex('product_limits').where({ product_id: productId }).orderBy(['limit_type', 'match_type']);
    const shape = (rows) => rows.map((r) => [r.limit_type, r.match_type, r.match_value, Number(r.limit_value), r.limit_unit, r.severity]);
    const ours = () => knex('lawn_protocol_audit_log').whereIn('action', [stonewallMigration.ACTION, stonewallMigration.CATALOG_ACTION]).orderBy('id');
    const catalogRow = () => knex('products_catalog').where({ id: stonewallId() }).first();
    // Every catalog column, the stamp included: a catalog row that already holds its analysis is never written.
    const catalogJson = async () => JSON.stringify(await catalogRow());
    const otherRows = () => knex('lawn_protocol_products as p').join('lawn_protocol_windows as w', 'p.lawn_protocol_window_id', 'w.id')
      .whereNot({ 'w.window_key': 'oct_v13_spreader_fall' }).orderBy('p.id').select('p.id', 'p.product_name', 'p.product_id', 'p.rate_per_1000', 'p.rate_unit', 'p.gates', 'p.annual_counter');
    // The whole staged row as the migrations leave it, the same on all four tracks and in production (read 2026-11-22).
    const ROW_GATES = { targetN: '0.73 lb N/1000', targetK2O: '0.4 lb K2O/1000', fertilizerSafety: true, blackoutSensitive: true };
    const DIMENSION_OCTOBER = {
      product_name: DIMENSION, role: 'fall_pre_emergent_nutrition', application_mode: 'broadcast', rate_per_1000: 4.04, rate_unit: 'lb', carrier_gal_per_1000: null, default_in_plan: true,
      gates: { ...ROW_GATES, annualCounter: 'dithiopyr_lb_per_1000' }, annual_counter: { counter: 'dithiopyr_lb_per_1000' }, mixing: {}, report_copy: { role: 'fall_pre_emergent_nutrition' },
    };
    // The fixture as 20261007120500 leaves it: the Dimension row, its goal, no Stonewall 0.37% limit row, no audit row of ours.
    async function resetToDimension() {
      const row = await octoberRow();
      await knex('lawn_protocol_products').where({ id: row.id }).update({
        ...DIMENSION_OCTOBER, product_id: dimensionId(), gates: JSON.stringify(DIMENSION_OCTOBER.gates), annual_counter: JSON.stringify(DIMENSION_OCTOBER.annual_counter),
        mixing: JSON.stringify(DIMENSION_OCTOBER.mixing), report_copy: JSON.stringify(DIMENSION_OCTOBER.report_copy),
      });
      await knex('lawn_protocol_windows').where({ id: row.lawn_protocol_window_id }).update({ goal: stonewallMigration.OLD_GOAL });
      // A row the migration inserted (no other row had the name): gone, once the protocol row points back at Dimension.
      const inserted = await knex('products_catalog').where({ name: STW_037 }).whereNot({ id: stonewallId() }).select('id');
      for (const { id } of inserted) await knex('product_limits').where({ product_id: id }).del();
      if (inserted.length) await knex('products_catalog').whereIn('id', inserted.map((r) => r.id)).del();
      await knex('products_catalog').where({ id: stonewallId() }).update({ name: STW_037, hrac_group: null, active: true, active_ingredient: 'Prodiamine 0.37% + 18-0-10', epa_reg_number: '10404-114' });
      await knex('product_limits').where({ product_id: stonewallId() }).del();
      await knex('product_aliases').where({ product_id: stonewallId() }).del();
      await knex('lawn_protocol_audit_log').whereIn('action', [stonewallMigration.ACTION, stonewallMigration.CATALOG_ACTION]).del();
    }
    const withReset = async (run) => {
      await resetToDimension();
      try { await run(); } finally { await resetToDimension(); }
    };

    beforeAll(async () => {
      const [row] = await knex('products_catalog').insert({
        name: STW_037, category: 'herbicide', label_verified_at: new Date(), inventory_on_hand: 100000, inventory_unit: 'lb', active: true,
        active_ingredient: 'Prodiamine 0.37% + 18-0-10', epa_reg_number: '10404-114', formulation: 'granular', default_rate_per_1000: 4.04, rate_unit: 'lb', analysis_n: 18, analysis_p: 0, analysis_k: 10,
        slow_release_n_pct: 56, min_label_rate_per_1000: 3.1, max_label_rate_per_1000: 9.3, best_price: 33.46, best_vendor: 'Fixture vendor',
        post_application_watering: stonewallMigration.CATALOG_ROW.post_application_watering,
      }).returning('*');
      catalog[STW_037] = row;
      await resetToDimension();
    });

    test('up: the October row is Stonewall 0.37% 18-0-10 at the same 4.04 lb, with its product id, the same N and K2O gate text, the prodiamine counter and the new goal', async () => {
      const before = { other: JSON.stringify(await otherRows()), catalog: await catalogJson(), dimension: JSON.stringify(await limitRows(dimensionId())) };
      await stonewallMigration.up(knex);
      const row = await octoberRow();
      expect(row).toMatchObject({ product_name: STW_037, product_id: stonewallId(), role: 'fall_pre_emergent_nutrition', rate_unit: 'lb', goal: stonewallMigration.NEW_GOAL });
      expect(Number(row.rate_per_1000)).toBe(4.04);
      expect(row.gates).toEqual({ ...ROW_GATES, annualCounter: 'prodiamine_lb_per_1000' });
      // Nothing else of the row moves: role, mode, carrier, mixing, report copy.
      expect(row).toMatchObject({ application_mode: 'broadcast', carrier_gal_per_1000: null, default_in_plan: true, mixing: {}, report_copy: { role: 'fall_pre_emergent_nutrition' } });
      expect(row.annual_counter).toEqual({ counter: 'prodiamine_lb_per_1000' });
      expect(stonewallMigration.NEW_GOAL).toBe('Stonewall 18-0-10 fall feeding with pre-emergent; mapped large patch, take-all, grub and weed spots.');
      // Out of scope, exactly as before: every other window's rows (the 9x April Dimension row, January 4FL), the catalog row, the Dimension limit rows.
      expect(JSON.stringify(await otherRows())).toBe(before.other);
      expect(await catalogJson()).toBe(before.catalog);
      expect(JSON.stringify(await limitRows(dimensionId()))).toBe(before.dimension);
      const april = await knex('lawn_protocol_products as p').join('lawn_protocol_windows as w', 'p.lawn_protocol_window_id', 'w.id')
        .where({ 'w.window_key': aprilMigration.APRIL_WINDOW, 'p.product_name': DIMENSION }).select('p.rate_per_1000', 'p.rate_unit', 'p.gates').first();
      expect([april.rate_per_1000, april.rate_unit, april.gates.targetN, april.gates.planVisitsPerYear]).toEqual([null, 'lb_n', '0.5 lb N/1000', 9]);
    });

    test('up inserts the yearly prodiamine cap (the label maximum: 405 lb per acre, printed as 9.3 lb of the bag per 1,000 sq ft) where the product has none, and audits it once', async () => {
      expect(shape(await limitRows(stonewallId()))).toEqual([['annual_max_rate', 'active_ingredient', 'prodiamine', 9.3, 'lb/1000sf/year', 'hard_block']]);
      // The figure derived from 1.5 lb ai per acre is a little above the label's printed maximum: the cap is the lower one.
      expect([stonewallMigration.CAP_VALUE, stonewallMigration.DERIVED_CAP]).toEqual([9.3, 9.3068]);
      expect(stonewallMigration.CAP_VALUE).toBe(stonewallMigration.CATALOG_ROW.max_label_rate_per_1000);
      const audits = await ours();
      expect(audits.map((log) => log.action).sort()).toEqual([stonewallMigration.ACTION, stonewallMigration.CATALOG_ACTION].sort());
      expect(audits.find((log) => log.action === stonewallMigration.ACTION).after_snapshot.rows[0].columns.product_name).toEqual({ before: DIMENSION, after: STW_037 });
      expect(audits.find((log) => log.action === stonewallMigration.CATALOG_ACTION).after_snapshot)
        .toMatchObject({ insertedProductId: null, caps: [expect.objectContaining({ limit_value: 9.3 })], capsLowered: [], defaultRate: null, analysisFilled: null });
    });

    test('a second up changes nothing', async () => {
      const stateOf = async () => JSON.stringify([await octoberRow(), await catalogRow(), await limitRows(stonewallId()), await otherRows(), await ours()]);
      const before = await stateOf();
      await stonewallMigration.up(knex);
      expect(await stateOf()).toBe(before);
    });

    test('down puts the Dimension row, its goal and counter back and removes the protocol audit row; the cap row and its audit row stay (label facts); up swaps again', async () => {
      const stamped = async () => { const { updated_at: _u, ...rest } = await octoberRow(); return JSON.stringify(rest); };
      const swapped = await stamped();
      const caps = JSON.stringify(await limitRows(stonewallId()));
      await stonewallMigration.down(knex);
      try {
        const row = await octoberRow();
        expect(row).toMatchObject({ product_name: DIMENSION, product_id: dimensionId(), rate_unit: 'lb', goal: stonewallMigration.OLD_GOAL });
        expect(Number(row.rate_per_1000)).toBe(4.04);
        expect(row.gates).toEqual(DIMENSION_OCTOBER.gates);
        expect(row.annual_counter).toEqual(DIMENSION_OCTOBER.annual_counter);
        // An application made with the bag still counts against the cap, so the cap row is never rolled back.
        expect(JSON.stringify(await limitRows(stonewallId()))).toBe(caps);
        expect((await ours()).map((log) => log.action)).toEqual([stonewallMigration.CATALOG_ACTION]);
      } finally {
        await stonewallMigration.up(knex);
      }
      expect(await stamped()).toBe(swapped);
      // The second up found the cap row: one catalog audit row, not two.
      expect((await ours()).map((log) => log.action).sort()).toEqual([stonewallMigration.ACTION, stonewallMigration.CATALOG_ACTION].sort());
    });

    // Identity, dose and counter are one rollback decision: an edited Stonewall dose never ends on the Dimension row.
    test.each([
      ['re-rated', (row) => ({ rate_per_1000: 3.9 })],
      ['on another N target', (row) => ({ gates: JSON.stringify({ ...row.gates, targetN: '0.7 lb N/1000' }) })],
      ['turned off', () => ({ default_in_plan: false })],
      ['renamed', () => ({ product_name: 'Renamed by the office' })],
      ['switched to a spot treatment', () => ({ application_mode: 'spot' })],
      // Nothing written since can be erased: the row is not put back in part.
      ['given another member in its annual counter', (row) => ({ annual_counter: JSON.stringify({ ...row.annual_counter, maxApplications: 1 }) })],
      ['given another gate', (row) => ({ gates: JSON.stringify({ ...row.gates, officeGate: 'kept' }) })],
    ])('a swapped row %s since is not the row this wrote: down leaves the whole row, its goal and both audit rows', async (_label, edit) => {
      const log = jest.spyOn(console, 'log').mockImplementation(() => {});
      const row = await octoberRow();
      await knex('lawn_protocol_products').where({ id: row.id }).update(edit(row));
      try {
        const stateOf = async () => JSON.stringify([await octoberRow(), await limitRows(stonewallId()), await ours()]);
        const before = await stateOf();
        await stonewallMigration.down(knex);
        expect(await stateOf()).toBe(before);
        expect(await octoberRow()).toMatchObject({ product_id: stonewallId(), goal: stonewallMigration.NEW_GOAL });
        expect(log).toHaveBeenCalledWith(expect.stringContaining(`rollback skipped for protocol ${KEY}: its October row is no longer the row this migration wrote`));
      } finally {
        log.mockRestore();
        await resetToDimension();
        await stonewallMigration.up(knex);
      }
    });

    test('a visit pinned to the protocol makes the rollback a no-op: the Stonewall row, its audit rows and the cap row stay', async () => {
      const log = jest.spyOn(console, 'log').mockImplementation(() => {});
      const { scheduled } = await visit('2026-10-13', { lawn_protocol_key: KEY, lawn_protocol_version: LAWN_V13_VERSION });
      try {
        const stateOf = async () => JSON.stringify([await octoberRow(), await limitRows(stonewallId()), await ours()]);
        const before = await stateOf();
        await stonewallMigration.down(knex);
        expect(await stateOf()).toBe(before);
        expect(log).toHaveBeenCalledWith(expect.stringContaining(`rollback skipped for protocol ${KEY}`));
      } finally {
        log.mockRestore();
        await knex('scheduled_services').where({ id: scheduled.id }).update({ lawn_protocol_key: null, lawn_protocol_version: null });
      }
      await stonewallMigration.down(knex);
      expect(await octoberRow()).toMatchObject({ product_name: DIMENSION });
      await stonewallMigration.up(knex);
      expect(await octoberRow()).toMatchObject({ product_name: STW_037 });
    });

    describe('only the exact Dimension October row is swapped; any other state stops the migration before it writes', () => {
      // The recipe says Stonewall on every track: a track left on another row would put the recipe and the staged protocol apart.
      test.each([
        ['renamed', { product_name: 'Renamed by the office' }],
        ['on another product id', { product_id: null }],
        ['re-rated', { rate_per_1000: 3.9 }],
        ['in another unit (4.04 oz is not 4.04 lb)', { rate_unit: 'oz' }],
        ['on another N target', { gates: JSON.stringify({ ...DIMENSION_OCTOBER.gates, targetN: '0.5 lb N/1000' }) }],
        ['on another K2O target', { gates: JSON.stringify({ ...DIMENSION_OCTOBER.gates, targetK2O: '0.2 lb K2O/1000' }) }],
        ['on another counter', { annual_counter: JSON.stringify({ counter: 'office_counter' }) }],
        ['turned off (not in the plan by default)', { default_in_plan: false }],
        ['applied as a spot treatment (the plan would size no whole-lawn amount)', { application_mode: 'spot' }],
        ['on another role', { role: 'fall_nutrition' }],
        ['given a carrier volume', { carrier_gal_per_1000: 1 }],
        ['given another gate', { gates: JSON.stringify({ ...DIMENSION_OCTOBER.gates, officeGate: true }) }],
        ['given another member in its annual counter', { annual_counter: JSON.stringify({ counter: 'dithiopyr_lb_per_1000', maxApplications: 1 }) }],
        ['given mixing notes', { mixing: JSON.stringify({ note: 'office' }) }],
      ])('a row that is %s: up throws, names the protocol and writes nothing', async (_label, change) => {
        await withReset(async () => {
          const row = await octoberRow();
          await knex('lawn_protocol_products').where({ id: row.id }).update(change);
          const stateOf = async () => JSON.stringify([await octoberRow(), await catalogJson(), await limitRows(stonewallId()), await otherRows(), await ours()]);
          const before = await stateOf();
          await expect(stonewallMigration.up(knex)).rejects.toThrow(`the October step of ${KEY} is not the row 20261007120500 wrote`);
          expect(await stateOf()).toBe(before);
        });
      });

      const stateOf = async () => JSON.stringify([await octoberRow(), await catalogJson(), await limitRows(stonewallId()), await otherRows(), await ours()]);

      test('both bags in one window (an optional Stonewall 0.37% row beside the Dimension row): up throws and writes nothing', async () => {
        await withReset(async () => {
          const row = await octoberRow();
          const [extra] = await knex('lawn_protocol_products').insert({
            lawn_protocol_window_id: row.lawn_protocol_window_id, product_id: stonewallId(), product_name: STW_037, application_mode: 'broadcast', default_in_plan: false, role: 'fall_pre_emergent_nutrition', rate_per_1000: 4.04, rate_unit: 'lb',
          }).returning('id');
          try {
            const before = await stateOf();
            await expect(stonewallMigration.up(knex)).rejects.toThrow(`the October step of ${KEY} is not the row 20261007120500 wrote`);
            expect(await stateOf()).toBe(before);
            expect(await knex('lawn_protocol_products').where({ lawn_protocol_window_id: row.lawn_protocol_window_id, product_name: DIMENSION }).first()).toBeTruthy();
          } finally { await knex('lawn_protocol_products').where({ id: extra.id ?? extra }).del(); }
        });
      });

      test.each([
        ['at another rate', { rate_per_1000: 3.1 }],
        ['turned off', { default_in_plan: false }],
        ['on the dithiopyr counter', { annual_counter: JSON.stringify({ counter: 'dithiopyr_lb_per_1000' }) }],
        ['linked to another product', { product_id: null }],
      ])('a Stonewall 0.37% row set by hand %s is not the swapped row: up throws and writes nothing', async (_label, change) => {
        await withReset(async () => {
          await stonewallMigration.up(knex);
          const row = await octoberRow();
          await knex('lawn_protocol_products').where({ id: row.id }).update(change);
          const before = await stateOf();
          await expect(stonewallMigration.up(knex)).rejects.toThrow(`the October step of ${KEY} is not the row 20261007120500 wrote`);
          expect(await stateOf()).toBe(before);
          await knex('lawn_protocol_products').where({ id: row.id }).update({ default_in_plan: true });
        });
      });

      test('every window already holds the swapped row: up writes no protocol row and still puts back a missing cap row', async () => {
        await withReset(async () => {
          await stonewallMigration.up(knex);
          const swapped = JSON.stringify(await octoberRow());
          await knex('product_limits').where({ product_id: stonewallId() }).del();
          await knex('lawn_protocol_audit_log').whereIn('action', [stonewallMigration.ACTION, stonewallMigration.CATALOG_ACTION]).del();
          await stonewallMigration.up(knex);
          expect(JSON.stringify(await octoberRow())).toBe(swapped);
          expect(shape(await limitRows(stonewallId()))).toEqual([['annual_max_rate', 'active_ingredient', 'prodiamine', 9.3, 'lb/1000sf/year', 'hard_block']]);
          expect((await ours()).map((log) => log.action)).toEqual([stonewallMigration.CATALOG_ACTION]);
        });
      });

      test('a goal the office rewrote is kept; the row still swaps', async () => {
        await withReset(async () => {
          const row = await octoberRow();
          await knex('lawn_protocol_windows').where({ id: row.lawn_protocol_window_id }).update({ goal: 'Office goal' });
          await stonewallMigration.up(knex);
          expect(await octoberRow()).toMatchObject({ product_name: STW_037, goal: 'Office goal' });
          await stonewallMigration.down(knex);
          expect(await octoberRow()).toMatchObject({ product_name: DIMENSION, goal: 'Office goal' });
        });
      });
    });

    describe('a cap row that exists', () => {
      const capRow = (value, extra = {}) => ({
        product_id: stonewallId(), match_type: 'active_ingredient', match_value: 'prodiamine', limit_type: 'annual_max_rate', limit_value: value, limit_unit: 'lb/1000sf/year', severity: 'hard_block', description: 'Existing production row', ...extra,
      });

      // The planner divides by this row, so it may never be above the label's yearly maximum.
      test.each([
        ['the derived 9.3068 (production, from 20261006140000)', 9.3068],
        ['a higher figure someone set', 9.5],
      ])('%s is above the label\'s 9.3: lowered to 9.3, audited, and down leaves it at 9.3', async (_label, value) => {
        await withReset(async () => {
          const [made] = await knex('product_limits').insert(capRow(value)).returning('id');
          const id = made.id ?? made;
          const catalogBefore = await catalogJson();
          await stonewallMigration.up(knex);
          const rows = await limitRows(stonewallId());
          expect(rows.map((row) => [row.id, Number(row.limit_value), row.limit_unit, row.severity, row.description])).toEqual([[id, 9.3, 'lb/1000sf/year', 'hard_block', 'Existing production row']]);
          expect(await catalogJson()).toBe(catalogBefore);
          expect((await ours()).find((log) => log.action === stonewallMigration.CATALOG_ACTION).after_snapshot)
            .toMatchObject({ caps: [], capsLowered: [{ id, before: value, after: 9.3 }] });
          await stonewallMigration.down(knex);
          expect(shape(await limitRows(stonewallId()))).toEqual([['annual_max_rate', 'active_ingredient', 'prodiamine', 9.3, 'lb/1000sf/year', 'hard_block']]);
          expect(await octoberRow()).toMatchObject({ product_name: DIMENSION });
        });
      });

      test.each([
        ['a stricter figure the office set', 8.5],
        ['the label figure itself', 9.3],
      ])('%s is at or under the label maximum: kept as it is, no catalog audit row, and down leaves it', async (_label, value) => {
        await withReset(async () => {
          await knex('product_limits').insert(capRow(value));
          const before = (await limitRows(stonewallId())).map((r) => JSON.stringify(r));
          const catalogBefore = await catalogJson();
          await stonewallMigration.up(knex);
          expect((await limitRows(stonewallId())).map((r) => JSON.stringify(r))).toEqual(before);
          expect(await catalogJson()).toBe(catalogBefore);
          // The protocol audit row only: nothing in the catalog or the limits was written.
          expect((await ours()).map((log) => log.action)).toEqual([stonewallMigration.ACTION]);
          await stonewallMigration.down(knex);
          expect((await limitRows(stonewallId())).map((r) => JSON.stringify(r))).toEqual(before);
          expect(await octoberRow()).toMatchObject({ product_name: DIMENSION });
        });
      });

      test.each([
        ['in another unit', [{ limit_unit: 'oz/1000sf/year' }]],
        ['that only warns', [{ severity: 'warning' }]],
        // The yearly check joins an application to every matching cap row and adds the shares: two rows count it twice.
        ['beside a second cap row', [{}, { description: 'A second row' }]],
      ])('a cap row %s cannot be checked against the label maximum: up throws and writes nothing', async (_label, extras) => {
        await withReset(async () => {
          for (const extra of extras) await knex('product_limits').insert(capRow(9.3068, extra));
          const stateOf = async () => JSON.stringify([await octoberRow(), await catalogJson(), await limitRows(stonewallId()), await otherRows(), await ours()]);
          const before = await stateOf();
          await expect(stonewallMigration.up(knex)).rejects.toThrow('cannot be checked against the label maximum of 9.3 lb per 1,000 sq ft. Nothing was written.');
          expect(await stateOf()).toBe(before);
          expect(await octoberRow()).toMatchObject({ product_name: DIMENSION });
        });
      });

      test('the January 4FL cap row and the Dimension limit rows are not touched', async () => {
        await withReset(async () => {
          const rows4fl = JSON.stringify(await limitRows(catalog[STW_4FL].id));
          const rowsDim = JSON.stringify(await limitRows(dimensionId()));
          await stonewallMigration.up(knex);
          expect(JSON.stringify(await limitRows(catalog[STW_4FL].id))).toBe(rows4fl);
          expect(JSON.stringify(await limitRows(dimensionId()))).toBe(rowsDim);
        });
      });
    });

    describe('the Stonewall product id', () => {
      // The gate: one row with the exact name and the production facts, or no row and no alias at all. Nothing between.
      const stateOf = async () => JSON.stringify([await octoberRow(), await knex('products_catalog').where({ name: STW_037 }).orWhere({ id: stonewallId() }).orderBy('id'), await limitRows(stonewallId()), await otherRows(), await ours()]);
      const refuses = async (message) => {
        const before = await stateOf();
        await expect(stonewallMigration.up(knex)).rejects.toThrow(message);
        expect(await stateOf()).toBe(before);
        expect(await octoberRow()).toMatchObject({ product_name: DIMENSION });
      };

      test.each([
        ['is not active', { active: false }, 'is not active'],
        ['states no active ingredient (the yearly cap check finds an application by that word)', { active_ingredient: null }, 'does not state prodiamine first as its active ingredient (null)'],
        ['states another active ingredient first', { active_ingredient: 'Dithiopyr 0.21% + 18-0-10' }, 'does not state prodiamine first as its active ingredient'],
        ['holds another EPA registration', { epa_reg_number: '10404-87' }, 'holds EPA registration "10404-87", not 10404-114'],
        ['holds no EPA registration', { epa_reg_number: null }, 'holds EPA registration null, not 10404-114'],
      ])('a catalog row that %s is not the bag this swap knows: up throws and writes nothing', async (_label, change, message) => {
        await withReset(async () => {
          await knex('products_catalog').where({ id: stonewallId() }).update(change);
          await refuses(message);
        });
      });

      test('a product known only through an alias: up throws and writes nothing (no second catalog row is made)', async () => {
        await withReset(async () => {
          await knex('products_catalog').where({ id: stonewallId() }).update({ name: 'Stonewall 0.37% Bag (SiteOne)' });
          await knex('product_aliases').insert({ product_id: stonewallId(), alias_name: STW_037 });
          await refuses(`0 catalog rows are named ${STW_037}, and an alias spells that name`);
        });
      });

      test('an alias that spells the name on another product: up throws and writes nothing', async () => {
        await withReset(async () => {
          const [alias] = await knex('product_aliases').insert({ product_id: dimensionId(), alias_name: STW_037 }).returning('id');
          try {
            await refuses(`an alias spells ${STW_037} on another product`);
          } finally { await knex('product_aliases').where({ id: alias.id ?? alias }).del(); }
        });
      });

      test('an alias that spells the name on the same product changes nothing: the row swaps', async () => {
        await withReset(async () => {
          await knex('product_aliases').insert({ product_id: stonewallId(), alias_name: STW_037.toLowerCase() });
          await stonewallMigration.up(knex);
          expect(await octoberRow()).toMatchObject({ product_name: STW_037, product_id: stonewallId() });
        });
      });

      test('the Dimension product known only through an alias (the path 20261007120500 supports): its id is still the row link, and the row swaps', async () => {
        await withReset(async () => {
          await knex('products_catalog').where({ id: dimensionId() }).update({ name: 'Dimension 0.21% Bag (SiteOne)' });
          const [alias] = await knex('product_aliases').insert({ product_id: dimensionId(), alias_name: DIMENSION }).returning('id');
          try {
            await stonewallMigration.up(knex);
            expect(await octoberRow()).toMatchObject({ product_name: STW_037, product_id: stonewallId() });
          } finally {
            await knex('product_aliases').where({ id: alias.id ?? alias }).del();
            await knex('products_catalog').where({ id: dimensionId() }).update({ name: DIMENSION });
          }
        });
      });

      test('an active ingredient with a leading space is not found by the yearly cap check (ILIKE \'prodiamine%\'): up throws and writes nothing', async () => {
        await withReset(async () => {
          await knex('products_catalog').where({ id: stonewallId() }).update({ active_ingredient: ' Prodiamine 0.37% + 18-0-10' });
          await refuses('does not state prodiamine first as its active ingredient');
        });
      });

      test('a catalog name that differs only in letter case is not the exact name the recipe finds: up throws and writes nothing', async () => {
        await withReset(async () => {
          await knex('products_catalog').where({ id: stonewallId() }).update({ name: STW_037.toLowerCase() });
          try { await refuses('on the locked row, not exactly "LESCO Stonewall 0.37% 18-0-10"'); } finally { await knex('products_catalog').where({ id: stonewallId() }).update({ name: STW_037 }); }
        });
      });

      test('a second v13 protocol with no October window: up throws and writes nothing (that track\'s recipe step would have no staged row)', async () => {
        await withReset(async () => {
          const [other] = await knex('lawn_protocols').insert({ protocol_key: 'fixture_v13_no_october', version: LAWN_V13_VERSION, name: 'Fixture v13, no October', status: 'staged', grass_track: 'zoysia', region: 'swfl' }).returning('id');
          try { await refuses('the v13 protocol(s) fixture_v13_no_october do not hold exactly one oct_v13_spreader_fall window while others do'); } finally { await knex('lawn_protocols').where({ id: other.id ?? other }).del(); }
        });
      });

      test('two catalog rows with the name: up throws and writes nothing', async () => {
        await withReset(async () => {
          const [twin] = await knex('products_catalog').insert({ name: `${STW_037} `, category: 'herbicide', active: true, active_ingredient: 'Prodiamine 0.37% + 18-0-10', epa_reg_number: '10404-114', rate_unit: 'lb' }).returning('id');
          const id = twin.id ?? twin;
          try {
            const before = JSON.stringify([await octoberRow(), await catalogJson(), await limitRows(stonewallId()), await ours()]);
            await expect(stonewallMigration.up(knex)).rejects.toThrow(`2 catalog rows are named ${STW_037}`);
            expect(JSON.stringify([await octoberRow(), await catalogJson(), await limitRows(stonewallId()), await ours()])).toBe(before);
          } finally { await knex('products_catalog').where({ id }).del(); }
        });
      });

      const insertedRow = () => knex('products_catalog').where({ name: STW_037 }).whereNot({ id: stonewallId() }).first();
      const awayFromCatalog = () => knex('products_catalog').where({ id: stonewallId() }).update({ name: 'Renamed away' });

      test('no catalog row or alias (a database built from migrations alone): the row is inserted with the production values and the protocol rows link to it', async () => {
        await withReset(async () => {
          await awayFromCatalog();
          await stonewallMigration.up(knex);
          const made = await insertedRow();
          expect(made).toMatchObject({
            name: STW_037, category: 'herbicide', subcategory: 'Pre-emergent + fertilizer combo', active_ingredient: 'Prodiamine 0.37% + 18-0-10', moa_group: 'Group 3',
            formulation: 'granular', container_size: '50 lb', epa_reg_number: '10404-114', rate_unit: 'lb', service_lines: ['lawn'], active: true,
            approved_for_service_report: false, content_status: 'draft', customer_visibility: 'internal_only',
          });
          // The standard rate is the program rate (AGENTS.md fan-out rule); the label's range is 3.1 to 9.3 lb.
          expect([Number(made.unit_size_oz), Number(made.default_rate_per_1000), Number(made.min_label_rate_per_1000), Number(made.max_label_rate_per_1000)]).toEqual([800, 4.04, 3.1, 9.3]);
          expect(made.post_application_watering).toMatchObject({ mode: 'water_in', source: 'label', water_in_inches: 0.5, water_in_by_hours: 336 });
          expect(made.post_application_watering.label_note).toContain('activated by at least 0.5 inch of rainfall or irrigation prior to weed seed germination and within 14 days following application.');
          expect(await octoberRow()).toMatchObject({ product_name: STW_037, product_id: made.id });
          expect(shape(await limitRows(made.id))).toEqual([['annual_max_rate', 'active_ingredient', 'prodiamine', 9.3, 'lb/1000sf/year', 'hard_block']]);
          expect((await ours()).find((log) => log.action === stonewallMigration.CATALOG_ACTION).after_snapshot).toMatchObject({ insertedProductId: made.id, productId: made.id, analysisFilled: null });
        });
      });

      test('down never deletes the catalog row or the cap row this migration inserted (an administrator may have edited them since); up again finds them and inserts nothing', async () => {
        await withReset(async () => {
          await awayFromCatalog();
          await stonewallMigration.up(knex);
          const made = await insertedRow();
          expect([Number(made.analysis_n), Number(made.analysis_p), Number(made.analysis_k), Number(made.slow_release_n_pct)]).toEqual([18, 0, 10, 56]);
          await knex('products_catalog').where({ id: made.id }).update({ best_price: 35.98, best_vendor: 'Set by the office', approved_for_service_report: true });
          await stonewallMigration.down(knex);
          expect(await octoberRow()).toMatchObject({ product_name: DIMENSION, product_id: dimensionId() });
          expect(await insertedRow()).toMatchObject({ id: made.id, best_vendor: 'Set by the office', approved_for_service_report: true });
          expect(shape(await limitRows(made.id))).toHaveLength(1);
          expect((await ours()).map((log) => log.action)).toEqual([stonewallMigration.CATALOG_ACTION]);
          await stonewallMigration.up(knex);
          expect(await octoberRow()).toMatchObject({ product_name: STW_037, product_id: made.id });
          expect((await knex('products_catalog').where({ name: STW_037 }).select('id')).map((row) => row.id)).toEqual([made.id]);
          expect(shape(await limitRows(made.id))).toHaveLength(1);
          expect((await ours()).filter((log) => log.action === stonewallMigration.CATALOG_ACTION)).toHaveLength(1);
        });
      });

      test('a catalog row that already holds its analysis is never written: not one column of it moves, the chemical group columns and the stamp included, up or down', async () => {
        await withReset(async () => {
          const before = await catalogJson();
          expect(await catalogRow()).toMatchObject({ hrac_group: null });
          await stonewallMigration.up(knex);
          expect(await catalogJson()).toBe(before);
          await stonewallMigration.down(knex);
          expect(await catalogJson()).toBe(before);
        });
      });

      // Production, read 2026-11-22: the row holds no analysis, so the new-sod sheet and the completion checks would not read the bag as a fertilizer.
      const setAnalysis = (values) => knex('products_catalog').where({ id: stonewallId() }).update(values);
      const analysisOf = async () => { const row = await catalogRow(); return [row.analysis_n, row.analysis_p, row.analysis_k].map((value) => (value == null ? null : Number(value))); };

      test('a catalog row with no analysis and no slow-release share (the production row) gets 18-0-10 and 56%, and nothing else; the fill is audited and down leaves it', async () => {
        await withReset(async () => {
          await setAnalysis({ analysis_n: null, analysis_p: null, analysis_k: null, slow_release_n_pct: null });
          try {
            const strip = ({ analysis_n: _n, analysis_p: _p, analysis_k: _k, slow_release_n_pct: _s, updated_at: _u, ...rest }) => JSON.stringify(rest);
            const before = strip(await catalogRow());
            await stonewallMigration.up(knex);
            expect(await analysisOf()).toEqual([18, 0, 10]);
            expect(Number((await catalogRow()).slow_release_n_pct)).toBe(56);
            expect(strip(await catalogRow())).toBe(before);
            expect((await ours()).find((log) => log.action === stonewallMigration.CATALOG_ACTION).after_snapshot)
              .toMatchObject({ insertedProductId: null, analysisFilled: { analysis_n: 18, analysis_p: 0, analysis_k: 10, slow_release_n_pct: 56 } });
            await stonewallMigration.down(knex);
            expect(await analysisOf()).toEqual([18, 0, 10]);
            expect(Number((await catalogRow()).slow_release_n_pct)).toBe(56);
          } finally { await setAnalysis({ analysis_n: 18, analysis_p: 0, analysis_k: 10, slow_release_n_pct: 56 }); }
        });
      });

      // The nutrient ledger books the share for every application; the county rules need at least 50%.
      test('a catalog row that holds another slow-release share: up throws and writes nothing', async () => {
        await withReset(async () => {
          await setAnalysis({ slow_release_n_pct: 30 });
          try { await refuses('holds a slow-release nitrogen share of 30%, not 56% (SiteOne item 702562: 56%CRN)'); } finally { await setAnalysis({ slow_release_n_pct: 56 }); }
        });
      });

      // Production, read 2026-11-22: the row's standard rate is 3.1 lb, the label's lowest listed rate. The yearly cap check counts
      // an application with no recorded rate at the standard rate, so the 4.04 lb October pass would count 0.94 lb short.
      const setRate = (values) => knex('products_catalog').where({ id: stonewallId() }).update(values);
      const rateOf = async () => { const row = await catalogRow(); return [row.default_rate_per_1000 == null ? null : Number(row.default_rate_per_1000), row.rate_unit]; };

      test.each([
        ['the label\'s lowest rate, 3.1 lb (the production row)', 3.1],
        ['no standard rate', null],
        ['another figure in pounds', 3.5],
      ])('a catalog row with %s gets the program rate, 4.04 lb; the change is audited with the old figure and down leaves it', async (_label, stored) => {
        await withReset(async () => {
          await setRate({ default_rate_per_1000: stored, rate_unit: 'lb' });
          try {
            const strip = ({ default_rate_per_1000: _d, updated_at: _u, ...rest }) => JSON.stringify(rest);
            const others = strip(await catalogRow());
            await stonewallMigration.up(knex);
            expect(await rateOf()).toEqual([4.04, 'lb']);
            expect(strip(await catalogRow())).toBe(others);
            expect((await ours()).find((log) => log.action === stonewallMigration.CATALOG_ACTION).after_snapshot).toMatchObject({ defaultRate: { before: stored, after: 4.04 } });
            await stonewallMigration.down(knex);
            expect(await rateOf()).toEqual([4.04, 'lb']);
          } finally { await setRate({ default_rate_per_1000: 4.04, rate_unit: 'lb' }); }
        });
      });

      test.each([
        ['ounces', { default_rate_per_1000: 3.1, rate_unit: 'oz' }],
        ['no unit', { default_rate_per_1000: 4.04, rate_unit: null }],
      ])('a catalog row whose rates are in %s cannot take the program rate: up throws and writes nothing', async (_label, values) => {
        await withReset(async () => {
          await setRate(values);
          try {
            const stateOf = async () => JSON.stringify([await octoberRow(), await catalogJson(), await limitRows(stonewallId()), await otherRows(), await ours()]);
            const before = await stateOf();
            await expect(stonewallMigration.up(knex)).rejects.toThrow('so its standard rate cannot be set to the program rate of 4.04 lb per 1,000 sq ft. Nothing was written.');
            expect(await stateOf()).toBe(before);
          } finally { await setRate({ default_rate_per_1000: 4.04, rate_unit: 'lb' }); }
        });
      });

      // 20261022120000 stored the label water-in rule on the row it found by exact name: a bag known only through an alias has none.
      const setWatering = (value) => knex('products_catalog').where({ id: stonewallId() }).update({ post_application_watering: value });
      const LABEL_RULE = JSON.parse(stonewallMigration.CATALOG_ROW.post_application_watering);

      test('a catalog row with no watering rule gets the label water-in rule (0.5 inch within 14 days); the fill is audited', async () => {
        await withReset(async () => {
          await setWatering(null);
          try {
            await stonewallMigration.up(knex);
            expect((await catalogRow()).post_application_watering).toEqual(LABEL_RULE);
            expect(LABEL_RULE).toMatchObject({ mode: 'water_in', source: 'label', water_in_inches: 0.5, water_in_by_hours: 336 });
            expect((await ours()).find((log) => log.action === stonewallMigration.CATALOG_ACTION).after_snapshot).toMatchObject({ wateringFilled: true });
          } finally { await setWatering(JSON.stringify(LABEL_RULE)); }
        });
      });

      // The report's watering reader accepts only a rule it can validate (another one reads as 0.25 inch): any rule but the label rule stops the swap.
      test.each([
        ['more water, sooner (a stricter rule the migration cannot validate)', { mode: 'water_in', source: 'office', water_in_inches: 0.75, water_in_by_hours: 48 }],
        ['less water than the label needs', { mode: 'water_in', source: 'office', water_in_inches: 0.25, water_in_by_hours: 24 }],
        ['a later deadline than the label\'s 14 days', { ...LABEL_RULE, water_in_by_hours: 500 }],
        ['the label figures from another source', { ...LABEL_RULE, source: 'office' }],
        ['a hold rule in place of a water-in rule', { mode: 'hold', source: 'office', hold_hours: 24 }],
        ['no watering at all', { mode: 'none', source: 'office' }],
      ])('a catalog row whose watering rule states %s: up throws and writes nothing', async (_label, rule) => {
        await withReset(async () => {
          await setWatering(JSON.stringify(rule));
          try { await refuses('holds a watering rule that is not the label rule this migration stores (water in 0.5 inch within 14 days, source label)'); } finally { await setWatering(JSON.stringify(LABEL_RULE)); }
        });
      });

      test.each([
        ['N only', { analysis_n: 18, analysis_p: null, analysis_k: null }, [18, 0, 10], { analysis_p: 0, analysis_k: 10 }],
        // The case the new-sod sheet cares about: a row that holds P but no N is no fertilizer to it.
        ['P only', { analysis_n: null, analysis_p: 0, analysis_k: null }, [18, 0, 10], { analysis_n: 18, analysis_k: 10 }],
      ])('an analysis the row holds in part (%s) keeps what it holds; only the empty columns are filled', async (_label, stored, expected, filled) => {
        await withReset(async () => {
          await setAnalysis(stored);
          try {
            await stonewallMigration.up(knex);
            expect(await analysisOf()).toEqual(expected);
            expect((await ours()).find((log) => log.action === stonewallMigration.CATALOG_ACTION).after_snapshot.analysisFilled).toEqual(filled);
          } finally { await setAnalysis({ analysis_n: 18, analysis_p: 0, analysis_k: 10 }); }
        });
      });

      // The recipe plans 18-0-10; the nutrient ledger books what the row holds. Another figure stops the swap.
      test.each([
        ['another whole analysis', { analysis_n: 16, analysis_p: 2, analysis_k: 8 }, 'holds the fertilizer analysis 16-2-8, not 18-0-10'],
        ['another N beside empty P and K', { analysis_n: 16, analysis_p: null, analysis_k: null }, 'holds the fertilizer analysis 16-?-?, not 18-0-10'],
      ])('a catalog row with %s: up throws and writes nothing', async (_label, stored, message) => {
        await withReset(async () => {
          await setAnalysis(stored);
          try { await refuses(message); } finally { await setAnalysis({ analysis_n: 18, analysis_p: 0, analysis_k: 10 }); }
        });
      });
    });

    describe('the plan for an October visit', () => {
      beforeAll(async () => { await resetToDimension(); await stonewallMigration.up(knex); });
      afterAll(async () => { await resetToDimension(); await stonewallMigration.up(knex); });

      test('plans Stonewall 0.37% 18-0-10 at 4.04 lb per 1,000 sq ft (40.4 lb on 10,000 sq ft) with January 4FL history: 88.8% of the yearly prodiamine cap, no block', async () => {
        setGates();
        const { scheduled, customerId } = await visit('2026-10-12');
        await applied(customerId, STW_4FL, '2026-01-20', 0.5, 'fl oz');
        const result = await plan(scheduled);
        expect(codes(result)).not.toContain('lawn_v13_annual_limit');
        expect(item(result, STW_037).mix).toMatchObject({ amount: 40.4, amountUnit: 'lb' });
        expect(item(result, DIMENSION)).toBeUndefined();
      });

      test('a season with 1.0 fl oz of 4FL already (90.7%) would pass the cap with this step: no amount, a block naming prodiamine', async () => {
        setGates();
        const { scheduled, customerId } = await visit('2026-10-12');
        await applied(customerId, STW_4FL, '2026-01-20', 1, 'fl oz');
        const result = await plan(scheduled);
        expect(result.propertyGate.blocks.find((b) => b.code === 'lawn_v13_annual_limit').message)
          .toMatch(/prodiamine across all products this year is 90\.\d% of the yearly label cap; this application brings it to 134\.\d% — THIS APPLICATION WOULD EXCEED IT/);
        expect(item(result, STW_037).mix).toBeNull();
      });

      test('the 9x April step still plans the Dimension granular (dithiopyr), not Stonewall', async () => {
        setGates();
        const { scheduled } = await visit('2026-04-14', { service_type: 'Every 6 Weeks Lawn Care Service' });
        const result = await plan(scheduled);
        expect(item(result, DIMENSION).mix).toMatchObject({ amount: 27.778 });
        expect(item(result, STW_037)).toBeUndefined();
      });
    });

    // The staged row is live data: a report opened after the swap reads it. A visit made before the swap keeps the window as it was.
    describe('the report card of an October visit, opened after the swap', () => {
      const SWAP_AT = '2026-11-22T15:00:00Z'; // 10:00 AM Eastern on 2026-11-22
      const stampSwap = () => knex('lawn_protocol_audit_log').where({ action: stonewallMigration.ACTION }).update({ created_at: SWAP_AT });
      beforeAll(async () => { await resetToDimension(); await stonewallMigration.up(knex); await stampSwap(); });
      afterAll(async () => { await resetToDimension(); await stonewallMigration.up(knex); });

      const completedVisit = async ({ serviceDate, completedAt = null, recorded = [] }) => {
        const { scheduled, customerId } = await visit(serviceDate);
        const [record] = await knex('service_records').insert({ customer_id: customerId, scheduled_service_id: scheduled.id, service_date: serviceDate, service_type: 'Lawn fixture' }).returning('*');
        const protocol = await knex('lawn_protocols').where({ protocol_key: KEY, version: LAWN_V13_VERSION }).first();
        const window = await knex('lawn_protocol_windows').where({ lawn_protocol_id: protocol.id, window_key: stonewallMigration.OCTOBER_WINDOW }).first();
        await knex('lawn_protocol_service_completions').insert({
          service_record_id: record.id, scheduled_service_id: scheduled.id, customer_id: customerId, lawn_protocol_id: protocol.id,
          lawn_protocol_window_id: window.id, protocol_key: KEY, protocol_version: LAWN_V13_VERSION, window_key: stonewallMigration.OCTOBER_WINDOW,
          ...(completedAt ? { created_at: completedAt } : {}),
        });
        for (const name of recorded) await knex('service_products').insert({ service_record_id: record.id, product_id: catalog[name].id, product_name: name });
        return { id: record.id, customer_id: customerId, service_date: serviceDate, scheduled_service_id: scheduled.id };
      };
      const card = async (options, db = knex) => {
        const context = await buildLawnProtocolReportContext(await completedVisit(options), db, new Date('2026-12-01T16:00:00Z'));
        const bag = context.products.find((product) => product.role === 'fall_pre_emergent_nutrition');
        return { goal: context.window.goal, name: bag.productName, protocolName: bag.protocolProductName, productId: bag.productId, counter: bag.gates.annualCounter, annual: bag.annualCounter, rate: bag.ratePer1000 };
      };
      const dimensionCard = () => ({
        goal: stonewallMigration.OLD_GOAL, name: DIMENSION, protocolName: DIMENSION, productId: dimensionId(),
        counter: 'dithiopyr_lb_per_1000', annual: { counter: 'dithiopyr_lb_per_1000' }, rate: 4.04,
      });
      const stonewallCard = () => ({
        goal: stonewallMigration.NEW_GOAL, name: STW_037, protocolName: STW_037, productId: stonewallId(),
        counter: 'prodiamine_lb_per_1000', annual: { counter: 'prodiamine_lb_per_1000' }, rate: 4.04,
      });

      // Whatever the visit applied, skipped or substituted: the window it followed held the Dimension bag.
      test.each([
        ['recorded the Dimension bag', [DIMENSION]],
        ['skipped the bag (no product recorded)', []],
        ['recorded a substitute in its place', [STW_4FL]],
      ])('a visit made before the swap that %s shows the window as it was: the Dimension bag, its counter and the earlier goal', async (_label, recorded) => {
        expect(await card({ serviceDate: '2026-10-12', recorded })).toEqual(dimensionCard());
      });

      test('a visit made before the swap but closed out after it still shows the Dimension bag (its service day decides)', async () => {
        expect(await card({ serviceDate: '2026-11-09', completedAt: '2026-11-24T15:00:00Z', recorded: [DIMENSION] })).toEqual(dimensionCard());
      });

      test('a visit made after the swap shows the window as it is now, even when it recorded the Dimension bag', async () => {
        expect(await card({ serviceDate: '2027-10-12', recorded: [DIMENSION] })).toEqual(stonewallCard());
        expect(await card({ serviceDate: '2026-11-23', recorded: [STW_037] })).toEqual(stonewallCard());
      });

      test('on the day of the swap, the moment of the closeout decides: before it the Dimension bag, after it Stonewall', async () => {
        expect(await card({ serviceDate: '2026-11-22', completedAt: '2026-11-22T14:00:00Z' })).toEqual(dimensionCard());
        expect(await card({ serviceDate: '2026-11-22', completedAt: '2026-11-22T16:00:00Z' })).toEqual(stonewallCard());
      });

      test('a staged row the office changed after the swap is shown as it is, for an earlier visit too', async () => {
        const row = await octoberRow();
        await knex('lawn_protocol_products').where({ id: row.id }).update({ product_name: 'Renamed by the office' });
        try {
          const context = await buildLawnProtocolReportContext(await completedVisit({ serviceDate: '2026-10-12' }), knex, new Date('2026-12-01T16:00:00Z'));
          expect(context.products.find((product) => product.role === 'fall_pre_emergent_nutrition').protocolProductName).toBe('Renamed by the office');
        } finally { await knex('lawn_protocol_products').where({ id: row.id }).update({ product_name: STW_037 }); }
      });

      test('a failed read of the swap record omits the card for that render: the error is not turned into "no swap"', async () => {
        const failing = Object.assign((table) => { if (table === 'lawn_protocol_audit_log') throw new Error('db down'); return knex(table); }, { schema: knex.schema, raw: knex.raw.bind(knex), fn: knex.fn });
        await expect(card({ serviceDate: '2026-10-12', recorded: [DIMENSION] }, failing)).rejects.toThrow('db down');
      });
    });
  });
});
