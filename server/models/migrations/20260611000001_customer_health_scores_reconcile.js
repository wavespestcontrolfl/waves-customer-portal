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

  // ── Collapse to one current row per customer ───────────────────────
  // On the 037 shape there is no UNIQUE(customer_id), so day-keyed inserts
  // may have accumulated multiple rows per customer. Both writers
  // (customer-health.js and customer-intelligence/health-scorer.js) and all
  // readers treat this table as current-row data (latest per customer);
  // per-day history belongs in customer_health_history. Before deleting the
  // non-latest rows, preserve them losslessly: a full-fidelity JSONB copy of
  // every column (whatever the live shape is) goes to
  // customer_health_scores_archive, and a chart-friendly snapshot goes to
  // customer_health_history.
  const dedupeRanking = `
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY customer_id
      ORDER BY scored_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC
    ) AS rn
    FROM customer_health_scores
    WHERE customer_id IS NOT NULL
  `;

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS customer_health_scores_archive (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      source_row_id uuid,
      customer_id uuid,
      payload jsonb NOT NULL,
      archived_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_chs_archive_customer
    ON customer_health_scores_archive (customer_id)
  `);

  // to_jsonb(s) captures every column of the row regardless of which schema
  // variant the live table has — nothing is lost (risk_factors,
  // churn_signals, upsell_opportunities, next_best_action, engagement_trend,
  // lifetime_value_estimate, all legacy 037 fields, everything).
  await knex.raw(`
    WITH ranked AS (${dedupeRanking})
    INSERT INTO customer_health_scores_archive (source_row_id, customer_id, payload)
    SELECT s.id, s.customer_id, to_jsonb(s)
    FROM customer_health_scores s
    JOIN ranked r ON r.id = s.id
    WHERE r.rn > 1
  `);

  if (await knex.schema.hasTable('customer_health_history')) {
    await knex.raw(`
      WITH ranked AS (${dedupeRanking})
      INSERT INTO customer_health_history
        (customer_id, overall_score, payment_score, service_score,
         engagement_score, satisfaction_score, loyalty_score, growth_score,
         churn_risk, scored_at, created_at)
      SELECT s.customer_id,
             COALESCE(s.overall_score, 0),
             s.payment_score, s.service_score, s.engagement_score,
             s.satisfaction_score, s.loyalty_score, s.growth_score,
             LEFT(s.churn_risk, 10),
             COALESCE(s.scored_at::date, s.created_at::date, CURRENT_DATE),
             COALESCE(s.created_at, NOW())
      FROM customer_health_scores s
      JOIN ranked r ON r.id = s.id
      WHERE r.rn > 1
    `);
  }

  await knex.raw(`
    WITH ranked AS (${dedupeRanking})
    DELETE FROM customer_health_scores s
    USING ranked r
    WHERE s.id = r.id AND r.rn > 1
  `);

  // ── Enforce the current-row invariant going forward ────────────────
  // 093-shaped tables already have UNIQUE(customer_id); add an equivalent
  // unique index on 037-shaped tables (safe now that duplicates are gone).
  const existingUnique = await knex.raw(`
    SELECT 1 FROM pg_indexes
    WHERE schemaname = current_schema()
      AND tablename = 'customer_health_scores'
      AND indexdef ILIKE '%unique%'
      AND indexdef ~* '\\(customer_id\\)'
  `);
  if (!existingUnique.rows.length) {
    await knex.raw(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_health_scores_customer_id_uniq
      ON customer_health_scores (customer_id)
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
  // Columns are intentionally NOT dropped. This migration is an additive,
  // idempotent reconcile over an unknown live shape — dropping columns here
  // could destroy data that 093 (or runtime ensures) legitimately created.
  // Only the indexes this migration may have created are removed. The
  // customer_health_scores_archive table is intentionally kept — it holds
  // the only remaining copy of the collapsed historical rows.
  if (await knex.schema.hasTable('customer_health_scores')) {
    await knex.raw('DROP INDEX IF EXISTS idx_customer_health_scores_customer_scored_at');
    await knex.raw('DROP INDEX IF EXISTS idx_customer_health_scores_customer_id_uniq');
  }
};
