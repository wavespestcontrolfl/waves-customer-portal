/**
 * The admin_usage_events reload columns (20261120213000) on PostgreSQL: both
 * are nullable, they take the values POST /api/admin/usage/track writes, and
 * the migration runs twice either way, its down taking both columns away.
 *
 * Self-skips without DATABASE_URL. It runs in a schema of its own, so it
 * needs no migrated database.
 */
const SKIP = !process.env.DATABASE_URL;
const knex = require('knex');
const { randomUUID } = require('crypto');
const createTable = require('../models/migrations/20260723000001_admin_usage_events');
const addColumns = require('../models/migrations/20261120213000_admin_usage_reload_columns');

jest.setTimeout(60000);

(SKIP ? describe.skip : describe)('admin_usage_events reload columns on PostgreSQL', () => {
  const schema = `usage_reload_${randomUUID().replaceAll('-', '')}`;
  const TECH = randomUUID();
  let database;

  beforeAll(async () => {
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema, 'public'], pool: { min: 0, max: 2 } });
    await database.raw('CREATE SCHEMA ??', [schema]);
    await database.raw('CREATE TABLE ??.technicians (id uuid PRIMARY KEY)', [schema]);
    await database('technicians').insert({ id: TECH });
    await createTable.up(database);
    await addColumns.up(database);
  });
  afterAll(async () => {
    if (!database) return;
    await database.raw('DROP SCHEMA ?? CASCADE', [schema]).catch(() => {});
    await database.destroy();
  });

  const view = (fields) => ({ technician_id: TECH, page_key: 'pipeline', path: '/admin/pipeline', ...fields });

  test('a page view stores the tab fields, a view without them keeps both null, and a name has 32 characters at most', async () => {
    await database('admin_usage_events').insert([
      view({ stale_build: true, reload_hold: 'card-payment' }),
      view({ page_key: 'dashboard', path: '/admin/dashboard' }),
    ]);
    const rows = await database('admin_usage_events').select('page_key', 'stale_build', 'reload_hold').orderBy('page_key');
    expect(rows).toEqual([
      { page_key: 'dashboard', stale_build: null, reload_hold: null },
      { page_key: 'pipeline', stale_build: true, reload_hold: 'card-payment' },
    ]);
    await expect(database('admin_usage_events').insert(view({ reload_hold: 'x'.repeat(33) }))).rejects.toThrow(/too long/);
  });

  test('the migration runs twice either way, and its down takes both columns away', async () => {
    await addColumns.up(database);
    await addColumns.down(database);
    expect(await database.schema.hasColumn('admin_usage_events', 'stale_build')).toBe(false);
    expect(await database.schema.hasColumn('admin_usage_events', 'reload_hold')).toBe(false);
    await addColumns.down(database);
    await addColumns.up(database);
    const info = await database('admin_usage_events').columnInfo();
    expect(info.stale_build).toMatchObject({ type: 'boolean', nullable: true });
    expect(info.reload_hold).toMatchObject({ type: 'character varying', maxLength: 32, nullable: true });
  });
});
