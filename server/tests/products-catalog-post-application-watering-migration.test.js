// DB-backed (self-skips without DATABASE_URL, like the other Postgres suites).
// Runs the real migration against an owned clone of products_catalog.
const SKIP = !process.env.DATABASE_URL;
const describeDb = SKIP ? describe.skip : describe;
const { randomUUID } = require('crypto');
const knexFactory = require('knex');
const migration = require('../models/migrations/20260930000001_products_catalog_post_application_watering');
const verifiedAtFix = require('../models/migrations/20260930000002_watering_rule_seed_verified_at');
const correction = require('../models/migrations/20260930000003_watering_rule_celsius_until_dry_audit');

describeDb('products_catalog.post_application_watering migration', () => {
  let knex;
  let schema;

  beforeEach(async () => {
    schema = `watering_rule_${randomUUID().replace(/-/g, '')}`;
    knex = knexFactory({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 4 } });
    await knex.raw('CREATE SCHEMA ??', [schema]);
    await knex.raw('CREATE TABLE ??.products_catalog (LIKE public.products_catalog INCLUDING ALL)', [schema]);
    // CI may already have run the real migration: start the owned copy before it.
    await knex.raw('ALTER TABLE products_catalog DROP CONSTRAINT IF EXISTS products_catalog_post_application_watering_mode_check');
    await knex.raw('ALTER TABLE products_catalog DROP COLUMN IF EXISTS post_application_watering');
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

  test('adds the column and a CHECK that pins mode (a missing mode or non-object fails)', async () => {
    await migration.up(knex);
    expect(await knex.schema.hasColumn('products_catalog', 'post_application_watering')).toBe(true);
    const id = await insert({ name: 'Plain Product', category: 'fertilizer' });
    const set = (value) => knex('products_catalog').where({ id }).update({ post_application_watering: value });
    await expect(set(JSON.stringify({ mode: 'hold', hold_hours: 24 }))).resolves.toBe(1);
    await expect(set(JSON.stringify({ mode: 'water_in' }))).resolves.toBe(1);
    await expect(set(JSON.stringify({ mode: 'none' }))).resolves.toBe(1);
    await expect(set(null)).resolves.toBe(1);
    await expect(set(JSON.stringify({ mode: 'sometimes' }))).rejects.toThrow(/post_application_watering_mode_check/);
    await expect(set(JSON.stringify({ hold_hours: 24 }))).rejects.toThrow(/post_application_watering_mode_check/);
    await expect(set(JSON.stringify([]))).rejects.toThrow(/post_application_watering_mode_check/);
    await expect(set(JSON.stringify('hold'))).rejects.toThrow(/post_application_watering_mode_check/);
  });

  test('seeds the label-read products by EPA number, else by name, and skips absent products', async () => {
    const drive = await insert({ name: 'Drive XLR8', epa_reg_number: '7969-272', irrigation_notes: 'For best results, do not water or irrigate for 24 hours after application.' });
    const threeWay = await insert({ name: 'LESCO Three-Way Selective Herbicide', epa_reg_number: '10404-43', irrigation_notes: 'Delay irrigation for 24 hours after application; do not apply if rain is expected within 4 hours.' });
    const celsius = await insert({ name: 'Celsius WG', epa_reg_number: '432-1507' });
    const sedge = await insert({ name: 'Sedgehammer Plus', epa_reg_number: '81880-24' });
    const arena = await insert({ name: 'Arena 50 WDG', epa_reg_number: '59639-152' });
    const talak = await insert({ name: 'Atticus Talak 7.9 F', epa_reg_number: null }); // name fallback
    const artavia = await insert({ name: 'Artavia 2 SC (Azoxy)', epa_reg_number: null }); // name fallback
    const other = await insert({ name: 'K-Flow 0-0-25', category: 'fertilizer' });
    await migration.up(knex);

    expect(await rule(drive)).toMatchObject({
      mode: 'hold', hold_hours: 24, source: 'label', verified_by: 'label-check-2026-09-29',
      label_note: 'For best results, do not water or irrigate for 24 hours after application.',
    });
    expect((await rule(threeWay)).label_note).toMatch(/^Delay irrigation for 24 hours/);
    expect(await rule(celsius)).toMatchObject({ mode: 'hold', hold_hours: 6, source: 'label', label_note: 'Do not irrigate until the spray has dried.' });
    expect(await rule(sedge)).toMatchObject({ mode: 'hold', hold_hours: 48, source: 'label' });
    expect(await rule(arena)).toMatchObject({ mode: 'water_in', water_in_inches: 0.25, water_in_by_hours: 24, source: 'label' });
    expect(await rule(talak)).toMatchObject({ mode: 'hold', hold_hours: 24, source: 'label' });
    expect(await rule(artavia)).toMatchObject({ mode: 'hold', hold_hours: 48, source: 'label' });
    expect(Object.keys(await rule(celsius))).not.toContain('mow_hold_days');
    expect(Date.parse((await rule(celsius)).verified_at)).not.toBeNaN();
    expect(await rule(other)).toBeNull();
  });

  test('fill-only-empty: an existing rule is never overwritten, and re-running changes nothing', async () => {
    const owned = { mode: 'none', source: 'owner', label_note: 'owner edit' };
    const celsius = await insert({ name: 'Celsius WG', epa_reg_number: '432-1507' });
    await migration.up(knex);
    const first = await rule(celsius);
    // Owner replaces the seeded rule, then the migration runs again.
    await knex('products_catalog').where({ id: celsius }).update({ post_application_watering: JSON.stringify(owned) });
    await migration.up(knex);
    expect(await rule(celsius)).toEqual(owned);
    expect(first.mode).toBe('hold');

  });

  test('down drops the constraint and the column', async () => {
    await migration.up(knex);
    await migration.down(knex);
    expect(await knex.schema.hasColumn('products_catalog', 'post_application_watering')).toBe(false);
    await migration.down(knex); // idempotent
  });
});

describeDb('20260930000003 Celsius until-dry correction + audit', () => {
  let knex;
  let schema;
  beforeEach(async () => {
    schema = `watering_fix_${randomUUID().replace(/-/g, '')}`;
    knex = knexFactory({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 4 } });
    await knex.raw('CREATE SCHEMA ??', [schema]);
    await knex.raw('CREATE TABLE ??.products_catalog (LIKE public.products_catalog INCLUDING ALL)', [schema]);
    await knex.raw('ALTER TABLE products_catalog DROP CONSTRAINT IF EXISTS products_catalog_post_application_watering_mode_check');
    await knex.raw('ALTER TABLE products_catalog DROP COLUMN IF EXISTS post_application_watering');
    await migration.up(knex);
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

  test('rewrites only the seeded 6-hour Celsius rule to an until-dry condition, idempotently', async () => {
    const celsius = await insert({ name: 'Celsius WG', epa_reg_number: '432-1507' });
    const owned = await insert({ name: 'Celsius WG (owner)', epa_reg_number: '432-1507' });
    const talak = await insert({ name: 'Atticus Talak 7.9 F' });
    await knex('products_catalog').where({ id: celsius }).update({ post_application_watering: null });
    await knex('products_catalog').where({ id: owned }).update({ post_application_watering: JSON.stringify({ mode: 'hold', hold_hours: 8, source: 'owner', verified_by: 'label-check-2026-09-29' }) });
    await migration.up(knex); // re-seed the cleared Celsius row (fill-only-empty)
    await verifiedAtFix.up(knex); // production order: 000001 → 000002 → 000003
    expect(await rule(celsius)).toMatchObject({ mode: 'hold', hold_hours: 6, source: 'label' });
    await correction.up(knex);
    expect(await rule(celsius)).toMatchObject({ mode: 'hold', hold_until: 'dry', hold_hours: null, source: 'label', label_note: 'Do not irrigate until the spray has dried.' });
    expect(await rule(owned)).toMatchObject({ mode: 'hold', hold_hours: 8, source: 'owner' }); // owner edit untouched
    expect(await rule(talak)).toMatchObject({ mode: 'hold', hold_hours: 24, source: 'label' }); // other seeds untouched
    const once = await rule(celsius);
    await correction.up(knex);
    expect(await rule(celsius)).toEqual(once);
  });
});
