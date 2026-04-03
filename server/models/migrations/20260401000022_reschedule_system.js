exports.up = async function (knex) {
  await knex.schema.createTable('reschedule_log', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('scheduled_service_id').references('id').inTable('scheduled_services');
    t.uuid('customer_id').references('id').inTable('customers');
    t.date('original_date');
    t.date('new_date');
    t.string('reason_code', 30); // weather_rain, weather_wind, customer_request, customer_noshow, gate_locked, tech_callout, route_overload, partial_service, customer_sms, holiday
    t.string('initiated_by', 20); // weather_auto, customer_sms, customer_portal, tech, admin, system
    t.string('customer_response', 20); // option_1, option_2, call_requested, no_response, freeform
    t.text('customer_response_text');
    t.integer('response_time_minutes');
    t.string('original_window', 20);
    t.string('new_window', 20);
    t.timestamp('sms_sent_at');
    t.timestamp('sms_responded_at');
    t.boolean('escalated').defaultTo(false);
    t.text('notes');
    t.timestamp('created_at').defaultTo(knex.fn.now());

    t.index('customer_id');
    t.index('scheduled_service_id');
    t.index('reason_code');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('reschedule_log');
};
