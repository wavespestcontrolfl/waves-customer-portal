// GATE_REPORT_WEB_SLIDER (owner 2026-10-20 "OK BUILD THEM ALL", idea 2b): pairs
// of lawn photos for the before/after slider on the simple web report, and the
// same pairing for the technician's "same angle" guide.
//
// Pairing rule, one place for both callers:
//   - the PREVIOUS visit of the same property (lawn-assessment-history, the
//     module every lawn history read goes through: property scope, move reset,
//     confirmed visits only; an unresolvable property gives no previous visit,
//     so nothing pairs);
//   - the same SHOT KEY on both visits, and only a key whose spot is the same
//     every visit (shared/lawn-photo-shots.json `recheckPairable`: front and
//     back; side is left out because it does not record which side it shows);
//   - both photos must exist, be customer visible and sign to a URL.
// Nothing here writes, sends or calls a model.
const shotList = require('../lawn-photo-shots');
const history = require('../lawn-assessment-history');

const SLIDER_SHOTS = shotList.RECHECK_PAIRABLE_SHOT_ZONES;

// First photo of each slider shot on one assessment: best photo first.
async function photosByShot(knex, assessmentId) {
  const rows = await knex('lawn_assessment_photos')
    .where({ assessment_id: assessmentId, customer_visible: true })
    .whereIn('zone', SLIDER_SHOTS)
    .orderBy('is_best_photo', 'desc')
    .orderBy('quality_score', 'desc')
    .orderBy('photo_order', 'asc');
  const byShot = new Map();
  for (const row of rows) {
    const key = String(row.zone).trim().toLowerCase();
    if (!byShot.has(key)) byShot.set(key, row);
  }
  return byShot;
}

// Shots (in shot-list order) that have a photo on both sides, signed.
async function signedPairs(knex, beforeId, afterId, photoUrl) {
  const [before, after] = await Promise.all([photosByShot(knex, beforeId), photosByShot(knex, afterId)]);
  const out = [];
  for (const key of SLIDER_SHOTS) {
    if (!before.has(key) || !after.has(key)) continue;
    const [beforeUrl, afterUrl] = await Promise.all([photoUrl(before.get(key)), photoUrl(after.get(key))]);
    if (beforeUrl && afterUrl) out.push({ key, label: shotList.SHOT_REPORT_LABELS[key], beforeUrl, afterUrl });
  }
  return out;
}

/**
 * The report payload key `lawnSlider`: { pairs: [{ key, label, before: { url, date }, after: { url, date } }] }
 * or null (no previous visit at this property, or no shot on both visits).
 * Dates are the two visits' calendar days (YYYY-MM-DD).
 *
 * @param {object} args
 * @param {string} args.assessmentId - the report's lawn assessment
 * @param {object} args.knex
 * @param {Function} args.photoUrl - async (photoRow) => signed URL or null
 */
async function buildLawnSlider({ assessmentId, knex, photoUrl }) {
  if (!assessmentId) return null;
  const row = await knex('lawn_assessments').where({ id: assessmentId }).first();
  if (!row) return null;
  const scoped = await history.historyForAssessment(row, { knex });
  if (!scoped.current || scoped.current.id !== row.id || !scoped.previous) return null;
  const { previous, current } = scoped;
  if (!previous.visit_date || !current.visit_date || previous.visit_date >= current.visit_date) return null;
  const pairs = await signedPairs(knex, previous.id, current.id, photoUrl);
  if (!pairs.length) return null;
  return {
    pairs: pairs.map((pair) => ({
      key: pair.key,
      label: pair.label,
      before: { url: pair.beforeUrl, date: previous.visit_date },
      after: { url: pair.afterUrl, date: current.visit_date },
    })),
  };
}

/**
 * The technician's "same angle" guide: last visit's photo for each slider shot,
 * for the visit being photographed now. { front: { url, date }, back: {...} } or null.
 * The previous visit is the one before THIS visit's scheduled day at the same
 * property; this visit's own attempts never count.
 */
async function lastVisitShots({ customerId, scheduledService, throughVisitDate, knex, photoUrl }) {
  if (!customerId || !scheduledService || !throughVisitDate) return null;
  const scoped = await history.historyBeforeVisit({ customerId, scheduledService, throughVisitDate }, knex);
  const previous = scoped.previous;
  if (!previous) return null;
  const byShot = await photosByShot(knex, previous.id);
  const out = {};
  for (const key of SLIDER_SHOTS) {
    if (!byShot.has(key)) continue;
    const url = await photoUrl(byShot.get(key));
    if (url) out[key] = { url, date: previous.visit_date };
  }
  return Object.keys(out).length ? out : null;
}

/**
 * The same guide, found from the scheduled visit the technician is working.
 * Null when the visit is unknown, has no day, or has no earlier lawn visit at this property.
 */
async function lastVisitShotsForService({ serviceId, knex, photoUrl }) {
  if (!serviceId) return null;
  const scheduledService = await knex('scheduled_services').where({ id: serviceId }).first();
  const raw = scheduledService?.scheduled_date;
  const day = raw == null ? '' : (raw instanceof Date ? raw.toISOString() : String(raw)).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  return lastVisitShots({ customerId: scheduledService.customer_id, scheduledService, throughVisitDate: day, knex, photoUrl });
}

module.exports = { buildLawnSlider, lastVisitShots, lastVisitShotsForService, SLIDER_SHOTS };
