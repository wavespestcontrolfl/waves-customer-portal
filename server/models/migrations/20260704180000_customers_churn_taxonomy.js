/**
 * Churn-reason taxonomy (Growth Command Center Phase 7).
 *
 * - churn_reason_code: CHECK-constrained enum — the Pareto card and any churn
 *   analytics group on this, so free-text drift is fenced out at the schema.
 *   Nullable: rows churned before this ships stay NULL until the (owner-
 *   authorized, dry-run-first) backfill classifies them; the read side treats
 *   NULL as 'unclassified'.
 * - churn_reason_detail: the customer's own words (the legacy churn_reason is
 *   varchar(30) — too short to keep the actual cancellation text).
 * - churn_mrr: the monthly rate AT churn. customers.monthly_rate gets zeroed/
 *   repriced over time, so without a snapshot the Pareto's dollar bars would
 *   rewrite history.
 */

const CODES = [
  'price', 'moving', 'service_quality', 'results', 'competitor',
  'seasonal_pause', 'financial', 'no_longer_needed', 'other', 'unclassified',
];
const CONSTRAINT = 'customers_churn_reason_code_check';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn('customers', 'churn_reason_code'))) {
    await knex.schema.alterTable('customers', (t) => {
      t.string('churn_reason_code', 40).nullable();
    });
  }
  if (!(await knex.schema.hasColumn('customers', 'churn_reason_detail'))) {
    await knex.schema.alterTable('customers', (t) => {
      t.text('churn_reason_detail').nullable();
    });
  }
  if (!(await knex.schema.hasColumn('customers', 'churn_mrr'))) {
    await knex.schema.alterTable('customers', (t) => {
      t.decimal('churn_mrr', 10, 2).nullable();
    });
  }
  // CHECK constraint, guarded for re-runs.
  const [{ exists }] = (await knex.raw(
    "SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = ?) as exists",
    [CONSTRAINT],
  )).rows;
  if (!exists) {
    const list = CODES.map((c) => `'${c}'`).join(', ');
    await knex.raw(
      `ALTER TABLE customers ADD CONSTRAINT ${CONSTRAINT}
       CHECK (churn_reason_code IS NULL OR churn_reason_code IN (${list}))`,
    );
  }
};

exports.down = async function down(knex) {
  await knex.raw(`ALTER TABLE customers DROP CONSTRAINT IF EXISTS ${CONSTRAINT}`);
  for (const col of ['churn_reason_code', 'churn_reason_detail', 'churn_mrr']) {
    if (await knex.schema.hasColumn('customers', col)) {
      await knex.schema.alterTable('customers', (t) => {
        t.dropColumn(col);
      });
    }
  }
};
