exports.up = async function (knex) {
  await knex.schema.createTable('sms_log', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('customer_id').references('id').inTable('customers');
    t.enu('direction', ['outbound', 'inbound']).notNullable();
    t.string('from_phone', 20).notNullable();
    t.string('to_phone', 20).notNullable();
    t.text('message_body');
    t.string('twilio_sid', 50);
    t.string('status', 20).defaultTo('sent');
    t.string('message_type', 30); // manual, reminder, estimate, review, completion, billing, campaign, en_route
    t.uuid('admin_user_id').references('id').inTable('technicians');
    t.jsonb('metadata');
    t.timestamps(true, true);

    t.index('customer_id');
    t.index('direction');
    t.index('message_type');
    t.index('created_at');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('sms_log');
};
