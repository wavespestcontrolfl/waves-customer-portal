/**
 * Durable pre-provider "I'm about to text this lead a consultation link"
 * marker, written by ALL THREE consultation-link senders (codex #5196
 * P1/P2 follow-up) — call-booking-link-text.js's own automated lane,
 * admin-leads.js's manual send, and admin-communications.js's composer
 * send.
 *
 * The automated lane already had its own handoff marker
 * (call_booking_link_text_handoffs, migration 20260927160000) proving ITS
 * OWN attempt reached the provider even if its transaction later rolled
 * back — but that table is written only from onDispatchStart, so it never
 * protected an accepted MANUAL send whose outer transaction then failed to
 * commit: that rollback releases lockSmsPhone before a competing sender
 * (another manual composer, or this lane's own worker) can see either the
 * rolled-back sms_log row or a marker, and it could send the same link
 * again (codex #5196 P1). This table generalizes the same evidence across
 * all three senders, keyed by (lead_id, to_phone) rather than call_log_id
 * alone, so linkSentRecently's phone-scoped manual-race check
 * (call-booking-link-text.js) can see it too.
 *
 * NO FOREIGN KEYS, same reasoning as call_booking_link_text_handoffs's own
 * doc comment: the insert runs on markerDb()'s separate single connection
 * FROM INSIDE the sender's own held handoff transaction (lockSmsPhone,
 * lockCustomerComms, and — for the automated lane — the leads/call_log row
 * locks). An FK's KEY SHARE check against a leads or call_log row that
 * transaction already holds FOR UPDATE would deadlock: the KEY SHARE lock
 * can never acquire until the holding transaction ends, but that
 * transaction's own commit is waiting on this insert to return.
 *
 * Housekeeping: the live sweep (call-booking-link-text.js's pruneHandoffMarkers)
 * deletes rows older than 15 days — longer than the 14-day linkSentRecently
 * dedupe window, so a row is never pruned while it could still matter to a
 * dedupe read.
 */

exports.up = async function up(knex) {
  const has = await knex.schema.hasTable('consultation_link_send_attempts');
  if (has) return;
  await knex.schema.createTable('consultation_link_send_attempts', (t) => {
    t.bigIncrements('id').primary();
    t.uuid('lead_id').notNullable();
    t.text('to_phone').notNullable();
    t.text('source').notNullable();
    t.uuid('call_log_id').nullable();
    t.timestamp('started_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['lead_id', 'started_at'], 'consultation_link_send_attempts_lead_started_idx');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('consultation_link_send_attempts');
};
