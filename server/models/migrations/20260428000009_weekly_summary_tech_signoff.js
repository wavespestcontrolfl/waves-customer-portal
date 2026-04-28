/**
 * Tech-side weekly timecard sign-off on time_weekly_summary.
 *
 * Mirrors the Square pattern where the employee acknowledges their
 * own week before the manager approves it — useful for audit and
 * for catching errors the tech sees but the admin wouldn't (e.g.,
 * a missed clock-out the tech remembers but the data shows wrong).
 *
 * tech_signature stores the tech's typed name as the "I attest"
 * marker. Both columns nullable so existing rows are untouched.
 * Sign-off does NOT change approval status — admin still approves.
 * Unlocking a week clears these on the unlock path.
 */
exports.up = async function (knex) {
  if (!(await knex.schema.hasColumn('time_weekly_summary', 'tech_signed_at'))) {
    await knex.schema.alterTable('time_weekly_summary', t => {
      t.timestamp('tech_signed_at');
    });
  }
  if (!(await knex.schema.hasColumn('time_weekly_summary', 'tech_signature'))) {
    await knex.schema.alterTable('time_weekly_summary', t => {
      t.string('tech_signature', 200);
    });
  }
};

exports.down = async function (knex) {
  if (await knex.schema.hasColumn('time_weekly_summary', 'tech_signature')) {
    await knex.schema.alterTable('time_weekly_summary', t => t.dropColumn('tech_signature'));
  }
  if (await knex.schema.hasColumn('time_weekly_summary', 'tech_signed_at')) {
    await knex.schema.alterTable('time_weekly_summary', t => t.dropColumn('tech_signed_at'));
  }
};
