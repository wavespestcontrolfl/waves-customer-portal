/**
 * Automation v2 — in-house email sequences on SendGrid.
 *
 * Four tables:
 *   automation_templates   — one row per automation (keyed by short `key` like
 *                            'new_recurring', 'bed_bug', etc. — matches the
 *                            keys in email-automations.js for drop-in swap).
 *   automation_steps       — ordered email steps in a sequence. delay_hours = 0
 *                            means "send on enroll"; >0 means "send N hours after
 *                            the previous step's sent_at" (or enrollment for step 0).
 *   automation_enrollments — per-customer enrollment. next_send_at is the scheduler
 *                            tick's only hot column (indexed); advances as each step
 *                            fires.
 *   automation_step_sends  — per-(enrollment, step) delivery ledger.
 *
 * The legacy email-automations.js + beehiiv.js paths keep working; the runtime
 * falls back to Beehiiv for any template whose local steps are empty, so the
 * cutover is per-automation as operator populates step bodies.
 */

exports.up = async function (knex) {
  await knex.schema.createTable('automation_templates', (t) => {
    t.string('key').primary();                           // e.g. 'new_recurring'
    t.string('name').notNullable();
    t.text('description');
    t.string('trigger_type').defaultTo('manual');        // manual | system
    t.string('asm_group').defaultTo('service');          // service | newsletter
    t.jsonb('tags').defaultTo('[]');
    t.text('sms_template');                              // inline SMS body; can use {first_name} substitution
    t.boolean('enabled').defaultTo(true);
    t.string('beehiiv_automation_id');                   // fallback target while cutover is in progress
    t.timestamps(true, true);
    t.index(['enabled']);
  });

  await knex.schema.createTable('automation_steps', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('template_key').references('key').inTable('automation_templates').onDelete('CASCADE').notNullable();
    t.integer('step_order').notNullable();               // 0,1,2,3...
    t.integer('delay_hours').defaultTo(0);               // hours after previous step (or enrollment for step 0)
    t.string('subject');
    t.string('preview_text');
    t.text('html_body');
    t.text('text_body');
    t.string('from_name').defaultTo('Waves Pest Control');
    t.string('from_email').defaultTo('automations@wavespestcontrol.com');
    t.string('reply_to').defaultTo('contact@wavespestcontrol.com');
    t.boolean('enabled').defaultTo(true);
    t.timestamps(true, true);
    t.unique(['template_key', 'step_order']);
    t.index(['template_key']);
  });

  await knex.schema.createTable('automation_enrollments', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('template_key').references('key').inTable('automation_templates').onDelete('CASCADE').notNullable();
    t.uuid('customer_id').references('id').inTable('customers').onDelete('SET NULL');
    t.string('email').notNullable();                     // denormalized so test-sends without a customer work
    t.string('first_name');
    t.string('last_name');
    t.string('status').defaultTo('active');              // active | completed | cancelled | failed
    t.integer('current_step').defaultTo(0);
    t.timestamp('enrolled_at').defaultTo(knex.fn.now());
    t.timestamp('next_send_at');                         // indexed hot column
    t.timestamp('last_sent_at');
    t.timestamp('completed_at');
    t.jsonb('metadata').defaultTo('{}');
    t.timestamps(true, true);
    t.index(['status', 'next_send_at']);
    t.index(['template_key']);
    t.index(['customer_id']);
    t.unique(['template_key', 'customer_id']);
  });

  await knex.schema.createTable('automation_step_sends', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('enrollment_id').references('id').inTable('automation_enrollments').onDelete('CASCADE').notNullable();
    t.uuid('step_id').references('id').inTable('automation_steps').onDelete('SET NULL');
    t.integer('step_order').notNullable();               // copied so deletions don't break history
    t.string('email').notNullable();
    t.string('status').defaultTo('queued');              // queued | sent | failed
    t.string('sendgrid_message_id');
    t.text('failure_reason');
    t.timestamp('sent_at');
    t.timestamp('delivered_at');
    t.timestamp('opened_at');
    t.timestamp('clicked_at');
    t.timestamps(true, true);
    t.index(['enrollment_id']);
    t.index(['sendgrid_message_id']);
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('automation_step_sends');
  await knex.schema.dropTableIfExists('automation_enrollments');
  await knex.schema.dropTableIfExists('automation_steps');
  await knex.schema.dropTableIfExists('automation_templates');
};
