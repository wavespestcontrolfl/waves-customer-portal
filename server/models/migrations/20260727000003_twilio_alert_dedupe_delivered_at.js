/**
 * Two-phase claim for twilio_alert_dedupe (Codex round 5 on #3003).
 *
 * A claim taken just before a process restart used to hold the full 24h
 * window with no alert ever delivered. `delivered_at` splits the claim into
 * a short pending lease (confirmed by the service after a channel actually
 * received the alert) and the full window: rows with delivered_at NULL only
 * suppress duplicates for the lease duration, so a crash mid-dispatch
 * self-heals in minutes instead of silencing a remote party for a day.
 *
 * Separate migration (not an edit of 20260727000002): that file already ran
 * in the PR preview environment, and knex tracks by filename — an edit would
 * be a silent no-op there.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('twilio_alert_dedupe'))) return;
  if (await knex.schema.hasColumn('twilio_alert_dedupe', 'delivered_at')) return;

  await knex.schema.alterTable('twilio_alert_dedupe', (t) => {
    t.timestamp('delivered_at', { useTz: true });
  });
  // Pre-existing rows predate the two-phase claim; treat them as delivered so
  // they keep suppressing for their original window instead of expiring on
  // the short lease and double-alerting.
  await knex('twilio_alert_dedupe')
    .whereNull('delivered_at')
    .update({ delivered_at: knex.raw('last_alerted_at') });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('twilio_alert_dedupe'))) return;
  if (!(await knex.schema.hasColumn('twilio_alert_dedupe', 'delivered_at'))) return;
  await knex.schema.alterTable('twilio_alert_dedupe', (t) => {
    t.dropColumn('delivered_at');
  });
};
