/**
 * payment_plans lifecycle stamps. Plans were record-only (status never left
 * 'active'), yet an active row blocks invoice edits / credit reversal / auto
 * credit. Add the columns the cancel route and the paid-invoice auto-complete
 * hook write so the transition is auditable.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('payment_plans'))) return;
  await knex.schema.alterTable('payment_plans', (t) => {
    t.timestamp('completed_at');
    t.timestamp('cancelled_at');
    t.string('cancelled_by', 200);
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('payment_plans'))) return;
  await knex.schema.alterTable('payment_plans', (t) => {
    t.dropColumn('completed_at');
    t.dropColumn('cancelled_at');
    t.dropColumn('cancelled_by');
  });
};
