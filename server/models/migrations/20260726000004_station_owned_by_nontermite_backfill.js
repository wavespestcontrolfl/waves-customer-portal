/**
 * Backfill owned_by = 'waves' for rodent/trapping stations (codex P1 on
 * #2998, second half).
 *
 * 20260726000002 added owned_by with a 'customer' default and backfilled
 * EVERY existing row with it — correct for termite (every pre-rental bait
 * station was a purchase by construction) but wrong for the rodent and
 * trapping programs that share the registry: that hardware is never sold.
 * It is placed, serviced, and retrieved by Waves, so it belongs in the
 * Waves-owned asset/recovery set unconditionally. The service layer now
 * stamps new non-termite rows 'waves'; this fixes the rows the original
 * backfill already stamped.
 *
 * A NEW migration rather than an edit of 000002 because 000002 has already
 * run in PR/preview environments — knex tracks by filename, so an in-place
 * edit would be a silent no-op there.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('termite_stations'))) return;
  if (!(await knex.schema.hasColumn('termite_stations', 'owned_by'))) return;
  await knex('termite_stations')
    .whereIn('program', ['rodent', 'trapping'])
    .where({ owned_by: 'customer' })
    .update({ owned_by: 'waves' });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('termite_stations'))) return;
  if (!(await knex.schema.hasColumn('termite_stations', 'owned_by'))) return;
  // Restores the state 000002's blanket backfill left behind.
  await knex('termite_stations')
    .whereIn('program', ['rodent', 'trapping'])
    .where({ owned_by: 'waves' })
    .update({ owned_by: 'customer' });
};
