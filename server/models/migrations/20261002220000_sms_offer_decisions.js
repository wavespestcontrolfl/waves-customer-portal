/**
 * sms_offer_decisions — what the SMS scheduling decide step concluded about a
 * customer's reply to a recorded offer (GATE_SMS_SCHEDULING_DECIDE, dark).
 *
 * One row per (offer, inbound text). In shadow mode (this slice) nothing is
 * moved, booked or sent: the row records the model's answer, the code checks
 * that ran on it, and what the executor WOULD have done, so the decide step can
 * be scored against what staff actually did before any action is switched on.
 *
 * outcome:
 *   would_move    accepted an offered slot for a visit move; every check passed
 *   would_book    accepted an offered slot for a booking (estimate / new visit)
 *   confirm_only  accepted the slot the calendar already shows (no write needed)
 *   staff         accepted or unclear, but a check refused it → a person decides
 *   no_action     declined, or asked for other times (the drafter answers that)
 *   error         the model call failed or its answer was malformed
 */

const TABLE = 'sms_offer_decisions';

exports.up = async function up(knex) {
  if (await knex.schema.hasTable(TABLE)) return;
  await knex.schema.createTable(TABLE, (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('sms_offer_id').notNullable().references('id').inTable('sms_offers').onDelete('CASCADE');
    // The customer's text being decided (sms_log.id of the inbound row).
    t.uuid('inbound_sms_log_id').notNullable().references('id').inTable('sms_log').onDelete('CASCADE');
    t.uuid('customer_id').references('id').inTable('customers').onDelete('CASCADE');
    // shadow (this slice); later slices add live modes per action kind.
    t.string('mode', 12).notNullable().defaultTo('shadow');
    t.string('model', 60);
    t.string('prompt_version', 40);
    // The model's answer: accept_slot | decline | asks_other_time | unclear.
    t.string('action', 20);
    // 1-based slot in the offer's slots array; null when none was named.
    t.integer('slot_number');
    // Verbatim span of the customer's text the model quoted for its answer.
    t.text('customer_quote');
    t.string('confidence', 10);
    t.string('outcome', 20).notNullable();
    // The checks that refused an accept (empty when none did).
    t.jsonb('refusals').notNullable().defaultTo('[]');
    // What the executor would have done: { kind, scheduled_service_id,
    // estimate_id, service_key, date, start, end, from: { date, start, end } }.
    t.jsonb('would_have');
    t.string('error', 60);
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['sms_offer_id', 'inbound_sms_log_id']);
    t.index('created_at');
    t.index(['customer_id', 'created_at']);
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists(TABLE);
};
