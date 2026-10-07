// The February atrazine option (migration 20261007160000), through the real plan engine and the real
// migration on PostgreSQL (cloned schema), plus the pieces that need no database. Synthetic data only.
const { createLawnHistoryDb, fixture } = require('./helpers/lawn-history-db');
const engine = require('../services/waveguard-plan-engine');
const { buildPlanForService } = engine;
const migration = require('../models/migrations/20261007160000_lawn_v13_atrazine_feb_option');
const { turfRestrictedProductsBlockPayload } = require('../services/complete-scheduled-service');
const { validateRule } = require('../services/service-report/lawn-watering-rule');
const { buildWateringInstruction } = require('../services/service-report/lawn-watering-instruction');
const { LAWN_V13_VERSION } = require('../services/lawn-program');
const v13 = require('../config/lawn-protocol-v13.json');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const ATRAZINE = migration.NAME;
const F24 = migration.DEFAULT_BAG;
const FEB = 'feb_v13_spreader_green_up';
const KEY = 'fixture_v13_atrazine';

describe('the atrazine option data (no database)', () => {
  const febLines = v13.st_augustine.visits.find((v) => v.month === 'Feb').secondary.split('\n');
  const line = febLines.find((l) => l.startsWith(ATRAZINE));

  test('the recipe line: one line on the St. Augustine track only, the owner rule text, 4.0 lb, a conditional', () => {
    expect(febLines.filter((l) => l.startsWith(ATRAZINE))).toHaveLength(1);
    for (const grass of ['bermuda', 'zoysia', 'bahia']) expect(JSON.stringify(v13[grass])).not.toMatch(/atrazine/i);
    expect(line).toMatch(/weedy St\. Augustine or centipede lawns only, instead of the 24-0-11 on this visit, 4\.0 lb per 1,000 sq ft \(0\.72 lb N\), spreader, 2 applications a year at most and 2 months apart\./);
    expect(line).toMatch(/Water in right after application \(label: must be watered in immediately\)\./);
    expect(line).toMatch(/Not on bermuda, zoysia or bahia\. Not on wet or sandy lots with a high water table\. Not within 200 ft of a lake or pond or 66 ft of a storm inlet until the bag label is read\.$/);
    expect(line).not.toMatch(/within 1 hour|inch/i);
    const [parsed] = engine.parseProtocolLines(line, 'conditional', { exactName: true });
    expect(engine.matchCatalogProduct(parsed, [{ id: 'a', name: ATRAZINE, active: true }]).name).toBe(ATRAZINE);
  });

  test('the catalog values match the label and the pricing file carries the same SKU row', () => {
    const p = migration.PRODUCT;
    expect(p).toMatchObject({ epa_reg_number: '10404-94', siteone_sku: '702202', best_price: 36.14, container_size: '50 lb', default_rate_per_1000: 4, min_label_rate_per_1000: 3.27, max_label_rate_per_1000: 4.37, analysis_n: 18, analysis_p: 0, analysis_k: 10 });
    expect(4.0 * 0.18).toBeCloseTo(0.72, 5);
    const csv = fs.readFileSync(path.join(__dirname, '../data/pricing.csv'), 'utf8').split('\n').filter((l) => l.startsWith(`${ATRAZINE},`));
    expect(csv).toHaveLength(1);
    expect(csv[0]).toMatch(/,SiteOne,50 lb,.*,\$36\.14,\$0\.72\/lb$/);
    const inventory = fs.readFileSync(path.join(__dirname, '../routes/admin-inventory.js'), 'utf8');
    expect(inventory).toContain(`'v13_atrazine_bag', '${ATRAZINE}'`);
  });

  test('the watering rule is valid, not label-sourced, and the report never says within one hour', () => {
    const checked = validateRule(migration.WATERING);
    expect(checked.valid).toBe(true);
    expect(checked.rule.source).toBe('owner');
    expect(checked.rule.label_note).toMatch(/watered in immediately after application/);
    expect(checked.rule.label_note).toMatch(/Program choice, not label/);
    const instruction = buildWateringInstruction({ rules: [{ name: ATRAZINE, rule: migration.WATERING }], completedAt: new Date('2026-02-12T15:00:00-05:00') });
    expect(instruction.state).toBe('water_in');
    expect(instruction.ruleSource).toBe('owner');
    expect(instruction.lines.join(' ')).not.toMatch(/within|1 hour|an hour/i);
    // 15 minutes after completion, never a later deadline.
    expect(new Date(instruction.waterInBy).getTime() - new Date('2026-02-12T15:00:00-05:00').getTime()).toBeLessThanOrEqual(15 * 60000);
  });

  test('the gate notes: the species note shows only for a grass the row does not allow; the rule texts', () => {
    const gates = JSON.parse(migration.PROTOCOL_ROW.gates);
    const keys = (ctx) => engine.v13GateNotes(gates, ctx).map((n) => n.key);
    expect(keys({ turfSpecies: 'st_augustine' })).not.toContain('turfOnly');
    expect(keys({ turfSpecies: 'centipede' })).not.toContain('turfOnly');
    expect(keys({ turfSpecies: 'mixed' })).toContain('turfOnly');
    expect(keys({})).toContain('turfOnly');
    const text = Object.fromEntries(engine.v13GateNotes(gates, { turfSpecies: null }).map((n) => [n.key, n.text]));
    expect(text.waterInNow).toMatch(/Water in right after application/);
    expect(text.replacesProduct).toBe('Instead of the LESCO 24-0-11 with PolyPlus OPTI on this visit: spread one bag only and record the bag you used.');
    expect(text.minDistanceFromWaterFt).toMatch(/200 ft/);
    expect(text.minDistanceFromStormInletFt).toMatch(/66 ft/);
    expect(text.avoidHighWaterTable).toMatch(/high water table/);
  });

  test('turf species: St. Augustine and centipede only, from the profile grass, then track, then the legacy lawn type', () => {
    const species = (profile, legacy) => engine.v13TurfSpecies(profile, legacy);
    expect(species({ grass_type: 'st_augustine' })).toBe('st_augustine');
    expect(species({ grass_type: 'Centipede' })).toBe('centipede');
    expect(species({ grass_type: 'mixed', track_key: 'st_augustine' })).toBe('mixed');
    expect(species({ track_key: 'st_augustine' })).toBe('st_augustine');
    expect(species(null, 'Floratam Full Sun')).toBe('st_augustine');
    expect(species({ grass_type: 'bermuda' })).toBe('bermuda');
    expect([species({}, 'weird lawn of things'), species(null, null)]).toEqual([null, null]);
  });

  test('the completion refuses a restricted product and nothing else', () => {
    const plan = { propertyGate: { turfRestrictedProductIds: ['p1'] } };
    expect(turfRestrictedProductsBlockPayload({ plan, products: [{ productId: 'p2' }] })).toBeNull();
    expect(turfRestrictedProductsBlockPayload({ plan: null, products: [{ productId: 'p1' }] })).toBeNull();
    expect(turfRestrictedProductsBlockPayload({ plan: { propertyGate: {} }, products: [{ productId: 'p1' }] })).toBeNull();
    expect(turfRestrictedProductsBlockPayload({ plan, products: [{ productId: 'p1', productName: 'Bag' }, { productId: 'p2' }] }))
      .toMatchObject({ code: 'lawn_v13_turf_species_not_allowed', productIds: ['p1'], error: expect.stringMatching(/^Bag cannot be recorded on this lawn/) });
  });
});

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

describeDb('the atrazine option through PostgreSQL', () => {
  const saved = process.env.GATE_LAWN_V13;
  let owned;
  let knex;
  let f24;

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
    [f24] = await knex('products_catalog').insert({
      name: F24, category: 'fertilizer', label_verified_at: new Date(), inventory_on_hand: 100000, inventory_unit: 'lb', active: true,
      formulation: 'granular', default_rate_per_1000: 4.2, rate_unit: 'lb', analysis_n: 24, analysis_p: 0, analysis_k: 11,
    }).returning('*');
    await knex('lawn_protocols').insert({ protocol_key: KEY, version: '2026.05', name: 'Fixture old', status: 'active', grass_track: 'st_augustine', region: 'swfl' });
    const [staged] = await knex('lawn_protocols').insert({ protocol_key: KEY, version: LAWN_V13_VERSION, name: 'Fixture v13', status: 'staged', grass_track: 'st_augustine', region: 'swfl', effective_from: '2000-01-01' }).returning('*');
    const [window] = await knex('lawn_protocol_windows').insert({
      lawn_protocol_id: staged.id, month: 2, window_key: FEB, title: 'February', visit_type: 'fixture', production_mode: 'spreader_plus_spot_backpack',
    }).returning('*');
    await knex('lawn_protocol_products').insert({
      lawn_protocol_window_id: window.id, product_id: f24.id, product_name: F24, role: 'nutrition', application_mode: 'broadcast', default_in_plan: true,
      rate_unit: 'lb_n', sort_order: 9, gates: JSON.stringify({ targetN: '0.75 lb N/1000', blackoutSensitive: true }),
    });
    await knex.raw('ALTER TABLE ??.lawn_protocol_audit_log ALTER COLUMN lawn_protocol_id DROP NOT NULL', [owned.schema]).catch(() => {});
    await migration.up(knex);
    const [equipment] = await knex('equipment_systems').insert({ name: 'Fixture rig', system_type: 'skid', tank_capacity_gal: 110, active: true }).returning('*');
    await knex('equipment_calibrations').insert({ equipment_system_id: equipment.id, carrier_gal_per_1000: 1, active: true });
  }, 60000);
  afterAll(async () => { if (owned) await owned.dispose(); });
  afterEach(() => { if (saved === undefined) delete process.env.GATE_LAWN_V13; else process.env.GATE_LAWN_V13 = saved; });

  const rows = () => knex('lawn_protocol_products').where({ product_name: ATRAZINE });
  const limits = () => knex('product_limits').where('description', 'like', 'v13 atrazine%').orderBy('limit_type');

  async function visit(grass, track = null) {
    process.env.GATE_LAWN_V13 = 'true';
    const f = await fixture(knex);
    await knex('customers').where({ id: f.customerId }).update({ address_line1: f.property.address_line1, city: f.property.city, zip: f.property.zip, state: f.property.state, waveguard_tier: 'Silver' });
    await knex('customer_turf_profiles').insert({ customer_id: f.customerId, active: true, grass_type: grass, track_key: track, lawn_sqft: 10000 });
    return f.visit(0, { scheduled_date: '2026-02-12' });
  }
  const plan = (scheduled, selected = true) => buildPlanForService(scheduled.id, { db: knex, ...(selected ? { selectedConditionalProductNames: [ATRAZINE] } : {}) });
  const item = (result, name) => result.mixCalculator.items.find((entry) => entry.product?.name === name);
  const blockCodes = (result) => result.propertyGate.blocks.map((block) => block.code);

  describe('the migration', () => {
    test('one non-default row in the St. Augustine February window, two hard limits, one catalog row', async () => {
      const [row] = await rows();
      expect(row).toMatchObject({ role: 'weedy_lawn_option', application_mode: 'broadcast', default_in_plan: false, rate_unit: 'lb', sort_order: 10 });
      expect(Number(row.rate_per_1000)).toBe(4);
      expect(row.gates).toMatchObject({ turfOnly: ['st_augustine', 'centipede'], wholeLawn: true, replacesProduct: F24, waterInNow: true, avoidHighWaterTable: true, minDistanceFromWaterFt: 200, minDistanceFromStormInletFt: 66 });
      expect((await limits()).map((l) => [l.limit_type, Number(l.limit_value), l.limit_unit, l.severity])).toEqual([
        ['annual_max_apps', 2, 'applications', 'hard_block'],
        ['min_interval_days', 60, 'days', 'hard_block'],
      ]);
      const catalog = await knex('products_catalog').where({ name: ATRAZINE });
      expect(catalog).toHaveLength(1);
      expect(catalog[0].post_application_watering).toMatchObject({ source: 'owner', mode: 'water_in' });
    });

    test('a second up changes nothing; a row on another grass track is never written', async () => {
      await migration.up(knex);
      expect(await rows()).toHaveLength(1);
      expect(await limits()).toHaveLength(2);
      expect(await knex('products_catalog').where({ name: ATRAZINE })).toHaveLength(1);
    });

    test('down keeps a row a completion actual references (and its link), removes the limits; up then keeps one row', async () => {
      const [row] = await rows();
      const [actual] = await knex('lawn_protocol_product_actuals').insert({
        lawn_protocol_service_completion_id: randomUUID(), protocol_product_id: row.id, product_name: ATRAZINE,
      }).returning('*');
      try {
        await migration.down(knex);
        expect((await rows()).map((r) => r.id)).toEqual([row.id]);
        expect((await knex('lawn_protocol_product_actuals').where({ id: actual.id }).first()).protocol_product_id).toBe(row.id);
        expect(await limits()).toHaveLength(0);
        await migration.up(knex);
        expect((await rows()).map((r) => r.id)).toEqual([row.id]);
        expect(await limits()).toHaveLength(2);
      } finally {
        await knex('lawn_protocol_product_actuals').where({ id: actual.id }).del();
      }
    });

    test('down with no actual removes the row and the limits and leaves the catalog row; up restores them', async () => {
      await migration.down(knex);
      expect(await rows()).toHaveLength(0);
      expect(await limits()).toHaveLength(0);
      expect(await knex('products_catalog').where({ name: ATRAZINE })).toHaveLength(1);
      expect(await knex('lawn_protocol_products').where({ product_name: F24 })).toHaveLength(1);
      await migration.up(knex);
      expect(await rows()).toHaveLength(1);
      expect(await limits()).toHaveLength(2);
    });
  });

  describe('the plan', () => {
    test('St. Augustine, atrazine picked: the atrazine bag is sized for the whole lawn and the 24-0-11 is off the visit', async () => {
      const result = await plan(await visit('st_augustine', 'st_augustine'));
      expect(item(result, ATRAZINE)).toMatchObject({ selected: true });
      expect(item(result, ATRAZINE).mix).toMatchObject({ amount: 40 });
      // The replaced bag is out of the mix (only selected lines are sized) and shown as not selected on the protocol.
      expect(item(result, F24)).toBeUndefined();
      expect(result.protocol.base.find((entry) => entry.product?.name === F24)).toMatchObject({ selected: false, selectionReason: 'replaced_by_alternative_bag' });
      expect(blockCodes(result)).not.toContain('lawn_v13_turf_species');
      const selectedBags = result.mixCalculator.items.filter((entry) => entry.selected && entry.product && /^LESCO (24|Atrazine)/.test(entry.product.name));
      expect(selectedBags.map((entry) => entry.product.name)).toEqual([ATRAZINE]);
      expect(result.propertyGate.turfRestrictedProductIds).toEqual([]);
    });

    test('atrazine not picked: the default bag is unchanged and atrazine is not selected', async () => {
      const result = await plan(await visit('st_augustine', 'st_augustine'), false);
      expect(item(result, F24)).toMatchObject({ selected: true });
      expect(item(result, F24).mix).toBeTruthy();
      expect(item(result, ATRAZINE)?.selected ?? false).toBe(false);
    });

    test('centipede is allowed', async () => {
      const result = await plan(await visit('centipede'));
      expect(blockCodes(result)).not.toContain('lawn_v13_turf_species');
      expect(item(result, ATRAZINE).mix).toMatchObject({ amount: 40 });
      expect(item(result, F24)).toBeUndefined();
      expect(item(result, ATRAZINE).gateNotes.map((n) => n.key)).not.toContain('turfOnly');
    });

    test.each([['mixed', null], ['unknown', null], ['bahia', 'st_augustine']])('%s grass: no amount, a block, the default bag stays, completion refuses the product', async (grass, track) => {
      const result = await plan(await visit(grass, track));
      expect(blockCodes(result)).toContain('lawn_v13_turf_species');
      expect(result.status).toBe('blocked');
      const bag = item(result, ATRAZINE);
      expect(bag.mix).toBeNull();
      expect(bag.unavailable.reason).toMatch(/not allowed on the grass recorded/);
      expect(bag.gateNotes.map((n) => n.key)).toContain('turfOnly');
      expect(item(result, F24)).toMatchObject({ selected: true });
      expect(item(result, F24).mix).toBeTruthy();
      expect(result.propertyGate.turfRestrictedProductIds).toEqual([String(bag.product.id)]);
      expect(turfRestrictedProductsBlockPayload({ plan: result, products: [{ productId: bag.product.id }] })).toMatchObject({ code: 'lawn_v13_turf_species_not_allowed' });
    });

    test('no grass on file at all is not St. Augustine or centipede either', async () => {
      const result = await plan(await visit(null));
      expect(result.propertyGate.turfRestrictedProductIds.length).toBe(1);
    });
  });
});
