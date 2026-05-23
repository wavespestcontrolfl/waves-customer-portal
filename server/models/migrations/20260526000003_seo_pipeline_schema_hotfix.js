exports.up = async function (knex) {
  const hasPageAuditDomain = await knex.schema.hasColumn('seo_page_audits', 'domain');
  if (!hasPageAuditDomain) {
    await knex.schema.alterTable('seo_page_audits', (t) => {
      t.string('domain', 200);
    });
  }

  await knex.raw(`
    UPDATE seo_page_audits
    SET domain = regexp_replace(
      regexp_replace(lower(url), '^https?://(www\\.)?', ''),
      '/.*$',
      ''
    )
    WHERE domain IS NULL
  `);
  await knex.raw('CREATE INDEX IF NOT EXISTS seo_page_audits_domain_index ON seo_page_audits (domain)');

  if (await knex.schema.hasTable('seo_pipeline_runs')) {
    await knex.raw('ALTER TABLE seo_pipeline_runs ALTER COLUMN status TYPE varchar(40)');
  }
};

exports.down = async function (knex) {
  await knex.raw('DROP INDEX IF EXISTS seo_page_audits_domain_index');

  const hasPageAuditDomain = await knex.schema.hasColumn('seo_page_audits', 'domain');
  if (hasPageAuditDomain) {
    await knex.schema.alterTable('seo_page_audits', (t) => {
      t.dropColumn('domain');
    });
  }

  if (await knex.schema.hasTable('seo_pipeline_runs')) {
    await knex.raw("UPDATE seo_pipeline_runs SET status = 'failed' WHERE length(status) > 20");
    await knex.raw('ALTER TABLE seo_pipeline_runs ALTER COLUMN status TYPE varchar(20)');
  }
};
