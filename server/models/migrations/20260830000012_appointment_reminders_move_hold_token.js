/**
 * Unique cohort identity for grouped unit-move reminder holds (codex #3609
 * r35): move_hold_until is a lease EXPIRY — two moves for one customer
 * starting within the same second can collide on it, and the repair-release
 * keyed on it could clear an unrelated partial move's holds. The token is
 * written with the stamp by the mover's claim (and copied by re-stamps,
 * join-inherits and held-row creation) and is what the repair-release keys
 * on; the senders' hold checks keep reading move_hold_until alone.
 */
exports.up = async function up(knex) {
  const has = await knex.schema.hasColumn('appointment_reminders', 'move_hold_token');
  if (!has) {
    await knex.schema.alterTable('appointment_reminders', (t) => {
      t.string('move_hold_token', 64).nullable();
    });
  }
};

exports.down = async function down(knex) {
  const has = await knex.schema.hasColumn('appointment_reminders', 'move_hold_token');
  if (has) {
    await knex.schema.alterTable('appointment_reminders', (t) => {
      t.dropColumn('move_hold_token');
    });
  }
};
