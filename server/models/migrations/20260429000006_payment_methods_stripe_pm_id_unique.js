/**
 * payment_methods.stripe_payment_method_id — partial unique index.
 *
 * The original integration migration (20260401000101) declared a
 * non-unique index on this column. Stripe payment_method ids (`pm_xxx`)
 * are globally unique, so duplicate rows for the same `pm_xxx` are
 * always a bug — most likely the savePaymentMethod path firing twice
 * via a webhook race or a setup-intent retry — but nothing on the DB
 * side stopped them from accumulating.
 *
 * Two-step migration:
 *
 *   1. De-duplicate existing rows. Keep the earliest (oldest created_at,
 *      tie-broken by id) per stripe_payment_method_id. Heuristic — older
 *      is more likely to be the original consent-tracked row, and any
 *      autopay default that was on a later duplicate is corrected by the
 *      next setup-intent / save flow.
 *
 *   2. Add a partial unique index — partial because legacy rows
 *      (cash/check, manual entries, pre-Stripe Square migrations) carry
 *      stripe_payment_method_id = NULL and we don't want to enforce
 *      uniqueness on the NULL bucket.
 *
 * Drop the old non-unique index first; the partial unique covers it.
 */

exports.up = async function (knex) {
  // 1. De-duplicate. ROW_NUMBER() over the partition keeps row-1 as
  //    canonical and queues the rest for delete. Filter on
  //    stripe_payment_method_id IS NOT NULL so legacy non-Stripe rows
  //    aren't touched.
  await knex.raw(`
    DELETE FROM payment_methods
     WHERE id IN (
       SELECT id FROM (
         SELECT id,
                ROW_NUMBER() OVER (
                  PARTITION BY stripe_payment_method_id
                  ORDER BY created_at ASC NULLS LAST, id ASC
                ) AS rn
           FROM payment_methods
          WHERE stripe_payment_method_id IS NOT NULL
       ) t
      WHERE t.rn > 1
     )
  `);

  // 2. Drop the old non-unique index (introduced by 20260401000101) so
  //    the new partial unique can take over without leaving an
  //    unused-index warning behind.
  await knex.raw('DROP INDEX IF EXISTS idx_pm_stripe_pm_id');

  // 3. Partial unique — only enforces when the column is set. NULL rows
  //    (legacy / non-Stripe) coexist freely.
  await knex.raw(`
    CREATE UNIQUE INDEX payment_methods_stripe_pm_id_unique
       ON payment_methods (stripe_payment_method_id)
    WHERE stripe_payment_method_id IS NOT NULL
  `);
};

exports.down = async function (knex) {
  // Recreate the old non-unique index. The dedupe in up() is not
  // reversible — rows that were deleted as duplicates stay gone — but
  // the index shape can be rolled back.
  await knex.raw('DROP INDEX IF EXISTS payment_methods_stripe_pm_id_unique');
  await knex.raw('CREATE INDEX IF NOT EXISTS idx_pm_stripe_pm_id ON payment_methods (stripe_payment_method_id)');
};
