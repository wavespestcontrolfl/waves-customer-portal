/**
 * Skip weekends on recurring appointments — per-customer / per-appointment
 * preference that shifts a recurring spawn off Sat/Sun. Lives on the parent
 * scheduled_services row so the auto-extend-on-completion path
 * (server/routes/admin-schedule.js) can read it without a separate join.
 *
 * skip_weekends: when true, recurring children that land on Sat/Sun get
 *   pushed to weekend_shift direction (forward → Mon, back → Fri).
 * weekend_shift: 'forward' (default) or 'back'.
 */
exports.up = async function (knex) {
  const cols = await knex('scheduled_services').columnInfo();

  await knex.schema.alterTable('scheduled_services', (t) => {
    if (!cols.skip_weekends) t.boolean('skip_weekends').defaultTo(false);
    if (!cols.weekend_shift) t.string('weekend_shift', 10).defaultTo('forward');
  });
};

exports.down = async function (knex) {
  const cols = await knex('scheduled_services').columnInfo();
  await knex.schema.alterTable('scheduled_services', (t) => {
    if (cols.skip_weekends) t.dropColumn('skip_weekends');
    if (cols.weekend_shift) t.dropColumn('weekend_shift');
  });
};
