'use strict';

/**
 * Away Watch + Welcome Home (GATE_AWAY_WATCH, owner approved 2026-10-31): the
 * two ET calendar days a WaveGuard member sets when they will be away.
 *
 * - away_watch_from: the day they leave.
 * - away_watch_until: the day they are back. A visit is an away visit when its
 *   scheduled day is in [away_watch_from, away_watch_until).
 *
 * Both nullable, no default, no rewrite of existing rows. Not
 * away_mode_until: that is the cancel-flow Away Mode (plan_holds migration)
 * with no start date and its own surfaces. Guarded; idempotent both ways.
 */
const COLUMNS = ['away_watch_from', 'away_watch_until'];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('property_preferences'))) return;
  for (const column of COLUMNS) {
    if (!(await knex.schema.hasColumn('property_preferences', column))) {
      await knex.schema.alterTable('property_preferences', (t) => { t.date(column); });
    }
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('property_preferences'))) return;
  for (const column of COLUMNS) {
    if (await knex.schema.hasColumn('property_preferences', column)) {
      await knex.schema.alterTable('property_preferences', (t) => { t.dropColumn(column); });
    }
  }
};
