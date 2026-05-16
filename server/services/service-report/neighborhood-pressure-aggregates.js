const db = require('../../models/db');

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
    WHERE service_records.status = 'completed'
      AND service_records.pressure_index IS NOT NULL
      AND service_records.service_date >= ?
      AND service_records.service_date < ?
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
  })));

  return { inserted: rows.length, periodStart, periodEnd };
}

module.exports = {
  buildNeighborhoodPressureAggregates,
};
