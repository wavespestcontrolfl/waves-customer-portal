/**
 * Supersedes 20260926180000_invoice_billing_review.js (#5021 — the hold
 * design has been replaced by an alert-only design; see the PR body for the
 * ruling history and first-application-sibling-split.js for the current
 * behavior). That migration is PUSHED/FROZEN — it already ran on the
 * preview database — so it is never edited or deleted; this migration
 * drops the three columns it added instead, so the net schema change
 * across both migrations is zero.
 *
 * The redesigned same-trip first-application alert never reads or writes
 * an invoice row at all — the durable record is the admin notification
 * itself (notification-service.notifyAdmin), not a column on `invoices`.
 *
 * hasTable/hasColumn-guarded — safe to run more than once and safe on a
 * database that predates the frozen migration (never applied the columns
 * in the first place).
 */

const COLUMNS = ['billing_review_opened_at', 'billing_review_reason', 'billing_review_context'];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('invoices'))) return;
  for (const col of COLUMNS) {
    if (await knex.schema.hasColumn('invoices', col)) {
      await knex.schema.alterTable('invoices', (t) => {
        t.dropColumn(col);
      });
    }
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('invoices'))) return;
  if (!(await knex.schema.hasColumn('invoices', 'billing_review_opened_at'))) {
    await knex.schema.alterTable('invoices', (t) => {
      t.timestamp('billing_review_opened_at', { useTz: true });
    });
  }
  if (!(await knex.schema.hasColumn('invoices', 'billing_review_reason'))) {
    await knex.schema.alterTable('invoices', (t) => {
      t.text('billing_review_reason');
    });
  }
  if (!(await knex.schema.hasColumn('invoices', 'billing_review_context'))) {
    await knex.schema.alterTable('invoices', (t) => {
      t.jsonb('billing_review_context');
    });
  }
};
