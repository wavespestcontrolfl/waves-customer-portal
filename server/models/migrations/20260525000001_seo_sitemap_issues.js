exports.up = async function (knex) {
  await knex.schema.createTable('seo_sitemap_issues', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('domain', 200).notNullable();
    t.text('sitemap_url').notNullable();
    t.text('page_url').notNullable();
    t.string('issue_type', 40).notNullable();
    t.string('severity', 10).notNullable().defaultTo('warning');
    t.text('detail');
    t.string('status', 20).notNullable().defaultTo('open');
    t.timestamp('resolved_at');
    t.timestamp('last_checked_at');
    t.timestamps(true, true);

    t.unique(['domain', 'page_url', 'issue_type']);
    t.index('domain');
    t.index('status');
    t.index('issue_type');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('seo_sitemap_issues');
};
