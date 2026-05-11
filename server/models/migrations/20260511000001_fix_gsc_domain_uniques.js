exports.up = async function (knex) {
  const ensureDomainColumn = async (table) => {
    if (!(await knex.schema.hasTable(table))) return false;
    if (!(await knex.schema.hasColumn(table, 'domain'))) {
      await knex.schema.alterTable(table, (t) => {
        t.string('domain', 200);
        t.index(['domain', 'date']);
      });
    }
    await knex(table).whereNull('domain').update({ domain: 'wavespestcontrol.com' });
    return true;
  };

  const hasQueries = await ensureDomainColumn('gsc_queries');
  const hasPages = await ensureDomainColumn('gsc_pages');
  const hasDaily = await ensureDomainColumn('gsc_performance_daily');

  if (hasQueries) {
    await knex.raw(`
      DELETE FROM gsc_queries a
      USING gsc_queries b
      WHERE a.ctid < b.ctid
        AND a.query = b.query
        AND a.date = b.date
        AND a.domain = b.domain
    `);
    await knex.raw(`
      CREATE UNIQUE INDEX IF NOT EXISTS gsc_queries_query_date_domain_unique
      ON gsc_queries (query, date, domain)
    `);
  }

  if (hasPages) {
    await knex.raw(`
      DELETE FROM gsc_pages a
      USING gsc_pages b
      WHERE a.ctid < b.ctid
        AND a.page_url = b.page_url
        AND a.date = b.date
        AND a.domain = b.domain
    `);
    await knex.raw(`
      CREATE UNIQUE INDEX IF NOT EXISTS gsc_pages_page_url_date_domain_unique
      ON gsc_pages (page_url, date, domain)
    `);
  }

  if (hasDaily) {
    await knex.raw('ALTER TABLE gsc_performance_daily DROP CONSTRAINT IF EXISTS gsc_performance_daily_date_device_unique');
    await knex.raw('DROP INDEX IF EXISTS gsc_performance_daily_date_device_unique');
    await knex.raw(`
      DELETE FROM gsc_performance_daily a
      USING gsc_performance_daily b
      WHERE a.ctid < b.ctid
        AND a.date = b.date
        AND COALESCE(a.device, '') = COALESCE(b.device, '')
        AND a.domain = b.domain
    `);
    await knex.raw(`
      CREATE UNIQUE INDEX IF NOT EXISTS gsc_performance_daily_date_device_domain_unique
      ON gsc_performance_daily (date, device, domain)
    `);
  }
};

exports.down = async function (knex) {
  await knex.raw('DROP INDEX IF EXISTS gsc_performance_daily_date_device_domain_unique');
  await knex.raw('DROP INDEX IF EXISTS gsc_pages_page_url_date_domain_unique');
  await knex.raw('DROP INDEX IF EXISTS gsc_queries_query_date_domain_unique');
};
