// Clash keys for the lawn watering label ladder (owner 2026-10-24). Read only under GATE_LAWN_WATERING_EVERY_VISIT:
// with the gate off every row must read exactly as before; with it on, the decision page's texts come out.
const SKIP = !process.env.DATABASE_URL;
const describeDb = SKIP ? describe.skip : describe;
const { randomUUID } = require('crypto');
const knexFactory = require('knex');
const migration = require('../models/migrations/20261025020000_watering_rule_clash_keys');
const { validateRule, rulesForTargets } = require('../services/service-report/lawn-watering-rule');
const { buildWateringInstruction } = require('../services/service-report/lawn-watering-instruction');
const { shortWateringText } = require('../services/service-report/lawn-watering-short-text');

const TUE_9AM = '2026-10-27T13:00:00Z';
const TUE_6PM = '2026-10-27T22:00:00Z';
const TUE_7PM = '2026-10-27T23:00:00Z';
const afterOf = (name) => migration.REPLACE.find((item) => item.name === name).after;
// Rules the migration does not touch, as production stores them.
const CELSIUS = { mode: 'hold', source: 'owner', hold_hours: 24, hold_until: 'dry', label_minimum: { hold_until: 'dry' } };
const SPEEDZONE = { mode: 'hold', source: 'owner', hold_hours: 24, label_minimum: { hold_hours: 3 } };
const ANUEW = { mode: 'hold', source: 'label', hold_hours: 4 };
const DYLOX = { mode: 'water_in', source: 'owner', water_in_inches: 0.25, water_in_by_hours: 24, water_in_same_day: true };
const TARGETS = {
  'Acelepryn Xtra': ['Southern chinch bugs', 'Tropical sod webworms', 'White grubs', 'Fall armyworms'],
  'Tetrino Insecticide': ['Southern chinch bugs', 'Tropical sod webworms', 'Fall armyworms', 'White grubs'],
};

// One logged use of a product, as report-data.js resolves it under the gate.
const use = (name, rule, targets = []) => rulesForTargets(validateRule(rule).rule, targets, { labelTargets: TARGETS[name] || [] })
  .map((resolved) => ({ name, rule: resolved }));
const visit = (uses, completedAt = TUE_9AM) => buildWateringInstruction({ rules: uses.flat(), completedAt, plainWhenNoSetup: true, labelFirst: true });
const text = (uses, completedAt) => shortWateringText(visit(uses, completedAt));
// The instruction as the gate-off path builds it: the stored rule as is, no targets, no label first.
const gateOff = (rule) => {
  const ins = buildWateringInstruction({ rules: [{ name: 'P', rule }], completedAt: TUE_9AM, plainWhenNoSetup: true });
  return { state: ins.state, lines: ins.lines };
};

describe('clash keys (pure)', () => {
  test('every rule it writes passes the validator, and every product it names has a before value', () => {
    expect(migration.REPLACE).toHaveLength(25);
    for (const item of migration.REPLACE) {
      expect(item.before).toBeTruthy();
      expect(validateRule(item.after)).toMatchObject({ valid: true });
    }
  });

  test('no direction, amount, window or provenance changes: only the clash keys are added', () => {
    const DIRECTION = ['mode', 'hold_hours', 'hold_until', 'water_in_inches', 'water_in_by_hours', 'water_in_same_day', 'rain_counts', 'then_water_in', 'source'];
    const pick = (rule) => Object.fromEntries(DIRECTION.filter((key) => rule[key] !== undefined).map((key) => [key, rule[key]]));
    for (const item of migration.REPLACE) {
      expect({ name: item.name, ...pick(item.after) }).toEqual({ name: item.name, ...pick(item.before) });
      (item.before.by_target || []).forEach((entry, i) => expect(pick(item.after.by_target[i])).toEqual(pick(entry)));
    }
  });

  test('with the gate off, every replaced rule reads exactly as before', () => {
    for (const item of migration.REPLACE) {
      expect({ name: item.name, ...gateOff(item.after) }).toEqual({ name: item.name, ...gateOff(item.before) });
    }
  });

  test('SpeedZone is not touched: its 3 hours is a label direction, never cut late in the day', () => {
    expect(migration.REPLACE.find((item) => item.name === 'SpeedZone Southern')).toBeUndefined();
    expect(visit([use('Dylox', DYLOX), use('SpeedZone', SPEEDZONE)], TUE_7PM).noClaim.reason).toBe('water_in_conflict');
  });

  // The decision page's examples, through the real target pick, builder and short writer.
  test('Acelepryn Xtra on grubs beside Talak: the label window counts from the application', () => {
    expect(text([use('Acelepryn Xtra', afterOf('Acelepryn Xtra'), ['White grubs']), use('Talak', afterOf('Atticus Talak 7.9 F'))]))
      .toBe('Let the treatment dry first. Then water about 1/4 inch by Wed 9 AM, even on an off day.');
  });

  test('T-Storm 2G beside our own SedgeHammer hold: the hold shortens to its label minimum', () => {
    expect(text([use('T-Storm', afterOf('LESCO T-Storm 2G Fungicide')), use('SedgeHammer', afterOf('Sedgehammer Plus Halosulfuron-Methyl 5% Post Emergent Soluble Herbicide'))]))
      .toBe('Skip lawn watering until 1 PM today. Then water about 1/4 inch by Wed 9 AM, even on an off day.');
  });

  test('T-Storm 2G beside Drive XLR8\'s own best-results hold: the hold goes first, then T-Storm', () => {
    expect(text([use('T-Storm', afterOf('LESCO T-Storm 2G Fungicide')), use('Drive', afterOf('Drive XLR8 Post Emergent Liquid Herbicide'))]))
      .toBe('Skip lawn watering until Wed 9 AM. Then water about 1/4 inch by Thu 9 AM, even on an off day. Get about 1/2 inch total by Tue, Nov 3 at 8 AM. Rain and regular watering count.');
  });

  test('Dylox beside Advion Insect Granule: the bait gives way, and the instruction names both', () => {
    const ins = visit([use('Dylox', DYLOX), use('Advion Insect Granule', afterOf('Advion Insect Granule'))]);
    expect(shortWateringText(ins)).toBe('Water about 1/4 inch by 11 PM tonight, even on an off day.');
    expect(ins.yielded).toEqual({ holds: ['Advion Insect Granule'], waterIns: ['Dylox'] });
  });

  test('Hydretain beside Talak: the hold first, then the root-zone step within a day', () => {
    expect(text([use('Hydretain', afterOf('Hydretain Liquid')), use('Talak', afterOf('Atticus Talak 7.9 F'))]))
      .toBe('Skip lawn watering until Wed 9 AM. Then water about 1/4 inch by Thu 9 AM, even on an off day.');
  });

  test('Dylox beside Three-Way at 6 PM: the advisory 4 hours end at 9 PM, a full run before midnight', () => {
    expect(text([use('Dylox', DYLOX), use('Three-Way', afterOf('LESCO Three-Way Selective Herbicide'))], TUE_6PM))
      .toBe('Skip lawn watering until 9 PM tonight. Then water about 1/4 inch by 11:59 PM tonight, even on an off day.');
  });

  test('Dylox beside Anuew EZ at 6 PM: two label directions, no claim, for the technician', () => {
    expect(visit([use('Dylox', DYLOX), use('Anuew EZ', ANUEW)], TUE_6PM).noClaim).toMatchObject({
      reason: 'water_in_conflict', holdProducts: ['Anuew EZ'], waterInProducts: ['Dylox'],
    });
  });

  test('Tetrino: chinch bugs (the v13 May use) read as today; grubs count from the application', () => {
    const tetrino = afterOf('Tetrino Insecticide');
    const prefill = TARGETS['Tetrino Insecticide'].slice(0, 3);
    expect(text([use('Tetrino Insecticide', tetrino, prefill), use('Celsius', CELSIUS)]))
      .toBe(text([use('Tetrino Insecticide', migration.BEFORE['Tetrino Insecticide'], prefill), use('Celsius', CELSIUS)]));
    expect(text([use('Tetrino Insecticide', tetrino, ['White grubs']), use('Celsius', CELSIUS)]))
      .toBe('Let the treatment dry first. Then water about 1/4 inch by Wed 9 AM, even on an off day.');
  });

  test('every v13 program mix reads exactly as before: the ladder only changes clashes the program never makes', () => {
    const v13 = require('../config/lawn-protocol-v13.json');
    const RULES = require('./fixtures/lawn-watering-rules-v13-2026-10-22.json');
    const after = Object.fromEntries(Object.entries(RULES).map(([name, rule]) => [name, migration.AFTER[name] ? migration.AFTER[name](rule) : rule]));
    const namesOf = (lines) => String(lines || '').split('\n').map((line) => line.split(' — ')[0].trim()).filter((name) => name && !name.startsWith('Scout visit'));
    const read = (rules, names, completedAt) => {
      const ins = buildWateringInstruction({ rules: names.flatMap((name) => rulesForTargets(validateRule(rules[name]).rule, []).map((rule) => ({ name, rule }))), completedAt, plainWhenNoSetup: true, labelFirst: true });
      return [ins.state, ...ins.lines];
    };
    let checked = 0;
    const changed = [];
    for (const [turf, program] of Object.entries(v13)) {
      for (const v of program.visits) {
        const names = [...new Set([...namesOf(v.primary), ...namesOf(v.secondary), ...Object.values(v.addOns || {}).flatMap((addOn) => namesOf(addOn.secondary))])];
        for (const completedAt of [TUE_9AM, '2026-10-27T20:00:00Z']) {
          checked += 1;
          if (JSON.stringify(read(RULES, names, completedAt)) !== JSON.stringify(read(after, names, completedAt))) changed.push(`${turf} ${v.month}`);
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
    expect(changed).toEqual([]);
  });

  test('the Advion precaution sentence is swapped one for one', () => {
    const before = 'Keep pets and children from picking at the bait granules. Granules on sidewalks or driveways are swept back into the turf. Skip your turf watering for the time shown on this report.';
    expect(before.split(migration.OLD_PRECAUTION_SENTENCE)).toHaveLength(2);
    expect(migration.NEW_PRECAUTION_SENTENCE.split('.').filter((part) => part.trim())).toHaveLength(1);
  });
});

describeDb('20261025020000 clash keys', () => {
  let knex;
  let schema;

  beforeEach(async () => {
    schema = `clash_keys_${randomUUID().replace(/-/g, '')}`;
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
  const read = async (id) => knex('products_catalog').where({ id }).first();

  test('replaces only an exact before value in any key order, leaves edits alone, swaps the precaution once; audited', async () => {
    const talak = migration.REPLACE.find((item) => item.name === 'Atticus Talak 7.9 F');
    const reordered = Object.fromEntries(Object.entries(talak.before).reverse());
    const tal = await insert({ name: talak.name, post_application_watering: JSON.stringify(reordered) });
    const edited = { ...migration.BEFORE['Hydretain Liquid'], water_in_by_hours: 3 };
    const hyd = await insert({ name: 'Hydretain Liquid', post_application_watering: JSON.stringify(edited) });
    const precaution = 'Keep pets and children from picking at the bait granules. Granules on sidewalks or driveways are swept back into the turf. Skip your turf watering for the time shown on this report.';
    const adv = await insert({
      name: 'Advion Insect Granule',
      post_application_watering: JSON.stringify(migration.BEFORE['Advion Insect Granule']),
      customer_precaution_summary: precaution,
    });

    await migration.up(knex);
    await migration.up(knex);
    expect((await read(tal)).post_application_watering).toEqual(talak.after);
    expect((await read(hyd)).post_application_watering).toEqual(edited);
    const advion = await read(adv);
    expect(advion.post_application_watering).toEqual(migration.REPLACE.find((item) => item.name === 'Advion Insect Granule').after);
    expect(advion.customer_precaution_summary).toBe(precaution.replace(migration.OLD_PRECAUTION_SENTENCE, migration.NEW_PRECAUTION_SENTENCE));
    const audits = await knex('audit_log').where('action', 'like', 'migration:20261025020000_%');
    expect(audits.map((a) => `${a.resource_id}:${a.action.split(':').pop()}`).sort()).toEqual([`${tal}:clash_keys`, `${adv}:clash_keys`, `${adv}:precaution`].sort());
    await migration.down(knex);
  });
});
