/**
 * Risk factor / conducive condition rating extractor.
 *
 * Waves doesn't have a separate conducive_conditions table — risk signals
 * live in service_findings under risk-relevant categories. The extractor
 * counts findings whose category falls in the risk vocabulary and maps
 * count + max severity to a 0–5 rating per the Pest Pressure spec.
 *
 * Spec mapping:
 *   0 risk findings                  → 0
 *   1 risk finding, low/medium sev   → 1
 *   2 risk findings, low/medium sev  → 2
 *   3+ risk findings                 → 3
 *   any high severity                → 4
 *   any critical severity            → 5
 *
 * "Major unresolved" (4–5) is signalled by severity escalation. A future
 * iteration may incorporate a resolved/unresolved flag on findings;
 * for now we treat the current report as the source of truth.
 *
 * RISK_CATEGORIES is hard-coded in Phase 1. Phase 3 (admin settings UI)
 * will move it into config so admins can extend the vocabulary.
 */

const DEFAULT_RISK_CATEGORIES = Object.freeze([
  'entry_point',
  'moisture',
  'standing_water',
  'sanitation',
  'food_source',
  'harborage',
  'clutter',
  'landscaping',
  'landscaping_touching_structure',
  'gap',
  'crack',
  'debris',
  'trash',
  'neighbor_pressure',
  'conducive_condition',
]);

const SEVERITY_ORDER = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };

function mapRiskFindingsToRating(findings) {
  if (!findings || findings.length === 0) return 0;
  let maxSeverityOrder = -1;
  for (const f of findings) {
    const order = SEVERITY_ORDER[f.severity];
    if (order !== undefined && order > maxSeverityOrder) maxSeverityOrder = order;
  }
  if (maxSeverityOrder >= SEVERITY_ORDER.critical) return 5;
  if (maxSeverityOrder >= SEVERITY_ORDER.high) return 4;
  if (findings.length >= 3) return 3;
  if (findings.length === 2) return 2;
  return 1;
}

async function extractRiskFactorRating({ knex, serviceRecordId, riskCategories = DEFAULT_RISK_CATEGORIES }) {
  if (!knex || !serviceRecordId) {
    throw new TypeError('extractRiskFactorRating: knex and serviceRecordId are required');
  }

  const findings = await knex('service_findings')
    .where({ service_record_id: serviceRecordId })
    .whereIn('category', riskCategories)
    .select('category', 'severity');

  const record = await knex('service_records').where({ id: serviceRecordId }).first('status');
  if (!record) {
    return { value: null, present: false, source: 'no_record' };
  }

  // If the report is still pending and there's no risk data yet, we can't
  // claim "no risk factors" — treat as missing so the engine recalculates
  // without this component.
  if (findings.length === 0 && record.status !== 'completed') {
    return { value: null, present: false, source: 'pending' };
  }

  return {
    value: mapRiskFindingsToRating(findings),
    present: true,
    source: 'findings',
    count: findings.length,
  };
}

module.exports = {
  extractRiskFactorRating,
  mapRiskFindingsToRating,
  DEFAULT_RISK_CATEGORIES,
};
