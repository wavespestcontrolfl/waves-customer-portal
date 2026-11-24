/**
 * The 25 ft water setback that 20261119010500 put on the LESCO Crosscheck Plus lawn protocol rows stays on a rollback. That
 * migration's down() takes the setback off every row that still holds 25 ft, whatever product the row names by then, so a row the
 * office has since moved to Tetrino (its label needs the same setback) would lose it. waves-db: the down() of a data correction is a
 * documented no-op, and a rollback never drops safety data from a protocol row.
 *
 * 20261119010500 is pushed, so it cannot change. Its down() reads only its rollback records, the lawn_protocol_audit_log rows with
 * the action crosscheck_water_setback. This migration gives those rows the action crosscheck_water_setback_kept, which no down()
 * reads; each keeps its before and after snapshots, so the history of the change stays. down() is a documented no-op: the records
 * keep the new action, and the setback stays on every row.
 */
const MIGRATION = '20261119010700_crosscheck_setback_kept_on_rollback';
const FROM_ACTION = 'crosscheck_water_setback'; // 20261119010500's LAWN_ACTION
const KEPT_ACTION = 'crosscheck_water_setback_kept'; // lawn_protocol_audit_log.action is varchar(40)

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('lawn_protocol_audit_log'))) return;
  await knex('lawn_protocol_audit_log').where({ action: FROM_ACTION }).update({ action: KEPT_ACTION });
};

// Documented no-op: see the header. The setback stays on a rollback.
exports.down = async function down() {};

exports.MIGRATION = MIGRATION;
exports.FROM_ACTION = FROM_ACTION;
exports.KEPT_ACTION = KEPT_ACTION;
