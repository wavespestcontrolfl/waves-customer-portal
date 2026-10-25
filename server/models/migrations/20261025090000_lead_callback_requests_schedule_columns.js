/**
 * Part 2b of the lead call/text follow-up (GATE_LEAD_CALL_TEXT_FOLLOWUP):
 * the per-minute scheduler's own claims on a booked call
 * (services/lead-callback-scheduler.js). Each is stamped once, before its
 * side effect, so an overlapping tick or a second instance never repeats it.
 *   reminded_at     — the 15-minute reminder (lead text + owner bell) claimed
 *   ring_claimed_at — the press-1 ring at the booked time claimed
 *   ring_call_log_id — the ring's call_log row
 *   no_answer_at    — the 8 AM bell for a time question never answered
 */
const COLUMNS = [
  ['reminded_at', (t) => t.timestamp('reminded_at', { useTz: true })],
  ['ring_claimed_at', (t) => t.timestamp('ring_claimed_at', { useTz: true })],
  ['ring_call_log_id', (t) => t.uuid('ring_call_log_id')],
  ['no_answer_at', (t) => t.timestamp('no_answer_at', { useTz: true })],
];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('lead_callback_requests'))) return;
  for (const [name, add] of COLUMNS) {
    if (!(await knex.schema.hasColumn('lead_callback_requests', name))) {
      await knex.schema.alterTable('lead_callback_requests', (t) => add(t));
    }
  }
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS lead_callback_requests_due_idx
      ON lead_callback_requests (scheduled_for)
      WHERE state = 'scheduled'
  `);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('lead_callback_requests'))) return;
  await knex.raw('DROP INDEX IF EXISTS lead_callback_requests_due_idx');
  for (const [name] of COLUMNS) {
    if (await knex.schema.hasColumn('lead_callback_requests', name)) {
      await knex.schema.alterTable('lead_callback_requests', (t) => t.dropColumn(name));
    }
  }
};
