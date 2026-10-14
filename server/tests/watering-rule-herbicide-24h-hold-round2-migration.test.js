// Round 2 of the herbicide 24-hour hold (Codex round 2 on PR #6243): the owner's
// 24-hour floor on the admin rules the follow-up restored, and Celsius's label
// drying condition back beside the floor. Pure checks run everywhere; the DB
// block self-skips without DATABASE_URL and runs the three files in order
// against owned clones of the tables they read.
const SKIP = !process.env.DATABASE_URL;
const describeDb = SKIP ? describe.skip : describe;
const { randomUUID } = require('crypto');
const knexFactory = require('knex');
const first = require('../models/migrations/20261009120000_watering_rule_herbicide_24h_hold');
const followup = require('../models/migrations/20261009180000_watering_rule_herbicide_24h_hold_followup');
const round2 = require('../models/migrations/20261009181000_watering_rule_herbicide_24h_hold_round2');
const { validateRule } = require('../services/service-report/lawn-watering-rule');
const { buildWateringInstruction } = require('../services/service-report/lawn-watering-instruction');

const ADMIN_ID = 'a1b2c3d4-0000-4000-8000-000000000001';
const ADMIN_RULE = { mode: 'hold', hold_until: 'dry', hold_hours: 2, source: 'owner', label_note: 'Office: keep the drying condition.', verified_by: ADMIN_ID, verified_at: '2026-10-07T12:00:00.000Z' };

describe('round 2 (pure)', () => {
  test('the Celsius literal is exactly what the first file writes, and the round-2 rule adds only the drying condition', () => {
    expect(round2.CELSIUS_FIRST_FILE_RULE).toEqual(first.ITEMS[0].rule);
    expect(round2.CELSIUS_RULE).toEqual({ ...first.ITEMS[0].rule, hold_until: 'dry' });
    const checked = validateRule(round2.CELSIUS_RULE);
    expect(checked.errors).toEqual([]);
    expect(checked.rule).toMatchObject({ mode: 'hold', hold_until: 'dry', hold_hours: 24, source: 'owner' });
    expect(round2.RESTORED_ACTION).toBe('migration:20261009180000_watering_rule_herbicide_24h_hold_followup:restored');
  });

  test('floored: a shorter or hour-less admin hold keeps its conditions, note and provenance and gains the 24-hour floor; 24+ or another mode is untouched', () => {
    const out = round2.floored(ADMIN_RULE);
    expect(out).toEqual({ ...ADMIN_RULE, hold_hours: 24, label_note: `Office: keep the drying condition. ${round2.OWNER_LINE}` });
    expect(validateRule(out).errors).toEqual([]);
    expect(round2.floored({ mode: 'hold', hold_until: 'dry', hold_hours: null, source: 'owner', verified_by: ADMIN_ID })).toMatchObject({ hold_hours: 24, hold_until: 'dry', label_note: round2.OWNER_LINE });
    expect(round2.floored({ mode: 'hold', hold_hours: 36, source: 'owner', verified_by: ADMIN_ID })).toBeNull();
    expect(round2.floored({ mode: 'water_in', water_in_inches: 0.25, water_in_by_hours: 24, source: 'owner' })).toBeNull();
    // Idempotent on the note.
    expect(round2.floored({ ...out, hold_hours: 2 }).label_note).toBe(out.label_note);
  });

  test('Celsius 24 h + dry beside the pre-emergent: the clock time AND the drying condition, then the water-in from the hold end', () => {
    const stonewall = { mode: 'water_in', water_in_inches: 0.5, water_in_by_hours: 24, source: 'owner' };
    const r = buildWateringInstruction({ rules: [round2.CELSIUS_RULE, stonewall], completedAt: '2026-10-09T13:33:00Z', plainWhenNoSetup: true });
    expect(r.state).toBe('hold_then_water_in');
    expect(r.lines).toEqual([
      'Skip your turf watering until Sat 10 AM, and not before today’s treatment has dried.',
      'After that, water in today’s treatment with about ½ inch by Sun 10 AM.',
      'Run it even if it is not your usual day.',
    ]);
    expect(r.expiresAt).toBeNull(); // a drying condition never ends by the clock
  });
});

describeDb('20261009181000 herbicide 24-hour hold round 2', () => {
  let knex;
  let schema;

  beforeEach(async () => {
    schema = `herb_round2_${randomUUID().replace(/-/g, '')}`;
    knex = knexFactory({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 4 } });
    await knex.raw('CREATE SCHEMA ??', [schema]);
    for (const table of ['products_catalog', 'lawn_protocol_products', 'audit_log']) {
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

  test('first file, follow-up, then round 2: the admin rule comes back with its conditions and the 24-hour floor; Celsius keeps its drying condition; nothing else moves', async () => {
    const certainty = await insert({ name: 'Certainty Turf Herbicide', post_application_watering: JSON.stringify(ADMIN_RULE) });
    const celsius = await insert({ name: 'Celsius WG', epa_reg_number: '432-1507', post_application_watering: JSON.stringify({ mode: 'hold', hold_until: 'dry', hold_hours: null, source: 'label', verified_by: 'label-check-2026-09-29' }) });
    const sedge = await insert({ name: 'SedgeHammer Plus', post_application_watering: JSON.stringify({ mode: 'hold', hold_hours: 4, source: 'label', verified_by: 'label-check-2026-10-05' }) });
    const dismiss = await insert({ name: 'Dismiss NXT', post_application_watering: JSON.stringify({ ...ADMIN_RULE, hold_hours: 4 }) });
    await first.up(knex);
    await followup.up(knex);
    // The office edits Dismiss again after the restore: round 2 must leave that alone.
    const later = { mode: 'hold', hold_hours: 6, source: 'owner', verified_by: ADMIN_ID, verified_at: '2026-10-09T14:00:00.000Z' };
    await knex('products_catalog').where({ id: dismiss }).update({ post_application_watering: JSON.stringify(later) });

    await round2.up(knex);
    await round2.up(knex); // idempotent
    expect(await rule(certainty)).toEqual({ ...ADMIN_RULE, hold_hours: 24, label_note: `Office: keep the drying condition. ${round2.OWNER_LINE}` });
    expect(await rule(celsius)).toEqual(round2.CELSIUS_RULE);
    expect(await rule(sedge)).toEqual(first.ITEMS.find((i) => i.label === 'SedgeHammer / SedgeHammer Plus').rule);
    expect(await rule(dismiss)).toEqual(later);
    const actions = await knex('audit_log').where('action', 'like', 'migration:20261009181000%').select('action', 'resource_id');
    expect(actions.map((a) => [a.action.split(':').pop(), a.resource_id]).sort()).toEqual([['celsius_dry', celsius], ['floored', certainty]].sort());
  });

  test('a Celsius rule the office has since changed is left alone', async () => {
    const edited = { mode: 'hold', hold_hours: 48, source: 'owner', verified_by: ADMIN_ID };
    const celsius = await insert({ name: 'Celsius WG', post_application_watering: JSON.stringify(edited) });
    await round2.up(knex);
    expect(await rule(celsius)).toEqual(edited);
  });

  test('with no audit_log there is no restore record and Celsius still gets its condition back', async () => {
    await knex.raw('DROP TABLE ??.audit_log', [schema]);
    const celsius = await insert({ name: 'Celsius WG', post_application_watering: JSON.stringify(round2.CELSIUS_FIRST_FILE_RULE) });
    await round2.up(knex);
    expect(await rule(celsius)).toEqual(round2.CELSIUS_RULE);
    await round2.down(knex);
  });
});
