/**
 * Durable billing-review hold on an invoice (redesigned #5021 — owner
 * ruling: "flag, don't auto-split"). Additive; no earlier migration is
 * edited.
 *
 * When a same-trip first-application visit's date diverges from the
 * combined invoice it shares with a sibling (first-application-sibling-
 * split.js), the date-changing writer opens a review on that invoice IN THE
 * SAME TRANSACTION as the date write — never mutating the invoice's money.
 * invoice-helpers.js's assertInvoiceCollectible (the one gate every
 * charge/send seam already calls) refuses to collect while the review is
 * open.
 *
 * invoices.billing_review_opened_at (timestamptz) — non-null = an open
 * review; this is the column the collection gate reads. Null once cleared
 * (by hand, via POST /admin/invoices/:id/billing-review/clear, or
 * automatically when the diverging visits land back on the invoice's date
 * and the invoice was never touched since the review opened).
 *
 * invoices.billing_review_reason (text) — a short code, e.g.
 * 'sibling_date_diverged'. Null when no review is open.
 *
 * invoices.billing_review_context (jsonb) — small provenance blob (the
 * estimate id, the diverging sibling ids, and the invoice's own updated_at
 * AT THE MOMENT the review opened — read back by the auto-clear check to
 * prove the invoice was never touched). Null when no review is open.
 *
 * Additive, nullable, hasTable/hasColumn-guarded — safe to run more than
 * once and safe on a database that predates the table.
 */

exports.up = async function up(knex) {
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

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('invoices'))) return;
  for (const col of ['billing_review_opened_at', 'billing_review_reason', 'billing_review_context']) {
    if (await knex.schema.hasColumn('invoices', col)) {
       
      await knex.schema.alterTable('invoices', (t) => {
        t.dropColumn(col);
      });
    }
  }
};
