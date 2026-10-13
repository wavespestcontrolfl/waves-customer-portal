// Pre-emergent water-in follows the label (owner 2026-10-09): Stonewall and
// Dimension move from 0.5 inch within 24 hours to 0.5 inch within 14 days, and
// Topchoice's program-default rule is marked owner, not label.
const SKIP = !process.env.DATABASE_URL;
const describeDb = SKIP ? describe.skip : describe;
const { randomUUID } = require('crypto');
const knexFactory = require('knex');
const migration = require('../models/migrations/20261009200000_watering_rule_preemergent_label_window');
const v13 = require('../models/migrations/20261005235500_watering_rule_lawn_v13');
const { validateRule } = require('../services/service-report/lawn-watering-rule');

const v13Rule = (name) => v13.FILL.find((item) => item.name === name)?.rule;

describe('pre-emergent label window (pure)', () => {
  test('every v13 pre-emergent rule it targets is the 0.5 inch within 24 hours value, and comes out a valid 14-day rule', () => {
    for (const item of migration.PRE_EMERGENTS) {
      const before = v13Rule(item.name) || { mode: 'water_in', water_in_inches: 0.5, water_in_by_hours: 24, source: 'owner' };
      expect(migration.isV13PreEmergentRule(before)).toBe(true);
      const after = migration.preEmergentAfter(before, item);
      expect(after).toMatchObject({ mode: 'water_in', water_in_inches: 0.5, water_in_by_hours: 336, source: item.source });
      expect(validateRule(after).valid).toBe(true);
    }
  });

  test('a rule an admin changed (another amount or window) is not the v13 value', () => {
    expect(migration.isV13PreEmergentRule({ mode: 'water_in', water_in_inches: 0.25, water_in_by_hours: 24 })).toBe(false);
    expect(migration.isV13PreEmergentRule({ mode: 'water_in', water_in_inches: 0.5, water_in_by_hours: 48 })).toBe(false);
    expect(migration.isV13PreEmergentRule({ mode: 'hold', hold_hours: 24 })).toBe(false);
    expect(migration.isV13PreEmergentRule(null)).toBe(false);
  });

  test('Topchoice: a label-sourced water-in becomes owner-sourced; anything else is left alone', () => {
    const before = { mode: 'water_in', water_in_inches: 0.25, water_in_by_hours: 24, source: 'label', label_note: 'x' };
    expect(migration.topchoiceAfter(before)).toMatchObject({ ...before, source: 'owner' });
    expect(migration.topchoiceAfter({ ...before, source: 'owner' })).toBeNull();
    expect(migration.topchoiceAfter({ mode: 'hold', source: 'label' })).toBeNull();
  });
});

describeDb('20261009200000 pre-emergent label window', () => {
  let knex;
  let schema;

  beforeEach(async () => {
    schema = `preem_window_${randomUUID().replace(/-/g, '')}`;
    knex = knexFactory({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 4 } });
    await knex.raw('CREATE SCHEMA ??', [schema]);
    for (const table of ['products_catalog', 'audit_log']) {
      await knex.raw(`CREATE TABLE ??.${table} (LIKE public.${table} INCLUDING ALL)`, [schema]);
    }
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

  test('the v13 values move to 14 days, an admin edit and other products are untouched; once, audited', async () => {
    const [stonewall, dimension] = migration.PRE_EMERGENTS;
    const sw = await insert({ name: stonewall.name, post_application_watering: JSON.stringify(v13Rule(stonewall.name)) });
    const edited = { mode: 'water_in', water_in_inches: 0.25, water_in_by_hours: 48, source: 'owner' };
    const dim = await insert({ name: dimension.name, post_application_watering: JSON.stringify(edited) });
    const arena = { mode: 'water_in', water_in_inches: 0.25, water_in_by_hours: 24, source: 'label' };
    const ar = await insert({ name: 'Arena 50 WDG', post_application_watering: JSON.stringify(arena) });
    const topBefore = { mode: 'water_in', water_in_inches: 0.25, water_in_by_hours: 24, source: 'label', label_note: 'program default' };
    const top = await insert({ name: migration.TOPCHOICE, post_application_watering: JSON.stringify(topBefore) });

    await migration.up(knex);
    await migration.up(knex); // idempotent
    expect(await rule(sw)).toMatchObject({ water_in_inches: 0.5, water_in_by_hours: 336, source: 'label' });
    expect(await rule(dim)).toEqual(edited);
    expect(await rule(ar)).toEqual(arena);
    expect(await rule(top)).toMatchObject({ source: 'owner', water_in_by_hours: 24 });
    const audits = await knex('audit_log').where('action', 'like', 'migration:20261009200000_%');
    expect(audits.map((a) => a.resource_id).sort()).toEqual([sw, top].sort());
    await migration.down(knex);
  });
});
