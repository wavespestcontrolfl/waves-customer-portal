/**
 * Stops-ahead clamp columns (GATE_STOPS_AWAY).
 *
 * The customer tracker shows "N stops away" (capped at 3). Owner ruling
 * 2026-08-14: once a customer has SEEN a number, the display must never
 * increase — a mid-day reorder that bumps someone ahead of them shows the
 * previously-seen (smaller) number, not the new larger truth.
 *
 * The clamp floor is persisted on the visit row (not client-side) so the
 * authenticated portal tracker and the public /track/<token> page agree,
 * and the floor survives reloads and device switches. The floor is only
 * trusted for its own display date: a visit rescheduled to another day is
 * a new tracker, so stops_ahead_shown_date scopes the clamp and a stale
 * floor from a previous date is ignored and overwritten.
 */
exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('scheduled_services');
  if (!hasTable) return;
  const hasMin = await knex.schema.hasColumn('scheduled_services', 'stops_ahead_min_shown');
  const hasDate = await knex.schema.hasColumn('scheduled_services', 'stops_ahead_shown_date');
  await knex.schema.alterTable('scheduled_services', (t) => {
    if (!hasMin) t.integer('stops_ahead_min_shown').nullable();
    if (!hasDate) t.date('stops_ahead_shown_date').nullable();
  });
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('scheduled_services');
  if (!hasTable) return;
  const hasMin = await knex.schema.hasColumn('scheduled_services', 'stops_ahead_min_shown');
  const hasDate = await knex.schema.hasColumn('scheduled_services', 'stops_ahead_shown_date');
  await knex.schema.alterTable('scheduled_services', (t) => {
    if (hasMin) t.dropColumn('stops_ahead_min_shown');
    if (hasDate) t.dropColumn('stops_ahead_shown_date');
  });
};
