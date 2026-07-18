/**
 * annual_prepay_terms.dispute_suspended_at
 *
 * Stamped by suspendActiveTermsForDisputedInvoice when an open chargeback
 * demotes a live (active / renewal_pending) term to payment_pending
 * (Codex #2533 round-2). Two consumers:
 *
 *   - Retry safety: the suspend path re-selects payment_pending terms
 *     carrying this marker, so a Stripe retry after a crash between the
 *     status flip and the stamp-clear / billing-mode reset still runs the
 *     follow-up work (the conditional status UPDATE alone matches nothing
 *     on the retry — the term is already payment_pending).
 *   - GUARD 5: getPaymentPendingCustomerIds excludes marked terms from the
 *     monthly-billing suppression. The marker classifies dispute
 *     suspensions directly, unlike the prior_billing_mode heuristic, which
 *     misses LEGACY terms that activated before that column existed (never
 *     backfilled, so their prior stays NULL and they'd wrongly keep the
 *     suppression mid-dispute).
 *
 * Cleared by syncTermForInvoicePayment on the pending→active reactivation
 * (won dispute / re-collection). Left in place on a lost-dispute cancel —
 * inert there, since every consumer also filters on payment_pending.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('annual_prepay_terms'))) return;
  if (!(await knex.schema.hasColumn('annual_prepay_terms', 'dispute_suspended_at'))) {
    await knex.schema.alterTable('annual_prepay_terms', (t) => {
      t.timestamp('dispute_suspended_at', { useTz: true });
    });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('annual_prepay_terms'))) return;
  if (await knex.schema.hasColumn('annual_prepay_terms', 'dispute_suspended_at')) {
    await knex.schema.alterTable('annual_prepay_terms', (t) => {
      t.dropColumn('dispute_suspended_at');
    });
  }
};
