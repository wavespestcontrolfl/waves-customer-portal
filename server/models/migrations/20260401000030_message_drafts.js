exports.up = async function (knex) {
  await knex.schema.createTable('message_drafts', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('sms_log_id').references('id').inTable('sms_log');
    t.uuid('customer_id').references('id').inTable('customers');
    t.text('inbound_message');
    t.text('draft_response');
    t.text('revised_response');
    t.text('final_response');
    t.string('intent', 50);
    t.decimal('intent_confidence', 5, 2);
    t.text('context_summary');
    t.jsonb('flags');
    t.enu('status', ['pending', 'approved', 'revised', 'rejected', 'sent']).defaultTo('pending');
    t.uuid('approved_by').references('id').inTable('technicians');
    t.timestamp('approved_at');
    t.timestamp('sent_at');
    t.integer('response_time_seconds');
    t.timestamp('created_at').defaultTo(knex.fn.now());

    t.index('status');
    t.index('customer_id');
  });

  // Add AI fields to sms_log
  const cols = await knex('sms_log').columnInfo();
  await knex.schema.alterTable('sms_log', (t) => {
    if (!cols.intent) t.string('intent', 50);
    if (!cols.intent_confidence) t.decimal('intent_confidence', 5, 2);
    if (!cols.ai_suggested_reply) t.text('ai_suggested_reply');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('message_drafts');
};
