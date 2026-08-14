/**
 * customers.autopay_enabled: flip the column default TRUE -> FALSE and
 * normalize existing rows to reflect actual enrollment evidence.
 *
 * Why: migration 20260414000031 created the column with default true AND
 * backfilled true for every existing customer, so the flag has carried no
 * signal — hundreds of never-enrolled customers read as "autopay on" in the
 * admin UI while the charge engine (services/autopay-eligibility.js)
 * independently requires a chargeable default Stripe payment_methods row and
 * skips them. This migration makes the flag mean what it says.
 *
 * Behavior-neutral by construction:
 *  - The engine's JS predicate treats only explicit false as disabled and
 *    then requires PM evidence; the SQL predicate uses IS NOT FALSE plus the
 *    same PM EXISTS. Every row this migration flips to false has no
 *    autopay-enabled Stripe payment_methods row, so both predicates already
 *    rejected it. Rows WITH evidence are set explicitly true (NULL rows
 *    included), which both predicates already accepted.
 *  - Explicit false rows (customer opt-outs) are never touched.
 *  - All enrollment paths (customer-autopay.js, billing-v2.js,
 *    contracts-public.js, stripe-webhook.js) set autopay_enabled = true
 *    explicitly, so new enrollments are unaffected by the default change.
 */

exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('customers');
  if (!hasTable) return;
  const hasColumn = await knex.schema.hasColumn('customers', 'autopay_enabled');
  if (!hasColumn) return;

  await knex.raw('ALTER TABLE customers ALTER COLUMN autopay_enabled SET DEFAULT false');

  // Normalize every non-opted-out row to its enrollment evidence: an
  // autopay-enabled Stripe payment_methods row. Never resurrects an explicit
  // false (opt-out outranks evidence — a lingering PM row must not re-enable).
  await knex.raw(`
    UPDATE customers c
       SET autopay_enabled = EXISTS (
             SELECT 1 FROM payment_methods pm
              WHERE pm.customer_id = c.id
                AND pm.processor = 'stripe'
                AND pm.autopay_enabled IS TRUE
           )
     WHERE c.autopay_enabled IS DISTINCT FROM false
       AND c.autopay_enabled IS DISTINCT FROM EXISTS (
             SELECT 1 FROM payment_methods pm
              WHERE pm.customer_id = c.id
                AND pm.processor = 'stripe'
                AND pm.autopay_enabled IS TRUE
           )
  `);
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('customers');
  if (!hasTable) return;
  const hasColumn = await knex.schema.hasColumn('customers', 'autopay_enabled');
  if (!hasColumn) return;
  // Restore the old default only. The row normalization is not reversed:
  // the pre-migration values were the artifact of the 20260414 blanket
  // backfill, not state worth restoring, and re-backfilling true for
  // never-enrolled customers would recreate the misleading flag.
  await knex.raw('ALTER TABLE customers ALTER COLUMN autopay_enabled SET DEFAULT true');
};
