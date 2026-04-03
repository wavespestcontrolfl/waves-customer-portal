exports.up = async function (knex) {
  // SMS sequences table for multi-step workflows
  await knex.schema.createTable('sms_sequences', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
    t.string('sequence_type', 30).notNullable(); // cancellation_save, lead_nurture, renewal_reminder, upsell
    t.integer('step').defaultTo(1);
    t.enu('status', ['active', 'completed', 'cancelled', 'paused']).defaultTo('active');
    t.timestamp('next_send_at');
    t.jsonb('metadata');
    t.timestamps(true, true);
    t.index('customer_id');
    t.index(['sequence_type', 'status']);
  });

  // Renewal dates on customers
  await knex.schema.alterTable('customers', (t) => {
    t.date('termite_renewal_date');
    t.date('mosquito_season_start');
    t.date('waveguard_renewal_date');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('sms_sequences');
  await knex.schema.alterTable('customers', (t) => {
    t.dropColumn('termite_renewal_date');
    t.dropColumn('mosquito_season_start');
    t.dropColumn('waveguard_renewal_date');
  });
};
