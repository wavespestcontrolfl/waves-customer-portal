/**
 * Bank Import — admit 'refund_applied' to the status CHECK.
 *
 * The apply-refund route claims a card-statement credit as
 * status='refund_applied' after reducing the original expense; the original
 * CHECK (20260813000030) predates that status and would reject the update,
 * rolling the whole refund back. Follow-up migration rather than an edit —
 * knex tracks by filename and the original may already have run in preview
 * environments.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('bank_transactions'))) return;
  await knex.raw(`
    ALTER TABLE bank_transactions
    DROP CONSTRAINT IF EXISTS bank_transactions_status_check
  `);
  await knex.raw(`
    ALTER TABLE bank_transactions
    ADD CONSTRAINT bank_transactions_status_check
    CHECK (status IN ('unmatched','matched_expense','matched_payout','created_expense','refund_applied','ignored'))
  `);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('bank_transactions'))) return;
  await knex.raw(`
    ALTER TABLE bank_transactions
    DROP CONSTRAINT IF EXISTS bank_transactions_status_check
  `);
  // The restored CHECK excludes 'refund_applied' — convert those rows to a
  // legal legacy status FIRST or the ALTER fails outright. 'ignored' is the
  // safe downgrade (the row leaves review without touching the ledger); the
  // audit trail survives in suggestion, plus a marker of the downgrade.
  await knex.raw(`
    UPDATE bank_transactions
    SET status = 'ignored',
        suggestion = coalesce(suggestion, '{}'::jsonb) || '{"downgradedFrom":"refund_applied"}'::jsonb
    WHERE status = 'refund_applied'
  `);
  await knex.raw(`
    ALTER TABLE bank_transactions
    ADD CONSTRAINT bank_transactions_status_check
    CHECK (status IN ('unmatched','matched_expense','matched_payout','created_expense','ignored'))
  `);
};
