/**
 * Lawn 9x rounds: the series round anchor (owner 2026-10-28, Option A; recurring_pattern 'lawn_rounds_9').
 *
 * A lawn_rounds_9 series books one visit in each of nine fixed rounds a year. Every visit keeps the
 * anchor date's offset in its round and its weekday. A series move on a later visit, an Edit appointment
 * cadence rewrite and make-recurring re-place the series from a new date. The series PARENT row is the
 * template every top-up and extension reads, but its scheduled_date is history (usually a completed
 * visit) and must not change. recurring_round_anchor_date stores the new anchor on the parent instead.
 *
 * NULL = the parent's own cadence position is the anchor, as before this column existed. Read and
 * written for lawn_rounds_9 series only; nothing selects that pattern yet, so no row is written until
 * the 9x booking path ships.
 *
 * A pushed migration is frozen. The down drops only what this file added.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('scheduled_services'))) return;
  if (await knex.schema.hasColumn('scheduled_services', 'recurring_round_anchor_date')) return;
  await knex.schema.alterTable('scheduled_services', (table) => {
    table.date('recurring_round_anchor_date').nullable();
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('scheduled_services'))) return;
  if (!(await knex.schema.hasColumn('scheduled_services', 'recurring_round_anchor_date'))) return;
  await knex.schema.alterTable('scheduled_services', (table) => {
    table.dropColumn('recurring_round_anchor_date');
  });
};
