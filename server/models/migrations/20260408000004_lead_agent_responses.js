/**
 * Lead Response Agent tracking table.
 */
exports.up = async function (knex) {
  const exists = await knex.schema.hasTable('lead_agent_responses');
  if (exists) return;

  await knex.schema.createTable('lead_agent_responses', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('lead_id').references('id').inTable('leads');
    t.uuid('customer_id').references('id').inTable('customers');
    t.string('action_taken', 30); // auto_sent, queued_for_adam, existing_customer_routed
    t.text('response_message');
    t.integer('response_time_seconds');
    t.text('triage_summary');
    t.boolean('follow_up_scheduled').defaultTo(false);
    t.timestamp('created_at').defaultTo(knex.fn.now());

    t.index('lead_id');
    t.index('created_at');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('lead_agent_responses');
};
