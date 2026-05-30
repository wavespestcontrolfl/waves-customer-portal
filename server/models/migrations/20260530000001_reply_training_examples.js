/**
 * reply_training_examples — examples for teaching the comms agent how Waves
 * actually replies to customer messages.
 *
 * Rows are captured passively from admin-authored outbound SMS. Each row pairs
 * the latest prior customer inbound message with Adam/Waves' sent reply plus a
 * context snapshot for later fixture export and evaluation.
 */

exports.up = async function (knex) {
  const exists = await knex.schema.hasTable('reply_training_examples');
  if (exists) return;

  await knex.schema.createTable('reply_training_examples', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));

    t.string('channel', 20).notNullable().defaultTo('sms');
    t.uuid('conversation_id').references('id').inTable('conversations').onDelete('SET NULL');
    t.uuid('customer_id').references('id').inTable('customers').onDelete('SET NULL');
    t.uuid('lead_id').references('id').inTable('leads').onDelete('SET NULL');
    t.uuid('estimate_id').references('id').inTable('estimates').onDelete('SET NULL');

    t.uuid('inbound_message_id').references('id').inTable('messages').onDelete('SET NULL');
    t.uuid('outbound_message_id').references('id').inTable('messages').onDelete('SET NULL').unique();
    t.uuid('source_agent_decision_id');

    t.text('inbound_body');
    t.text('outbound_body').notNullable();
    t.text('agent_draft');
    t.boolean('agent_draft_edited');
    t.text('edit_summary');

    t.string('scenario_label', 80);
    t.string('capture_reason', 120).notNullable().defaultTo('admin_sms_reply');
    t.string('status', 30).notNullable().defaultTo('captured'); // captured | reviewed | excluded
    t.string('review_verdict', 30);
    t.text('review_note');
    t.string('reviewed_by', 100);
    t.timestamp('reviewed_at');

    t.jsonb('context_snapshot').notNullable().defaultTo(knex.raw("'{}'::jsonb"));
    t.jsonb('metadata').notNullable().defaultTo(knex.raw("'{}'::jsonb"));
    t.timestamp('captured_at').notNullable().defaultTo(knex.fn.now());
    t.timestamps(true, true);

    t.index(['status', 'captured_at']);
    t.index(['scenario_label', 'captured_at']);
    t.index(['customer_id', 'captured_at']);
    t.index(['conversation_id', 'captured_at']);
    t.index(['inbound_message_id']);
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('reply_training_examples');
};
