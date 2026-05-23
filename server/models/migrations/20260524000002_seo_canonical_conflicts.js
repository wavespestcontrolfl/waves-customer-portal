exports.up = async function (knex) {
  await knex.schema.createTable('seo_canonical_conflicts', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));

    t.text('spoke_url').notNullable();
    t.text('hub_url').notNullable();
    t.string('spoke_domain', 200).notNullable();
    t.string('hub_domain', 200).notNullable();

    t.text('user_declared_canonical_spoke');
    t.text('user_declared_canonical_hub');
    t.text('google_selected_canonical');

    t.decimal('body_similarity_pct', 5, 2);
    t.decimal('title_similarity_pct', 5, 2);
    t.decimal('query_overlap_pct', 5, 2);

    t.integer('internal_links_to_spoke').defaultTo(0);
    t.integer('internal_links_to_hub').defaultTo(0);

    t.text('recommended_fix');
    t.string('status', 20).notNullable().defaultTo('open');
    t.text('resolved_action');
    t.timestamp('resolved_at');

    t.timestamps(true, true);

    t.unique(['spoke_url', 'hub_url']);
    t.index('status');
    t.index('spoke_domain');
    t.index('hub_domain');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('seo_canonical_conflicts');
};
