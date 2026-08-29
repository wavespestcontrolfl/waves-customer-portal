/**
 * irrigation_week_plans — the Monday watering-plan decision snapshot
 * (inputs + restriction policy + plan) so the lawn report renders the SAME
 * plan the email sent for that week. One row per customer per week; rows are
 * inserted before the send and stamped sent_at after the provider accepts.
 */
exports.up = async function up(knex) {
  // The sweep reconciles delivery per customer-week by
  // email_messages.trigger_event_id (one lookup per eligible customer) —
  // index it so that is never a full scan of message history.
  if (await knex.schema.hasTable('email_messages') && await knex.schema.hasColumn('email_messages', 'trigger_event_id')) {
    await knex.raw('CREATE INDEX IF NOT EXISTS email_messages_trigger_event_id_idx ON email_messages (trigger_event_id)');
  }
  if (await knex.schema.hasTable('irrigation_week_plans')) return;
  await knex.schema.createTable('irrigation_week_plans', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
    t.date('week_ending').notNullable();
    t.timestamp('plan_as_of', { useTz: true }).notNullable();
    t.jsonb('weather_inputs').notNullable().defaultTo('{}');
    t.jsonb('restriction_policy');
    t.jsonb('week_plan').notNullable();
    // sha1 of the plan JSON: mark-sent binds to the decision that was
    // actually emailed, never to a stale unsent row from an earlier attempt.
    t.string('decision_hash', 40).notNullable();
    // Send lease: the worker that claims the customer-week row (token +
    // time) is the only one that sends; a stale lease (>15 min, no sent_at)
    // can be re-claimed by a retry.
    t.string('claim_token', 64);
    t.timestamp('claimed_at', { useTz: true });
    // Set once the provider accepts the email built from this plan. A row
    // left null is a decision that was never delivered (send failed or was
    // suppressed) and is discarded by the sweep; the report renders only
    // sent plans.
    t.timestamp('sent_at', { useTz: true });
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['customer_id', 'week_ending']);
    t.index(['customer_id', 'plan_as_of']);
  });
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('irrigation_week_plans')) {
    await knex.schema.dropTable('irrigation_week_plans');
  }
  await knex.raw('DROP INDEX IF EXISTS email_messages_trigger_event_id_idx');
};
