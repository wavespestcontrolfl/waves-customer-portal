'use strict';

/**
 * PROTOTYPE ONLY. Facts for the lawn Visit Summary composer (lawn-visit-summary.js),
 * read once at completion from the report data the write gate has just built (the
 * same object the customer report renders) plus one small read: the visit's kept
 * photo findings. No model reads these; code picks fixed sentences from them.
 *
 * Fail closed: a read that throws propagates and the caller stores no summary.
 * A read that succeeds and finds nothing is an empty fact, not a failure.
 *
 * What it never passes on: a product's name, active ingredient or rate (only its
 * KIND), the technician note, the program line, the headline, a score, a date, an
 * address, a customer name, a price, the weather. Not rain: conditions.rain_24h_in
 * mixes observed and forecast hours (application-conditions.js), so observed rain
 * cannot be told apart and the summary never states it.
 */

const { appliedFromProducts } = require('./lawn-visit-memory');
const { keptFindings } = require('./lawn-tech-paragraph-inputs');
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

/**
 * The visit's watering step in the facts' shape, from the FROZEN instruction only
 * (never the live catalog, so a later rule edit changes nothing). The instruction
 * is the authority for the state and the inches; the hours are the window it froze,
 * from completion to its water-in deadline, rounded DOWN so the paragraph can never
 * ask for a longer window than the report's own banner. A deadline under an hour
 * away, or an unreadable one, gives no step: the banner owns it.
 */
function wateringFacts(instruction) {
  if (!instruction || !['water_in', 'hold_then_water_in', 'hold'].includes(instruction.state)) return null;
  if (instruction.state === 'hold') return { state: 'hold' };
  const inches = Number(instruction.waterInInches);
  const at = Date.parse(instruction.completedAt);
  const by = Date.parse(instruction.waterInBy);
  if (!Number.isFinite(inches) || !(inches > 0) || !Number.isFinite(at) || !Number.isFinite(by) || by <= at) return null;
  const hours = Math.floor((by - at) / 3600000);
  return hours >= 1 ? { state: instruction.state, inches, hours } : null;
}

// Products as kinds only; the composer reads a name solely to spot a fertilizer analysis.
function appliedFacts(reportV2) {
  const products = (reportV2.treatment && reportV2.treatment.products) || [];
  return appliedFromProducts(products).map((a) => ({ name: a.name, activeIngredient: a.activeIngredient, kind: a.kind }));
}

// The report's score cards by their own key.
function areaFacts(reportV2) {
  return (Array.isArray(reportV2.diagnosis) ? reportV2.diagnosis : []).map((d) => ({ key: d && d.key, label: d && d.label, status: d && d.status }));
}

// Insight categories that read watch or needs attention, as the composer's topic keys.
// Water and sprinkler coverage belong to the watering banner.
const TOPIC_BY_INSIGHT = Object.freeze({ weeds: 'weeds', damage: 'damage', mowing: 'mowing' });
function watchTopics(reportV2) {
  const topics = [];
  for (const card of Array.isArray(reportV2.insights) ? reportV2.insights : []) {
    const topic = card && TOPIC_BY_INSIGHT[card.category];
    if (topic && ['watch', 'needs_attention'].includes(card.status) && !topics.includes(topic)) topics.push(topic);
  }
  return topics;
}

async function readKeptFindingsFor(knex, assessmentId) {
  const assessment = await knex('lawn_assessments').where({ id: assessmentId }).first('id', 'customer_id', 'confirmed_by_tech');
  if (!assessment) return [];
  const run = await knex('lawn_assessment_runs')
    .where({ assessment_id: assessmentId, customer_id: assessment.customer_id })
    .first('assessment_id', 'customer_id', 'reviewed_findings', 'added_details', 'reviewed_at');
  return keptFindings(run, assessment);
}

/**
 * @param {object} args
 * @param {object} args.record       the customer-joined service record (service_date)
 * @param {object} args.data         buildReportV1Data output (reportV2, lawnAssessment)
 * @param {object} [args.instruction] the visit's frozen watering instruction
 * @param {object} args.knex
 * @returns {Promise<object|null>} normalized facts, or null when the visit cannot support a summary
 */
async function gatherVisitSummaryFacts({ record, data, instruction = null, knex }) {
  const reportV2 = data && data.reportV2;
  const lawnAssessment = data && data.lawnAssessment;
  const assessmentId = lawnAssessment && lawnAssessment.assessmentId;
  if (!reportV2 || assessmentId == null || !record) return null;
  if (lawnAssessment.lawnCopyV6Unfrozen === true) return null; // a degraded report read writes no summary
  return normalizeFacts({
    season: seasonOf(visitMonth(record)),
    applied: appliedFacts(reportV2),
    findings: await readKeptFindingsFor(knex, assessmentId),
    areas: areaFacts(reportV2),
    watering: wateringFacts(instruction),
    watchNext: watchTopics(reportV2),
  });
}

module.exports = { gatherVisitSummaryFacts, wateringFacts, seasonOf, _test: { visitMonth } };
