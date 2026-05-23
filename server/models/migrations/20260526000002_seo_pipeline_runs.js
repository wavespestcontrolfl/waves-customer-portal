exports.up = async function (knex) {
  await knex.schema.createTable('seo_pipeline_runs', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('idempotency_key', 120).notNullable().unique();
    t.string('domain', 200).notNullable();
    t.string('status', 20).notNullable().defaultTo('running');
    t.string('requested_by', 120);
    t.timestamp('started_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('completed_at');
    t.jsonb('result').defaultTo(knex.raw("'{}'::jsonb"));
    t.text('error');
    t.timestamps(true, true);

    t.index('domain');
    t.index('status');
    t.index('started_at');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('seo_pipeline_runs');
};
