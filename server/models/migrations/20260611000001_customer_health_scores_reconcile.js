/**
 * Migration — Reconcile customer_health_scores to the shape the code needs.
 *
 * Background: 20260401000037_customer_intelligence.js runs first and creates
 * customer_health_scores with score_date / churn_risk_level / health_score /
 * risk_factors. 20260401000093_customer_health_scoring.js would have created
 * the shape the code actually reads/writes (scored_at / churn_risk /
 * overall_score / churn_signals / sub-scores ...), but its hasTable guard
 * makes it a no-op because 037 already created the table. Result: the nightly
 * customer-intelligence pipeline (health-scorer.js + scheduler.js) and every
 * reader of scored_at / churn_risk fails with undefined-column on the 037
 * shape.
 *
 * This migration is fully idempotent and shape-agnostic: every column add is
 * guarded with hasColumn, so it is correct whether the live table has the 037
 * shape, the 093 shape, the admin-health.js auto-created shape, or a shape
 * already partially patched by customer-health.js's runtime column ensures.
 *
 * 037's columns (score_date, churn_risk_level, health_score, risk_factors,
 * ...) are intentionally NOT dropped — they may hold data.
 *
 * Ensured columns = the union of what current writers write and readers read:
 *  - health-scorer.js writes: overall_score, churn_probability, churn_risk,
 *    churn_signals, upsell_opportunities, next_best_action, engagement_trend,
 *    lifetime_value_estimate, scored_at
 *  - customer-health.js writes: overall_score, score_grade, the six
 *    *_score integers, the six *_details jsonb, churn_risk,
 *    churn_probability, churn_signals, days_until_predicted_churn,
 *    score_trend, previous_score, score_change_30d, scored_at
 *  - scheduler.js / admin-customer-intel.js / admin-health.js /
 *    retention-agent-tools.js / bi-agent-tools.js read: scored_at,
 *    churn_risk, overall_score plus the columns above
 */

exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('customer_health_scores'))) {
    // Nothing to reconcile; 037/093 (or admin-health auto-heal) will create it.
    return;
  }

  const addIfMissing = async (column, builder) => {
    if (!(await knex.schema.hasColumn('customer_health_scores', column))) {
      await knex.schema.alterTable('customer_health_scores', builder);
    }
  };

  // ── Core columns the nightly pipeline depends on ──────────────────
  await addIfMissing('scored_at', t => t.timestamp('scored_at'));
  await addIfMissing('churn_risk', t => t.string('churn_risk'));
  await addIfMissing('overall_score', t => t.integer('overall_score'));
  await addIfMissing('churn_signals', t => t.jsonb('churn_signals'));

  // ── churn_probability exists on both 037 and 093, but guard anyway
  //    (admin-health.js auto-created tables may lack it) ─────────────
  await addIfMissing('churn_probability', t => t.decimal('churn_probability', 5, 4));

  // ── Sub-scores + details written by customer-health.js, read by
  //    admin-health.js ───────────────────────────────────────────────
  await addIfMissing('score_grade', t => t.string('score_grade', 1));
  for (const col of ['payment_score', 'service_score', 'engagement_score', 'satisfaction_score', 'loyalty_score', 'growth_score']) {
    await addIfMissing(col, t => t.integer(col));
  }
  for (const col of ['payment_details', 'service_details', 'engagement_details', 'satisfaction_details', 'loyalty_details', 'growth_details']) {
    await addIfMissing(col, t => t.jsonb(col));
  }
  await addIfMissing('days_until_predicted_churn', t => t.integer('days_until_predicted_churn'));
  await addIfMissing('score_trend', t => t.string('score_trend', 10));
  await addIfMissing('previous_score', t => t.integer('previous_score'));
  await addIfMissing('score_change_30d', t => t.integer('score_change_30d'));

  // ── 037-only columns health-scorer.js writes — must also exist on a
  //    093-shaped table or its inserts fail the other way around ─────
  await addIfMissing('upsell_opportunities', t => t.jsonb('upsell_opportunities'));
  await addIfMissing('next_best_action', t => t.text('next_best_action'));
  await addIfMissing('engagement_trend', t => t.string('engagement_trend'));
  await addIfMissing('lifetime_value_estimate', t => t.decimal('lifetime_value_estimate', 10, 2));

  // ── Backfill new columns from the legacy 037 columns where present,
  //    so pre-existing rows stay visible to the new readers ──────────
  const has = {};
  for (const col of ['score_date', 'churn_risk_level', 'health_score', 'risk_factors', 'created_at']) {
    has[col] = await knex.schema.hasColumn('customer_health_scores', col);
  }

  if (has.score_date && has.created_at) {
    await knex.raw(`
      UPDATE customer_health_scores
      SET scored_at = COALESCE(score_date::timestamp, created_at)
      WHERE scored_at IS NULL
    `);
  } else if (has.created_at) {
    await knex.raw(`
      UPDATE customer_health_scores
      SET scored_at = created_at
      WHERE scored_at IS NULL
    `);
  }

  if (has.churn_risk_level) {
    // 037 vocabulary (healthy/watch/at_risk/critical) matches health-scorer's.
    await knex.raw(`
      UPDATE customer_health_scores
      SET churn_risk = churn_risk_level
      WHERE churn_risk IS NULL AND churn_risk_level IS NOT NULL
    `);
  }

  if (has.health_score) {
    await knex.raw(`
      UPDATE customer_health_scores
      SET overall_score = health_score
      WHERE overall_score IS NULL AND health_score IS NOT NULL
    `);
  }

  if (has.risk_factors) {
    await knex.raw(`
      UPDATE customer_health_scores
      SET churn_signals = risk_factors
      WHERE churn_signals IS NULL AND risk_factors IS NOT NULL
    `);
  }

  // ── Index for latest-per-customer lookups (MAX(scored_at) / ORDER BY
  //    scored_at DESC) used by the pipeline and intel readers ─────────
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_customer_health_scores_customer_scored_at
    ON customer_health_scores (customer_id, scored_at DESC)
  `);
};

exports.down = async function (knex) {
  // Intentionally a no-op. This migration is an additive, idempotent
  // reconcile over an unknown live shape — dropping columns here could
  // destroy data that 093 (or runtime ensures) legitimately created.
  if (await knex.schema.hasTable('customer_health_scores')) {
    await knex.raw('DROP INDEX IF EXISTS idx_customer_health_scores_customer_scored_at');
  }
};
