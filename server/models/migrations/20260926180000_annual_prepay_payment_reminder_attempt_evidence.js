/**
 * Durable evidence for resuming an open annual-prepay 3-day payment reminder.
 *
 * The claim timestamp is cleared when a pre-ledger or retryable attempt
 * fails. payment_reminder_3d_attempted_for keeps the promised first-visit
 * date claimed by that attempt, allowing only that episode to resume two
 * days out. A term created after stage due has no marker, and moving the
 * promised visit makes the old date mismatch until the new 3-day stage is
 * actually claimed.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('annual_prepay_terms'))) return;
  if (await knex.schema.hasColumn('annual_prepay_terms', 'payment_reminder_3d_attempted_for')) return;
  await knex.schema.alterTable('annual_prepay_terms', (table) => {
    table.date('payment_reminder_3d_attempted_for').nullable();
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('annual_prepay_terms'))) return;
  if (!(await knex.schema.hasColumn('annual_prepay_terms', 'payment_reminder_3d_attempted_for'))) return;
  await knex.schema.alterTable('annual_prepay_terms', (table) => {
    table.dropColumn('payment_reminder_3d_attempted_for');
  });
};
