/**
 * Partial unique index on geofence_events(time_entry_id) where
 * action_taken='auto_flip_claim'. Backs the per-timer atomic dedupe
 * gate in services/geofence-handler.js maybeAutoFlipNextJob().
 *
 * The previous read-before-write check (isAutoFlipAlreadyEvaluatedForTimer)
 * had a race window where two concurrent EXIT webhooks for the same
 * tech could both observe no prior row and both proceed — A flips
 * job N, B then flips job N+1, sending an SMS to the wrong customer.
 *
 * With this partial unique index, the INSERT of the 'auto_flip_claim'
 * row is the atomic claim itself: the first request wins the unique
 * constraint, the second gets a UNIQUE violation and exits dedupe.
 * No advisory locks, no transactions, no helper code — Postgres
 * enforces mutual exclusion via the index.
 *
 * Why partial: a single time_entry_id will accumulate multiple
 * geofence_events rows over its lifetime (timer_started, timer_stopped,
 * the auto_flip_claim itself, then the outcome row like
 * auto_flip_en_route or auto_flip_skipped_*). Only the claim is
 * mutually exclusive; the outcome rows are append-only audit history.
 */
exports.up = async function (knex) {
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS geofence_events_auto_flip_claim_per_timer_idx
    ON geofence_events (time_entry_id)
    WHERE action_taken = 'auto_flip_claim'
  `);
};

exports.down = async function (knex) {
  await knex.raw('DROP INDEX IF EXISTS geofence_events_auto_flip_claim_per_timer_idx');
};
