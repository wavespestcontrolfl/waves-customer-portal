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
const { selectPhotoFindings } = require('./lawn-photo-findings');
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
  // The report's watering note owns the hold's release condition and the water-in deadline.
  const expiresAt = instruction.expiresAt || null;
  if (instruction.state === 'hold' || instruction.state === 'hold_then_water_in') return { state: instruction.state, expiresAt };
  const inches = Number(instruction.waterInInches);
  const at = Date.parse(instruction.completedAt);
  const by = Date.parse(instruction.waterInBy);
  if (!Number.isFinite(inches) || !(inches > 0) || !Number.isFinite(at) || !Number.isFinite(by) || by <= at) return null;
  const hours = Math.floor((by - at) / 3600000);
  return hours >= 1 ? { state: instruction.state, inches, hours, expiresAt } : null;
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

// The technician-kept PHOTO findings, chosen by the report's own selector for "What the
// photos showed" (confirmed assessment, its own reviewed run, reviewed rows only, symptom
// allowlist). Added details have no photo provenance and never come through. Each keeps its
// read's confidence and whether the photos could determine it.
async function readKeptFindingsFor(knex, assessmentId) {
  const assessment = await knex('lawn_assessments').where({ id: assessmentId }).first('id', 'customer_id', 'confirmed_by_tech');
  if (!assessment) return [];
  const run = await knex('lawn_assessment_runs')
    .where({ assessment_id: assessmentId, customer_id: assessment.customer_id })
    .first('assessment_id', 'customer_id', 'reviewed_findings', 'added_details', 'reviewed_at');
  // Confidence and canDetermine ride on EACH selected row, so the composer's dedupe by label
  // keeps the least-confident evidence.
  return selectPhotoFindings(run, assessment).map((f) => ({ label: f.label, confidence: f.confidence, canDetermine: f.canDetermine }));
}

/**
 * @param {object} args
 * @param {object} args.record       the customer-joined service record (service_date)
 * @param {object} args.data         buildReportV1Data output (reportV2, lawnAssessment)
 * @param {object} [args.instruction] the visit's frozen watering instruction
 * @param {boolean} [args.programVisit] the report's own resolveProgramVisit answer: a recurring lawn plan visit
 * @param {boolean} [args.nextVisitBooked] the report's PROPERTY-scoped next lawn booking exists (lawnNextVisitAtProperty)
 * @param {object} args.knex
 * @returns {Promise<object|null>} normalized facts, or null when the visit cannot support a summary
 */
async function gatherVisitSummaryFacts({ record, data, instruction = null, programVisit = false, nextVisitBooked = false, knex }) {
  const reportV2 = data && data.reportV2;
  const lawnAssessment = data && data.lawnAssessment;
  const assessmentId = lawnAssessment && lawnAssessment.assessmentId;
  if (!reportV2 || assessmentId == null || !record) return null;
  // A degraded report read or a failed product read writes no summary, with or without the watering gate.
  if (lawnAssessment.lawnCopyV6Unfrozen === true || lawnAssessment.productsReadFailed === true) return null;
  return normalizeFacts({
    season: seasonOf(visitMonth(record)),
    applied: appliedFacts(reportV2),
    findings: await readKeptFindingsFor(knex, assessmentId),
    areas: areaFacts(reportV2),
    watering: wateringFacts(instruction),
    watchNext: watchTopics(reportV2),
    // Recurring-plan promises ("each visit adds to the last one", "at the next visit") need a recurring
    // plan visit; the next-visit line also needs a real booking (the report's own scheduled next visit,
    // never a cadence estimate, and never another property's booking: snapshot.nextVisit is customer-wide
    // while copy v6 is off, so the property-scoped answer is passed in).
    recurring: programVisit === true,
    nextVisitBooked: nextVisitBooked === true,
  });
}

module.exports = { gatherVisitSummaryFacts, wateringFacts, seasonOf, _test: { visitMonth } };
