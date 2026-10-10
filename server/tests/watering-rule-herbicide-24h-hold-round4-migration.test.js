// Round 4 of the herbicide 24-hour hold (Codex round 4 on PR #6243): a floored
// admin note that the round-2 owner line pushed past the 500-character limit is
// trimmed back under it with the owner line whole, so the rule validates again.
const SKIP = !process.env.DATABASE_URL;
const describeDb = SKIP ? describe.skip : describe;
const { randomUUID } = require('crypto');
const knexFactory = require('knex');
const round2 = require('../models/migrations/20261009181000_watering_rule_herbicide_24h_hold_round2');
const round4 = require('../models/migrations/20261009183000_watering_rule_herbicide_24h_hold_round4');
const { validateRule, resolveWateringRule } = require('../services/service-report/lawn-watering-rule');

const ADMIN_ID = 'a1b2c3d4-0000-4000-8000-000000000001';
const longNote = (n) => 'Office: '.padEnd(n, 'x');
const adminRule = (note) => ({ mode: 'hold', hold_until: 'dry', hold_hours: 2, source: 'owner', label_note: note, verified_by: ADMIN_ID, verified_at: '2026-10-07T12:00:00.000Z' });

describe('round 4 (pure)', () => {
  test('the owner line is the one round 2 appends', () => {
    expect(round4.OWNER_LINE).toBe(round2.OWNER_LINE);
    expect(round4.MAX_NOTE).toBe(500);
  });

  test('round 2 on a 409+ character admin note produces an over-long, invalid rule; round 4 trims it to a valid one with the owner line whole', () => {
    for (const len of [409, 450, 500]) {
      const floored = round2.floored(adminRule(longNote(len)));
      expect(floored.label_note.length).toBeGreaterThan(500);
      expect(validateRule(floored).valid).toBe(false);
      const note = round4.trimmedNote(floored.label_note);
      expect(note.length).toBeLessThanOrEqual(500);
      expect(note.endsWith(round4.OWNER_LINE)).toBe(true);
      expect(note).toMatch(/^Office: x+… Owner \(2026-10-09\)/);
      expect(validateRule({ ...floored, label_note: note })).toMatchObject({ valid: true });
    }
  });

  test('a note within the limit, or one without the owner line, is left alone', () => {
    expect(round4.trimmedNote(round2.floored(adminRule(longNote(300))).label_note)).toBeNull();
    expect(round4.trimmedNote(`${round4.OWNER_LINE}`)).toBeNull();
    expect(round4.trimmedNote(longNote(600))).toBeNull(); // over the limit but not round 2's doing
    expect(round4.trimmedNote(null)).toBeNull();
  });
});

describeDb('20261009183000 herbicide 24-hour hold round 4', () => {
  let knex;
  let schema;

  beforeEach(async () => {
    schema = `herb_round4_${randomUUID().replace(/-/g, '')}`;
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

  test('an over-long floored note is trimmed to a valid rule the resolver accepts again; in-limit and unrelated notes are untouched; once, audited', async () => {
    const overLong = round2.floored(adminRule(longNote(480)));
    const certainty = await insert({ name: 'Certainty Turf Herbicide', category: 'herbicide', formulation: 'WDG', post_application_watering: JSON.stringify(overLong) });
    const fine = round2.floored(adminRule(longNote(200)));
    const sedge = await insert({ name: 'SedgeHammer Plus', post_application_watering: JSON.stringify(fine) });
    const unrelated = { mode: 'none', source: 'owner', label_note: longNote(600) }; // over the limit but not round 2's line: left for the admin
    const other = await insert({ name: 'Dispatch Sprayable Wetting Agent', post_application_watering: JSON.stringify(unrelated) });
    expect(validateRule(overLong).valid).toBe(false);

    await round4.up(knex);
    await round4.up(knex); // idempotent
    const trimmed = await rule(certainty);
    expect(trimmed.label_note.length).toBeLessThanOrEqual(500);
    expect(trimmed).toMatchObject({ mode: 'hold', hold_until: 'dry', hold_hours: 24, verified_by: ADMIN_ID });
    expect(validateRule(trimmed).valid).toBe(true);
    expect(resolveWateringRule({ name: 'Certainty Turf Herbicide', category: 'herbicide', formulation: 'WDG', post_application_watering: trimmed })).toMatchObject({ hold_hours: 24, hold_until: 'dry' });
    expect(await rule(sedge)).toEqual(fine);
    expect(await rule(other)).toEqual(unrelated);
    const audits = await knex('audit_log').where({ action: 'migration:20261009183000_watering_rule_herbicide_24h_hold_round4:note_trimmed' });
    expect(audits).toHaveLength(1);
    expect(audits[0].resource_id).toBe(certainty);
    await round4.down(knex);
  });
});
