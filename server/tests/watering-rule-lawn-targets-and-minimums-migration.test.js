// Target rules, label minimums and the herbicides' second watering step (owner 2026-10-22). Read only under
// GATE_LAWN_WATERING_EVERY_VISIT: with the gate off every row must read exactly as before.
const SKIP = !process.env.DATABASE_URL;
const describeDb = SKIP ? describe.skip : describe;
const { randomUUID } = require('crypto');
const knexFactory = require('knex');
const migration = require('../models/migrations/20261022150000_watering_rule_lawn_targets_and_minimums');
const { validateRule, rulesForTargets } = require('../services/service-report/lawn-watering-rule');
const { buildWateringInstruction } = require('../services/service-report/lawn-watering-instruction');

const AT = '2026-10-21T14:00:00Z';
// The instruction as the gate-off path builds it: the stored rule as is, no targets, no label-first rule.
const gateOff = (rule) => {
  const ins = buildWateringInstruction({ rules: [{ name: 'P', rule }], completedAt: AT, plainWhenNoSetup: true });
  return { state: ins.state, lines: ins.lines };
};

describe('target rules and label minimums (pure)', () => {
  test('every rule it writes passes the validator', () => {
    for (const rule of [...migration.FILL.map((f) => f.rule), ...migration.REPLACE.map((r) => r.after)]) {
      expect(validateRule(rule)).toMatchObject({ valid: true });
    }
  });

  test('a product with no rule today gets a target-only rule, so with the gate off it stays no claim', () => {
    for (const name of ['Acelepryn Insecticide', 'Acelepryn Xtra', 'Heritage Action Fungicide', 'Torque SC', 'Armada 50 WDG',
      'LESCO T-Storm Flowable Thiophanate-Methyl 46.2 Systemic Liquid Fungicide']) {
      const { rule } = migration.FILL.find((item) => item.name === name);
      expect(rule.mode).toBeUndefined();
      expect(gateOff(rule).state).toBeNull();
    }
  });

  test('with the gate off, every replaced rule reads exactly as before', () => {
    for (const item of migration.REPLACE) {
      for (const before of item.befores) expect({ name: item.name, ...gateOff(item.after) }).toEqual({ name: item.name, ...gateOff(before) });
    }
  });

  test('a granular that guessed 0.25 inch within 24 hours keeps that as its product-wide rule', () => {
    for (const name of ['Headway G', 'Heritage G', 'Pillar G Intrinsic']) {
      const { rule } = migration.FILL.find((item) => item.name === name);
      expect(rule).toMatchObject({ mode: 'water_in', water_in_inches: 0.25, water_in_by_hours: 24 });
    }
  });

  test('the target words pick the label direction: Acelepryn grubs water in, caterpillars hold', () => {
    const { rule } = migration.FILL.find((item) => item.name === 'Acelepryn Insecticide');
    expect(rulesForTargets(validateRule(rule).rule, ['White grubs']).map((r) => r.mode)).toEqual(['water_in']);
    expect(rulesForTargets(validateRule(rule).rule, ['Tropical sod webworms']).map((r) => r.mode)).toEqual(['hold']);
  });

  test('Blindside, Drive XLR8 and Dismiss NXT carry the label second step after the hold', () => {
    for (const [name, hours] of [['Blindside Herbicide', 168], ['Drive XLR8 Post Emergent Liquid Herbicide', 168], ['Dismiss NXT', 240]]) {
      const { after } = migration.REPLACE.find((item) => item.name === name);
      expect(after.then_water_in).toEqual({ water_in_inches: 0.5, water_in_by_hours: hours });
    }
  });
});

describeDb('20261022150000 target rules and label minimums', () => {
  let knex;
  let schema;

  beforeEach(async () => {
    schema = `targets_min_${randomUUID().replace(/-/g, '')}`;
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

  test('fills an empty rule, replaces only an exact before value in any key order, leaves edits alone; once, audited', async () => {
    const acelepryn = await insert({ name: 'Acelepryn Insecticide' });
    const celsius = migration.REPLACE.find((item) => item.name === 'Celsius WG');
    const reordered = Object.fromEntries(Object.entries(celsius.befores[0]).reverse());
    const cel = await insert({ name: celsius.name, post_application_watering: JSON.stringify(reordered) });
    const edited = { ...migration.REPLACE.find((item) => item.name === 'Blindside Herbicide').befores[0], hold_hours: 12 };
    const blind = await insert({ name: 'Blindside Herbicide', post_application_watering: JSON.stringify(edited) });

    await migration.up(knex);
    await migration.up(knex);
    expect(await rule(acelepryn)).toEqual(migration.FILL.find((item) => item.name === 'Acelepryn Insecticide').rule);
    expect(await rule(cel)).toEqual(celsius.after);
    expect(await rule(blind)).toEqual(edited);
    const audits = await knex('audit_log').where('action', 'like', 'migration:20261022150000_%');
    expect(audits.map((a) => a.resource_id).sort()).toEqual([acelepryn, cel].sort());
    await migration.down(knex);
  });
});
