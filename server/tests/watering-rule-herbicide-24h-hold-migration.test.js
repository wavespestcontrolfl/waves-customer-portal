// 24-hour watering hold for every post-emergent herbicide (owner ruling
// 2026-10-09). The rule checks run everywhere; the migration itself is
// DB-backed (self-skips without DATABASE_URL, like the other Postgres suites)
// and runs against an owned clone of products_catalog.
const SKIP = !process.env.DATABASE_URL;
const describeDb = SKIP ? describe.skip : describe;
const { randomUUID } = require('crypto');
const knexFactory = require('knex');
const migration = require('../models/migrations/20261009120000_watering_rule_herbicide_24h_hold');
const { validateRule, resolveWateringRule } = require('../services/service-report/lawn-watering-rule');
const { buildWateringInstruction } = require('../services/service-report/lawn-watering-instruction');

describe('the herbicide 24-hour hold rules', () => {
  test.each(migration.ITEMS.map((item) => [item.label, item.rule]))('%s is a valid owner-sourced 24-hour hold', (_label, rule) => {
    const checked = validateRule(rule);
    expect(checked.errors).toEqual([]);
    expect(checked.rule).toMatchObject({ mode: 'hold', hold_hours: 24, source: 'owner', verified_at: '2026-10-09T00:00:00.000Z', verified_by: 'owner-ruling-2026-10-09' });
    // No until-dry condition: the owner's hold is a clock time.
    expect(checked.rule.hold_until).toBeUndefined();
    // The note keeps the label's own words next to the owner line.
    expect(rule.label_note).toMatch(/^(Label:|Foliar herbicide)/);
    expect(rule.label_note).toMatch(/Owner \(2026-10-09\): no rain or irrigation for 24 hours/);
  });

  test('a stored rule wins over the Celsius until-dry derivation', () => {
    const celsius = migration.ITEMS[0];
    expect(resolveWateringRule({ name: 'Celsius WG', category: 'herbicide', formulation: 'WDG', post_application_watering: celsius.rule }))
      .toMatchObject({ mode: 'hold', hold_hours: 24, source: 'owner' });
  });

  test('needsHold24: empty or a hold shorter than 24 hours (an until-dry hold included); never a 24+ hour hold or another mode', () => {
    expect(migration.needsHold24(null)).toBe(true);
    expect(migration.needsHold24({ mode: 'hold', hold_until: 'dry', hold_hours: null, source: 'label' })).toBe(true);
    expect(migration.needsHold24({ mode: 'hold', hold_hours: 2, source: 'label' })).toBe(true);
    expect(migration.needsHold24({ mode: 'hold', hold_hours: 6, source: 'label' })).toBe(true);
    expect(migration.needsHold24({ mode: 'hold', hold_hours: 24, source: 'label' })).toBe(false);
    expect(migration.needsHold24({ mode: 'hold', hold_hours: 48, source: 'owner' })).toBe(false);
    expect(migration.needsHold24({ mode: 'water_in', water_in_inches: 0.5, water_in_by_hours: 24, source: 'owner' })).toBe(false);
    expect(migration.needsHold24({ mode: 'none', source: 'owner' })).toBe(false);
  });

  test('Celsius 24 h beside the October pre-emergent and Arena: hold, then water in half an inch from the hold end', () => {
    const celsius = migration.ITEMS[0].rule;
    const stonewall = { mode: 'water_in', water_in_inches: 0.5, water_in_by_hours: 24, source: 'owner' };
    const arena = { mode: 'water_in', water_in_inches: 0.25, water_in_by_hours: 24, source: 'label' };
    // Fri 2026-10-09 9:33 AM ET.
    const r = buildWateringInstruction({ rules: [celsius, stonewall, arena], completedAt: '2026-10-09T13:33:00Z', plainWhenNoSetup: true });
    expect(r.state).toBe('hold_then_water_in');
    expect(r.lines).toEqual([
      'Skip your turf watering until Sat 10 AM.',
      'After that, water in today’s treatment with about ½ inch by Sun 10 AM.',
      'Run it even if it is not your usual day.',
    ]);
    // With rotors on file the same visit gets minutes from the customer's setup.
    const minutes = buildWateringInstruction({ rules: [celsius, stonewall, arena], completedAt: '2026-10-09T13:33:00Z', runtime: { headTypes: ['rotor'] }, plainWhenNoSetup: true });
    expect(minutes.lines[1]).toBe('After that, water in today’s treatment by Sun 10 AM: run each zone about 80 minutes.');
  });
});

describeDb('20261009120000 herbicide 24-hour watering hold', () => {
  let knex;
  let schema;

  beforeEach(async () => {
    schema = `herb_hold_${randomUUID().replace(/-/g, '')}`;
    knex = knexFactory({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 4 } });
    await knex.raw('CREATE SCHEMA ??', [schema]);
    await knex.raw('CREATE TABLE ??.products_catalog (LIKE public.products_catalog INCLUDING ALL)', [schema]);
  });

  afterEach(async () => {
    await knex.raw('DROP SCHEMA ?? CASCADE', [schema]);
    await knex.destroy();
  });

  const insert = async (row) => {
    const [created] = await knex('products_catalog').insert({ id: randomUUID(), ...row }).returning('id');
    return created.id;
  };
  const rule = async (id) => (await knex('products_catalog').where({ id }).first()).post_application_watering;
  const ruleOf = (label) => migration.ITEMS.find((item) => item.label === label).rule;

  test('replaces the shorter label holds, fills an empty row, and leaves 24+ hour holds, other modes and other products alone', async () => {
    const celsius = await insert({ name: 'Celsius WG', epa_reg_number: '432-1507', post_application_watering: JSON.stringify({ mode: 'hold', hold_until: 'dry', hold_hours: null, source: 'label', label_note: 'Do not irrigate until the spray has dried.' }) });
    const certainty = await insert({ name: 'Certainty Turf Herbicide', post_application_watering: JSON.stringify({ mode: 'hold', hold_hours: 2, source: 'label' }), mow_hold_days: 2 });
    const sedge = await insert({ name: 'Sedgehammer Halosulfuron-methyl 75% Post Emergent Soluble Herbicide', post_application_watering: JSON.stringify({ mode: 'hold', hold_hours: 4, source: 'label' }) });
    const dismiss = await insert({ name: 'Dismiss 64 oz' });
    const blindside = await insert({ name: 'Blindside Herbicide', post_application_watering: JSON.stringify({ mode: 'hold', hold_hours: 24, source: 'label' }) });
    const stonewall = await insert({ name: 'LESCO Stonewall 4FL Prodiamine 40.7% Pre-Emergent Liquid Herbicide', post_application_watering: JSON.stringify({ mode: 'water_in', water_in_inches: 0.5, water_in_by_hours: 24, source: 'owner' }) });
    const arena = await insert({ name: 'Arena 50 WDG', post_application_watering: JSON.stringify({ mode: 'water_in', water_in_inches: 0.25, water_in_by_hours: 24, source: 'label' }) });
    await migration.up(knex);

    expect(await rule(celsius)).toEqual(ruleOf('Celsius WG'));
    expect(await rule(certainty)).toEqual(ruleOf('Certainty Turf Herbicide'));
    expect((await knex('products_catalog').where({ id: certainty }).first()).mow_hold_days).toBe(2);
    expect(await rule(sedge)).toEqual(ruleOf('SedgeHammer / SedgeHammer Plus'));
    expect(await rule(dismiss)).toEqual(ruleOf('Dismiss'));
    expect(await rule(blindside)).toEqual({ mode: 'hold', hold_hours: 24, source: 'label' });
    expect(await rule(stonewall)).toMatchObject({ mode: 'water_in' });
    expect(await rule(arena)).toMatchObject({ mode: 'water_in' });
  });

  test('a hold already at or past 24 hours is kept, and re-running changes nothing', async () => {
    const celsius = await insert({ name: 'Celsius WG', post_application_watering: JSON.stringify({ mode: 'hold', hold_hours: 48, source: 'owner', label_note: 'owner edit' }) });
    const fusilade = await insert({ name: 'Fusilade II Post Emergent Liquid Herbicide', post_application_watering: JSON.stringify({ mode: 'hold', hold_hours: 3, source: 'owner' }) });
    await migration.up(knex);
    await migration.up(knex);
    expect(await rule(celsius)).toEqual({ mode: 'hold', hold_hours: 48, source: 'owner', label_note: 'owner edit' });
    expect(await rule(fusilade)).toEqual(ruleOf('Fusilade II'));
  });

  test('down is a documented no-op', async () => {
    const dismiss = await insert({ name: 'Dismiss 64 oz' });
    await migration.up(knex);
    await migration.down(knex);
    expect(await rule(dismiss)).toEqual(ruleOf('Dismiss'));
  });
});
