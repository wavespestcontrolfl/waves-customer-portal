/**
 * "Suggest a post" customer-name check on real PostgreSQL (GitHub Codex P1 on
 * 322faf591d): a phrase holding any customer's whole name (first and last, in
 * either order, punctuation read as a space) is refused, and so is any word of
 * the visit's own customer's name; a row missing either name never matches on
 * its other one. Isolated schema on a loopback waves_test database; never
 * reads the application's DATABASE_URL.
 */
const knex = require('knex');
const { randomUUID } = require('node:crypto');
const { namesACustomer } = require('../services/service-report/report-blog-suggestion');

const connection = process.env.REPORT_BLOG_SEARCH_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const schema = `suggest_names_${randomUUID().replaceAll('-', '')}`;
let admin;
let pg;

postgres('"Suggest a post" customer names on PostgreSQL', () => {
  const SUMMER = randomUUID();
  beforeAll(async () => {
    const url = new URL(connection);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.pathname !== '/waves_test') {
      throw new Error('Use an isolated loopback waves_test database');
    }
    admin = knex({ client: 'pg', connection });
    await admin.schema.createSchema(schema);
    pg = knex({ client: 'pg', connection: { connectionString: connection, application_name: schema }, searchPath: [schema], pool: { min: 0, max: 2 } });
    await pg.schema.createTable('customers', (t) => { t.uuid('id').primary(); t.text('first_name'); t.text('last_name'); });
    await pg('customers').insert([
      { id: SUMMER, first_name: 'Summer', last_name: 'Wood' },
      { id: randomUUID(), first_name: 'Mary Ann', last_name: 'Smith' },
      { id: randomUUID(), first_name: 'Pat', last_name: "O'Brien" },
      { id: randomUUID(), first_name: '', last_name: 'Green' },
      { id: randomUUID(), first_name: 'Rose', last_name: null },
    ]);
  });
  afterAll(async () => {
    if (pg) await pg.destroy();
    if (admin) { await admin.schema.dropSchemaIfExists(schema, true); await admin.destroy(); }
  });

  test.each([
    ['ants summer wood', true],
    ['wood summer ants', true],
    ['ants at mary ann smith', true],
    ['roaches pat o brien', true],
    ['summer ants', false],
    ['wood ants', false],
    ['green lawn', false],
    ['rose bush aphids', false],
    ['standing water', false],
  ])('%p names a customer: %p', async (phrase, named) => {
    expect(await namesACustomer(pg, phrase)).toBe(named);
  });

  test('any word of the visit\'s own customer\'s name', async () => {
    expect(await namesACustomer(pg, 'wood ants', SUMMER)).toBe(true);
    expect(await namesACustomer(pg, 'summer ants', SUMMER)).toBe(true);
    expect(await namesACustomer(pg, 'standing water', SUMMER)).toBe(false);
  });
});
