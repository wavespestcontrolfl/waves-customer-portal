// Lawn label pass (owner 2026-10-22: every lawn product combination gets an
// accurate watering text): every lawn product with no rule or a derived guess
// gets a stored label or owner rule, and five catalog values the labels
// contradict are corrected.
const SKIP = !process.env.DATABASE_URL;
const describeDb = SKIP ? describe.skip : describe;
const { randomUUID } = require('crypto');
const knexFactory = require('knex');
const migration = require('../models/migrations/20261022120000_watering_rule_lawn_label_pass');
const { validateRule, deriveDefaultRule } = require('../services/service-report/lawn-watering-rule');

const fillRule = (name) => migration.FILL.find((item) => item.name === name)?.rule;

describe('lawn label pass rules (pure)', () => {
  test('every rule it writes passes the validator, with a label or owner source and a note', () => {
    for (const item of [...migration.FILL.map((f) => f.rule), ...migration.REPLACE.map((r) => r.after)]) {
      expect(validateRule(item)).toMatchObject({ valid: true });
      expect(['label', 'owner']).toContain(item.source);
      expect(item.label_note.length).toBeGreaterThan(0);
    }
  });

  test('a product is filled once and never both filled and replaced', () => {
    const filled = migration.FILL.map((item) => item.name);
    expect(new Set(filled).size).toBe(filled.length);
    for (const item of migration.REPLACE) expect(filled).not.toContain(item.name);
  });

  test('the pre-emergents the guess watered in within 24 hours take the label: 0.5 inch within 14 days', () => {
    for (const name of ['LESCO Stonewall 0.37% 18-0-10', 'LESCO Stonewall 0-0-7', 'Prodiamine 65 WDG']) {
      expect(deriveDefaultRule({ name, category: 'herbicide', formulation: 'granular' })).toMatchObject({ water_in_by_hours: 24 });
      expect(fillRule(name)).toMatchObject({ mode: 'water_in', water_in_inches: 0.5, water_in_by_hours: 336, source: 'label' });
    }
  });

  test('a product whose label directions differ by target gets no product-wide rule here', () => {
    for (const name of ['Acelepryn Insecticide', 'Acelepryn Xtra', 'Heritage Action Fungicide', 'Torque SC', 'Armada 50 WDG',
      'LESCO T-Storm Flowable Thiophanate-Methyl 46.2 Systemic Liquid Fungicide', 'Headway G', 'Heritage G', 'Pillar G Intrinsic']) {
      expect(fillRule(name)).toBeUndefined();
    }
  });
});

describeDb('20261022120000 lawn label pass', () => {
  let knex;
  let schema;

  beforeEach(async () => {
    schema = `label_pass_${randomUUID().replace(/-/g, '')}`;
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
  const read = (id) => knex('products_catalog').where({ id }).first();
  const audits = () => knex('audit_log').where('action', 'like', 'migration:20261022120000_%');

  test('fills an empty rule and its empty mow hold, leaves an admin rule alone; once, audited', async () => {
    const medallion = await insert({ name: 'Medallion SC' });
    const speedzone = await insert({ name: 'SpeedZone Southern' });
    const edited = { mode: 'none', source: 'owner' };
    const kflow = await insert({ name: 'LESCO K-Flow 0-0-25 17% S Turfgrass Liquid Fertilizer', post_application_watering: JSON.stringify(edited) });

    await migration.up(knex);
    await migration.up(knex);
    expect((await read(medallion)).post_application_watering).toEqual(fillRule('Medallion SC'));
    expect(await read(speedzone)).toMatchObject({ mow_hold_days: 2, post_application_watering: fillRule('SpeedZone Southern') });
    expect((await read(kflow)).post_application_watering).toEqual(edited);
    const written = await audits();
    expect(written.map((a) => a.action).sort()).toEqual([
      'migration:20261022120000_watering_rule_lawn_label_pass:mow_hold_seeded',
      'migration:20261022120000_watering_rule_lawn_label_pass:seeded',
      'migration:20261022120000_watering_rule_lawn_label_pass:seeded',
    ]);
  });

  test('replaces a rule only while it is exactly the value read on 2026-10-22, in any key order', async () => {
    const [arena] = migration.REPLACE;
    const reordered = Object.fromEntries(Object.entries(arena.before).reverse());
    const same = await insert({ name: arena.name, post_application_watering: JSON.stringify(reordered) });
    const changed = { ...arena.before, water_in_by_hours: 48 };
    const edited = await insert({ name: arena.name, post_application_watering: JSON.stringify(changed) });

    await migration.up(knex);
    await migration.up(knex);
    expect((await read(same)).post_application_watering).toEqual(arena.after);
    expect((await read(edited)).post_application_watering).toEqual(changed);
    expect((await audits()).map((a) => a.resource_id)).toEqual([same]);
  });

  test('sets the two label mow holds only from the values read', async () => {
    const fusilade = await insert({ name: 'Fusilade II Post Emergent Liquid Herbicide', mow_hold_days: 2 });
    const drive = await insert({ name: 'Drive XLR8 Post Emergent Liquid Herbicide' });
    const driveEdited = await insert({ name: 'Drive XLR8 Post Emergent Liquid Herbicide', mow_hold_days: 3 });

    await migration.up(knex);
    await migration.up(knex);
    expect(await read(fusilade)).toMatchObject({ mow_hold_days: 7 });
    expect(await read(drive)).toMatchObject({ mow_hold_days: 2 });
    expect(await read(driveEdited)).toMatchObject({ mow_hold_days: 3 });
    expect((await audits()).length).toBe(2);
    await migration.down(knex);
  });
});
