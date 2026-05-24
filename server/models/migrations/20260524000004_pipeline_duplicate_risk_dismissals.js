exports.up = async function up(knex) {
  await knex.raw('CREATE EXTENSION IF NOT EXISTS pgcrypto');

  if (!(await knex.schema.hasTable('pipeline_duplicate_risk_dismissals'))) {
    await knex.schema.createTable('pipeline_duplicate_risk_dismissals', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('estimate_id').notNullable();
      t.uuid('lead_id').notNullable();
      t.uuid('dismissed_by');
      t.string('reason', 40).notNullable().defaultTo('not_same_customer');
      t.text('note');
      t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

      t.unique(['estimate_id', 'lead_id'], 'pipeline_duplicate_risk_dismissals_pair_unique');
      t.index(['dismissed_by'], 'pipeline_duplicate_risk_dismissals_dismissed_by_index');
      t.index(['created_at'], 'pipeline_duplicate_risk_dismissals_created_at_index');
    });

    await knex.raw(`
      ALTER TABLE pipeline_duplicate_risk_dismissals
        ADD CONSTRAINT pipeline_duplicate_risk_dismissals_reason_check
        CHECK (reason IN ('not_same_customer','bad_match','already_handled','other'))
    `);
  }
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('pipeline_duplicate_risk_dismissals');
};
