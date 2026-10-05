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
 * The technician's decisions govern what the model may see (owner ruling
 * 2026-10-02, GATE_TS_TECH_FINDINGS_COPY):
 *  - a photo finding the technician HID is not an input (the report nulls its
 *    score, so its category reads "tracking" and is skipped here);
 *  - a finding the technician REWROTE is not an input either: their own words
 *    already speak for that category on the report, and the paragraph neither
 *    repeats nor contradicts them;
 *  - a CONFIRMED finding enters with high confidence, an unreviewed flagged one
 *    with low confidence (the paragraph must hedge it);
 *  - the seasonal watch list (the frozen watch items) is NOT an
 *    input: it stays tech-facing storage only (GATE_TS_WATCH_LIST) until the
 *    owner approves customer wording for a confirmed watch item. A watch item
 *    the technician wants the customer to hear about goes in the note;
 *  - the last visit is NOT an input, and neither is the report's headline (a
 *    headline built from a low-confidence photo read would otherwise license the
 *    very condition the paragraph must hedge).
 *
 * What it never passes on: any customer name, an address, a price, the raw photo
 * list, the photo read's free text, the technician's edit text.
 */

const { normalizeTechFindings } = require('./tree-shrub-tech-findings');
const { normalizeInputs } = require('./tree-shrub-tech-paragraph');

const FINDING_KEYS = ['pest_activity', 'disease_leaf_spot', 'water_heat_mechanical_stress', 'leaf_color_vigor', 'foliage_fullness'];

// Symptom labels for the kept photo findings: signals, never a diagnosis, and
// worded without the watering words the paragraph validator rejects.
const FINDING_LABEL = {
  pest_activity: 'pest pressure signals',
  disease_leaf_spot: 'leaf spot signals',
  water_heat_mechanical_stress: 'heat or pruning stress',
  leaf_color_vigor: 'off-color leaves',
  foliage_fullness: 'thin foliage',
};

const FLAGGED = new Set(['watch', 'needs_attention']);

function parseJsonObject(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}; } catch { return {}; }
}

/**
 * The kept photo findings, in the report's order: a finding the technician
 * confirmed (the report prints it as the technician's whatever the photo score),
 * or a flagged diagnosis row nobody reviewed (to be hedged). A hidden or
 * rewritten finding never enters. Pure.
 */
function keptPhotoFindings(diagnosis, decisions) {
  const byKey = new Map((Array.isArray(decisions) ? decisions : []).map((d) => [d.key, d]));
  const rows = new Map((Array.isArray(diagnosis) ? diagnosis : []).filter(Boolean).map((row) => [row.key, row]));
  const out = [];
  for (const key of FINDING_KEYS) {
    const decision = byKey.get(key);
    if (decision && (decision.action === 'hidden' || decision.action === 'edit')) continue;
    const row = rows.get(key);
    if (decision && decision.action === 'confirmed') out.push({ label: FINDING_LABEL[key], confidence: 'high' });
    else if (row && FLAGGED.has(row.status)) out.push({ label: FINDING_LABEL[key], confidence: 'low' });
  }
  return out;
}

/**
 * @param {object} args
 * @param {object} args.record  the customer-joined service record (technician_notes, structured_notes, ...)
 * @param {object} args.data    buildReportV1Data output (reportV2)
 * @param {object} args.knex
 * @returns {Promise<object|null>} normalized inputs, or null when the visit cannot support a paragraph
 */
async function gatherTreeShrubTechParagraphInputs({ record, data, knex }) {
  const reportV2 = data && data.reportV2;
  if (!reportV2 || !record) return null;

  const structured = parseJsonObject(record.structured_notes);
  const decisions = normalizeTechFindings(structured.treeShrubTechFindings);
  const treatment = reportV2.treatment && typeof reportV2.treatment === 'object' ? reportV2.treatment : {};
  const products = (Array.isArray(treatment.products) ? treatment.products : []).map((p) => ({
    name: p.name,
    activeIngredient: p.activeIngredient,
    kind: p.kind,
    method: p.method,
    targets: p.targets,
  }));

  const catalogRows = await knex('products_catalog').select('name');

  return normalizeInputs({
    technicianNote: record.technician_notes,
    products,
    findings: keptPhotoFindings(reportV2.diagnosis, decisions),
    knownProductNames: (catalogRows || []).map((row) => row && row.name),
  });
}

module.exports = { gatherTreeShrubTechParagraphInputs, keptPhotoFindings };
