'use strict';

/**
 * Inputs for the tree & shrub "From your technician" paragraph
 * (tree-shrub-tech-paragraph.js), read once at completion from the report data
 * the completion step has just built (the same object the customer report
 * renders) plus the record's own frozen technician decisions.
 *
 * Fail closed: a read that throws propagates, and the caller stores no
 * paragraph. A read that succeeds and finds nothing is an empty input.
 *
 * What the paragraph can use, and nothing else:
 *  - the technician's note (the only text the model ever reads);
 *  - the applied products' display names (no ingredient, target or method);
 *  - the kept photo findings as { key, kind }: a finding the technician HID or
 *    REWROTE is not an input; a CONFIRMED one is `confirmed`; a flagged one nobody
 *    reviewed is `maybe`;
 *  - the technician's own landscape rating (typed completion form).
 * The seasonal watch list (GATE_TS_WATCH_LIST) is NOT an input: it stays
 * tech-facing storage until the owner approves customer wording. The last visit
 * and the report headline are not inputs either.
 */

const { normalizeTechFindings } = require('./tree-shrub-tech-findings');
const { normalizeInputs } = require('./tree-shrub-tech-paragraph');

const FINDING_KEYS = ['pest_activity', 'disease_leaf_spot', 'water_heat_mechanical_stress', 'leaf_color_vigor', 'foliage_fullness'];
const FLAGGED = new Set(['watch', 'needs_attention']);

function parseJsonObject(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}; } catch { return {}; }
}

/**
 * The kept photo findings, in the report's order. A hidden or rewritten finding
 * never enters; a confirmed one is `confirmed`; a flagged diagnosis row nobody
 * reviewed is `maybe`. Pure.
 */
function keptPhotoFindings(diagnosis, decisions) {
  const byKey = new Map((Array.isArray(decisions) ? decisions : []).map((d) => [d.key, d]));
  const rows = new Map((Array.isArray(diagnosis) ? diagnosis : []).filter(Boolean).map((row) => [row.key, row]));
  const out = [];
  for (const key of FINDING_KEYS) {
    const decision = byKey.get(key);
    if (decision && (decision.action === 'hidden' || decision.action === 'edit')) continue;
    const row = rows.get(key);
    if (decision && decision.action === 'confirmed') out.push({ key, kind: 'confirmed' });
    else if (row && FLAGGED.has(row.status)) out.push({ key, kind: 'maybe' });
  }
  return out;
}

/** The technician's landscape rating from the frozen typed completion, or null. */
function landscapeConditionOf(record) {
  const data = parseJsonObject(record && record.service_data);
  const snapshot = data.typedReportSnapshot && typeof data.typedReportSnapshot === 'object' ? data.typedReportSnapshot : {};
  const values = snapshot.values && typeof snapshot.values === 'object' ? snapshot.values : {};
  return typeof values.landscape_condition === 'string' ? values.landscape_condition : null;
}

/**
 * @param {object} args
 * @param {object} args.record  the customer-joined service record (technician_notes, structured_notes, service_data)
 * @param {object} args.data    buildReportV1Data output (reportV2)
 * @returns {object|null} normalized inputs, or null when the visit cannot support a paragraph
 */
function gatherTreeShrubTechParagraphInputs({ record, data }) {
  const reportV2 = data && data.reportV2;
  if (!reportV2 || !record) return null;
  const decisions = normalizeTechFindings(parseJsonObject(record.structured_notes).treeShrubTechFindings);
  const treatment = reportV2.treatment && typeof reportV2.treatment === 'object' ? reportV2.treatment : {};
  return normalizeInputs({
    technicianNote: record.technician_notes,
    products: (Array.isArray(treatment.products) ? treatment.products : []).map((p) => ({ name: p && p.name })),
    findings: keptPhotoFindings(reportV2.diagnosis, decisions),
    landscapeCondition: landscapeConditionOf(record),
  });
}

module.exports = { gatherTreeShrubTechParagraphInputs, keptPhotoFindings, landscapeConditionOf };
