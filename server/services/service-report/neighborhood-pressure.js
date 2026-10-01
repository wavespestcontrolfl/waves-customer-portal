const db = require('../../models/db');
const { detectServiceLine } = require('./service-line-configs');
const { customerVisiblePressureIndex } = require('../pest-pressure/display');
const {
  TECH_RATING_CUTOVER_DATE, SCALE_BLENDED, SCALE_TECHNICIAN_RATING, SCALE_UNKNOWN, isComparable,
} = require('../pest-pressure/score-scale');

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
      scoreScale: row.score_scale || null,
    }))
    .filter((point) => Number.isFinite(point.avgPressureIndex))
    .sort((a, b) => Date.parse(a.periodStart) - Date.parse(b.periodStart));

  if (!points.length) return undefined;
  // #4741 (2026-09-24): an aggregate is only comparable with windows of the
  // same scale. The builder averages one scale per window by score-row
  // provenance and stores it in score_scale. A row from before that column
  // (null) is blended only when its window ended before the cutover; otherwise
  // it may mix scales and is unknown. Chart windows comparable to the newest;
  // when the newest is unknown there is no honest average to show yet.
  const ymd = (value) => String(value).slice(0, 10);
  const windowScale = (point) => {
    if ([SCALE_BLENDED, SCALE_TECHNICIAN_RATING].includes(point.scoreScale)) return point.scoreScale;
    return ymd(point.periodEnd) <= TECH_RATING_CUTOVER_DATE ? SCALE_BLENDED : SCALE_UNKNOWN;
  };
  const newest = points[points.length - 1];
  const newestScale = windowScale(newest);
  if (newestScale === SCALE_UNKNOWN) return undefined;
  const sameScale = points.filter((point) => point === newest || isComparable(windowScale(point), newestScale));
  const latest = sameScale[sameScale.length - 1];
  return {
    points: sameScale,
    sampleSize: latest.sampleSize,
    customerSummary: `Nearby WaveGuard homes averaged ${latest.avgPressureIndex.toFixed(1)} this month.`,
  };
}

module.exports = {
  buildNeighborhoodPressureContext,
};
