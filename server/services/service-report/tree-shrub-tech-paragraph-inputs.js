'use strict';

/**
 * Inputs for the tree & shrub "From your technician" paragraph
 * (tree-shrub-tech-paragraph.js), read once at completion from the report data
 * the completion step has just built (the same object the customer report
 * renders) plus the record's own frozen technician decisions and one small read
 * of the last visit.
 *
 * Fail closed: a read that throws propagates, and the caller stores no
 * paragraph. A read that succeeds and finds nothing is an empty input.
 *
 * The technician's decisions govern what the model may see (owner rulings
 * 2026-10-02, 2026-10-05):
 *  - a photo finding the technician HID is not an input (the report nulls its
 *    score, so its category reads "tracking" and is skipped here);
 *  - a finding the technician REWROTE is not an input either: their own words
 *    already speak for that category on the report, and the paragraph neither
 *    repeats nor contradicts them;
 *  - a CONFIRMED finding enters with high confidence, an unreviewed flagged one
 *    with low confidence (the paragraph must hedge it);
 *  - watch-list items marked Seen enter as the technician's own findings. Items
 *    that are refer-only (palm weevil / crown decline, declining palms, trunk
 *    conk) never enter: the office follows those up, and the customer copy rule
 *    is that they are never named.
 *
 * What it never passes on: any customer name, an address, a price, the raw photo
 * list, the photo read's free text, the technician's edit text.
 */

const { ITEMS } = require('../../config/tree-shrub-watch-list');
const { normalizeTechFindings } = require('./tree-shrub-tech-findings');
const { etCalendarDayOf } = require('../../utils/datetime-et');
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
 * The items a technician marked Seen, as customer-safe lowercase labels. Pure.
 * Unknown keys, not-seen entries, refer-only items and the conk item drop.
 */
function seenWatchLabels(watchItems) {
  const out = [];
  for (const entry of Array.isArray(watchItems) ? watchItems : []) {
    if (!entry || entry.state !== 'seen' || !Object.hasOwn(ITEMS, entry.key)) continue;
    const item = ITEMS[entry.key];
    if (item.referOnly || entry.key === 'trunk_conk_base') continue;
    const label = item.label.toLowerCase();
    if (!out.includes(label)) out.push(label);
  }
  return out;
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
    if (decision && decision.action === 'confirmed') out.push({ label: FINDING_LABEL[key], confidence: 'high', source: 'photo' });
    else if (row && FLAGGED.has(row.status)) out.push({ label: FINDING_LABEL[key], confidence: 'low', source: 'photo' });
  }
  return out;
}

// The last completed tree & shrub visit at THIS property (an unresolved
// property proves nothing about which address an earlier visit was at, so it
// gives no prior): its date, product names and seen items. null when none.
async function readLastVisit(record, knex) {
  if (!record.scheduled_service_id || !record.customer_id) return null;
  const sched = await knex('scheduled_services').where({ id: record.scheduled_service_id }).first('property_id');
  if (!sched || !sched.property_id) return null;
  const last = await knex('service_records as sr')
    .join('scheduled_services as ss', 'ss.id', 'sr.scheduled_service_id')
    .where('sr.customer_id', record.customer_id)
    .where('sr.service_line', 'tree_shrub')
    .where('sr.status', 'completed')
    .where('sr.service_date', '<', record.service_date)
    .whereNot('sr.id', record.id)
    .where('ss.property_id', sched.property_id)
    .orderBy('sr.service_date', 'desc')
    .orderBy('sr.created_at', 'desc')
    .orderBy('sr.id', 'desc')
    .first('sr.id', 'sr.service_date', 'sr.structured_notes');
  if (!last) return null;
  const rows = await knex('service_products')
    .where({ service_record_id: last.id })
    .orderBy('created_at')
    .select('product_name');
  return {
    date: etCalendarDayOf(last.service_date),
    products: (rows || []).map((r) => ({ name: r && r.product_name })).filter((p) => p.name),
    watched: seenWatchLabels(parseJsonObject(last.structured_notes).treeShrubWatchItems),
    findings: [],
  };
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
  const seen = seenWatchLabels(structured.treeShrubWatchItems).map((label) => ({ label, confidence: 'high', source: 'seen' }));
  const treatment = reportV2.treatment && typeof reportV2.treatment === 'object' ? reportV2.treatment : {};
  const products = (Array.isArray(treatment.products) ? treatment.products : []).map((p) => ({
    name: p.name,
    activeIngredient: p.activeIngredient,
    kind: p.kind,
    method: p.method,
    targets: p.targets,
  }));

  const prior = await readLastVisit(record, knex);
  const catalogRows = await knex('products_catalog').select('name');

  return normalizeInputs({
    technicianNote: record.technician_notes,
    products,
    findings: [...seen, ...keptPhotoFindings(reportV2.diagnosis, decisions)],
    prior,
    facts: { headline: reportV2.snapshot && reportV2.snapshot.statusHeadline },
    knownProductNames: (catalogRows || []).map((row) => row && row.name),
  });
}

module.exports = { gatherTreeShrubTechParagraphInputs, seenWatchLabels, keptPhotoFindings };
