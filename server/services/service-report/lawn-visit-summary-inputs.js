'use strict';

/**
 * PROTOTYPE ONLY. Facts for the lawn Visit Summary writer (lawn-visit-summary.js),
 * read once at completion from the report data the write gate has just built (the
 * same object the customer report renders) plus two small reads: the visit's kept
 * photo findings, and the product catalog (each applied product's watering rule
 * and the catalog's names, a defense list for the validator).
 *
 * Fail closed: a read that throws propagates and the caller stores no summary.
 * A read that succeeds and finds nothing is an empty fact, not a failure.
 *
 * What it never passes on: a product name to the model (only its CATEGORY; the
 * name rides the facts for the validator), a rate, a score, a date, an address, a
 * customer name, a price.
 */

const { appliedFromProducts } = require('./lawn-visit-memory');
const { keptFindings } = require('./lawn-tech-paragraph-inputs');
const { WATCH_TOPIC } = require('./lawn-since-last-copy');
const { resolveWateringRule } = require('./lawn-watering-rule');
const { normalizeFacts } = require('./lawn-visit-summary');

// Florida seasons by visit month.
function seasonOf(month) {
  const m = Number(month);
  if ([3, 4, 5].includes(m)) return 'spring';
  if ([6, 7, 8, 9].includes(m)) return 'summer';
  if ([10, 11].includes(m)) return 'fall';
  if ([12, 1, 2].includes(m)) return 'winter';
  return null;
}

function visitMonth(record) {
  const raw = record && (record.service_date || record.serviceDate);
  const ymd = raw instanceof Date ? raw.toISOString().slice(0, 10) : String(raw || '').slice(0, 10);
  const m = /^\d{4}-(\d{2})-\d{2}$/.exec(ymd);
  return m ? Number(m[1]) : null;
}

function parseJsonObject(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  try { const p = JSON.parse(value); return p && typeof p === 'object' && !Array.isArray(p) ? p : {}; } catch { return {}; }
}

// Did rain fall in the day before the visit? null when the record has no reading.
function recentRainOf(record) {
  const conditions = parseJsonObject(record && record.conditions);
  const n = conditions.rain_24h_in;
  if (n === null || n === undefined || n === '' || !Number.isFinite(Number(n))) return null;
  return Number(n) >= 0.1;
}

/**
 * The visit's watering step in the facts' shape. The frozen instruction is the
 * authority for the STATE and the inches (it resolved every product's rule, the
 * holds and the same-day cutoff). The hours come from the water-in rules
 * themselves (the shortest window, exactly as the instruction builder takes it),
 * bounded by the deadline the instruction froze, so the paragraph can never ask
 * for a longer window than the report's own banner.
 */
function wateringFacts(instruction, ruleRows) {
  if (!instruction || !['water_in', 'hold_then_water_in', 'hold'].includes(instruction.state)) return null;
  if (instruction.state === 'hold') return { state: 'hold' };
  const inches = Number(instruction.waterInInches);
  const ruleHours = (Array.isArray(ruleRows) ? ruleRows : [])
    .map((row) => resolveWateringRule(row))
    .filter((rule) => rule && rule.mode === 'water_in')
    .map((rule) => Number(rule.water_in_by_hours))
    .filter((h) => Number.isFinite(h) && h > 0);
  let hours = ruleHours.length ? Math.min(...ruleHours) : null;
  const at = Date.parse(instruction.completedAt);
  const by = Date.parse(instruction.waterInBy);
  if (Number.isFinite(at) && Number.isFinite(by) && by > at) {
    const window = Math.ceil((by - at) / 3600000);
    hours = hours == null ? window : Math.min(hours, window);
  }
  if (!Number.isFinite(inches) || !(inches > 0) || !Number.isFinite(hours)) return null;
  return { state: instruction.state, inches, hours };
}

/**
 * @param {object} args
 * @param {object} args.record       the customer-joined service record (technician_notes, service_date, conditions)
 * @param {object} args.data         buildReportV1Data output (reportV2, lawnAssessment)
 * @param {object} [args.instruction] the visit's watering instruction
 * @param {object} args.knex
 * @returns {Promise<object|null>} normalized facts, or null when the visit cannot support a summary
 */
async function gatherVisitSummaryFacts({ record, data, instruction = null, knex }) {
  const reportV2 = data && data.reportV2;
  const lawnAssessment = data && data.lawnAssessment;
  const assessmentId = lawnAssessment && lawnAssessment.assessmentId;
  if (!reportV2 || assessmentId == null || !record) return null;
  if (lawnAssessment.lawnCopyV6Unfrozen === true) return null; // a degraded report read writes no summary

  const treatmentProducts = (reportV2.treatment && reportV2.treatment.products) || [];
  const methodOf = new Map(treatmentProducts.map((p) => [p && p.name, p && p.method]));
  const applied = appliedFromProducts(treatmentProducts).map((a) => ({ ...a, method: methodOf.get(a.name) || null }));

  // Catalog: every name (validator defense) and the applied products' full rows (watering rules).
  const catalog = await knex('products_catalog').select('name');
  const appliedNames = applied.map((a) => a.name);
  const ruleRows = appliedNames.length ? await knex('products_catalog').whereIn('name', appliedNames).select('*') : [];

  const findingsRun = await (async () => {
    const assessment = await knex('lawn_assessments').where({ id: assessmentId }).first('id', 'customer_id', 'confirmed_by_tech');
    if (!assessment) return [];
    const run = await knex('lawn_assessment_runs')
      .where({ assessment_id: assessmentId, customer_id: assessment.customer_id })
      .first('assessment_id', 'customer_id', 'reviewed_findings', 'added_details', 'reviewed_at');
    return keptFindings(run, assessment);
  })();

  const snapshot = reportV2.snapshot || {};
  const programLine = snapshot.seasonalNoteSource === 'program' ? snapshot.seasonalNote : null;

  const insights = Array.isArray(reportV2.insights) ? reportV2.insights : [];
  const watch = [];
  for (const card of insights) {
    const topic = card && WATCH_TOPIC[card.category];
    if (!topic || card.category === 'water' || card.category === 'coverage') continue;
    if (!['watch', 'needs_attention'].includes(card.status)) continue;
    if (!watch.includes(topic)) watch.push(topic);
  }
  for (const f of findingsRun) if (!watch.includes(f.label)) watch.push(f.label);

  return normalizeFacts({
    season: seasonOf(visitMonth(record)),
    programLine,
    applied,
    findings: findingsRun,
    areas: (Array.isArray(reportV2.diagnosis) ? reportV2.diagnosis : []).map((d) => ({ label: d && d.label, status: d && d.status })),
    headline: snapshot.statusHeadline,
    watering: wateringFacts(instruction, ruleRows),
    recentRain: recentRainOf(record),
    watchNext: watch.length ? watch : ['how the lawn responds to today’s treatment'],
    technicianNote: record.technician_notes,
    knownProductNames: (catalog || []).map((row) => row && row.name),
  });
}

module.exports = { gatherVisitSummaryFacts, wateringFacts, seasonOf, recentRainOf, _test: { visitMonth } };
