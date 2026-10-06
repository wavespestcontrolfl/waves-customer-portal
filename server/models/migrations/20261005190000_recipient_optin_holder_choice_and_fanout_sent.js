/**
 * recipient_optin, two more nullable markers for the on-site follow-up
 * (GATE_ONSITE_CALLER_DEMOTE):
 *   caller_choice_at       — after this flow switched the caller's appointment
 *                            texts off (caller_demoted_at), the holder or the
 *                            office set that preference themselves. From then
 *                            on it is their choice: the flow never restores it.
 *   fanout_confirmed_at    — the call pipeline's contact fan-out sent this
 *                            row's visit its confirmation while holding the
 *                            follow-up claim; the replay is not owed (durable
 *                            where the best-effort sms_log write was lost).
 * Additive and nullable.
 */

const COLUMNS = ['caller_choice_at', 'fanout_confirmed_at'];

exports.up = async function up(knex) {
  for (const column of COLUMNS) {
    if (!(await knex.schema.hasColumn('recipient_optin', column))) {
      await knex.schema.alterTable('recipient_optin', (t) => {
        t.timestamp(column, { useTz: true }).nullable();
      });
    }
  }
};

exports.down = async function down(knex) {
  for (const column of COLUMNS) {
    if (await knex.schema.hasColumn('recipient_optin', column)) {
      await knex.schema.alterTable('recipient_optin', (t) => {
        t.dropColumn(column);
      });
    }
  }
};
