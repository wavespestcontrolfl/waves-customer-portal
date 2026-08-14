/**
 * Partial indexes for the voice-relay durable obligation markers on call_log.
 *
 * Two hourly recovery sweeps scan call_log by jsonb marker keys that
 * DELIBERATELY carry no age bound (an obligation is retained until its
 * receipt lands — a gate outage longer than any window must not silently
 * discard an owed page or a stated do-not-contact):
 *
 *   - sweepAbandonedHotAlerts:          metadata->>'relay_hot_alert_needed' IS NOT NULL
 *                                       AND metadata->>'relay_hot_alert_sent_at' IS NULL
 *   - sweepUnsurfacedContactInstructions: metadata->>'relay_contact_instruction_needed' = 'true'
 *
 * Without an index, the steady state (no outstanding markers — the normal
 * case) is a full scan of a growing call_log table every hour, per sweep.
 * These partial indexes keep the empty-result proof O(markers): they index
 * only rows that carry a marker, ordered by created_at (both sweeps order by
 * it), and the query predicates imply the index predicates so the planner can
 * use them.
 */
exports.up = async function up(knex) {
  await knex.raw(
    "CREATE INDEX IF NOT EXISTS call_log_relay_hot_alert_needed_idx "
    + 'ON call_log (created_at) '
    + "WHERE (metadata->>'relay_hot_alert_needed') IS NOT NULL",
  );
  await knex.raw(
    'CREATE INDEX IF NOT EXISTS call_log_relay_contact_instruction_needed_idx '
    + 'ON call_log (created_at) '
    + "WHERE metadata->>'relay_contact_instruction_needed' = 'true'",
  );
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS call_log_relay_hot_alert_needed_idx');
  await knex.raw('DROP INDEX IF EXISTS call_log_relay_contact_instruction_needed_idx');
};
