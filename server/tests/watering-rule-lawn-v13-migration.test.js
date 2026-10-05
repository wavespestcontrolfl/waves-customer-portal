// Watering rules for the lawn protocol v13 products (owner 2026-10-05). The rule
// checks run everywhere; the migration itself is DB-backed (self-skips without
// DATABASE_URL, like the other Postgres suites) and runs against an owned clone
// of products_catalog.
const SKIP = !process.env.DATABASE_URL;
const describeDb = SKIP ? describe.skip : describe;
const { randomUUID } = require('crypto');
const fs = require('fs');
const path = require('path');
const knexFactory = require('knex');
const migration = require('../models/migrations/20261005230000_watering_rule_lawn_v13');
const { validateRule } = require('../services/service-report/lawn-watering-rule');
const { buildWateringInstruction } = require('../services/service-report/lawn-watering-instruction');

const ALL = [...migration.FILL, ...migration.REPLACE];

describe('the v13 watering rules', () => {
  test.each(ALL.map((item) => [item.name, item.rule]))('%s is a valid rule', (_name, rule) => {
    const checked = validateRule(rule);
    expect(checked.errors).toEqual([]);
    expect(checked.rule.verified_by).toBe('label-check-2026-10-05');
  });

  test('every product named in the v13 recipe has a rule here or one already stored on main', () => {
    const recipe = path.join(__dirname, '../config/lawn-protocol-v13.json');
    if (!fs.existsSync(recipe)) return; // the v13 recipe lands in its own PR (#5942)
    const names = new Set();
    for (const track of Object.values(JSON.parse(fs.readFileSync(recipe, 'utf8')))) {
      for (const visit of track.visits || []) {
        for (const field of ['primary', 'secondary']) {
          for (const line of String(visit[field] || '').split('\n')) {
            const name = line.split(' — ')[0].trim();
            if (name && !/^Scout visit/.test(name)) names.add(name);
          }
        }
      }
    }
    // Stored on main by earlier label reads (20260930000001 seed).
    const storedOnMain = new Set(['Arena 50 WDG', 'Celsius WG', 'Atticus Talak 7.9 F']);
    const covered = new Set([...ALL.map((item) => item.name), ...storedOnMain, ...migration.FAIL_CLOSED.map((item) => item.name)]);
    expect([...names].filter((name) => !covered.has(name))).toEqual([]);
  });

  test('Tetrino is watered in, so a soil-pest (white grub) application is never told "no change"', () => {
    expect(ALL.find((item) => item.name === 'Tetrino Insecticide').rule).toMatchObject({ mode: 'water_in', water_in_inches: 0.25, water_in_by_hours: 24 });
  });

  test('a product whose labeled targets need opposite directions gets no rule (fail closed)', () => {
    for (const { name } of migration.FAIL_CLOSED) expect(ALL.find((item) => item.name === name)).toBeUndefined();
    expect(migration.FAIL_CLOSED.map((item) => item.name)).toContain('Acelepryn Insecticide');
  });

  test('a Dylox afternoon completion is told to water in the same day (ET)', () => {
    const dylox = ALL.find((item) => item.name === 'Dylox 6.2 G Granular Insecticide').rule;
    const completedAt = new Date('2026-10-14T19:00:00Z'); // 3 PM ET
    const instruction = buildWateringInstruction({ rules: [{ name: 'Dylox 6.2 G Granular Insecticide', ...dylox }], completedAt });
    expect(instruction.state).toBe('water_in');
    expect(instruction.lines[0]).toMatch(/(today|tonight)/);
  });

  test('no 48-hour runoff advisory is turned into a hold', () => {
    for (const item of ALL) expect(item.rule.hold_hours ?? 0).toBeLessThan(48);
  });

  test('pre-emergent water-in plus Celsius and Certainty spots still yields one instruction', () => {
    if (typeof buildWateringInstruction !== 'function') return;
    const byName = Object.fromEntries(ALL.map((item) => [item.name, item.rule]));
    const rules = [
      byName['LESCO Stonewall 4FL Prodiamine 40.7% Pre-Emergent Liquid Herbicide'],
      byName['LESCO Nutra-TECH T&O Micronutrient Package'],
      byName['Certainty Turf Herbicide'],
      { mode: 'hold', hold_until: 'dry', hold_hours: null, source: 'label' }, // Celsius WG on main
    ];
    const instruction = buildWateringInstruction({ rules, completedAt: new Date('2026-01-14T15:00:00Z') });
    expect(instruction && instruction.state).toBe('hold_then_water_in');
  });
});

describeDb('20261005230000 lawn v13 watering rules', () => {
  let knex;
  let schema;

  beforeEach(async () => {
    schema = `v13_water_${randomUUID().replace(/-/g, '')}`;
    knex = knexFactory({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 4 } });
    await knex.raw('CREATE SCHEMA ??', [schema]);
    await knex.raw('CREATE TABLE ??.products_catalog (LIKE public.products_catalog INCLUDING ALL)', [schema]);
    await knex.raw('CREATE TABLE ??.audit_log (LIKE public.audit_log INCLUDING ALL)', [schema]);
  });

  afterEach(async () => {
    await knex.raw('DROP SCHEMA ?? CASCADE', [schema]);
    await knex.destroy();
  });

  const insert = async (row) => {
    const [created] = await knex('products_catalog').insert({ id: randomUUID(), ...row }).returning('id');
    return created.id;
  };
  const get = async (id) => knex('products_catalog').where({ id }).first();
  const item = (name) => ALL.find((entry) => entry.name === name);

  test('fills empty rules and mow holds by exact name, and leaves other products alone', async () => {
    const certainty = await insert({ name: 'Certainty Turf Herbicide' });
    const velista = await insert({ name: 'Velista' });
    const lookalike = await insert({ name: 'Certainty Turf Post Emergent Dry Herbicide' });
    await migration.up(knex);
    expect((await get(certainty)).post_application_watering).toEqual(item('Certainty Turf Herbicide').rule);
    expect((await get(certainty)).mow_hold_days).toBe(2);
    expect((await get(velista)).post_application_watering).toEqual(item('Velista').rule);
    expect((await get(velista)).mow_hold_days).toBeNull();
    expect((await get(lookalike)).post_application_watering).toBeNull();
  });

  test('never overwrites an existing rule or mow hold, and re-running changes nothing', async () => {
    const owned = { mode: 'none', source: 'owner', label_note: 'owner edit' };
    const certainty = await insert({ name: 'Certainty Turf Herbicide', post_application_watering: JSON.stringify(owned), mow_hold_days: 3 });
    const dismiss = await insert({ name: 'Dismiss 64 oz' });
    await migration.up(knex);
    await migration.up(knex);
    expect((await get(certainty)).post_application_watering).toEqual(owned);
    expect((await get(certainty)).mow_hold_days).toBe(3);
    expect((await get(dismiss)).post_application_watering).toEqual(item('Dismiss 64 oz').rule);
  });

  test('replaces only the 2026-09-29 seed value, whatever its verified_at', async () => {
    const artavia = item('Artavia 2 SC (Azoxy)');
    const seeded = await insert({ name: artavia.name, post_application_watering: JSON.stringify(artavia.seeded) });
    // The seed's first run stamped the run time before 20260930000002 pinned it.
    const runStamped = await insert({ name: artavia.name, post_application_watering: JSON.stringify({ ...artavia.seeded, verified_at: '2026-09-30T14:03:11.512Z' }) });
    const extraKey = await insert({ name: artavia.name, post_application_watering: JSON.stringify({ ...artavia.seeded, verified_by: 'owner' }) });
    const edited = await insert({ name: artavia.name, post_application_watering: JSON.stringify({ ...artavia.seeded, hold_hours: 36 }) });
    await migration.up(knex);
    expect((await get(seeded)).post_application_watering).toEqual(artavia.rule);
    expect((await get(runStamped)).post_application_watering).toEqual(artavia.rule);
    expect((await get(extraKey)).post_application_watering.verified_by).toBe('owner');
    expect((await get(edited)).post_application_watering.hold_hours).toBe(36);
  });

  test('down is a no-op: rules, corrections and mow holds all stay', async () => {
    const artavia = item('Artavia 2 SC (Azoxy)');
    const art = await insert({ name: artavia.name, post_application_watering: JSON.stringify(artavia.seeded) });
    const certainty = await insert({ name: 'Certainty Turf Herbicide' });
    await migration.up(knex);
    await migration.down(knex);
    expect((await get(art)).post_application_watering).toEqual(artavia.rule);
    expect((await get(certainty)).post_application_watering).toEqual(item('Certainty Turf Herbicide').rule);
    expect((await get(certainty)).mow_hold_days).toBe(2);
  });

  test('every write is recorded in audit_log with the fields it changed', async () => {
    const artavia = item('Artavia 2 SC (Azoxy)');
    await insert({ name: artavia.name, post_application_watering: JSON.stringify(artavia.seeded) });
    await insert({ name: 'Certainty Turf Herbicide', mow_hold_days: 2 });
    await migration.up(knex);
    const rows = await knex('audit_log').where('action', 'like', 'migration:20261005230000_watering_rule_lawn_v13:%').select('action', 'metadata');
    const byProduct = Object.fromEntries(rows.map((r) => [r.metadata.product, r]));
    expect(byProduct[artavia.name].action).toMatch(/:corrected$/);
    expect(byProduct[artavia.name].metadata.before).toEqual(artavia.seeded);
    expect(byProduct['Certainty Turf Herbicide'].metadata.after).toEqual(item('Certainty Turf Herbicide').rule);
    expect(byProduct['Certainty Turf Herbicide'].metadata.mow_hold_days_after).toBeNull();
  });
});
