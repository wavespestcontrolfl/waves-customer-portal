/**
 * The bar's visit-history readers name only columns that exist (gap audit
 * 11-23). service_records lost `notes`, `products_used` and `technician_name`
 * long ago; the readers kept reading them, so every history answer said "no
 * products logged" and get_stop_details threw "column does not exist". The
 * unit suites mock the database and could not see it. This suite checks each
 * exported column list against the migrated schema.
 */
const SKIP = !process.env.DATABASE_URL;
const knex = require('knex');
const {
  SERVICE_RECORD_COLUMNS, SERVICE_PRODUCT_COLUMNS, TECHNICIAN_COLUMNS,
} = require('../services/intelligence-bar/service-record-facts');

(SKIP ? describe.skip : describe)('service-record facts columns on PostgreSQL', () => {
  let database;
  beforeAll(() => {
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 1 } });
  });
  afterAll(async () => { await database.destroy(); });

  const columnsOf = async (table) => (await database('information_schema.columns')
    .where({ table_schema: 'public', table_name: table }).select('column_name')).map((r) => r.column_name);

  test.each([
    ['service_records', SERVICE_RECORD_COLUMNS],
    ['service_products', [...SERVICE_PRODUCT_COLUMNS, 'created_at']],
    ['technicians', TECHNICIAN_COLUMNS],
  ])('every column the readers select exists on %s', async (table, wanted) => {
    const have = await columnsOf(table);
    expect(wanted.filter((c) => !have.includes(c))).toEqual([]);
  });
});
