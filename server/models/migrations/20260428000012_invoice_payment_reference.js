// Adds payment_reference + payment_recorded_by + payment_recorded_at to
// invoices so manually-recorded payments (cash / check / Zelle / other)
// can store a check #, Zelle confirmation, or operator note alongside
// the existing payment_method column. payment_method already accepts
// arbitrary strings; the only change here is the audit metadata for
// off-Stripe payments captured via "Add payment".
exports.up = async function (knex) {
  const hasReference = await knex.schema.hasColumn('invoices', 'payment_reference');
  const hasRecordedBy = await knex.schema.hasColumn('invoices', 'payment_recorded_by');
  const hasRecordedAt = await knex.schema.hasColumn('invoices', 'payment_recorded_at');
  await knex.schema.alterTable('invoices', (t) => {
    if (!hasReference) t.string('payment_reference', 200);
    if (!hasRecordedBy) t.string('payment_recorded_by', 100);
    if (!hasRecordedAt) t.timestamp('payment_recorded_at');
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('invoices', (t) => {
    t.dropColumn('payment_reference');
    t.dropColumn('payment_recorded_by');
    t.dropColumn('payment_recorded_at');
  });
};
