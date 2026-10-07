// The February atrazine option (migration 20261007160000), through the real plan engine and the real
// migration on PostgreSQL (cloned schema), plus the pieces that need no database. Synthetic data only.
const { createLawnHistoryDb, fixture } = require('./helpers/lawn-history-db');
const engine = require('../services/waveguard-plan-engine');
const { buildPlanForService } = engine;
const migration = require('../models/migrations/20261007160000_lawn_v13_atrazine_feb_option');
const { turfRestrictedProductsBlock } = require('../services/complete-scheduled-service');
const { allowedTurfFor, singleTurfFamily } = require('../services/lawn-turf-restrictions');
const stampMigration = require('../models/migrations/20261007162000_lawn_v13_atrazine_label_stamp');
const fillMigration = require('../models/migrations/20261007161000_lawn_v13_atrazine_catalog_fill');
const { validateRule } = require('../services/service-report/lawn-watering-rule');
const { buildWateringInstruction } = require('../services/service-report/lawn-watering-instruction');
const applicationLimits = require('../services/application-limits');
const { confirmIrrigationFields, GRASS_CONFIRMED_FIELD } = require('../services/irrigation-schedule-confirmation');
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

  test('turf species: one grass family from the profile grass, then track, then the legacy lawn type; anything mixed or unclear is none', () => {
    const species = (profile, legacy) => engine.v13TurfSpecies(profile, legacy);
    expect(species({ grass_type: 'st_augustine' })).toBe('st_augustine');
    expect(species({ grass_type: 'Centipede' })).toBe('centipede');
    expect(species({ grass_type: 'mixed', track_key: 'st_augustine' })).toBeNull();
    expect(species({ track_key: 'st_augustine' })).toBe('st_augustine');
    expect(species(null, 'Floratam Full Sun')).toBe('st_augustine');
    expect(species({ grass_type: 'bermuda' })).toBe('bermuda');
    expect([species({}, 'weird lawn of things'), species(null, null)]).toEqual([null, null]);
  });

  test.each([
    'St. Augustine / Bahia mix', 'St. Augustine and Bahia', 'Bahia mixed with St. Augustine', 'St Augustine, Bermuda', 'Floratam + Argentine bahia',
    'St. Augustine blend', 'Centipede/St Augustine', 'St. Augustine x Zoysia', 'Augustine w/ Bermuda patches', 'Bermuda patches in St Augustine',
    'half St Augustine half bahia', 'Centipede & St. Augustine', 'mixed', 'unknown',
  ])('"%s" is never one allowed grass, in the profile or the legacy lawn type', (text) => {
    expect(engine.v13TurfSpecies({ grass_type: text })).toBeNull();
    expect(engine.v13TurfSpecies(null, text)).toBeNull();
    expect(singleTurfFamily(text)).toBeNull();
  });

  test('the closeout list names the atrazine bag for St. Augustine and centipede only, and no other product', () => {
    expect(allowedTurfFor(ATRAZINE)).toEqual(['st_augustine', 'centipede']);
    expect(allowedTurfFor('lesco atrazine 1.05% 18-0-10 56% polyplus opti45 2%fe 0.5%mn 0.5%mg as mop')).toEqual(['st_augustine', 'centipede']);
    expect(allowedTurfFor(F24)).toBeNull();
    expect(JSON.parse(migration.PROTOCOL_ROW.gates).turfOnly).toEqual(allowedTurfFor(ATRAZINE));
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

    test.each([['mixed', null], ['unknown', null], ['bahia', 'st_augustine']])('%s grass: no amount, a block, the default bag stays', async (grass, track) => {
      const result = await plan(await visit(grass, track));
      expect(blockCodes(result)).toContain('lawn_v13_turf_species');
      expect(result.status).toBe('blocked');
      const bag = item(result, ATRAZINE);
      expect(bag.mix).toBeNull();
      expect(bag.unavailable.reason).toMatch(/certain grasses only/);
      expect(bag.gateNotes.map((n) => n.key)).toContain('turfOnly');
      expect(item(result, F24)).toMatchObject({ selected: true });
      expect(item(result, F24).mix).toBeTruthy();
      // The plan's own block is the only one: the withheld amount is not also a missing nutrient rate.
      expect(blockCodes(result)).not.toContain('missing_nutrient_rate');
    });

    test('no grass on file at all is not St. Augustine or centipede either', async () => {
      const result = await plan(await visit(null));
      expect(blockCodes(result)).toContain('lawn_v13_turf_species');
    });
  });

  describe('a turf profile authorizes the bag only for the property it describes (the customer\'s home)', () => {
    const atrazineId = async () => (await knex('products_catalog').where({ name: ATRAZINE }).first()).id;
    async function customerWithHome(grass = 'st_augustine') {
      process.env.GATE_LAWN_V13 = 'true';
      const f = await fixture(knex);
      await knex('customers').where({ id: f.customerId }).update({ address_line1: f.property.address_line1, city: f.property.city, zip: f.property.zip, state: f.property.state, waveguard_tier: 'Silver' });
      await knex('customer_turf_profiles').insert({ customer_id: f.customerId, active: true, grass_type: grass, track_key: grass, lawn_sqft: 10000 });
      return f;
    }
    const visitAt = async (f, propertyId, changes = {}) => f.visit(0, { scheduled_date: '2026-02-12', property_id: propertyId, ...changes });
    const guard = async (visit) => turfRestrictedProductsBlock(knex, visit, [{ productId: await atrazineId() }]);
    const planBlocks = async (visit) => blockCodes(await plan(visit));

    test('the home property: allowed in the plan and the closeout', async () => {
      const f = await customerWithHome();
      const visit = await visitAt(f, f.property.id);
      expect(await planBlocks(visit)).not.toContain('lawn_v13_turf_species');
      expect(await guard(visit)).toBeNull();
    });

    test('a St. Augustine home profile and a second property: blocked at the second, in the plan and the closeout, allowed at home', async () => {
      const f = await customerWithHome();
      const [second] = await knex('customer_properties').insert({ customer_id: f.customerId, address_line1: '200 Fixture Street', city: 'Fixture City', zip: '34201', is_primary: false }).returning('*');
      const atSecond = await visitAt(f, second.id);
      const blocked = await plan(atSecond);
      expect(blockCodes(blocked)).toContain('lawn_v13_turf_species');
      expect(blocked.propertyGate.blocks.find((b) => b.code === 'lawn_v13_turf_species').message).toMatch(/cannot be tied to this visit's property/);
      expect(item(blocked, ATRAZINE).mix).toBeNull();
      expect(await guard(atSecond)).toMatchObject({ code: 'lawn_v13_turf_species_not_allowed' });
      const atHome = await visitAt(f, f.property.id);
      expect(await planBlocks(atHome)).not.toContain('lawn_v13_turf_species');
      expect(await guard(atHome)).toBeNull();
    });

    test('unknown property linkage fails closed: no property on the visit, a property of another customer, an inactive property', async () => {
      const f = await customerWithHome();
      const other = await fixture(knex);
      const [inactive] = await knex('customer_properties').insert({ customer_id: f.customerId, address_line1: '300 Fixture Street', city: 'Fixture City', zip: '34201', is_primary: false, active: false }).returning('*');
      for (const propertyId of [null, other.property.id, inactive.id]) {
        const visit = await visitAt(f, propertyId);
        expect(await planBlocks(visit)).toContain('lawn_v13_turf_species');
        expect(await guard(visit)).toMatchObject({ code: 'lawn_v13_turf_species_not_allowed' });
      }
    });

    test('a visit stamped to another address is not the saved home; a stamp of the home\'s own address is', async () => {
      const f = await customerWithHome();
      const stamped = await visitAt(f, f.property.id, { service_address_line1: '999 Elsewhere Road', service_address_city: 'Fixture City', service_address_zip: '34201' });
      expect(await guard(stamped)).toMatchObject({ code: 'lawn_v13_turf_species_not_allowed' });
      const same = await visitAt(f, f.property.id, { service_address_line1: f.property.address_line1, service_address_city: f.property.city, service_address_zip: f.property.zip });
      expect(await guard(same)).toBeNull();
    });

    test('a moved home: the profile still holds the old lawn, so plan and closeout are blocked until the grass is re-confirmed, then allowed', async () => {
      const f = await customerWithHome();
      const visit = await visitAt(f, f.property.id);
      await knex('property_preferences').insert({ customer_id: f.customerId, irrigation_home_changed_at: new Date('2026-01-10T12:00:00Z'), irrigation_confirmed_fields: JSON.stringify([]) });
      const blocked = await plan(visit);
      expect(blockCodes(blocked)).toContain('lawn_v13_turf_species');
      expect(blocked.propertyGate.blocks.find((b) => b.code === 'lawn_v13_turf_species').message).toMatch(/not been re-confirmed since the home move/);
      expect(item(blocked, ATRAZINE).mix).toBeNull();
      expect(await guard(visit)).toMatchObject({ code: 'lawn_v13_turf_species_not_allowed' });
      // Other confirmations (the county, the sizing fields) do not re-confirm the grass.
      await confirmIrrigationFields(knex, f.customerId, ['turf_county', 'irrigation_run_minutes']);
      expect(await guard(visit)).toMatchObject({ code: 'lawn_v13_turf_species_not_allowed' });
      await confirmIrrigationFields(knex, f.customerId, [GRASS_CONFIRMED_FIELD]);
      expect(blockCodes(await plan(visit))).not.toContain('lawn_v13_turf_species');
      expect(item(await plan(visit), ATRAZINE).mix).toMatchObject({ amount: 40 });
      expect(await guard(visit)).toBeNull();
    });

    test('a customer with no move on record is not held (no preferences row, or a row with no move stamp)', async () => {
      const f = await customerWithHome();
      expect(await guard(await visitAt(f, f.property.id))).toBeNull();
      await knex('property_preferences').insert({ customer_id: f.customerId, irrigation_confirmed_fields: JSON.stringify([]) });
      expect(await guard(await visitAt(f, f.property.id))).toBeNull();
    });

    test('a sole active property is the home even when it is not flagged primary; with two active properties and no primary, neither is provable', async () => {
      const f = await customerWithHome();
      await knex('customer_properties').where({ id: f.property.id }).update({ is_primary: false });
      expect(await guard(await visitAt(f, f.property.id))).toBeNull();
      const [second] = await knex('customer_properties').insert({ customer_id: f.customerId, address_line1: '200 Fixture Street', city: 'Fixture City', zip: '34201', is_primary: false }).returning('*');
      expect(await guard(await visitAt(f, f.property.id))).toMatchObject({ code: 'lawn_v13_turf_species_not_allowed' });
      expect(await guard(await visitAt(f, second.id))).toMatchObject({ code: 'lawn_v13_turf_species_not_allowed' });
    });

    test.each(['St. Augustine / Bahia mix', 'St. Augustine and Bahia', 'Bahia mixed with St. Augustine', 'St Augustine blend'])(
      'a profile that reads "%s" is mixed: blocked in the plan and the closeout', async (grass) => {
        const f = await customerWithHome(grass);
        const visit = await visitAt(f, f.property.id);
        expect(await planBlocks(visit)).toContain('lawn_v13_turf_species');
        expect(await guard(visit)).toMatchObject({ code: 'lawn_v13_turf_species_not_allowed' });
      });
  });

  describe('the closeout refuses the product from the lawn\'s grass, in any month, on any track', () => {
    async function visitOn(grass, track, date) {
      const scheduled = await visit(grass, track);
      return knex('scheduled_services').where({ id: scheduled.id }).update({ scheduled_date: date }).then(() => ({ ...scheduled, scheduled_date: date }));
    }
    const atrazineId = async () => (await knex('products_catalog').where({ name: ATRAZINE }).first()).id;

    test.each([['bahia', 'bahia', '2026-07-14'], ['zoysia', 'zoysia', '2026-10-13'], ['bermuda', 'bermuda', '2026-02-12'], ['mixed', null, '2026-05-12'], [null, null, '2026-03-10']])(
      '%s lawn (track %s), visit on %s: refused with a 422 payload naming the bag', async (grass, track, date) => {
        const scheduled = await visitOn(grass, track, date);
        const block = await turfRestrictedProductsBlock(knex, scheduled, [{ productId: await atrazineId() }]);
        expect(block).toMatchObject({ code: 'lawn_v13_turf_species_not_allowed', productIds: [String(await atrazineId())] });
        expect(block.error).toMatch(/^LESCO Atrazine 1\.05%.* cannot be recorded on this lawn/);
      });

    test.each([['st_augustine', 'st_augustine'], ['centipede', null]])('%s lawn: allowed, and a product with no restriction is never refused', async (grass, track) => {
      const scheduled = await visitOn(grass, track, '2026-09-08');
      expect(await turfRestrictedProductsBlock(knex, scheduled, [{ productId: await atrazineId() }])).toBeNull();
      const bad = await visitOn('bahia', 'bahia', '2026-09-08');
      expect(await turfRestrictedProductsBlock(knex, bad, [{ productId: f24.id }])).toBeNull();
      expect(await turfRestrictedProductsBlock(knex, bad, [])).toBeNull();
    });

    test('the check does not depend on GATE_LAWN_V13', async () => {
      const bad = await visitOn('bahia', 'bahia', '2026-02-12');
      delete process.env.GATE_LAWN_V13;
      expect(await turfRestrictedProductsBlock(knex, bad, [{ productId: await atrazineId() }])).toMatchObject({ code: 'lawn_v13_turf_species_not_allowed' });
    });
  });

  describe('the hard limits read the atrazine history by property, visit and across the new year', () => {
    const atrazineId = async () => (await knex('products_catalog').where({ name: ATRAZINE }).first()).id;
    const applied = async (customerId, date, extra = {}) => knex('property_application_history').insert({
      customer_id: customerId, product_id: await atrazineId(), application_date: date, application_rate: 4, rate_unit: 'lb', active_ingredient: 'Atrazine', ...extra,
    });
    const check = async (customerId, date, opts = {}) => applicationLimits.checkLimits(customerId, await atrazineId(), new Date(`${date}T16:00:00Z`), knex, opts);
    const types = (result) => result.blocks.map((b) => b.type);

    test('a December application and a February proposal 50 days later: the 60-day interval blocks; 61 days later it does not', async () => {
      const { customerId } = await fixture(knex);
      await applied(customerId, '2025-12-20');
      const fifty = await check(customerId, '2026-02-08');
      expect(types(fifty)).toEqual(['min_interval_days']);
      expect(fifty.blocks[0]).toMatchObject({ current: 50, max: 60 });
      expect(types(await check(customerId, '2026-02-18'))).toEqual([]); // 60 days: the minimum is met
      expect(types(await check(customerId, '2026-02-19'))).toEqual([]); // 61 days
      expect(types(await check(customerId, '2026-02-17'))).toEqual(['min_interval_days']);
    });

    test('the yearly count keeps the calendar year: two 2025 applications do not count in February 2026, two 2026 ones do', async () => {
      const { customerId } = await fixture(knex);
      await applied(customerId, '2025-01-05');
      await applied(customerId, '2025-04-10');
      expect(types(await check(customerId, '2026-02-12'))).toEqual([]);
      const other = await fixture(knex);
      await applied(other.customerId, '2026-01-02');
      await applied(other.customerId, '2026-03-10');
      expect(types(await check(other.customerId, '2026-06-01'))).toEqual(['annual_max_apps']);
    });

    test('property scope: an application at another property of the customer blocks neither count nor interval; the same property does; the visit\'s own ledger row is left out', async () => {
      const { customerId, property } = await fixture(knex);
      const [other] = await knex('customer_properties').insert({ customer_id: customerId, address_line1: '200 Fixture Street', city: 'Fixture City', zip: '34201', is_primary: false }).returning('*');
      const ledgered = async (propertyId, date) => {
        const [past] = await knex('scheduled_services').insert({ customer_id: customerId, property_id: propertyId, scheduled_date: date, service_type: 'Lawn fixture' }).returning('*');
        const [record] = await knex('service_records').insert({ customer_id: customerId, scheduled_service_id: past.id, service_date: date, service_type: 'Lawn fixture' }).returning('*');
        await applied(customerId, date, { service_record_id: record.id });
        return past;
      };
      const atOther = await ledgered(other.id, '2026-01-20');
      expect(types(await check(customerId, '2026-02-12', { propertyId: property.id }))).toEqual([]);
      expect(types(await check(customerId, '2026-02-12', { propertyId: other.id }))).toEqual(['min_interval_days']);
      // Planning that other property's own completed visit leaves its own row out.
      expect(types(await check(customerId, '2026-02-12', { propertyId: other.id, excludeScheduledServiceId: atOther.id }))).toEqual([]);
    });
  });

  describe('migration 20261007161000: fills a catalog row that already existed', () => {
    const catalogRow = () => knex('products_catalog').where({ name: ATRAZINE }).first();
    const fillLog = () => knex('lawn_protocol_audit_log').where({ action: 'v13_atrazine_catalog_fill' });

    test('a complete row (the 160000 insert) is left alone: no change, no audit row', async () => {
      const before = await catalogRow();
      await fillMigration.up(knex);
      expect(await catalogRow()).toEqual(before);
      expect(await fillLog()).toHaveLength(0);
    });

    test('a hand-made row with blanks gets the missing label fields and price; its own values and inventory stay; down restores only what is unchanged', async () => {
      const original = await catalogRow();
      await knex('products_catalog').where({ id: original.id }).update({
        epa_reg_number: 'N/A', default_rate_per_1000: null, analysis_n: null, labeled_turf_species: JSON.stringify([]), post_application_watering: null,
        best_price: null, needs_pricing: true, max_label_rate_per_1000: 4.5, inventory_on_hand: 77,
      });
      try {
        await fillMigration.up(knex);
        const filled = await catalogRow();
        expect(filled).toMatchObject({ epa_reg_number: '10404-94', labeled_turf_species: ['st_augustine', 'centipede'], needs_pricing: false });
        expect(Number(filled.default_rate_per_1000)).toBe(4);
        expect(Number(filled.analysis_n)).toBe(18);
        expect(Number(filled.best_price)).toBe(36.14);
        expect(filled.post_application_watering).toMatchObject({ source: 'owner' });
        // Untouched: a value the row had, and operational fields.
        expect(Number(filled.max_label_rate_per_1000)).toBe(4.5);
        expect(Number(filled.inventory_on_hand)).toBe(77);
        const [log] = await fillLog();
        expect(log.changed_fields).toEqual(expect.arrayContaining(['epa_reg_number', 'default_rate_per_1000', 'best_price']));
        expect(log.changed_fields).not.toContain('max_label_rate_per_1000');
        // A second up writes nothing more.
        await fillMigration.up(knex);
        expect(await fillLog()).toHaveLength(1);
        // Someone edits the rate afterwards: down leaves that edit and takes back the rest.
        await knex('products_catalog').where({ id: original.id }).update({ default_rate_per_1000: 3.5 });
        await fillMigration.down(knex);
        const undone = await catalogRow();
        expect(Number(undone.default_rate_per_1000)).toBe(3.5);
        expect(undone).toMatchObject({ epa_reg_number: 'N/A', analysis_n: null, post_application_watering: null, best_price: null, needs_pricing: true });
        expect(undone.labeled_turf_species).toEqual([]);
        expect(Number(undone.inventory_on_hand)).toBe(77);
        expect(await fillLog()).toHaveLength(0);
      } finally {
        await knex('products_catalog').where({ id: original.id }).update({
          epa_reg_number: original.epa_reg_number, default_rate_per_1000: original.default_rate_per_1000, analysis_n: original.analysis_n,
          labeled_turf_species: JSON.stringify(original.labeled_turf_species), post_application_watering: JSON.stringify(original.post_application_watering),
          best_price: original.best_price, needs_pricing: original.needs_pricing, max_label_rate_per_1000: original.max_label_rate_per_1000, inventory_on_hand: original.inventory_on_hand,
        });
      }
    });
  });

  describe('migration 20261007162000: the label stamp the job card needs to show the dose', () => {
    const catalogRow = () => knex('products_catalog').where({ name: ATRAZINE }).first();
    test('the stamp is written once, cites the EPA 10404-94 label, and down clears only its own stamp', async () => {
      expect((await catalogRow()).label_verified_at).toBeNull();
      await stampMigration.up(knex);
      const stamped = await catalogRow();
      expect(stamped.label_verified_at).toBeTruthy();
      expect(stamped.label_verified_by).toMatch(/EPA Reg\. 10404-94 label read/);
      await stampMigration.up(knex); // a second run keeps the first stamp
      expect((await catalogRow()).label_verified_at).toEqual(stamped.label_verified_at);

      await stampMigration.down(knex);
      expect(await catalogRow()).toMatchObject({ label_verified_at: null, label_verified_by: null });
    });

    test('a stamp someone else wrote is never replaced, and down leaves it', async () => {
      const when = new Date('2026-09-01T12:00:00Z');
      await knex('products_catalog').where({ name: ATRAZINE }).update({ label_verified_at: when, label_verified_by: 'someone else' });
      await stampMigration.up(knex);
      expect(await catalogRow()).toMatchObject({ label_verified_by: 'someone else', label_verified_at: when });
      await stampMigration.down(knex);
      expect(await catalogRow()).toMatchObject({ label_verified_by: 'someone else' });
      await knex('products_catalog').where({ name: ATRAZINE }).update({ label_verified_at: null, label_verified_by: null });
    });
  });
});
