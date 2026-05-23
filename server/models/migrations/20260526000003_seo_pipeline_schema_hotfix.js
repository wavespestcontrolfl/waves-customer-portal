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

  const hasAuditRunDomain = await knex.schema.hasColumn('seo_site_audit_runs', 'domain');
  if (!hasAuditRunDomain) {
    await knex.schema.alterTable('seo_site_audit_runs', (t) => {
      t.string('domain', 200);
    });
  }
  await knex('seo_site_audit_runs')
    .whereNull('domain')
    .update({ domain: 'wavespestcontrol.com' });
  await knex.raw('CREATE INDEX IF NOT EXISTS seo_site_audit_runs_domain_index ON seo_site_audit_runs (domain)');

  if (await knex.schema.hasTable('seo_pipeline_runs')) {
    await knex.raw('ALTER TABLE seo_pipeline_runs ALTER COLUMN status TYPE varchar(40)');
  }

  if (await knex.schema.hasTable('seo_actions')) {
    await knex.raw('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    await knex.raw(`
      WITH normalized AS (
        SELECT
          id,
          left(action_type, 60) || ':' || encode(digest(
            regexp_replace(
              regexp_replace(
                regexp_replace(
                  regexp_replace(lower(trim(url)), '\\?.*$', ''),
                  '#.*$',
                  ''
                ),
                '/$',
                ''
              ),
              '^https?://(www\\.)?',
              ''
            ),
            'sha256'
          ), 'hex') AS new_key,
          row_number() OVER (
            PARTITION BY left(action_type, 60) || ':' || encode(digest(
              regexp_replace(
                regexp_replace(
                  regexp_replace(
                    regexp_replace(lower(trim(url)), '\\?.*$', ''),
                    '#.*$',
                    ''
                  ),
                  '/$',
                  ''
                ),
                '^https?://(www\\.)?',
                ''
              ),
              'sha256'
            ), 'hex')
            ORDER BY created_at NULLS LAST, id
          ) AS normalized_rank
        FROM seo_actions
        WHERE dedupe_key = action_type || ':' || url
      )
      UPDATE seo_actions AS action
      SET dedupe_key = normalized.new_key
      FROM normalized
      WHERE action.id = normalized.id
        AND normalized.normalized_rank = 1
        AND NOT EXISTS (
          SELECT 1
          FROM seo_actions existing
          WHERE existing.dedupe_key = normalized.new_key
            AND existing.id <> action.id
        )
    `);
  }
};

exports.down = async function (knex) {
  await knex.raw('DROP INDEX IF EXISTS seo_site_audit_runs_domain_index');
  const hasAuditRunDomain = await knex.schema.hasColumn('seo_site_audit_runs', 'domain');
  if (hasAuditRunDomain) {
    await knex.schema.alterTable('seo_site_audit_runs', (t) => {
      t.dropColumn('domain');
    });
  }

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
