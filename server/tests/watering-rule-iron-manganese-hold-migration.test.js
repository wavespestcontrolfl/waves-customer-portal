// 24-hour watering hold for LESCO Chelated Iron Plus and High Manganese Combo
// (owner 2026-10-03). The rule check runs everywhere; the migration itself is
// DB-backed (self-skips without DATABASE_URL, like the other Postgres suites)
// and runs against an owned clone of products_catalog.
const SKIP = !process.env.DATABASE_URL;
const describeDb = SKIP ? describe.skip : describe;
const { randomUUID } = require('crypto');
const knexFactory = require('knex');
const migration = require('../models/migrations/20261003110000_watering_rule_iron_manganese_hold');
const { validateRule, resolveWateringRule, deriveDefaultRule } = require('../services/service-report/lawn-watering-rule');

describe('the seeded iron / manganese rule', () => {
  test('is a valid label-sourced 24-hour hold with a pinned verification date', () => {
    const checked = validateRule(migration.RULE);
    expect(checked.errors).toEqual([]);
    expect(checked.rule).toMatchObject({
      mode: 'hold', hold_hours: 24, source: 'label',
      label_note: 'Avoid watering for 24 hours after application for optimal results.',
      verified_at: '2026-10-03T00:00:00.000Z', verified_by: 'label-check-2026-10-03',
    });
  });

  test('replaces the derived "no instruction" default for a liquid micronutrient spray', () => {
    const row = { name: 'LESCO Chelated Iron Plus 12-0-0', category: 'fertilizer', formulation: 'liquid' };
    expect(deriveDefaultRule(row)).toMatchObject({ mode: 'none', source: 'default' });
    expect(resolveWateringRule({ ...row, post_application_watering: migration.RULE })).toMatchObject({ mode: 'hold', hold_hours: 24, source: 'label' });
  });
});

describeDb('20261003110000 iron / manganese watering hold', () => {
  let knex;
  let schema;

  beforeEach(async () => {
    schema = `iron_hold_${randomUUID().replace(/-/g, '')}`;
    knex = knexFactory({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 4 } });
    await knex.raw('CREATE SCHEMA ??', [schema]);
    await knex.raw('CREATE TABLE ??.products_catalog (LIKE public.products_catalog INCLUDING ALL)', [schema]);
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

  test('seeds both products by name and leaves every other product alone', async () => {
    const iron = await insert({ name: 'LESCO Chelated Iron Plus 12-0-0', category: 'fertilizer' });
    const ironShort = await insert({ name: 'Chelated Iron Plus', category: 'fertilizer' });
    const manganese = await insert({ name: 'LESCO High Manganese Combo AM 1% Mg 5.75% S 3% Fe 4% Mn Chelated Micronutrient Liquid Fertilizer', category: 'fertilizer' });
    const otherMicros = await insert({ name: 'Chelated AM + Micros', category: 'fertilizer' });
    const potassium = await insert({ name: 'K-Flow 0-0-25', category: 'fertilizer' });
    await migration.up(knex);

    for (const id of [iron, ironShort, manganese]) {
      expect(await rule(id)).toEqual(migration.RULE);
    }
    expect(await rule(otherMicros)).toBeNull();
    expect(await rule(potassium)).toBeNull();
  });

  test('fill-only-empty: an existing rule is never overwritten, and re-running changes nothing', async () => {
    const owned = { mode: 'none', source: 'owner', label_note: 'owner edit' };
    const iron = await insert({ name: 'LESCO Chelated Iron Plus 12-0-0', post_application_watering: JSON.stringify(owned) });
    const manganese = await insert({ name: 'High Manganese Combo' });
    await migration.up(knex);
    await migration.up(knex);
    expect(await rule(iron)).toEqual(owned);
    expect(await rule(manganese)).toEqual(migration.RULE);
  });

  test('down clears only the rules this migration wrote', async () => {
    const iron = await insert({ name: 'LESCO Chelated Iron Plus 12-0-0' });
    const manganese = await insert({ name: 'High Manganese Combo' });
    const talak = await insert({
      name: 'Atticus Talak 7.9 F',
      post_application_watering: JSON.stringify({ mode: 'hold', hold_hours: 24, source: 'label', verified_by: 'label-check-2026-09-29' }),
    });
    await migration.up(knex);
    // The owner edits the manganese rule after the seed: down must keep it.
    // The edit keeps the note and the verified_by marker and changes only the hours.
    const edited = { ...migration.RULE, hold_hours: 12 };
    await knex('products_catalog').where({ id: manganese }).update({ post_application_watering: JSON.stringify(edited) });
    await migration.down(knex);
    expect(await rule(iron)).toBeNull();
    expect(await rule(manganese)).toEqual(edited);
    expect((await rule(talak)).verified_by).toBe('label-check-2026-09-29');
    await migration.down(knex); // idempotent
  });
});
