/**
 * outbox_messages — transactional outbox for SMS/email side effects
 * coming out of the call-triage routing decision.
 *
 * Why (docs/call-triage-discovery.md §13): if the route transaction
 * inserts a scheduled_services row AND fires the SMS confirmation
 * inline, a Twilio failure has nothing to roll back, and a DB rollback
 * after a successful Twilio send leaves the customer with a
 * confirmation for an appointment that doesn't exist. Outbox pattern
 * solves both: route transaction inserts one row here and commits;
 * a worker drains pending rows and calls Twilio. Crash mid-Twilio →
 * retried. Rollback before commit → row never existed → no SMS sent.
 *
 * PR1 ships the table only. PR4 adds the worker and rewires the
 * existing inline SMS calls in call-recording-processor.js to write
 * here instead of calling Twilio directly.
 */

exports.up = async function (knex) {
  await knex.schema.createTable('outbox_messages', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));

    t.string('channel', 20).notNullable();          // 'sms' | 'email'
    t.jsonb('payload').notNullable();                // { to, body, template_id, template_vars, ... }
    t.string('status', 20).notNullable().defaultTo('pending'); // 'pending' | 'sent' | 'failed' | 'cancelled'

    // Source linkage — every outbox row should be traceable back to a
    // routing decision (or a manual admin action; null is allowed).
    t.uuid('route_decision_id');                     // FK soft-set later; PR1 leaves it loose to avoid PR ordering pain
    t.uuid('related_call_log_id');
    t.uuid('related_customer_id');
    t.uuid('related_scheduled_service_id');

    t.integer('attempts').notNullable().defaultTo(0);
    t.timestamp('last_attempt_at');
    t.text('last_error');

    t.timestamp('sent_at');
    t.timestamps(true, true);

    // Worker query: pending, ordered by created_at, limit N. This
    // partial index keeps it tiny.
    t.index(['related_call_log_id']);
  });

  await knex.raw(`
    CREATE INDEX outbox_messages_pending_idx
    ON outbox_messages (created_at)
    WHERE status = 'pending'
  `);
};

exports.down = async function (knex) {
  await knex.raw('DROP INDEX IF EXISTS outbox_messages_pending_idx');
  await knex.schema.dropTableIfExists('outbox_messages');
};
