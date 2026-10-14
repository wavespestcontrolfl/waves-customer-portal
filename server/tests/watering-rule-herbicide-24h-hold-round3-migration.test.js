// Round 3 of the herbicide 24-hour hold (Codex round 3 on PR #6243): the field-
// sheet gate is floored at 24 on every bermuda-removal row, edited values
// included, and the recipe's Dismiss line carries the hold. The pure checks run
// everywhere; the DB block self-skips without DATABASE_URL.
const SKIP = !process.env.DATABASE_URL;
const describeDb = SKIP ? describe.skip : describe;
const { randomUUID } = require('crypto');
const fs = require('fs');
const path = require('path');
const knexFactory = require('knex');
const followup = require('../models/migrations/20261009180000_watering_rule_herbicide_24h_hold_followup');
const round3 = require('../models/migrations/20261009182000_watering_rule_herbicide_24h_hold_round3');

describe('round 3 (pure)', () => {
  test('the floor is the same 24 hours the follow-up wrote', () => {
    expect(round3.FIELD_GATE).toEqual({ key: 'noRainOrIrrigationHours', floor: 24 });
    expect(round3.FIELD_GATE.floor).toBe(followup.FIELD_GATE.after);
  });

  test('every post-emergent herbicide line in the v13 recipe carries the 24-hour hold', () => {
    const recipe = fs.readFileSync(path.join(__dirname, '../config/lawn-protocol-v13.json'), 'utf8');
    expect(recipe).not.toMatch(/irrigation for [0-9] hours after/);
    expect(recipe).toMatch(/Celsius \+ Certainty and Blindside: no rain or irrigation for 24 hours after/);
    expect(recipe).toMatch(/bermuda actively growing, no rain or irrigation for 24 hours after/);
    expect(recipe).toMatch(/Dismiss: use up the jug on green kyllinga under 85°F, no rain or irrigation for 24 hours after/);
    // No Dismiss sentence is left without the hold.
    for (const m of recipe.matchAll(/Dismiss: use up the jug[^"]*/g)) expect(m[0]).toMatch(/24 hours after/);
  });
});

describeDb('20261009182000 herbicide 24-hour hold round 3', () => {
  let knex;
  let schema;

  beforeEach(async () => {
    schema = `herb_round3_${randomUUID().replace(/-/g, '')}`;
    knex = knexFactory({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 4 } });
    await knex.raw('CREATE SCHEMA ??', [schema]);
    // products_catalog too: the follow-up returns early without it, and this
    // test runs the follow-up first to prove what it left behind.
    for (const table of ['products_catalog', 'lawn_protocol_products', 'audit_log']) {
      await knex.raw(`CREATE TABLE ??.${table} (LIKE public.${table} INCLUDING ALL)`, [schema]);
    }
  });

  afterEach(async () => {
    await knex.raw('DROP SCHEMA ?? CASCADE', [schema]);
    await knex.destroy();
  });

  const gate = async (id) => (await knex('lawn_protocol_products').where({ id }).first()).gates;
  const insertRow = async (name, gates) => {
    const [created] = await knex('lawn_protocol_products').insert({
      id: randomUUID(), lawn_protocol_window_id: randomUUID(), product_name: name, role: 'spot', application_mode: 'spray',
      rate_per_1000: 1, rate_unit: 'oz', gates: JSON.stringify(gates),
    }).returning('id');
    return created.id;
  };

  test('after the follow-up, an edited sub-24 gate is floored with its other keys intact; 24+ and untagged rows are untouched; once', async () => {
    const seeded = await insertRow('Recognition Post Emergent Herbicide', { bermudaRemoval: true, noRainOrIrrigationHours: 3, noMowDaysBeforeAfter: 2 });
    const edited = await insertRow('Fusilade II Post Emergent Liquid Herbicide', { bermudaRemoval: true, noRainOrIrrigationHours: 12, requiresProduct: 'Recognition', tankMixWith: 'Recognition Post Emergent Herbicide' });
    const stricter = await insertRow('LESCO 90/10 Nonionic Surfactant', { bermudaRemoval: true, noRainOrIrrigationHours: 36 });
    const other = await insertRow('Celsius WG', { noRainOrIrrigationHours: 3 });
    const noGate = await insertRow('Recognition Post Emergent Herbicide', { bermudaRemoval: true, noMowDaysBeforeAfter: 2 });
    await followup.up(knex);
    expect((await gate(seeded)).noRainOrIrrigationHours).toBe(24); // the follow-up moved the seeded 3
    expect((await gate(edited)).noRainOrIrrigationHours).toBe(12); // its exact-3 predicate skipped the edit

    await round3.up(knex);
    await round3.up(knex); // idempotent
    expect((await gate(seeded)).noRainOrIrrigationHours).toBe(24);
    expect(await gate(edited)).toEqual({ bermudaRemoval: true, noRainOrIrrigationHours: 24, requiresProduct: 'Recognition', tankMixWith: 'Recognition Post Emergent Herbicide' });
    expect((await gate(stricter)).noRainOrIrrigationHours).toBe(36);
    expect((await gate(other)).noRainOrIrrigationHours).toBe(3);
    expect(await gate(noGate)).toEqual({ bermudaRemoval: true, noMowDaysBeforeAfter: 2 });
    const audits = await knex('audit_log').where({ action: 'migration:20261009182000_watering_rule_herbicide_24h_hold_round3:field_gate_floor' }).select('resource_id', 'metadata');
    expect(audits).toHaveLength(1);
    expect(audits[0].resource_id).toBe(edited);
    expect(audits[0].metadata).toMatchObject({ before: 12, after: 24 });
    await round3.down(knex);
  });

  test('with no audit_log the floor still applies', async () => {
    await knex.raw('DROP TABLE ??.audit_log', [schema]);
    const edited = await insertRow('Fusilade II Post Emergent Liquid Herbicide', { bermudaRemoval: true, noRainOrIrrigationHours: 6 });
    await round3.up(knex);
    expect((await gate(edited)).noRainOrIrrigationHours).toBe(24);
  });
});
