/**
 * Technician-observed activity rating extractor.
 *
 * Maps service_findings severities for the current report to a 0–5 rating
 * per the Pest Pressure spec:
 *
 *   0 — No evidence found
 *   1 — Minor evidence (one low-severity finding)
 *   2 — Light activity (multiple low-severity findings)
 *   3 — Active infestation signs (medium severity)
 *   4 — Heavy activity (high severity)
 *   5 — Severe activity (critical severity)
 *
 * Returns null (missing) when the service report has no findings AND is
 * not yet completed — we can't claim "no evidence" until the tech finished.
 * Returns 0 when the report is completed and has zero qualifying findings.
 *
 * The 'no_activity' category is treated as an explicit zero — Waves uses
 * it to record "tech looked and found nothing."
 */

const SEVERITY_TO_BUCKET = {
  info: 0,
  low: 1,
  medium: 3,
  high: 4,
  critical: 5,
};

const COMPLETED_STATUS = 'completed';

function mapFindingsToRating(findings) {
  if (!findings || findings.length === 0) return 0;

  const explicitZero = findings.some((f) => f && f.category === 'no_activity');
  if (explicitZero && findings.every((f) => !f || f.category === 'no_activity')) {
    return 0;
  }

  let max = 0;
  let lowCount = 0;
  for (const f of findings) {
    if (!f || f.category === 'no_activity') continue;
    const bucket = SEVERITY_TO_BUCKET[f.severity];
    if (bucket === undefined) continue;
    if (bucket > max) max = bucket;
    if (f.severity === 'low') lowCount += 1;
  }

  // Promote two-or-more low findings to "light activity" (2) rather than
  // staying at "minor evidence" (1) — matches the spec mapping.
  if (max === 1 && lowCount >= 2) return 2;

  return max;
}

async function extractTechnicianRating({ knex, serviceRecordId }) {
  if (!knex || !serviceRecordId) {
    throw new TypeError('extractTechnicianRating: knex and serviceRecordId are required');
  }
  const record = await knex('service_records').where({ id: serviceRecordId }).first('status');
  if (!record) {
    return { value: null, present: false, source: 'no_record' };
  }

  const findings = await knex('service_findings')
    .where({ service_record_id: serviceRecordId })
    .select('id', 'category', 'severity');

  if (findings.length === 0 && record.status !== COMPLETED_STATUS) {
    return { value: null, present: false, source: 'pending' };
  }

  const value = mapFindingsToRating(findings);
  return {
    value,
    present: true,
    source: 'findings',
    findingCount: findings.length,
  };
}

module.exports = {
  extractTechnicianRating,
  mapFindingsToRating,
  SEVERITY_TO_BUCKET,
};
