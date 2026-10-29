/**
 * Commission ledger follow-up (D5 part 3b-2, Codex round 2 on #7033): an estimate deposit counts as collected money.
 *
 * A deposit has no payments row (estimate-deposits.js markDepositReceived): the deposit ledger (estimate_deposits) holds
 * it, with its refunds and disputes. The ledger counts each collected deposit row like a payment.
 * commission_entries.payment_source says what payment_id names: 'payment' (a payments row) or 'estimate_deposit' (an
 * estimate_deposits row).
 * 20261029200000 and 20261029203000 are frozen once pushed, so this is its own migration.
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable('commission_entries', (t) => {
    t.string('payment_source', 20).notNullable().defaultTo('payment');
  });
  await knex.raw(`ALTER TABLE commission_entries
    ADD CONSTRAINT commission_entries_payment_source_check CHECK (payment_source IN ('payment', 'estimate_deposit'))`);
};

exports.down = async function down(knex) {
  // Deposit entries are payroll evidence the older shape cannot tell from payment entries: preserve them and roll forward.
  if (await knex('commission_entries').where({ payment_source: 'estimate_deposit' }).first('id')) {
    throw new Error('commission_entries holds estimate deposit entries. Preserve the schema and roll forward; do not drop them.');
  }
  await knex.raw('ALTER TABLE commission_entries DROP CONSTRAINT IF EXISTS commission_entries_payment_source_check');
  await knex.schema.alterTable('commission_entries', (t) => {
    t.dropColumn('payment_source');
  });
};
