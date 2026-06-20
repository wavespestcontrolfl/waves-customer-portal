/**
 * Recurring issue rating extractor.
 *
 * Looks at the current report's findings, then walks prior completed
 * reports in the customer's history (same service_line if provided)
 * and counts how many prior service cycles contained a finding with a
 * matching (category, zone_id) tuple.
 *
 * Spec mapping:
 *   0 prior cycles with a match    → 0
 *   1 prior cycle with a match     → 1
 *   2 prior cycles with matches    → 3
 *   3+ prior cycles with matches   → 5
 *
 * "Same area or pest" — category is the pest/issue category;
 * zone_id is the spatial area. A match on either counts; matches on
 * both are weighted the same as a category-only match (we're measuring
 * recurrence, not exact tuple identity).
 *
 * Returns { value: null, present: false } when no prior service history
 * exists at all — the engine treats that as missing rather than 0.
 */

const MAX_LOOKBACK_REPORTS = 6;
const { applyCustomerVisibleServiceRecordFilter } = require('../history-filter');

function buildSignatureSet(findings) {
  const out = new Set();
  for (const f of findings || []) {
    if (!f || f.category === 'no_activity') continue;
    if (f.category) out.add(`cat:${f.category}`);
    if (f.zone_id) out.add(`zone:${f.zone_id}`);
  }
  return out;
}

function mapPriorCycleCountToRating(count) {
  if (count <= 0) return 0;
  if (count === 1) return 1;
  if (count === 2) return 3;
  return 5;
}

async function extractRecurringIssue({ knex, customerId, serviceRecordId, serviceLine = null, serviceDate = null }) {
  if (!knex || !customerId || !serviceRecordId) {
    throw new TypeError('extractRecurringIssue: knex, customerId, and serviceRecordId are required');
  }

  const currentFindings = await knex('service_findings')
    .where({ service_record_id: serviceRecordId })
    .select('category', 'zone_id');
  const currentSignatures = buildSignatureSet(currentFindings);

  // Cutoff date — `prior` cycles are visits whose service_date is strictly
  // earlier than the CURRENT service's date. Without this filter, walking
  // the customer's history newest-first surfaces visits that came AFTER
  // the current service (e.g., recalculating an older record after newer
  // ones exist, or backfilling historical reports), which would inflate
  // the recurringIssueRating and make scores non-reproducible. Callers
  // that have the date in hand should pass it; otherwise we look it up
  // from service_records.
  let cutoffDate = serviceDate;
  if (cutoffDate === null || cutoffDate === undefined) {
    const currentRecord = await knex('service_records')
      .where({ id: serviceRecordId })
      .select('service_date')
      .first();
    cutoffDate = currentRecord ? currentRecord.service_date : null;
  }

  const priorRecordsQuery = knex('service_records')
    .where('customer_id', customerId)
    .where('status', 'completed')
    .whereNot('id', serviceRecordId)
    .orderBy('service_date', 'desc')
    .limit(MAX_LOOKBACK_REPORTS)
    .select('id', 'service_date');
  applyCustomerVisibleServiceRecordFilter(priorRecordsQuery);
  if (serviceLine) priorRecordsQuery.where('service_line', serviceLine);
  if (cutoffDate) priorRecordsQuery.where('service_date', '<', cutoffDate);
  const priorRecords = await priorRecordsQuery;

  if (priorRecords.length === 0) {
    return { value: null, present: false, source: 'no_history' };
  }

  if (currentSignatures.size === 0) {
    return {
      value: 0,
      present: true,
      source: 'no_current_findings',
      priorCycleMatches: 0,
      priorCyclesChecked: priorRecords.length,
    };
  }

  const priorIds = priorRecords.map((r) => r.id);
  const priorFindings = await knex('service_findings')
    .whereIn('service_record_id', priorIds)
    .select('service_record_id', 'category', 'zone_id');

  const matchesByRecord = new Map();
  for (const f of priorFindings) {
    if (!f || f.category === 'no_activity') continue;
    const sig1 = f.category ? `cat:${f.category}` : null;
    const sig2 = f.zone_id ? `zone:${f.zone_id}` : null;
    if ((sig1 && currentSignatures.has(sig1)) || (sig2 && currentSignatures.has(sig2))) {
      matchesByRecord.set(f.service_record_id, true);
    }
  }

  const priorCycleMatches = matchesByRecord.size;
  return {
    value: mapPriorCycleCountToRating(priorCycleMatches),
    present: true,
    source: 'finding_recurrence',
    priorCycleMatches,
    priorCyclesChecked: priorRecords.length,
  };
}

module.exports = {
  extractRecurringIssue,
  mapPriorCycleCountToRating,
  buildSignatureSet,
  MAX_LOOKBACK_REPORTS,
};
