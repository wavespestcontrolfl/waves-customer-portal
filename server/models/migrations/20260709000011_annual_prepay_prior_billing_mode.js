/**
 * annual_prepay_terms.prior_billing_mode
 *
 * Records what customers.billing_mode was BEFORE the annual_prepay stamp
 * (Codex #2505 round-7): a void/refund must restore the customer's exact
 * prior model, and the source_estimate_id heuristic alone gets it wrong for
 * an estimate-flow per_application customer who later buys a MANUAL prepay
 * (Customer 360 / admin coverage — no source estimate on the term). Values:
 *
 *   - 'per_application' / 'monthly_membership'  the literal prior mode
 *   - 'none'                                    prior mode was NULL (legacy
 *                                               monthly) — a sentinel, since
 *                                               a NULL column value means
 *                                               "not recorded" and falls back
 *                                               to the source_estimate_id
 *                                               heuristic for pre-column terms
 *
 * Written once per term by stampAnnualPrepayBillingMode (first stamp wins —
 * renewal syncs and duplicate webhooks never overwrite it with
 * 'annual_prepay'); read by resetBillingModeAfterTermCancel.
 */

exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('annual_prepay_terms', 'prior_billing_mode'))) {
    await knex.schema.alterTable('annual_prepay_terms', (t) => {
      t.string('prior_billing_mode', 32);
    });
  }
};

exports.down = async (knex) => {
  if (await knex.schema.hasColumn('annual_prepay_terms', 'prior_billing_mode')) {
    await knex.schema.alterTable('annual_prepay_terms', (t) => {
      t.dropColumn('prior_billing_mode');
    });
  }
};
