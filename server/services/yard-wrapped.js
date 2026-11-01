/**
 * Yard Wrapped: a WaveGuard member's year-in-review card on the Home tab
 * (owner 2026-10-31 perks round 4, build ask 2026-11-01). Dark behind
 * GATE_YARD_WRAPPED (yardWrappedLive()). Read-only, counts only: nothing here
 * is estimated, averaged or invented, and every read is wrapped so one failed
 * read drops that field instead of the card.
 *
 *   yardWrappedYearFor({ customer, now }) -> the year to show, or null when
 *     the gate is off, today (ET) is outside Dec 1 - Jan 31, or the customer is
 *     not an active WaveGuard member. Does no database read.
 *   buildYardWrapped({ customerId, year, scope }) -> the card payload, or
 *     { enabled: false } when the year holds fewer than 3 performed visits.
 *
 * A visit is a service line's day with a completed service record that was
 * performed: the closeout outcome is not inspection_only / customer_declined
 * (visit-outcomes.js, the completion route's own list) or incomplete. A
 * backfill closeout counts: it is the office's late, quiet closeout of work
 * that happened (complete-scheduled-service.js backfillCompletionPlan). Two
 * records of one line on one day are one visit; a pest and a lawn visit on one
 * day are two, so the line counts always add up to the total the card shows.
 */
const db = require('../models/db');
const logger = require('./logger');
const { etParts, dateOnlyString } = require('../utils/datetime-et');
const { WAVES_BUSINESS_NAME } = require('../constants/business');
const { isMembershipCustomerRow } = require('./waveguard-existing-services');
const { NON_PERFORMED_VISIT_OUTCOMES } = require('./visit-outcomes');
const { detectServiceLine } = require('./service-report/service-line-configs');
const { customerCopyViolations } = require('./service-report/technician-report-copy');
const { parseJsonObject, suppressesCustomerArtifacts, scopeRecordsToProperty } = require('./portal-service-history');
const { lawnOverall } = require('./lawn-health-shared');

const MIN_VISITS = 3;
const MAX_TREATED_FOR = 5;
// Dec 1 through Jan 31, Eastern time. December shows its own year; January
// still shows the year that just ended.
const WINDOW_MONTH_YEAR_OFFSET = { 12: 0, 1: -1 };
const SHOWN_LINES = ['pest', 'lawn', 'mosquito', 'tree_shrub', 'termite', 'rodent', 'palm'];
// A pest or weed name: letters and a few joiners, no digits (a time, a code or a
// phone number never passes), short enough to be a label rather than a sentence.
const TREATED_LABEL_RE = /^[A-Za-z][A-Za-z '’&/().,-]{1,39}$/;
// What a fertilizer is logged for ("Deep green color", "Root strength & stress
// tolerance") is a goal, not something we treated for.
const GOAL_LABEL_RE = /\b(colou?r|strength|tolerance)\b/i;
const FIRST_NAME_RE = /^[A-Za-z][A-Za-z'’-]{0,29}$/;
const NOT_PERFORMED = new Set([...NON_PERFORMED_VISIT_OUTCOMES, 'incomplete']);

function yardWrappedLive() {
  const gates = require('../config/feature-gates');
  return typeof gates.yardWrappedLive === 'function' && gates.yardWrappedLive();
}

function yardWrappedYearFor({ customer, now = new Date() } = {}) {
  if (!yardWrappedLive()) return null;
  if (!customer || customer.active !== true || !isMembershipCustomerRow(customer)) return null;
  const { year, month } = etParts(now);
  const offset = WINDOW_MONTH_YEAR_OFFSET[month];
  return offset === undefined ? null : year + offset;
}

// One failed read drops its field; the card still renders.
async function safely(label, fn, fallback) {
  try {
    return await fn();
  } catch (err) {
    logger.warn(`[yard-wrapped] ${label} read failed: ${err.message}`);
    return fallback;
  }
}

function performedRecord(row) {
  return !NOT_PERFORMED.has(String(parseJsonObject(row.structured_notes).visitOutcome || ''));
}

async function readYearRecords(database, customerId, year, scope) {
  let query = database('service_records')
    .where({ 'service_records.customer_id': customerId })
    .whereBetween('service_records.service_date', [`${year}-01-01`, `${year}-12-31`])
    .whereRaw("COALESCE(service_records.status, 'completed') = 'completed'")
    .leftJoin('technicians', 'service_records.technician_id', 'technicians.id')
    .leftJoin('scheduled_services', 'service_records.scheduled_service_id', 'scheduled_services.id')
    .select(
      'service_records.id',
      database.raw("to_char(service_records.service_date, 'YYYY-MM-DD') as day"),
      'service_records.service_type',
      'service_records.service_line',
      'service_records.structured_notes',
      'service_records.technician_id',
      'technicians.name as technician_name',
    );
  if (scope) query = scopeRecordsToProperty(query, scope);
  return (await query).filter(performedRecord);
}

// Visits per service line (distinct days that line has a record) and per
// technician, in the same unit. The total adds the lines up, plus one for a day
// whose records are all of a line the card does not name.
function summarizeVisits(records) {
  const dayLines = new Map();
  const techVisits = new Map();
  const techNames = new Map();
  for (const row of records) {
    const line = String(row.service_line || '').trim() || detectServiceLine(row.service_type);
    const shown = SHOWN_LINES.includes(line);
    if (!dayLines.has(row.day)) dayLines.set(row.day, new Set());
    if (shown) dayLines.get(row.day).add(line);
    if (row.technician_id != null) {
      if (!techVisits.has(row.technician_id)) techVisits.set(row.technician_id, new Set());
      techVisits.get(row.technician_id).add(`${row.day}|${shown ? line : ''}`);
      techNames.set(row.technician_id, row.technician_name);
    }
  }
  const lineCounts = new Map();
  let total = 0;
  for (const lines of dayLines.values()) {
    total += Math.max(1, lines.size);
    for (const line of lines) lineCounts.set(line, (lineCounts.get(line) || 0) + 1);
  }
  const byLine = SHOWN_LINES
    .filter((line) => lineCounts.has(line))
    .map((line) => ({ line, count: lineCounts.get(line) }))
    .sort((a, b) => b.count - a.count);
  const topTech = [...techVisits.entries()]
    .map(([id, set]) => ({ name: String(techNames.get(id) || '').trim(), count: set.size }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))[0];
  const first = topTech ? topTech.name.split(/\s+/)[0] : '';
  return { total, byLine, technicianFirstName: FIRST_NAME_RE.test(first) ? first : null };
}

// What the year's applied products were logged for. service_products.targets is a
// text[] the technician picks or types, so every label passes the complete report
// copy screen before it can reach a customer; visits whose report is held back
// from the customer (internal-only typed completions) are skipped.
async function readTreatedFor(database, records) {
  const ids = records.filter((row) => !suppressesCustomerArtifacts(parseJsonObject(row.structured_notes))).map((row) => row.id);
  if (!ids.length) return [];
  const rows = await database('service_products').whereIn('service_record_id', ids).select('targets');
  const tally = new Map();
  for (const row of rows) {
    for (const raw of Array.isArray(row.targets) ? row.targets : []) {
      const label = String(raw || '').replace(/\s+/g, ' ').trim();
      if (!TREATED_LABEL_RE.test(label) || GOAL_LABEL_RE.test(label) || customerCopyViolations(label).length) continue;
      // "Orb-weaver spiders", "Orb weaver spiders" and "orb weaver spiders" are one pest.
      const key = label.toLowerCase().replace(/[-\s]+/g, ' ');
      const seen = tally.get(key);
      if (seen) seen.count += 1;
      else tally.set(key, { label: label[0].toUpperCase() + label.slice(1), count: 1 });
    }
  }
  return [...tally.values()].sort((a, b) => b.count - a.count).slice(0, MAX_TREATED_FOR).map((item) => item.label);
}

// Tech-confirmed lawn assessments dated in the year, oldest first, read the way
// the Lawn Health card reads them (lawn-health.js), including its saved-property
// history reader behind GATE_LAWN_PROPERTY_HISTORY. With that gate off the only
// read is customer-wide, which the Lawn Health card never dresses as one house's:
// under a selected saved property it would put another house's scores and photo
// under this card's house echo, so the card goes without them.
async function readYearAssessments(database, customerId, year, scope) {
  const gates = require('../config/feature-gates');
  const selectedHouse = scope && scope.enabled && scope.scoped && scope.property ? scope.property.id : undefined;
  if (typeof gates.gateEnvValue === 'function' && gates.gateEnvValue('GATE_LAWN_PROPERTY_HISTORY')) {
    const rows = await require('./lawn-assessment-history').latestForCustomer(customerId, { propertyId: selectedHouse }, database);
    return rows.filter((row) => dateOnlyString(row.visit_date).startsWith(`${year}-`));
  }
  if (selectedHouse) return [];
  return database('lawn_assessments')
    .where({ customer_id: customerId, confirmed_by_tech: true })
    .whereBetween('service_date', [`${year}-01-01`, `${year}-12-31`])
    .orderBy('service_date', 'asc');
}

// The same best, customer-visible lawn photo the Lawn Health history serves, signed
// the same way (never a storage path); the latest assessment's first.
async function readLawnPhotoUrl(database, assessments) {
  if (!assessments.length) return null;
  const PhotoService = require('./photos');
  const photos = await database('lawn_assessment_photos')
    .whereIn('assessment_id', assessments.map((row) => row.id))
    .where({ is_best_photo: true, customer_visible: true });
  const rank = (photo) => assessments.findIndex((row) => String(row.id) === String(photo.assessment_id));
  const usable = photos.filter((photo) => photo.s3_key && !String(photo.s3_key).startsWith('pending/')).sort((a, b) => rank(b) - rank(a));
  return usable.length ? PhotoService.getViewUrl(usable[0].s3_key, PhotoService.CUSTOMER_DWELL_TTL_SECONDS) : null;
}

async function buildYardWrapped({ customerId, year, scope = null, database = db }) {
  const records = await safely('visits', () => readYearRecords(database, customerId, year, scope), []);
  const visits = summarizeVisits(records);
  if (visits.total < MIN_VISITS) return { enabled: false };

  const [treatedFor, assessments] = await Promise.all([
    safely('treated-for', () => readTreatedFor(database, records), []),
    safely('lawn-assessments', () => readYearAssessments(database, customerId, year, scope), []),
  ]);
  const photoUrl = await safely('photo', () => readLawnPhotoUrl(database, assessments), null);
  const scores = assessments.map((row) => lawnOverall(row));

  return {
    enabled: true,
    year,
    visits: { total: visits.total, byLine: visits.byLine },
    ...(scores.length >= 2 ? { lawnScore: { first: scores[0], last: scores[scores.length - 1] } } : {}),
    treatedFor,
    ...(visits.technicianFirstName ? { technicianFirstName: visits.technicianFirstName } : {}),
    ...(photoUrl ? { photoUrl } : {}),
    businessName: WAVES_BUSINESS_NAME,
  };
}

module.exports = { yardWrappedYearFor, buildYardWrapped, MIN_VISITS, MAX_TREATED_FOR, _test: { summarizeVisits, performedRecord } };
