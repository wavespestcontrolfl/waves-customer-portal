/**
 * Drop two unique indexes that stop the daily Search Console sync from storing one query (or page)
 * for two network domains on the same date.
 *
 * gsc_queries and gsc_pages hold one row per (query | page_url, date, domain). The 6 AM sync
 * (services/seo/search-console-v2.js syncQueries / syncPages) upserts on that key, and
 * 20260511000001_fix_gsc_domain_uniques built the matching unique indexes. Production also holds
 * gsc_queries_query_date_unique (query, date) and gsc_pages_page_url_date_unique (page_url, date),
 * which no migration in this repo creates. They leave out the domain. So when a spoke site has
 * stored a query for a date, the hub's upsert of the same query on that date hits the two-column
 * index (ON CONFLICT names only the three-column one), and the whole hub sync fails with
 * "duplicate key value violates unique constraint gsc_queries_query_date_unique". A spoke whose
 * query the hub stored first fails the same way.
 *
 * up: make sure each domain-scoped unique index exists (a no-op where 20260511000001 ran; while the
 * two-column index is in place no (query, date, domain) duplicate can exist), then drop the legacy
 * index: as a constraint first (Postgres refuses to drop an index a constraint owns), then as a
 * plain index. Safe to run twice.
 *
 * down: does nothing. A (query, date) unique index cannot be rebuilt once two domains share a query
 * on a date, and that is the data this migration exists to allow.
 */
const TABLES = [
  {
    table: 'gsc_queries',
    keyColumn: 'query',
    domainUnique: 'gsc_queries_query_date_domain_unique',
    legacyUnique: 'gsc_queries_query_date_unique',
  },
  {
    table: 'gsc_pages',
    keyColumn: 'page_url',
    domainUnique: 'gsc_pages_page_url_date_domain_unique',
    legacyUnique: 'gsc_pages_page_url_date_unique',
  },
];

exports.up = async function up(knex) {
  for (const { table, keyColumn, domainUnique, legacyUnique } of TABLES) {
    if (!(await knex.schema.hasTable(table))) continue;
    if (!(await knex.schema.hasColumn(table, 'domain'))) continue;
    await knex.raw('CREATE UNIQUE INDEX IF NOT EXISTS ?? ON ?? (??, date, domain)', [domainUnique, table, keyColumn]);
    await knex.raw('ALTER TABLE ?? DROP CONSTRAINT IF EXISTS ??', [table, legacyUnique]);
    await knex.raw('DROP INDEX IF EXISTS ??', [legacyUnique]);
  }
};

exports.down = async function down() {
  // Intentionally empty: see the header.
};
