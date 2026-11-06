const SKIP = !process.env.DATABASE_URL;
// CI's DB-gated pass runs this against PostgreSQL. Each test builds gsc_queries and gsc_pages in a
// unique schema, shaped like production (the domain-scoped unique index plus the legacy two-column
// one), and the suite drops the schema afterwards.
const knex = require('knex');
const { randomUUID } = require('crypto');

const migration = require('../models/migrations/20261106110000_drop_gsc_legacy_date_uniques');

const HUB = 'wavespestcontrol.com';
const SPOKE = 'spoke-example.com';
const DATE = '2026-11-03';

jest.setTimeout(30000);
(SKIP ? describe.skip : describe)('drop legacy GSC (key, date) unique indexes on PostgreSQL', () => {
  let database;
  const schema = `gsc_legacy_uniq_${randomUUID().replaceAll('-', '')}`;

  async function buildTables({ legacyAsConstraint = false } = {}) {
    await database.raw('DROP TABLE IF EXISTS gsc_queries, gsc_pages');
    await database.raw(`CREATE TABLE gsc_queries (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      query text NOT NULL, date date NOT NULL, domain varchar(200), clicks integer DEFAULT 0)`);
    await database.raw(`CREATE TABLE gsc_pages (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      page_url text NOT NULL, date date NOT NULL, domain varchar(200), clicks integer DEFAULT 0)`);
    await database.raw('CREATE UNIQUE INDEX gsc_queries_query_date_domain_unique ON gsc_queries (query, date, domain)');
    await database.raw('CREATE UNIQUE INDEX gsc_pages_page_url_date_domain_unique ON gsc_pages (page_url, date, domain)');
    if (legacyAsConstraint) {
      await database.raw('ALTER TABLE gsc_queries ADD CONSTRAINT gsc_queries_query_date_unique UNIQUE (query, date)');
      await database.raw('ALTER TABLE gsc_pages ADD CONSTRAINT gsc_pages_page_url_date_unique UNIQUE (page_url, date)');
    } else {
      await database.raw('CREATE UNIQUE INDEX gsc_queries_query_date_unique ON gsc_queries (query, date)');
      await database.raw('CREATE UNIQUE INDEX gsc_pages_page_url_date_unique ON gsc_pages (page_url, date)');
    }
  }

  // The same upsert shape the sync uses (search-console-v2.js syncQueries / syncPages).
  const upsertQuery = (domain, clicks = 1) => database('gsc_queries')
    .insert({ query: 'pest control near me', date: DATE, domain, clicks })
    .onConflict(['query', 'date', 'domain'])
    .merge();
  const upsertPage = (domain, clicks = 1) => database('gsc_pages')
    .insert({ page_url: 'https://example.com/', date: DATE, domain, clicks })
    .onConflict(['page_url', 'date', 'domain'])
    .merge();

  const indexNames = async () => (await database.raw(
    'SELECT indexname FROM pg_indexes WHERE schemaname = ? ORDER BY indexname',
    [schema],
  )).rows.map((r) => r.indexname);

  beforeAll(async () => {
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 3 } });
    await database.raw('CREATE SCHEMA ??', [schema]);
  });
  afterAll(async () => {
    await database.raw('DROP SCHEMA ?? CASCADE', [schema]);
    await database.destroy();
  });

  test('before the migration, the hub upsert fails when a spoke stored the same query and date', async () => {
    await buildTables();
    await upsertQuery(SPOKE);
    await expect(upsertQuery(HUB)).rejects.toMatchObject({ code: '23505', constraint: 'gsc_queries_query_date_unique' });
    await upsertPage(SPOKE);
    await expect(upsertPage(HUB)).rejects.toMatchObject({ code: '23505', constraint: 'gsc_pages_page_url_date_unique' });
  });

  test('up drops the legacy indexes and keeps the domain-scoped ones', async () => {
    await buildTables();
    await migration.up(database);
    const names = await indexNames();
    expect(names).not.toContain('gsc_queries_query_date_unique');
    expect(names).not.toContain('gsc_pages_page_url_date_unique');
    expect(names).toContain('gsc_queries_query_date_domain_unique');
    expect(names).toContain('gsc_pages_page_url_date_domain_unique');
  });

  test('after up, hub and spoke each keep a row for one query and date, and a repeat merges', async () => {
    await buildTables();
    await migration.up(database);
    await upsertQuery(SPOKE, 2);
    await upsertQuery(HUB, 5);
    await upsertQuery(HUB, 7);
    const rows = await database('gsc_queries').select('domain', 'clicks').orderBy('domain');
    expect(rows).toEqual([{ domain: SPOKE, clicks: 2 }, { domain: HUB, clicks: 7 }]);

    await upsertPage(HUB, 3);
    await upsertPage(SPOKE, 4);
    await upsertPage(SPOKE, 6);
    const pages = await database('gsc_pages').select('domain', 'clicks').orderBy('domain');
    expect(pages).toEqual([{ domain: SPOKE, clicks: 6 }, { domain: HUB, clicks: 3 }]);
  });

  test('the domain-scoped index still refuses a same-domain duplicate after up', async () => {
    await buildTables();
    await migration.up(database);
    await database('gsc_queries').insert({ query: 'termite treatment', date: DATE, domain: HUB });
    await expect(database('gsc_queries').insert({ query: 'termite treatment', date: DATE, domain: HUB }))
      .rejects.toMatchObject({ code: '23505', constraint: 'gsc_queries_query_date_domain_unique' });
  });

  test('up also drops a legacy unique that a constraint owns', async () => {
    await buildTables({ legacyAsConstraint: true });
    await migration.up(database);
    const names = await indexNames();
    expect(names).not.toContain('gsc_queries_query_date_unique');
    expect(names).not.toContain('gsc_pages_page_url_date_unique');
    await upsertQuery(SPOKE);
    await expect(upsertQuery(HUB)).resolves.toBeTruthy();
  });

  test('up builds a missing domain-scoped index before it drops the legacy one', async () => {
    await buildTables();
    await database.raw('DROP INDEX gsc_queries_query_date_domain_unique');
    await migration.up(database);
    const names = await indexNames();
    expect(names).toContain('gsc_queries_query_date_domain_unique');
    expect(names).not.toContain('gsc_queries_query_date_unique');
  });

  test('up is safe to run twice, and down leaves the legacy indexes dropped', async () => {
    await buildTables();
    await migration.up(database);
    await migration.up(database);
    await migration.down(database);
    const names = await indexNames();
    expect(names).not.toContain('gsc_queries_query_date_unique');
    expect(names).toContain('gsc_queries_query_date_domain_unique');
  });

  test('up skips a table that does not exist', async () => {
    await database.raw('DROP TABLE IF EXISTS gsc_queries, gsc_pages');
    await expect(migration.up(database)).resolves.toBeUndefined();
  });
});
