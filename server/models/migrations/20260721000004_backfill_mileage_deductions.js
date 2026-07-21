/**
 * Backfill persisted mileage deductions to the DATE-EFFECTIVE IRS rate.
 *
 * mileage_log.deduction_amount / irs_rate were written by earlier code that
 * used a year-keyed rate (2026 → 0.70), and an interim table briefly dropped
 * the real 0.76 July-2026 rate. The P&L sums the PERSISTED deduction_amount
 * while the IRS report/CSV RECOMPUTE from the rate table, so stale rows made
 * the two surfaces disagree for the same trips. This one-time backfill makes
 * the persisted values authoritative and consistent with getIrsRate():
 *
 *   - RETIRE legacy auto-classifications first: rows the old webhook/cron
 *     marked is_business=true from a PROXIMITY job match (or geo-fence) were
 *     never operator-substantiated. Under the manual-review policy only an
 *     operator classification (classification_method 'manual'/'manual_review')
 *     substantiates a business trip, so every other is_business=true row is
 *     reset to unclassified/$0 (job context kept as a suggestion). Otherwise
 *     the automatic deductions this PR retires would survive in the backfill.
 *   - is_business = true  → (now only operator-classified) irs_rate = the rate
 *                           effective on trip_date; deduction_amount =
 *                           round(distance_miles * rate, 2)
 *   - everything else     → irs_rate = 0, deduction_amount = 0 (clears any
 *                           stale deduction; unclassified/personal trips
 *                           deduct nothing under the manual-review policy)
 *
 * The rate breakpoints are inlined (a migration must reproduce forever,
 * independent of later service edits) and MUST match IRS_MILEAGE_RATE_TABLE
 * in bouncie-mileage.js: 0.67 (2024, and the table floor), 0.70 (2025),
 * 0.725 (2026-01-01, Notice 2026-10), 0.76 (2026-07-01, Announcement 2026-11).
 * Daily/monthly summary irs_deduction are then recomputed from the corrected
 * rows so the mileage dashboards agree too.
 */

// Kept in one place so the row update and the summary rollup use the same SQL.
const RATE_CASE = `CASE
  WHEN trip_date >= DATE '2026-07-01' THEN 0.76
  WHEN trip_date >= DATE '2026-01-01' THEN 0.725
  WHEN trip_date >= DATE '2025-01-01' THEN 0.70
  ELSE 0.67
END`;

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('mileage_log'))) return;

  await knex.transaction(async (trx) => {
    // 0. RETIRE legacy auto-classifications: any is_business=true row NOT
    //    classified by an operator was auto-set from a proximity match and is
    //    not substantiated. Reset to unclassified/$0, keeping job context as a
    //    suggestion so it resurfaces in the Tax Center review. Idempotent —
    //    once is_business=false the row no longer matches.
    await trx.raw(`
      UPDATE mileage_log
      SET is_business = false,
          purpose = 'unclassified',
          deduction_amount = 0,
          irs_rate = 0,
          classification_method = CASE
            WHEN customer_id IS NOT NULL THEN 'job_match_suggested'
            ELSE 'needs_review' END,
          updated_at = now()
      WHERE is_business = true
        AND classification_method IS DISTINCT FROM 'manual'
        AND classification_method IS DISTINCT FROM 'manual_review'
    `);

    // 1. Operator-classified business trips → date-effective rate + deduction.
    await trx.raw(`
      UPDATE mileage_log
      SET irs_rate = (${RATE_CASE}),
          deduction_amount = ROUND(COALESCE(distance_miles, 0) * (${RATE_CASE})::numeric, 2),
          updated_at = now()
      WHERE is_business = true
    `);

    // 2. Non-business (incl. unclassified/personal) → no deduction. Clears any
    //    stale nonzero deduction the old job-match auto-classifier persisted.
    await trx.raw(`
      UPDATE mileage_log
      SET irs_rate = 0,
          deduction_amount = 0,
          updated_at = now()
      WHERE (is_business IS DISTINCT FROM true)
        AND (COALESCE(deduction_amount, 0) <> 0 OR COALESCE(irs_rate, 0) <> 0)
    `);

    // 3. Recompute daily-summary irs_deduction from the corrected rows (only
    //    the money field moves; miles/counts are unaffected by the rate).
    if (await knex.schema.hasTable('mileage_daily_summary')) {
      await trx.raw(`
        UPDATE mileage_daily_summary s
        SET irs_deduction = COALESCE(t.total, 0),
            irs_rate = (CASE
              WHEN s.summary_date >= DATE '2026-07-01' THEN 0.76
              WHEN s.summary_date >= DATE '2026-01-01' THEN 0.725
              WHEN s.summary_date >= DATE '2025-01-01' THEN 0.70
              ELSE 0.67 END),
            updated_at = now()
        FROM (
          SELECT equipment_id, trip_date, SUM(deduction_amount) AS total
          FROM mileage_log
          WHERE equipment_id IS NOT NULL
          GROUP BY equipment_id, trip_date
        ) t
        WHERE s.equipment_id = t.equipment_id AND s.summary_date = t.trip_date
      `);
    }

    // 4. Recompute monthly-summary irs_deduction from the corrected rows.
    if (await knex.schema.hasTable('mileage_monthly_summary')) {
      await trx.raw(`
        UPDATE mileage_monthly_summary s
        SET irs_deduction = COALESCE(t.total, 0),
            irs_rate = (CASE
              WHEN s.summary_month >= DATE '2026-07-01' THEN 0.76
              WHEN s.summary_month >= DATE '2026-01-01' THEN 0.725
              WHEN s.summary_month >= DATE '2025-01-01' THEN 0.70
              ELSE 0.67 END),
            updated_at = now()
        FROM (
          SELECT equipment_id, date_trunc('month', trip_date)::date AS month, SUM(deduction_amount) AS total
          FROM mileage_log
          WHERE equipment_id IS NOT NULL
          GROUP BY equipment_id, date_trunc('month', trip_date)::date
        ) t
        WHERE s.equipment_id = t.equipment_id AND s.summary_month = t.month
      `);
    }
  });
};

// Irreversible data correction — the prior values were WRONG (stale rates), so
// there is nothing correct to restore. No-op down keeps `migrate:rollback`
// from throwing while refusing to reintroduce the bad figures.
exports.down = async function down() {};
