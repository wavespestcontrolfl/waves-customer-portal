/**
 * Commission ledger follow-up (D5 part 3b-2, Codex round 2 on #7033): an estimate deposit counts as collected money.
 *
 * A deposit has no payments row (estimate-deposits.js markDepositReceived). The invoice writer credits it on the
 * estimate's invoice as a deposit_credit line, after tax, as a prior payment. The ledger counts that credit like a
 * payment on the invoice. commission_entries.payment_source says what payment_id names: 'payment' (a payments row) or
 * 'deposit_credit' (the invoice that carries the estimate's deposit credit; payment_id is then that invoice's id).
 * 20261029200000 and 20261029203000 are frozen once pushed, so this is its own migration.
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable('commission_entries', (t) => {
    t.string('payment_source', 20).notNullable().defaultTo('payment');
  });
  await knex.raw(`ALTER TABLE commission_entries
    ADD CONSTRAINT commission_entries_payment_source_check CHECK (payment_source IN ('payment', 'deposit_credit'))`);
};

exports.down = async function down(knex) {
  // Deposit entries are payroll evidence the older shape cannot tell from payment entries: preserve them and roll forward.
  if (await knex('commission_entries').where({ payment_source: 'deposit_credit' }).first('id')) {
    throw new Error('commission_entries holds deposit credit entries. Preserve the schema and roll forward; do not drop them.');
  }
  await knex.raw('ALTER TABLE commission_entries DROP CONSTRAINT IF EXISTS commission_entries_payment_source_check');
  await knex.schema.alterTable('commission_entries', (t) => {
    t.dropColumn('payment_source');
  });
};
