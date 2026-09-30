/**
 * Termite annual plan — the automatic renewal charge (slice 6b, dark behind
 * GATE_TERMITE_ANNUAL_PLAN). Follows 20260926050000 and 20260926050001,
 * both now PUSHED and treated as frozen for safety (PR #4971) — every
 * column here is new; nothing in either prior file is edited.
 *
 * annual_prepay_terms.renewal_charge_never_reached_stripe_belled_at —
 * Codex round-7 P1: reconcileStuckSuccessors' leg 7b (renewal_charge_
 * attempted_at IS NOT NULL but no stripe_invoice_charge_attempts row
 * exists — the claimed attempt provably never reached Stripe) had NO
 * persisted "already handled" marker, so its scan (ordered by
 * renewal_charge_attempted_at, LIMIT-ed) re-selected the SAME oldest page
 * every tick forever once handled — notifyAdmin's own dedupe silently
 * suppressed the repeat bell, but did nothing to shrink the scan's own
 * candidate set, so a backlog of already-handled rows could starve a
 * newer crash-gap row out of ever being reached (the SAME class of bug
 * round-4 P1 already fixed for leg 7a's renewal_charge_skipped_at and
 * round-5/6 P1 fixed for the three exception-bell scans). Stamped once
 * the leg's bell has actually been asked for (fresh or deduped — either
 * way staff has been told and the pay-link delivery was attempted), and
 * excluded on the column directly in leg 7b's own SQL. Additive,
 * nullable.
 */

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('annual_prepay_terms')) {
    if (!(await knex.schema.hasColumn('annual_prepay_terms', 'renewal_charge_never_reached_stripe_belled_at'))) {
      await knex.schema.alterTable('annual_prepay_terms', (t) => {
        t.timestamp('renewal_charge_never_reached_stripe_belled_at', { useTz: true });
      });
    }
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('annual_prepay_terms')) {
    if (await knex.schema.hasColumn('annual_prepay_terms', 'renewal_charge_never_reached_stripe_belled_at')) {
      await knex.schema.alterTable('annual_prepay_terms', (t) => {
        t.dropColumn('renewal_charge_never_reached_stripe_belled_at');
      });
    }
  }
};
