/**
 * Restore the annual_prepay_terms one-term-per-invoice UNIQUE constraint in
 * environments that ran the withdrawn 20260806210000 experiment (now a no-op
 * placeholder — see its header). The grouped-prepay writer it served was
 * descoped in #3244 review, so no invoice-sharing rows can exist; if any are
 * found this fails loudly rather than silently dropping them. Environments
 * that never ran the original (prod) still hold the constraint → no-op.
 */

exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('annual_prepay_terms'))) return;
  await knex.raw('DROP INDEX IF EXISTS idx_annual_prepay_terms_invoice');
  const [{ exists } = {}] = (await knex.raw(`
    SELECT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'annual_prepay_terms_invoice_unique'
    ) AS exists
  `)).rows;
  if (!exists) {
    const [{ shared } = {}] = (await knex.raw(`
      SELECT EXISTS (
        SELECT 1 FROM annual_prepay_terms
        WHERE prepay_invoice_id IS NOT NULL
        GROUP BY prepay_invoice_id
        HAVING COUNT(*) > 1
      ) AS shared
    `)).rows;
    if (shared) {
      throw new Error('annual_prepay_terms has invoice-sharing rows; resolve them before restoring the unique constraint');
    }
    await knex.raw('ALTER TABLE annual_prepay_terms ADD CONSTRAINT annual_prepay_terms_invoice_unique UNIQUE (prepay_invoice_id)');
  }
};

exports.down = async function () {
  // Nothing to undo: this migration restores the pre-experiment invariant.
};
