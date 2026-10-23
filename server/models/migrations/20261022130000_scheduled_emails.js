/**
 * scheduled_emails — Gmail-style "Schedule send" for the admin email composer
 * and reply box (owner 2026-10-22: "build it like Gmail has it").
 *
 * Writers: POST /api/admin/email/schedule (status 'scheduled'),
 * POST /api/admin/email/scheduled/:id/cancel ('scheduled' -> 'cancelled').
 * Sender: services/email/scheduled-email-sender.js, every minute behind
 * GATE_EMAIL_SEND_LATER: 'scheduled' -> 'sending' -> 'sent', or 'failed'
 * after a definite Gmail refusal on the last attempt, or 'outcome_unknown'
 * when Gmail may have accepted it (never retried: the office checks Sent).
 *
 * body_html is what Gmail receives (the composer's encoded body, as on
 * /send); draft_text is the operator's plain text, kept so "Cancel send"
 * puts the email back in the composer as a draft. client_key makes a retried
 * schedule request return the first row instead of queuing a second email.
 */
const STATUSES = ['scheduled', 'sending', 'sent', 'failed', 'cancelled', 'outcome_unknown'];

exports.up = async function up(knex) {
  await knex.schema.createTable('scheduled_emails', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.text('to_address').notNullable();
    t.text('subject').notNullable();
    t.text('body_html').notNullable();
    t.text('draft_text').notNullable();
    t.text('thread_id');
    t.uuid('reply_email_id');
    t.timestamp('send_at', { useTz: true }).notNullable();
    t.string('status', 20).notNullable().defaultTo('scheduled');
    t.uuid('created_by');
    t.string('client_key', 64).notNullable().unique();
    t.integer('attempts').notNullable().defaultTo(0);
    t.timestamp('claimed_at', { useTz: true });
    t.text('last_error');
    t.text('gmail_message_id');
    t.timestamp('sent_at', { useTz: true });
    t.timestamp('cancelled_at', { useTz: true });
    t.timestamps(true, true);
  });
  await knex.raw(`ALTER TABLE scheduled_emails ADD CONSTRAINT scheduled_emails_status_check
    CHECK (status IN (${STATUSES.map((s) => `'${s}'`).join(', ')}))`);
  await knex.raw(`CREATE INDEX scheduled_emails_due_idx ON scheduled_emails (send_at) WHERE status = 'scheduled'`);
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('scheduled_emails');
};
