// server/services/lawn-last-visit-scores.js
//
// The last confirmed lawn visit before a scheduled visit, as the four scores
// and the overall score, for the read-only "Last visit" row on the lawn
// completion screens (owner 2026-10-23: "I want the 4 scores and the final
// score"). GATE_LAWN_PROPERTY_HISTORY on: the same property-scoped history the
// report's progress line reads (historyBeforeVisit). Off: the customer's
// latest confirmed assessment on an earlier visit, never this visit's own.
const db = require('../models/db');
const { gateEnvValue } = require('../config/feature-gates');
const { lawnScoreValue, resolveStressDamage, calculateLawnOverallScore } = require('../../shared/lawn-scores.cjs');

const METRIC_KEYS = ['turf_density', 'weed_suppression', 'color_health', 'stress_damage'];
const YMD = /^\d{4}-\d{2}-\d{2}$/;

function ymd(value) {
  if (value == null) return null;
  const text = value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
  return YMD.test(text) ? text : null;
}

// Customer-wide fallback (gate off): rows from lawnAssessment's plain history
// query (la.* + appointment_date). A row tied to a visit dates by that visit's
// scheduled day; a row with no visit by its own service_date.
function previousFromCustomerRows(rows, { serviceId, visitDate }) {
  const day = (row) => ymd(row.service_id ? row.appointment_date : row.service_date);
  return (rows || [])
    .filter((row) => row.confirmed_by_tech === true
      && (!row.service_id || String(row.service_id) !== String(serviceId))
      && day(row) && day(row) < visitDate)
    .sort((a, b) => day(b).localeCompare(day(a))
      || (Date.parse(b.created_at) || 0) - (Date.parse(a.created_at) || 0))[0] || null;
}

function shape(row, date) {
  if (!row) return null;
  const scores = { ...row, stress_damage: resolveStressDamage(row) };
  return {
    date,
    overall: lawnScoreValue(calculateLawnOverallScore(row)),
    scores: Object.fromEntries(METRIC_KEYS.map((key) => [key, lawnScoreValue(scores[key])])),
  };
}

// `scoreScale` (GATE_LAWN_SCORE_SCALE_V2): the score scale this visit's AI read is
// on, so the row beside it is the last visit on the same scale (none at the first
// visit on a new scale). Omitted, the history's own rule picks the newest row's.
async function lastVisitScores(scheduledService, knex = db, { scoreScale } = {}) {
  const visitDate = ymd(scheduledService?.scheduled_date);
  const customerId = scheduledService?.customer_id;
  if (!customerId || !visitDate) return null;
  if (gateEnvValue('GATE_LAWN_PROPERTY_HISTORY')) {
    const { previous } = await require('./lawn-assessment-history')
      .historyBeforeVisit({ customerId, scheduledService, throughVisitDate: visitDate, scoreScale }, knex);
    return shape(previous, previous?.visit_date || null);
  }
  const rows = await knex('lawn_assessments as la')
    .leftJoin('scheduled_services as ss', 'la.service_id', 'ss.id')
    .select('la.*', 'ss.scheduled_date as appointment_date')
    .where('la.customer_id', customerId)
    .where('la.confirmed_by_tech', true);
  const previous = previousFromCustomerRows(rows, { serviceId: scheduledService.id, visitDate });
  return shape(previous, previous && ymd(previous.service_id ? previous.appointment_date : previous.service_date));
}

module.exports = { lastVisitScores, previousFromCustomerRows, shape };
