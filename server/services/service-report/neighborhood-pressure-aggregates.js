const db = require('../../models/db');
const {
  SCALE_BLENDED,
  SCALE_TECHNICIAN_RATING,
  TECH_RATING_CUTOVER_DATE,
} = require('../pest-pressure/score-scale');

function dateOnly(date) {
  return date.toISOString().slice(0, 10);
}

async function buildNeighborhoodPressureAggregates({ now = new Date(), knex = db } = {}) {
  const periodEndDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const periodStartDate = new Date(periodEndDate.getTime() - 30 * 24 * 60 * 60 * 1000);
  const periodStart = dateOnly(periodStartDate);
  const periodEnd = dateOnly(periodEndDate);
  const customerCols = await knex('customers').columnInfo().catch(() => ({}));
  const countySelect = customerCols.county ? 'customers.county' : 'NULL';
  const countyGroupBy = customerCols.county ? 'customers.county,' : '';
  const aggregateCols = await knex('neighborhood_pressure_aggregates').columnInfo().catch(() => ({}));

  // ONE scale per window, chosen by the window's dates and enforced by each
  // reading's score-row provenance (pest_pressure_scores.component_scores), so
  // the stored average never mixes tap-scored and blended readings (#4741;
  // customer-submitted ratings stay blended after the cutover). period_end is
  // exclusive: a window that ended by the cutover holds only blended readings;
  // any window reaching past it averages only technician-rated readings (a
  // reading without a score row, or a customer-rated one, is left out).
  const scoreScale = periodEnd <= TECH_RATING_CUTOVER_DATE ? SCALE_BLENDED : SCALE_TECHNICIAN_RATING;
  const isTap = "(pps.id IS NOT NULL AND jsonb_exists(pps.component_scores, 'technicianActivityRating'))";
  const scaleFilter = scoreScale === SCALE_TECHNICIAN_RATING
    ? `AND ${isTap}`
    : `AND NOT ${isTap}`;

  const result = await knex.raw(`
    SELECT
      ${countySelect} AS county,
      customers.zip AS postal_code,
      COALESCE(service_records.service_line, service_records.service_type, 'unknown') AS service_line,
      ROUND(AVG(service_records.pressure_index)::numeric, 1) AS avg_pressure_index,
      ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY service_records.pressure_index)::numeric, 1) AS median_pressure_index,
      COUNT(*)::int AS sample_size
    FROM service_records
    LEFT JOIN customers ON service_records.customer_id = customers.id
    LEFT JOIN pest_pressure_scores pps ON pps.service_record_id = service_records.id
    WHERE service_records.status = 'completed'
      AND service_records.pressure_index IS NOT NULL
      AND service_records.service_date >= ?
      AND service_records.service_date < ?
      ${scaleFilter}
    GROUP BY ${countyGroupBy} customers.zip, COALESCE(service_records.service_line, service_records.service_type, 'unknown')
  `, [periodStart, periodEnd]);

  const rows = result.rows || [];
  await knex('neighborhood_pressure_aggregates')
    .where({ period_start: periodStart, period_end: periodEnd })
    .del()
    .catch(() => {});

  if (!rows.length) {
    return { inserted: 0, periodStart, periodEnd };
  }

  await knex('neighborhood_pressure_aggregates').insert(rows.map((row) => ({
    county: row.county || null,
    postal_code: row.postal_code || null,
    service_line: row.service_line,
    period_start: periodStart,
    period_end: periodEnd,
    avg_pressure_index: row.avg_pressure_index,
    median_pressure_index: row.median_pressure_index,
    sample_size: row.sample_size,
    // Column arrives with its migration; until then the row is legacy-shaped
    // and the reader treats it conservatively.
    ...(aggregateCols.score_scale ? { score_scale: scoreScale } : {}),
  })));

  return { inserted: rows.length, periodStart, periodEnd };
}

module.exports = {
  buildNeighborhoodPressureAggregates,
};
