/**
 * Billing lane goes explicit — extend customers.billing_mode to the full
 * lane set and classify the provably-monthly cohort.
 *
 * Owner directive 2026-07-17 (after the membership double-billing incident):
 * "one explicit 'how does this customer pay' setting per customer — set in
 * one place, and every flow reads that instead of inferring."
 *
 * 1. CHECK gains 'per_visit' and 'one_time' alongside the existing
 *    'monthly_membership' / 'per_application' / 'annual_prepay'.
 * 2. Backfill is EVIDENCE-BASED and minimal: customers with a LIVE annual
 *    prepay term (active/renewal_pending AND covering today — a future-
 *    dated term must not park them in a lane the cron skips before
 *    coverage starts, Codex r8) are stamped 'annual_prepay' — the same
 *    rule the annual-prepay service applies when a prepay invoice pays. Then customers with an actual collected
 *    "WaveGuard Monthly" dues payment are stamped 'monthly_membership' —
 *    UNLESS any annual term is live or in flight, since a historical dues
 *    payment must not put a term-covered customer back in the monthly lane
 *    where the previsit sweep would dun them for "late dues" (Codex r6).
 *    Everyone else stays NULL (legacy inference, behavior-preserving) for
 *    the owner to classify via the new profile control. Rows already
 *    carrying a mode are untouched. Prod dry-run 2026-07-17: 2 annual
 *    stamps, 4 monthly stamps, zero overlap.
 */

exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('customers');
  if (!hasTable) return;
  const hasMode = await knex.schema.hasColumn('customers', 'billing_mode');
  if (!hasMode) return;

  await knex.raw('ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_billing_mode_check');
  await knex.raw(`
    ALTER TABLE customers
    ADD CONSTRAINT customers_billing_mode_check
    CHECK (billing_mode IS NULL OR billing_mode IN ('monthly_membership', 'per_visit', 'per_application', 'annual_prepay', 'one_time'))
  `);

  const hasTerms = await knex.schema.hasTable('annual_prepay_terms');
  if (hasTerms) {
    await knex.raw(`
      UPDATE customers SET billing_mode = 'annual_prepay'
      WHERE billing_mode IS NULL
        AND deleted_at IS NULL
        AND id IN (
          SELECT customer_id FROM annual_prepay_terms
          WHERE status IN ('active', 'renewal_pending')
            AND term_start <= CURRENT_DATE
            AND term_end >= CURRENT_DATE
        )
    `);
  }

  const hasPayments = await knex.schema.hasTable('payments');
  if (!hasPayments) return;
  await knex.raw(`
    UPDATE customers SET billing_mode = 'monthly_membership'
    WHERE billing_mode IS NULL
      AND deleted_at IS NULL
      AND id IN (
        SELECT DISTINCT customer_id FROM payments
        WHERE status IN ('paid', 'processing')
          AND description LIKE '%WaveGuard Monthly%'
      )
      ${hasTerms ? `AND id NOT IN (
        SELECT customer_id FROM annual_prepay_terms
        WHERE status IN ('active', 'renewal_pending', 'payment_pending', 'pending')
      )` : ''}
  `);
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('customers');
  if (!hasTable) return;
  const hasMode = await knex.schema.hasColumn('customers', 'billing_mode');
  if (!hasMode) return;

  // The new lane values must be cleared before the narrower CHECK can be
  // re-added; backfilled memberships revert to NULL (legacy inference gives
  // them identical behavior). The membership reversal uses the same
  // evidence predicate as the backfill, so exactly the rows up() stamped
  // (or hand-set rows that match the identical evidence — for which NULL
  // behaves identically) return to legacy inference (Codex r1).
  // The annual_prepay stamps are deliberately NOT reversed: the value is in
  // the restored CHECK, and an evidence-based reversal cannot distinguish
  // up()'s stamps from the service-stamped annual customers that predate
  // this migration — nulling those would let legacy tier/rate inference put
  // prepaid customers back in the monthly-dues cron (double-charge risk).
  await knex('customers').whereIn('billing_mode', ['per_visit', 'one_time']).update({ billing_mode: null });
  const hasPayments = await knex.schema.hasTable('payments');
  if (hasPayments) {
    await knex.raw(`
      UPDATE customers SET billing_mode = NULL
      WHERE billing_mode = 'monthly_membership'
        AND id IN (
          SELECT DISTINCT customer_id FROM payments
          WHERE status IN ('paid', 'processing')
            AND description LIKE '%WaveGuard Monthly%'
        )
    `);
  }
  await knex.raw('ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_billing_mode_check');
  await knex.raw(`
    ALTER TABLE customers
    ADD CONSTRAINT customers_billing_mode_check
    CHECK (billing_mode IS NULL OR billing_mode IN ('monthly_membership', 'per_application', 'annual_prepay'))
  `);
};
