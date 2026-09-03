/**
 * appointment_reminders.confirmation_estimate_id — the open estimate whose
 * accept line a HELD call-booking confirmation owes (GH codex #3814 r2 P2).
 *
 * The call pipeline appends "accept your estimate here: {link}" to the
 * confirmation text only when the accept page would adopt that very
 * visit. A QUIET_HOURS_HOLD / MOVE_HOLD hands delivery to the stranded-
 * confirmation sweep, whose canonical renderer had no estimate context, so
 * the deferred text went out without the line. The pipeline now stamps
 * the estimate id on the row it re-arms; the sweep re-verifies the
 * estimate is still the newest open one and still adopts the visit, and
 * appends the line for the account holder's own number only. Nullable —
 * every other confirmation leaves it null and renders unchanged.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('appointment_reminders'))) return;
  if (await knex.schema.hasColumn('appointment_reminders', 'confirmation_estimate_id')) return;
  await knex.schema.alterTable('appointment_reminders', (t) => {
    t.uuid('confirmation_estimate_id');
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('appointment_reminders'))) return;
  if (!(await knex.schema.hasColumn('appointment_reminders', 'confirmation_estimate_id'))) return;
  await knex.schema.alterTable('appointment_reminders', (t) => {
    t.dropColumn('confirmation_estimate_id');
  });
};
