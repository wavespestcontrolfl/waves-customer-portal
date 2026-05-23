exports.up = async function (knex) {
  await knex.schema.alterTable('seo_page_audits', (t) => {
    t.string('domain', 200);
    t.jsonb('internal_link_targets').defaultTo('[]');
    t.index('domain');
  });

  await knex.raw(`
    UPDATE seo_page_audits
    SET domain = regexp_replace(
      regexp_replace(lower(url), '^https?://(www\\.)?', ''),
      '/.*$',
      ''
    )
    WHERE domain IS NULL
  `);

  await knex.schema.createTable('seo_internal_link_graph', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.text('source_url').notNullable();
    t.text('target_url').notNullable();
    t.string('domain', 200);
    t.string('anchor_text', 300);
    t.timestamp('last_seen_at');
    t.timestamps(true, true);

    t.unique(['source_url', 'target_url']);
    t.index('target_url');
    t.index('domain');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('seo_internal_link_graph');
  await knex.schema.alterTable('seo_page_audits', (t) => {
    t.dropIndex('domain');
    t.dropColumn('domain');
    t.dropColumn('internal_link_targets');
  });
};
