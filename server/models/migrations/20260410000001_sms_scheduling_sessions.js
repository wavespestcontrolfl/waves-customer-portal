/**
 * SMS Scheduling Sessions — tracks multi-turn conversational scheduling via SMS
 */
exports.up = async function (knex) {
  if (await knex.schema.hasTable('sms_scheduling_sessions')) return;
  await knex.schema.createTable('sms_scheduling_sessions', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('customer_id').notNullable();
    t.string('state', 30).notNullable().defaultTo('idle');
    t.jsonb('offered_slots');
    t.jsonb('pending_slot');
    t.string('booked_date', 10);
    t.string('booked_time', 5);
    t.string('confirmation_code', 20);
    t.timestamps(true, true);
    t.index(['customer_id', 'state']);
    t.index('updated_at');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('sms_scheduling_sessions');
};
