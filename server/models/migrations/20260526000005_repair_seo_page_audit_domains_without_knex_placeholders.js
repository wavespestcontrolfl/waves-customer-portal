function pageAuditDomainExpression() {
  return `
    nullif(
      split_part(
        regexp_replace(
          regexp_replace(
            regexp_replace(lower(trim(url)), '^https://', ''),
            '^http://',
            ''
          ),
          '^www[.]',
          ''
        ),
        '/',
        1
      ),
      ''
    )
  `;
}

exports.up = async function (knex) {
  const hasTable = await knex.schema.hasTable('seo_page_audits');
  if (!hasTable) return;

  const hasDomain = await knex.schema.hasColumn('seo_page_audits', 'domain');
  if (!hasDomain) {
    await knex.schema.alterTable('seo_page_audits', (t) => {
      t.string('domain', 200);
    });
  }

  await knex.raw(`
    UPDATE seo_page_audits
    SET domain = ${pageAuditDomainExpression()}
    WHERE url IS NOT NULL
      AND trim(url) <> ''
      AND (
        domain IS NULL
        OR trim(domain) = ''
        OR lower(trim(domain)) IN ('http:', 'https:')
        OR lower(trim(domain)) LIKE 'http:%'
        OR lower(trim(domain)) LIKE 'https:%'
        OR lower(trim(domain)) !~ '^[a-z0-9.-]+$'
      )
  `);

  await knex.raw(`
    UPDATE seo_page_audits
    SET domain = regexp_replace(lower(trim(domain)), '^www[.]', '')
    WHERE domain IS NOT NULL
      AND domain <> regexp_replace(lower(trim(domain)), '^www[.]', '')
  `);

  await knex.raw('CREATE INDEX IF NOT EXISTS seo_page_audits_domain_index ON seo_page_audits (domain)');
};

exports.down = async function () {
  // Data repair only. Reverting would restore malformed domain values.
};

exports._internals = { pageAuditDomainExpression };
