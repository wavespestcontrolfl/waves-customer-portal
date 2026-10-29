/**
 * Payroll bank match (GATE_PAYROLL_BANK_MATCH, owner 2026-10-28, payroll item 8):
 * a bank line can be tied to the paycheck or the payroll tax calendar row it paid.
 *
 *   bank_transactions.matched_payroll_check_id  uuid NULL -> payroll_checks(id)
 *   bank_transactions.matched_tax_filing_id     uuid NULL -> tax_filing_calendar(id)
 *
 * Both are NULL for every existing row and stay NULL while the gate is off. The line is
 * ALSO linked to the expense the match created (status 'created_expense', matched_expense_id),
 * in the category "Payroll (counted from pay runs)", so the P&L and the Schedule C draft leave
 * it out; match_method records 'payroll_check' or 'payroll_tax' (no new status value).
 *
 *   - One bank line per paycheck and per calendar row: a partial unique index on each column
 *     is the real double-claim guard when two matching passes race.
 *   - A line holds at most one of the two links (CHECK).
 *   - ON DELETE SET NULL on both: a deleted calendar row (the sync removes an unmarked row whose
 *     duty is gone) must not block the sync or leave a dangling id. A paycheck is never deleted
 *     once final (protect_payroll_checks), so its FK cannot dangle.
 *
 * Additive and idempotent. Down fails closed while any link exists: the links are the audit
 * trail of what the bank paid, so the owner unlinks first (delete the created expense) or rolls
 * forward.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('bank_transactions'))) return;
  if (!(await knex.schema.hasColumn('bank_transactions', 'matched_payroll_check_id'))) {
    await knex.schema.alterTable('bank_transactions', (t) => {
      t.uuid('matched_payroll_check_id').nullable().references('id').inTable('payroll_checks').onDelete('SET NULL');
    });
  }
  if (!(await knex.schema.hasColumn('bank_transactions', 'matched_tax_filing_id'))) {
    await knex.schema.alterTable('bank_transactions', (t) => {
      t.uuid('matched_tax_filing_id').nullable().references('id').inTable('tax_filing_calendar').onDelete('SET NULL');
    });
  }
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS bank_transactions_matched_payroll_check_uniq
    ON bank_transactions (matched_payroll_check_id) WHERE matched_payroll_check_id IS NOT NULL`);
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS bank_transactions_matched_tax_filing_uniq
    ON bank_transactions (matched_tax_filing_id) WHERE matched_tax_filing_id IS NOT NULL`);
  await knex.raw('ALTER TABLE bank_transactions DROP CONSTRAINT IF EXISTS bank_transactions_one_payroll_link_check');
  await knex.raw(`ALTER TABLE bank_transactions ADD CONSTRAINT bank_transactions_one_payroll_link_check
    CHECK (matched_payroll_check_id IS NULL OR matched_tax_filing_id IS NULL)`);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('bank_transactions'))) return;
  const hasCheck = await knex.schema.hasColumn('bank_transactions', 'matched_payroll_check_id');
  const hasFiling = await knex.schema.hasColumn('bank_transactions', 'matched_tax_filing_id');
  if (hasCheck || hasFiling) {
    const linked = await knex('bank_transactions')
      .where(function anyLink() {
        if (hasCheck) this.orWhereNotNull('matched_payroll_check_id');
        if (hasFiling) this.orWhereNotNull('matched_tax_filing_id');
      })
      .first('id');
    if (linked) {
      throw new Error('cannot roll back: bank lines are linked to paychecks or payroll tax rows. Delete the expense each match created (Expenses tab) to release the line, then rerun, or roll forward.');
    }
  }
  await knex.raw('ALTER TABLE bank_transactions DROP CONSTRAINT IF EXISTS bank_transactions_one_payroll_link_check');
  await knex.raw('DROP INDEX IF EXISTS bank_transactions_matched_payroll_check_uniq');
  await knex.raw('DROP INDEX IF EXISTS bank_transactions_matched_tax_filing_uniq');
  if (hasCheck) {
    await knex.schema.alterTable('bank_transactions', (t) => { t.dropColumn('matched_payroll_check_id'); });
  }
  if (hasFiling) {
    await knex.schema.alterTable('bank_transactions', (t) => { t.dropColumn('matched_tax_filing_id'); });
  }
};
