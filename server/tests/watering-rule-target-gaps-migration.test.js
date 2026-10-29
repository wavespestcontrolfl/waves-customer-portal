// Final watering-rule audit (owner 2026-10-28): three lawn treatments whose catalog lists a target their rule did not
// name (Armada 50 WDG anthracnose; Acelepryn billbugs; Acelepryn Xtra southern chinch bugs) now build a customer text
// for every target case, and the approved Victor snap trap gets the not-turf rule.
const SKIP = !process.env.DATABASE_URL;
const describeDb = SKIP ? describe.skip : describe;
const { randomUUID } = require('crypto');
const knexFactory = require('knex');
const migration = require('../models/migrations/20261028210000_watering_rule_target_gaps');
const { validateRule, rulesForTargets } = require('../services/service-report/lawn-watering-rule');
const { buildWateringInstruction } = require('../services/service-report/lawn-watering-instruction');

const NAME = '20261028210000_watering_rule_target_gaps';
const DIMENSION = { name: 'LESCO Dimension 18-0-10', rule: { mode: 'water_in', water_in_inches: 0.5, water_in_by_hours: 336, source: 'owner' } };
// The catalog target_pests of each product (production, 2026-10-28): the completion form picks from these.
const CATALOG_TARGETS = {
  'Armada 50 WDG': ['Dollar spot', 'Large patch', 'Leaf spot', 'Anthracnose', 'Fairy ring'],
  'Acelepryn Insecticide': ['Tropical sod webworms', 'Fall armyworms', 'White grubs', 'Billbugs'],
  'Acelepryn Xtra': ['Southern chinch bugs', 'Tropical sod webworms', 'White grubs', 'Fall armyworms'],
};
const replaced = (name) => migration.REPLACE.find((item) => item.name === name);

// The live mapping (report-data.js buildReportWateringInstruction, GATE_LAWN_WATERING_EVERY_VISIT on).
function textFor(name, rule, targets) {
  const picked = rulesForTargets(rule, targets, { labelTargets: CATALOG_TARGETS[name] });
  const mine = picked.length ? picked.map((one) => ({ name, rule: one })) : [{ name, rule: null }];
  return [mine, [DIMENSION, ...mine]].map((rules) => {
    const ins = buildWateringInstruction({ rules, completedAt: '2026-10-28T15:00:00Z', runtime: null, plainWhenNoSetup: true, labelFirst: true });
    return ins.state ? 'ok' : (ins.noClaim && ins.noClaim.reason) || 'none';
  });
}
function cases(name) {
  const all = CATALOG_TARGETS[name];
  return [[], all.slice(0, 3), ...all.map((one) => [one]), all];
}

describe('the target gaps (pure)', () => {
  test('every rule it writes passes the validator, with a source, a note and the 10-28 check stamp', () => {
    for (const rule of [...migration.REPLACE.map((item) => item.after), ...migration.FILL.map((item) => item.rule)]) {
      expect(validateRule(rule)).toMatchObject({ valid: true });
      expect(rule).toMatchObject({ source: 'owner', verified_at: '2026-10-28T00:00:00.000Z', verified_by: 'label-check-2026-10-28' });
      expect(rule.label_note.length).toBeGreaterThan(0);
    }
  });

  test('before the fix, a catalog target got no rule; after it, every target case builds a customer text', () => {
    expect(textFor('Armada 50 WDG', replaced('Armada 50 WDG').before, ['Anthracnose'])).toEqual(['unruled_product', 'unruled_product']);
    expect(textFor('Acelepryn Insecticide', replaced('Acelepryn Insecticide').before, ['Billbugs'])).toEqual(['unruled_product', 'unruled_product']);
    expect(textFor('Acelepryn Xtra', replaced('Acelepryn Xtra').before, ['Southern chinch bugs'])).toEqual(['unruled_product', 'unruled_product']);
    for (const { name, after } of migration.REPLACE) {
      for (const targets of cases(name)) expect({ name, targets, result: textFor(name, after, targets) }).toEqual({ name, targets, result: ['ok', 'ok'] });
    }
  });

  test('the change is only the stated one: Armada gains the product-wide hold, each Acelepryn one hold-until-dry entry', () => {
    const armada = replaced('Armada 50 WDG');
    expect(armada.after).toMatchObject({ mode: 'hold', hold_until: 'dry', by_target: armada.before.by_target });
    for (const [name, words] of [['Acelepryn Insecticide', ['billbug', 'chinch']], ['Acelepryn Xtra', ['chinch', 'billbug', 'mole cricket']]]) {
      const { before, after } = replaced(name);
      expect(after.by_target.slice(0, -1)).toEqual(before.by_target);
      expect(after.by_target[after.by_target.length - 1]).toMatchObject({ mode: 'hold', hold_until: 'dry', match: words });
      expect(after.mode).toBeUndefined(); // still no product-wide rule: an unnamed target stays the office's call
    }
    expect(migration.FILL).toEqual([{ name: 'Victor Expanded Trigger Rat Snap Trap', rule: expect.objectContaining({ mode: 'none' }) }]);
  });
});

describeDb(`${NAME} migration`, () => {
  let knex;
  let schema;

  beforeEach(async () => {
    schema = `target_gaps_${randomUUID().replace(/-/g, '')}`;
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
  const audits = () => knex('audit_log').where('action', 'like', `migration:${NAME}:%`);

  test('replaces a rule only while it is exactly the value read, in any key order; fills the empty trap; once, audited', async () => {
    const [armada] = migration.REPLACE;
    const reordered = Object.fromEntries(Object.entries(armada.before).reverse());
    const same = await insert({ name: armada.name, post_application_watering: JSON.stringify(reordered) });
    const edited = { ...armada.before, label_note: 'Admin edit.' };
    const kept = await insert({ name: armada.name, post_application_watering: JSON.stringify(edited) });
    const trap = await insert({ name: 'Victor Expanded Trigger Rat Snap Trap' });

    await migration.up(knex);
    await migration.up(knex);
    expect((await read(same)).post_application_watering).toEqual(armada.after);
    expect((await read(kept)).post_application_watering).toEqual(edited);
    expect((await read(trap)).post_application_watering).toEqual(migration.FILL[0].rule);
    expect((await audits()).map((a) => a.action).sort()).toEqual([`migration:${NAME}:seeded`, `migration:${NAME}:target_gap`]);
    await migration.down(knex);
    expect((await read(same)).post_application_watering).toEqual(armada.after);
  });

  test('a trap rule an admin already set stands', async () => {
    const admin = { mode: 'none', source: 'owner', label_note: 'Admin.' };
    const trap = await insert({ name: 'Victor Expanded Trigger Rat Snap Trap', post_application_watering: JSON.stringify(admin) });
    await migration.up(knex);
    expect((await read(trap)).post_application_watering).toEqual(admin);
    expect(await audits()).toHaveLength(0);
  });
});
