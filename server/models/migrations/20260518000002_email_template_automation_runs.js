/**
 * Durable execution queue for email template automations.
 *
 * The template library owns content and send snapshots. This table owns
 * trigger execution: idempotency claims, delayed sends, retry state, and an
 * audit trail of what happened for each automation trigger.
 */

exports.up = async function up(knex) {
  await knex.schema.createTable('email_template_automation_runs', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('automation_id').references('id').inTable('email_template_automations').onDelete('SET NULL');
    t.string('automation_key', 140).notNullable();
    t.string('trigger_event_key', 120).notNullable();
    t.string('trigger_event_id', 180);
    t.string('entity_type', 80);
    t.string('entity_id', 120);
    t.string('template_key', 120).notNullable();
    t.uuid('template_version_id').references('id').inTable('email_template_versions').onDelete('SET NULL');
    t.string('recipient_type', 40);
    t.string('recipient_id', 120);
    t.string('recipient_email').notNullable();
    t.string('idempotency_key', 260).notNullable().unique();
    t.string('status', 40).notNullable().defaultTo('queued');
    t.timestamp('run_after').notNullable().defaultTo(knex.fn.now());
    t.timestamp('next_retry_at');
    t.integer('attempts').notNullable().defaultTo(0);
    t.integer('max_attempts').notNullable().defaultTo(2);
    t.text('last_error');
    t.text('exit_reason');
    t.uuid('email_message_id').references('id').inTable('email_messages').onDelete('SET NULL');
    t.jsonb('payload').defaultTo('{}');
    t.jsonb('context').defaultTo('{}');
    t.timestamp('completed_at');
    t.timestamps(true, true);
    t.index(['automation_key', 'created_at']);
    t.index(['trigger_event_key', 'created_at']);
    t.index(['status', 'run_after']);
    t.index(['recipient_email']);
    t.index(['entity_type', 'entity_id']);
  });

  await knex.schema.createTable('email_template_automation_run_events', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('run_id').notNullable().references('id').inTable('email_template_automation_runs').onDelete('CASCADE');
    t.string('event_type', 80).notNullable();
    t.text('message');
    t.jsonb('metadata').defaultTo('{}');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.index(['run_id', 'created_at']);
    t.index(['event_type']);
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('email_template_automation_run_events');
  await knex.schema.dropTableIfExists('email_template_automation_runs');
};
