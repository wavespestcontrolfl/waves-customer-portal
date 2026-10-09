// Follow-up to the herbicide 24-hour hold (Codex round 1 on PR #6243): admin-
// authored rules the first migration overwrote are restored from its audit
// rows, and the bermuda-removal field-sheet gate goes 3 -> 24. The pure checks
// run everywhere; the migration itself is DB-backed (self-skips without
// DATABASE_URL) and runs against owned clones of the three tables it reads.
const SKIP = !process.env.DATABASE_URL;
const describeDb = SKIP ? describe.skip : describe;
const { randomUUID } = require('crypto');
const fs = require('fs');
const path = require('path');
const knexFactory = require('knex');
const first = require('../models/migrations/20261009120000_watering_rule_herbicide_24h_hold');
const followup = require('../models/migrations/20261009180000_watering_rule_herbicide_24h_hold_followup');

const ADMIN_ID = 'a1b2c3d4-0000-4000-8000-000000000001';
const ADMIN_RULE = { mode: 'hold', hold_until: 'dry', hold_hours: 2, source: 'owner', label_note: 'Office: keep the drying condition.', verified_by: ADMIN_ID, verified_at: '2026-10-07T12:00:00.000Z' };

describe('the follow-up migration (pure)', () => {
  test('seededProvenance: a label-check marker or no provenance is seeded; an admin id is not', () => {
    expect(followup.seededProvenance({ mode: 'hold', hold_hours: 2, source: 'label', verified_by: 'label-check-2026-10-05' })).toBe(true);
    expect(followup.seededProvenance({ mode: 'hold', hold_hours: 6, source: 'label' })).toBe(true);
    expect(followup.seededProvenance({ mode: 'hold', hold_hours: 3, source: 'owner', verified_by: null })).toBe(true);
    expect(followup.seededProvenance(ADMIN_RULE)).toBe(false);
    expect(followup.seededProvenance({ mode: 'hold', hold_hours: 4, source: 'owner', verified_by: 'adam' })).toBe(false);
  });

  test('it reads the first migration\'s audit action and raises the seeded 3-hour field gate to 24', () => {
    expect(followup.SOURCE_ACTION).toBe('migration:20261009120000_watering_rule_herbicide_24h_hold:corrected');
    expect(followup.FIELD_GATE).toEqual({ key: 'noRainOrIrrigationHours', before: 3, after: 24 });
  });

  test('the v13 recipe no longer tells the technician a shorter herbicide hold than the customer gets', () => {
    const recipe = fs.readFileSync(path.join(__dirname, '../config/lawn-protocol-v13.json'), 'utf8');
    expect(recipe).not.toMatch(/irrigation for [0-9] hours after/);
    expect(recipe).toMatch(/Celsius \+ Certainty and Blindside: no rain or irrigation for 24 hours after/);
    expect(recipe).toMatch(/bermuda actively growing, no rain or irrigation for 24 hours after/);
  });
});

describeDb('20261009180000 herbicide 24-hour hold follow-up', () => {
  let knex;
  let schema;

  beforeEach(async () => {
    schema = `herb_followup_${randomUUID().replace(/-/g, '')}`;
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
  const hold24 = (label) => first.ITEMS.find((item) => item.label === label).rule;

  test('restores the admin-authored rules the first migration overwrote, keeps its seeded replacements, and never touches a later admin edit', async () => {
    const certainty = await insert({ name: 'Certainty Turf Herbicide', post_application_watering: JSON.stringify(ADMIN_RULE) });
    const celsius = await insert({ name: 'Celsius WG', post_application_watering: JSON.stringify({ mode: 'hold', hold_until: 'dry', hold_hours: null, source: 'label', verified_by: 'label-check-2026-09-29' }) });
    const dismiss = await insert({ name: 'Dismiss NXT', post_application_watering: JSON.stringify({ ...ADMIN_RULE, hold_hours: 4 }) });
    await first.up(knex);
    expect(await rule(certainty)).toEqual(hold24('Certainty Turf Herbicide')); // the first file's overwrite, audited
    // The office edits Dismiss again after the first file ran: the follow-up must leave that alone.
    const later = { mode: 'hold', hold_hours: 36, source: 'owner', verified_by: ADMIN_ID, verified_at: '2026-10-09T13:00:00.000Z' };
    await knex('products_catalog').where({ id: dismiss }).update({ post_application_watering: JSON.stringify(later) });

    await followup.up(knex);
    await followup.up(knex); // idempotent
    expect(await rule(certainty)).toEqual(ADMIN_RULE);
    expect(await rule(celsius)).toEqual(hold24('Celsius WG'));
    expect(await rule(dismiss)).toEqual(later);
    const restored = await knex('audit_log').where({ action: `migration:20261009180000_watering_rule_herbicide_24h_hold_followup:restored` }).select('resource_id', 'metadata');
    expect(restored.map((r) => r.resource_id)).toEqual([certainty]);
    expect(restored[0].metadata).toMatchObject({ before: hold24('Certainty Turf Herbicide'), after: ADMIN_RULE });
  });

  test('with no audit_log there is nothing to restore and the field gate still moves', async () => {
    await knex.raw('DROP TABLE ??.audit_log', [schema]);
    const windowId = randomUUID();
    const [row] = await knex('lawn_protocol_products').insert({
      id: randomUUID(), lawn_protocol_window_id: windowId, product_name: 'Recognition Post Emergent Herbicide', role: 'spot', application_mode: 'spray',
      rate_per_1000: 1, rate_unit: 'oz', gates: JSON.stringify({ bermudaRemoval: true, noRainOrIrrigationHours: 3 }),
    }).returning('id');
    await followup.up(knex);
    expect((await knex('lawn_protocol_products').where({ id: row.id }).first()).gates).toEqual({ bermudaRemoval: true, noRainOrIrrigationHours: 24 });
  });

  test('the bermuda-removal field-sheet gate goes 3 -> 24 on tagged rows still at the seed, once, with an audit row each', async () => {
    const gate = async (id) => (await knex('lawn_protocol_products').where({ id }).first()).gates;
    const windowId = randomUUID();
    const insertRow = async (name, gates) => {
      const [created] = await knex('lawn_protocol_products').insert({
        id: randomUUID(), lawn_protocol_window_id: windowId, product_name: name, role: 'spot', application_mode: 'spray',
        rate_per_1000: 1, rate_unit: 'oz', gates: JSON.stringify(gates),
      }).returning('id');
      return created.id;
    };
    const recognition = await insertRow('Recognition Post Emergent Herbicide', { bermudaRemoval: true, noRainOrIrrigationHours: 3, noMowDaysBeforeAfter: 2, tankMixWith: 'Fusilade II' });
    const edited = await insertRow('Fusilade II Post Emergent Liquid Herbicide', { bermudaRemoval: true, noRainOrIrrigationHours: 12 });
    const other = await insertRow('Celsius WG', { noRainOrIrrigationHours: 3 });
    await followup.up(knex);
    await followup.up(knex);
    expect(await gate(recognition)).toEqual({ bermudaRemoval: true, noRainOrIrrigationHours: 24, noMowDaysBeforeAfter: 2, tankMixWith: 'Fusilade II' });
    expect((await gate(edited)).noRainOrIrrigationHours).toBe(12); // an edited value is not the seeded 3: left alone
    expect((await gate(other)).noRainOrIrrigationHours).toBe(3); // not a bermuda-removal row
    const audits = await knex('audit_log').where({ action: 'migration:20261009180000_watering_rule_herbicide_24h_hold_followup:field_gate' });
    expect(audits).toHaveLength(1);
    expect(audits[0].resource_id).toBe(recognition);
  });

  test('down is a documented no-op', async () => {
    await followup.down(knex);
  });
});
