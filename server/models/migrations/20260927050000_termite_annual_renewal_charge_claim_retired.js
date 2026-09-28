/**
 * Termite annual plan — the automatic renewal charge (slice 6b, dark behind
 * GATE_TERMITE_ANNUAL_PLAN). Follows 20260926050000 / 050001 / 050002,
 * 20260927020000 and 20260927040000, all PUSHED and frozen (PR #4971) —
 * this column is new; nothing in those files is edited.
 *
 * annual_prepay_terms.renewal_charge_claim_retired_at — Codex #4971 r7 P1:
 * the renewal charge claims its Stripe-attempt fence before it takes the
 * renewal gate, so the recovery leg for a claim that never reached Stripe
 * (7b) could take over a claim whose worker was still on its way. Recovery
 * now RETIRES the claim under the gate (a compare-and-set on this column)
 * before it bells or delivers the fallback pay link, and the charging
 * worker's in-gate re-check refuses a retired claim — so the original
 * worker can never submit once recovery owns the renewal. Kept separate
 * from renewal_charge_never_reached_stripe_belled_at (7b's "done" marker,
 * written only once the fallback verifiably went out, so a failed delivery
 * is retried).
 *
 * Additive and nullable.
 */
const COLUMN = 'renewal_charge_claim_retired_at';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('annual_prepay_terms'))) return;
  if (!(await knex.schema.hasColumn('annual_prepay_terms', COLUMN))) {
    await knex.schema.alterTable('annual_prepay_terms', (t) => t.timestamp(COLUMN, { useTz: true }));
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('annual_prepay_terms'))) return;
  if (await knex.schema.hasColumn('annual_prepay_terms', COLUMN)) {
    await knex.schema.alterTable('annual_prepay_terms', (t) => t.dropColumn(COLUMN));
  }
};
