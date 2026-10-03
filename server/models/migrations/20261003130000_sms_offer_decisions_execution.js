/**
 * sms_offer_decisions: what the move executor did with a would-move decision
 * (GATE_SMS_SCHEDULING_ACT_MOVE, dark).
 *
 * execution_status:
 *   null      not executed (shadow, or the executor gate was off)
 *   claimed   the executor took the decision; no result yet (a process that
 *             died here leaves it claimed: never retried, a person decides)
 *   moved     the visit was moved; written in the move's own transaction
 *   refused   a check under the move's locks refused it; nothing was written
 *   failed    the move errored; nothing was written
 * execution: { reason, detail } for refused/failed; { date, start, end,
 *   series_move_id } for moved.
 */

const TABLE = 'sms_offer_decisions';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  if (await knex.schema.hasColumn(TABLE, 'execution_status')) return;
  await knex.schema.alterTable(TABLE, (t) => {
    t.string('execution_status', 12);
    t.jsonb('execution');
    t.timestamp('executed_at', { useTz: true });
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  if (!(await knex.schema.hasColumn(TABLE, 'execution_status'))) return;
  await knex.schema.alterTable(TABLE, (t) => {
    t.dropColumn('execution_status');
    t.dropColumn('execution');
    t.dropColumn('executed_at');
  });
};
