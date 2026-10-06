/**
 * Completed-visit date (owner "go" 2026-10-06, GATE_COMPLETION_MOVES_DATE).
 *
 * A visit finished BEFORE its booked day (a certificate / project closeout is
 * the only path that can do this today) moves its scheduled_services row to the
 * day the work was done, so the visit, its service record and its completion
 * invoice all carry one date. The booked day is kept here.
 *
 * `original_scheduled_date` (DATE, nullable): the day the visit was booked for
 * before a completion moved it. NULL = the visit was never moved this way (every
 * existing row, and every row while the gate is off). Fill-if-absent: a visit
 * moved a second time keeps its FIRST booked day. A recurring visit keeps its
 * series slot through the existing date_exception_cadence_date, not this column.
 *
 * Additive and reversible: no backfill, no index, no CHECK, no default. Safe to
 * run before the gate flips; nothing reads or writes the column while it is off.
 */
const TABLE = 'scheduled_services';
const COL = 'original_scheduled_date';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn(TABLE, COL))) {
    await knex.schema.alterTable(TABLE, (t) => {
      t.date(COL).nullable();
    });
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasColumn(TABLE, COL)) {
    await knex.schema.alterTable(TABLE, (t) => { t.dropColumn(COL); });
  }
};
