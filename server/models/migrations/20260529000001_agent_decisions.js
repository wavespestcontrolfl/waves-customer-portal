/**
 * agent_decisions — shared shadow/review ledger for Waves agents.
 *
 * This migration is kept in main because production migration history includes
 * it. Knex validates every applied migration file before running new
 * migrations, so removing the file makes deploy-time migrate:latest fail even
 * if the table already exists.
 */

exports.up = async function (knex) {
  const exists = await knex.schema.hasTable('agent_decisions');
  if (exists) return;

  await knex.schema.createTable('agent_decisions', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));

    t.string('workflow', 80).notNullable();
    t.string('agent_name', 120).notNullable();
    t.string('decision_version', 40).notNullable();
    t.string('mode', 20).notNullable().defaultTo('shadow');
    t.string('status', 30).notNullable().defaultTo('pending_review');

    t.string('entity_type', 60);
    t.uuid('entity_id');
    t.uuid('customer_id').references('id').inTable('customers').onDelete('SET NULL');
    t.uuid('lead_id').references('id').inTable('leads').onDelete('SET NULL');
    t.uuid('estimate_id').references('id').inTable('estimates').onDelete('SET NULL');

    t.string('source_channel', 30);
    t.uuid('sms_log_id').references('id').inTable('sms_log').onDelete('SET NULL');
    t.uuid('conversation_id').references('id').inTable('conversations').onDelete('SET NULL');
    t.string('source_message_id', 120);

    t.string('detected_intent', 80);
    t.decimal('confidence', 5, 4);
    t.string('confidence_label', 20);

    t.jsonb('input_snapshot');
    t.jsonb('recommended_actions').notNullable().defaultTo(knex.raw("'[]'::jsonb"));
    t.jsonb('auto_actions_allowed').notNullable().defaultTo(knex.raw("'[]'::jsonb"));
    t.jsonb('blocked_actions').notNullable().defaultTo(knex.raw("'[]'::jsonb"));
    t.jsonb('safety_flags').notNullable().defaultTo(knex.raw("'[]'::jsonb"));
    t.text('suggested_message');
    t.text('reasoning_summary');

    t.string('model', 80);
    t.string('prompt_version', 40);

    t.string('human_verdict', 30);
    t.jsonb('corrected_actions');
    t.text('correction_note');
    t.string('reviewed_by', 100);
    t.timestamp('reviewed_at');

    t.string('idempotency_key', 180).unique();
    t.timestamps(true, true);

    t.index(['workflow', 'created_at']);
    t.index(['status', 'created_at']);
    t.index(['customer_id', 'created_at']);
    t.index(['estimate_id']);
    t.index(['lead_id']);
    t.index(['detected_intent']);
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('agent_decisions');
};
