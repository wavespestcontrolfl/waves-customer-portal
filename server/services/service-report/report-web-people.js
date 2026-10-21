'use strict';

/**
 * GATE_REPORT_WEB_PEOPLE (owner 2026-10-20): the `webPeople` payload key of the simple web service report.
 *
 * Four small decisions, all from data the report already holds or a read-only query. Nothing is written and nothing is
 * sent. Every sentence the customer reads is a fixed sentence built on the page from these values; no value here is
 * model text.
 *
 *   tech       first name, photo and FDACS applicator number from the staff record the report already uses, plus how
 *              many visits that technician has done at this home.
 *   treatedMap true when the technician traced a treatment map for this visit (lawn, pest and the other lines).
 *   nextVisit  the next visit at this property (date and window only, never a reschedule link).
 *   review     the Google review link, only for a good visit and a quiet customer (see reviewLinkFor).
 */

const { isPerformedVisitOutcome } = require('../pest-pressure/first-visit');
const { serviceRecordSuppressesCustomerArtifacts } = require('../pest-pressure/history-filter');
const { isGenericTechnicianLabel } = require('../../utils/technician-name');
const linkage = require('../estimate-property-linkage');
const { resolveVisitPropertyScope, sameResolvedProperty, customerHasOnlyPrimaryPremises } = require('./visit-property-scope');

const REVIEW_MIN_LAWN_SCORE = 85;
const QUIET_DAYS = 30;
// satisfaction_responses.rating is 1-10; 6 or lower is not a happy customer.
const LOW_RATING_MAX = 6;
const NEGATIVE_CALL_SENTIMENTS = ['negative', 'frustrated'];
const MIN_VISITS_TO_SAY = 2;
// The record read is capped; a capped read cannot give an exact count, so it gives none.
const RECORD_READ_CAP = 500;

function parseJsonObject(value) {
  if (value && typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function firstNameOf(name) {
  return String(name || '').trim().split(/\s+/)[0] || null;
}

function lawnScoreOf(data) {
  const raw = data?.lawnAssessment?.scores?.overallScore;
  if (raw == null || raw === '') return null;
  const score = Number(raw);
  return Number.isFinite(score) ? score : null;
}

// A pest visit with nothing to follow up: treated, not a re-service, no high finding, no area that needed attention
// and no follow-up planned. coverageEvidence is the recorded coverage items ({ status, needsFollowUp }) from the build,
// read whether or not the report displays coverage; without it (not an array) the visit is not proven clean.
function isCleanPestVisit(data, coverageEvidence) {
  // treatmentPerformed null means unknown (the product load failed): not clean.
  if (data?.serviceLine !== 'pest' || data.isCallback === true || data.treatmentPerformed !== true) return false;
  if (!Array.isArray(coverageEvidence)) return false;
  const findings = Array.isArray(data.findings) ? data.findings : [];
  if (findings.some((f) => ['critical', 'high'].includes(String(f?.severity || '').toLowerCase()))) return false;
  const needsAction = ['inaccessible', 'skipped', 'not_serviced', 'needs_attention', 'needs_follow_up'];
  // A completed or treated item can still carry a recorded follow-up (service-coverage.js needsFollowUp).
  if (coverageEvidence.some((item) => item?.needsFollowUp === true || needsAction.includes(String(item?.status || '').toLowerCase()))) return false;
  return !data.followUp && !data.reportV2?.followUp;
}

function goodVisit(data, coverageEvidence) {
  if (data?.serviceLine === 'lawn') {
    const score = lawnScoreOf(data);
    return score != null && score >= REVIEW_MIN_LAWN_SCORE;
  }
  return isCleanPestVisit(data, coverageEvidence);
}

// True when the customer complained, rated low or sounded unhappy on a call in the last QUIET_DAYS. A failed read
// throws, and the caller then shows no link: the link needs proof of a quiet month.
async function hadNegativeContact(knex, customerId, now) {
  const since = new Date(now.getTime() - QUIET_DAYS * 86400000);
  const [complaint, lowRating, badCall] = await Promise.all([
    knex('customer_interactions').where({ customer_id: customerId, interaction_type: 'complaint' })
      .where('created_at', '>', since).first('id'),
    knex('satisfaction_responses').where('customer_id', customerId).where('created_at', '>', since)
      .where((qb) => qb.where('rating', '<=', LOW_RATING_MAX).orWhere('flagged_for_followup', true)).first('id'),
    knex('call_log').where('customer_id', customerId).where('created_at', '>', since)
      .whereIn('sentiment', NEGATIVE_CALL_SENTIMENTS).first('id'),
  ]);
  return Boolean(complaint || lowRating || badCall);
}

// The same eligibility the old report's review card used (customer has not already left a review, the server-resolved
// office), tightened to a good visit and a quiet month.
async function reviewLinkFor(data, service, knex, now, { readsOk, coverageEvidence }) {
  // The clean-visit check reads findings and coverage; when either read failed the visit is not proven clean.
  if (readsOk !== true) return null;
  if (data.hasLeftGoogleReview || data.reviewRequestEligible === false) return null;
  const url = data.reviewLocation?.reviewUrl;
  if (!url || !service.customer_id || !goodVisit(data, coverageEvidence)) return null;
  try {
    if (await hadNegativeContact(knex, service.customer_id, now)) return null;
  } catch {
    return null;
  }
  return { url, locationId: data.reviewLocation.id || null };
}

const SCOPE_COLUMNS = ['service_address_line1', 'service_address_line2', 'service_address_city', 'service_address_zip', 'property_id', 'source_estimate_id'];

// How many visits this technician has done at this home, counted as the plan card counts a visit: performed,
// customer-visible, one stop once however many services it held. "This home" is proven the way the upcoming-visits
// card proves it (visit-property-scope.js): a record counts only when its booking resolves to the same premises as
// this visit's booking. When this visit's premises cannot be proven, the count is 0 and the strip omits it.
async function visitsAtHome(knex, service) {
  if (!service.technician_id || !service.customer_id || !service.scheduled_service_id) return 0;
  const booking = await knex('scheduled_services').where({ id: service.scheduled_service_id }).first(...SCOPE_COLUMNS);
  const caches = { propertyById: new Map(), estimateById: new Map() };
  const here = booking ? await resolveVisitPropertyScope(booking, knex, caches) : null;
  if (!here?.key) return 0;
  const rows = await knex('service_records as sr')
    .leftJoin('scheduled_services as ss', 'ss.id', 'sr.scheduled_service_id')
    .where('sr.customer_id', service.customer_id)
    .where('sr.technician_id', service.technician_id)
    .where('sr.status', 'completed')
    .where('sr.service_date', '<=', service.service_date)
    .select('sr.id', 'sr.scheduled_service_id', 'sr.structured_notes', 'ss.visit_id', ...SCOPE_COLUMNS.map((c) => `ss.${c}`))
    .limit(RECORD_READ_CAP);
  if (rows.length >= RECORD_READ_CAP) return 0;
  const stops = new Set();
  for (const row of rows) {
    if (serviceRecordSuppressesCustomerArtifacts(row)
      || !isPerformedVisitOutcome(parseJsonObject(row.structured_notes).visitOutcome)) continue;
    const there = await resolveVisitPropertyScope(row, knex, caches);
    if (!sameResolvedProperty(there.key, here.key)) continue;
    stops.add(row.visit_id ? `visit:${row.visit_id}` : `booking:${row.scheduled_service_id || row.id}`);
  }
  return stops.size;
}

// "Move it" opens the portal schedule, which has no property deep link: it lands on the customer's own default home. So
// the button shows only on a proven single-premises account; otherwise the card says to call.
async function canMoveInPortal(knex, service) {
  try {
    const mirrorKey = linkage.normalizedStampedStreet(service.address_line1, service.address_line2, service.city, service.zip) || null;
    if (!mirrorKey) return false;
    const customerRow = await knex('customers').where({ id: service.customer_id }).first('has_multi_home');
    return (await customerHasOnlyPrimaryPremises(knex, service.customer_id, customerRow, mirrorKey, { unresolvedFails: true })) === true;
  } catch {
    return false;
  }
}

async function techFor(data, service, knex) {
  // The payload says "Your Waves technician" when no real technician is on the visit: no strip for a placeholder.
  const name = data.technician?.name || data.technicianName;
  if (isGenericTechnicianLabel(name)) return null;
  const firstName = firstNameOf(name);
  if (!firstName) return null;
  let count = 0;
  try {
    count = await visitsAtHome(knex, service);
  } catch { /* the strip still shows without the count */ }
  return {
    firstName,
    photoUrl: data.technician?.photoUrl || null,
    // Already on the report (applicatorFdacsId): withheld there when the license is expired or the identity changed.
    fdacsId: data.applicatorFdacsId || null,
    visitsAtHome: count >= MIN_VISITS_TO_SAY ? count : null,
  };
}

function nextVisitFor(visits, canMove) {
  const next = Array.isArray(visits) ? visits[0] : null;
  if (!next || !next.scheduledDate) return null;
  return {
    serviceType: next.serviceType || null,
    scheduledDate: next.scheduledDate,
    // No reschedule link: it is a bearer credential. "Move it" goes to the signed-in portal schedule.
    windowStart: next.windowStart || null,
    canMove,
  };
}

/**
 * @param {object} args
 * @param {object} args.data      the simple web payload, built in 'pdf' mode
 * @param {object} args.service   the joined service record row
 * @param {Array}  args.nextVisits upcoming visits from the build (webPeopleNext)
 * @param {Array}  args.coverageEvidence recorded coverage items from the build (webPeopleCoverage); missing = no review link
 * @param {boolean} args.readsOk  the build's findings and zones reads succeeded (webPeopleReadsOk); false = no review link
 * @returns {Promise<object|null>} the webPeople payload, or null when there is nothing to show
 */
async function buildWebPeople({ data, service, knex, nextVisits, readsOk = false, coverageEvidence, now = new Date() }) {
  if (!data || !service) return null;
  const [tech, review] = await Promise.all([
    techFor(data, service, knex),
    reviewLinkFor(data, service, knex, now, { readsOk, coverageEvidence }),
  ]);
  const nextVisit = nextVisitFor(nextVisits, (Array.isArray(nextVisits) && nextVisits[0]) ? await canMoveInPortal(knex, service) : false);
  const out = {
    ...(tech ? { tech } : {}),
    ...(data.treatmentMap?.traced?.snapshotUrl ? { treatedMap: true } : {}),
    ...(nextVisit ? { nextVisit } : {}),
    ...(review ? { review } : {}),
  };
  return Object.keys(out).length ? out : null;
}

module.exports = { buildWebPeople, isCleanPestVisit, REVIEW_MIN_LAWN_SCORE };
