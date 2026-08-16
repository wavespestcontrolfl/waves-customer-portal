// Retraction state for the FDACS application ledger (codex P1, PR #3419
// r10): the ledger is append-safe by design — 20260705000401's FK is ON
// DELETE SET NULL precisely so rows survive service_products replacement —
// so a recap edit that deselects a previously recorded product must not
// DELETE its regulatory row. It is marked retracted instead: compliance
// reporting and application-limit calculations exclude retracted rows,
// while the row itself survives as the auditable record that the
// application was recorded and then corrected. Re-selecting the product on
// a later recap clears the retraction (the re-link sync nulls both
// columns), so a correction of a correction needs no special case.

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('property_application_history'))) return;
  if (await knex.schema.hasColumn('property_application_history', 'retracted_at')) return;
  await knex.schema.alterTable('property_application_history', (t) => {
    t.timestamp('retracted_at', { useTz: true }).nullable();
    t.text('retraction_reason').nullable();
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('property_application_history'))) return;
  if (!(await knex.schema.hasColumn('property_application_history', 'retracted_at'))) return;
  await knex.schema.alterTable('property_application_history', (t) => {
    t.dropColumn('retracted_at');
    t.dropColumn('retraction_reason');
  });
};
