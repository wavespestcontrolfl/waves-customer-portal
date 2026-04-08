/**
 * Add domain column to GSC tables for multi-site SEO tracking.
 * Also adds target_domain to blog_posts for multi-site publishing.
 */
exports.up = async function (knex) {
  // Add domain to gsc_queries
  if (await knex.schema.hasTable('gsc_queries')) {
    const hasCol = await knex.schema.hasColumn('gsc_queries', 'domain');
    if (!hasCol) {
      await knex.schema.alterTable('gsc_queries', (t) => {
        t.string('domain', 200);
        t.index(['domain', 'date']);
      });
      // Backfill existing rows as wavespestcontrol.com
      await knex('gsc_queries').whereNull('domain').update({ domain: 'wavespestcontrol.com' });
    }
  }

  // Add domain to gsc_pages
  if (await knex.schema.hasTable('gsc_pages')) {
    const hasCol = await knex.schema.hasColumn('gsc_pages', 'domain');
    if (!hasCol) {
      await knex.schema.alterTable('gsc_pages', (t) => {
        t.string('domain', 200);
        t.index(['domain', 'date']);
      });
      await knex('gsc_pages').whereNull('domain').update({ domain: 'wavespestcontrol.com' });
    }
  }

  // Add domain to gsc_performance_daily
  if (await knex.schema.hasTable('gsc_performance_daily')) {
    const hasCol = await knex.schema.hasColumn('gsc_performance_daily', 'domain');
    if (!hasCol) {
      await knex.schema.alterTable('gsc_performance_daily', (t) => {
        t.string('domain', 200);
        t.index(['domain', 'date']);
      });
      await knex('gsc_performance_daily').whereNull('domain').update({ domain: 'wavespestcontrol.com' });
    }
  }

  // Add target_domain and target_site_id to blog_posts for multi-site publishing
  if (await knex.schema.hasTable('blog_posts')) {
    const hasDomain = await knex.schema.hasColumn('blog_posts', 'target_domain');
    if (!hasDomain) {
      await knex.schema.alterTable('blog_posts', (t) => {
        t.string('target_domain', 200); // which site this post is for
        t.uuid('target_site_id'); // FK to wordpress_sites
        t.index('target_domain');
      });
      // Backfill existing posts as wavespestcontrol.com
      await knex('blog_posts').whereNull('target_domain').update({ target_domain: 'wavespestcontrol.com' });
    }
  }

  // Add domain to seo_audit_runs if exists
  if (await knex.schema.hasTable('seo_audit_runs')) {
    const hasCol = await knex.schema.hasColumn('seo_audit_runs', 'domain');
    if (!hasCol) {
      await knex.schema.alterTable('seo_audit_runs', (t) => {
        t.string('domain', 200);
      });
      await knex('seo_audit_runs').whereNull('domain').update({ domain: 'wavespestcontrol.com' });
    }
  }

  // Add domain to seo_audit_pages if exists
  if (await knex.schema.hasTable('seo_audit_pages')) {
    const hasCol = await knex.schema.hasColumn('seo_audit_pages', 'domain');
    if (!hasCol) {
      await knex.schema.alterTable('seo_audit_pages', (t) => {
        t.string('domain', 200);
        t.index('domain');
      });
      await knex('seo_audit_pages').whereNull('domain').update({ domain: 'wavespestcontrol.com' });
    }
  }

  // Add domain to seo_rankings/seo_keywords if exists
  if (await knex.schema.hasTable('seo_keywords')) {
    const hasCol = await knex.schema.hasColumn('seo_keywords', 'target_domain');
    if (!hasCol) {
      await knex.schema.alterTable('seo_keywords', (t) => {
        t.string('target_domain', 200);
        t.index('target_domain');
      });
      await knex('seo_keywords').whereNull('target_domain').update({ target_domain: 'wavespestcontrol.com' });
    }
  }

  console.log('[migration] Added domain columns to GSC, blog_posts, and SEO audit tables');
};

exports.down = async function (knex) {
  const tables = [
    { table: 'gsc_queries', col: 'domain' },
    { table: 'gsc_pages', col: 'domain' },
    { table: 'gsc_performance_daily', col: 'domain' },
    { table: 'blog_posts', col: 'target_domain' },
    { table: 'blog_posts', col: 'target_site_id' },
    { table: 'seo_audit_runs', col: 'domain' },
    { table: 'seo_audit_pages', col: 'domain' },
    { table: 'seo_keywords', col: 'target_domain' },
  ];

  for (const { table, col } of tables) {
    if (await knex.schema.hasTable(table)) {
      const hasCol = await knex.schema.hasColumn(table, col);
      if (hasCol) {
        await knex.schema.alterTable(table, (t) => t.dropColumn(col));
      }
    }
  }
};
