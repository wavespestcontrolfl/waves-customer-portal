const db = require('../../models/db');
const { detectServiceLine } = require('./service-line-configs');
const { customerVisiblePressureIndex } = require('../pest-pressure/display');

async function buildNeighborhoodPressureContext({ record, knex = db } = {}) {
  if (!record?.id) return undefined;
  const county = String(record.county || record.customer_county || '').trim();
  const postalCode = String(record.zip || record.postal_code || '').trim();
  if (!county && !postalCode) return undefined;

  const serviceLine = record.service_line || detectServiceLine(record.service_type);
  const query = knex('neighborhood_pressure_aggregates')
    .where({ service_line: serviceLine })
    .orderBy('period_start', 'desc')
    .limit(4);

  if (county) query.where({ county });
  if (postalCode) query.where({ postal_code: postalCode });

  const rows = await query.catch(() => []);
  const points = rows
    .filter((row) => Number(row.sample_size || 0) >= 20)
    .map((row) => ({
      periodStart: row.period_start instanceof Date ? row.period_start.toISOString() : String(row.period_start),
      periodEnd: row.period_end instanceof Date ? row.period_end.toISOString() : String(row.period_end),
      avgPressureIndex: customerVisiblePressureIndex(row.avg_pressure_index),
      medianPressureIndex: row.median_pressure_index == null ? undefined : customerVisiblePressureIndex(row.median_pressure_index),
      sampleSize: Number(row.sample_size || 0),
    }))
    .filter((point) => Number.isFinite(point.avgPressureIndex))
    .sort((a, b) => Date.parse(a.periodStart) - Date.parse(b.periodStart));

  if (!points.length) return undefined;
  const latest = points[points.length - 1];
  return {
    points,
    sampleSize: latest.sampleSize,
    customerSummary: `Nearby WaveGuard homes averaged ${latest.avgPressureIndex.toFixed(1)} this month.`,
  };
}

module.exports = {
  buildNeighborhoodPressureContext,
};
