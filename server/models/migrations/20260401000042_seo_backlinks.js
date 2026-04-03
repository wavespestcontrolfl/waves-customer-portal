exports.up = async function (knex) {
  await knex.schema.createTable('seo_backlinks', t => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.text('source_url').notNullable();
    t.text('source_domain').notNullable();
    t.text('target_url').notNullable();
    t.text('anchor_text');
    t.integer('domain_rating');
    t.integer('toxicity_score').defaultTo(0);
    t.jsonb('toxicity_reasons');
    t.string('severity').defaultTo('watch'); // critical, warning, watch, clean
    t.string('status').defaultTo('active'); // active, disavowed, lost
    t.date('first_seen');
    t.date('last_checked');
    t.timestamps(true, true);
  });

  await knex.schema.createTable('seo_disavow_history', t => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.integer('domains_disavowed');
    t.integer('urls_disavowed');
    t.text('file_content');
    t.timestamps(true, true);
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('seo_disavow_history');
  await knex.schema.dropTableIfExists('seo_backlinks');
};
