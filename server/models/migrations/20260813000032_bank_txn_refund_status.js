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
  // FAIL CLOSED: a refund_applied row represents a REAL reduction already
  // written into an expense. Downgrading the row would abandon that money
  // adjustment with no undo path, and auto-reversing ledger values from a
  // migration is not this system's contract. The operator undoes the
  // refunds in the UI (which restores each expense from its snapshot)
  // before this rollback may proceed.
  const [{ count }] = await knex('bank_transactions').where({ status: 'refund_applied' }).count('* as count');
  if (Number(count) > 0) {
    throw new Error(`cannot roll back: ${count} refund_applied row(s) exist — undo each refund in /admin/tax Bank Import first (restores the adjusted expenses), then rerun`);
  }
  await knex.raw(`
    ALTER TABLE bank_transactions
    DROP CONSTRAINT IF EXISTS bank_transactions_status_check
  `);
  await knex.raw(`
    ALTER TABLE bank_transactions
    ADD CONSTRAINT bank_transactions_status_check
    CHECK (status IN ('unmatched','matched_expense','matched_payout','created_expense','ignored'))
  `);
};
