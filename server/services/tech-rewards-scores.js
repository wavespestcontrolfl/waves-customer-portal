/**
 * Tech Rewards score data layer (Plan D5-2). Reads the five score parts for one
 * technician and the versioned score settings, and builds the season score with
 * the pure calculator (tech-rewards-calc.js). No routes, no UI, no gate: nothing
 * calls this yet (the audit screen and the scoreboard are later PRs). Reads only,
 * except saveSettings, which inserts one tech_reward_settings row.
 *
 * Every part is 0..100 with at most 2 decimals, or null when there is no data to
 * measure. Null is never turned into 100 or 0: seasonScore refuses to compute a
 * number while any part is null (a bonus is never computed from partial data).
 *
 * Definitions (a window is two ET calendar dates, both days included)
 *   onTime       Of the technician's completed service_records with a service_report_v1 report dated
 *                in the window, the share whose customer report went out within REPORT_ON_TIME_HOURS
 *                of the visit becoming complete (the completion anchor of the completion-record detectors). Everything about delivery comes from ONE reader,
 *                completion-record-invariants.js deliveryEvidenceForRecords, which applies the same
 *                decisions as the completion-record detectors: the canonical sibling, the frozen
 *                closeout requirements with the legacy catalog fallback, backfill and delivery
 *                posture, project-backed visits, and every confirmed send channel (report row,
 *                report-ready email, completion text, provider-confirmed pest-recap text, video
 *                recap, combined-visit summary). Exempt records are left out. A confirmed send with
 *                no readable time and no other on-time proof makes the whole part null (unknown,
 *                never late). No confirmed send counts as not on time. bi-tech-scorecard.js
 *                carries no on-time rule; the 24 hours is this module's own, in one constant.
 *   audit        Share of the technician's tech_protocol_audits rows with result 'match',
 *                for audit months in the window. A row counts only while it matches its visit's current
 *                record (same technician and month, no newer replacement record), at most five per month: see tech-protocol-audit.js.
 *   callbacks    callbacksPer100 = callbacks credited to the technician (the source-visit
 *                credit bi-tech-scorecard.js uses: callbackCreditByTechnician) per 100
 *                completed non-callback visits in the window (a customer_declined visit performed no service, so it is
 *                not counted; a legacy row with no visitOutcome is). Score = 100 for 0 callbacks,
 *                falling in a straight line to 0 at CALLBACK_RATE_AT_ZERO (10) callbacks
 *                per 100 visits, never below 0. No completed visit = null.
 *   truck        Share of the technician's truck checks (equipment_checks, truck-kit.js) in
 *                the window with no missing and no damaged item.
 *   ownerRating  Average of tech_owner_ratings.rating for rating months in the window.
 */
const db = require('../models/db');
const { etDateString, validCalendarDate } = require('../utils/datetime-et');
const calc = require('./tech-rewards-calc');
const { callbackCreditByTechnician, PERFORMED_OUTCOME_SQL, VISIT_IS_CALLBACK_SQL } = require('./callback-credit');
const { deliveryEvidenceForRecords, CLOSEOUT_SLACK_MS } = require('./completion-record-invariants');
const { countedMarks } = require('./tech-protocol-audit');

const { DEFAULT_WEIGHTS, DEFAULT_CUT_LINES, seasonWindow, weightedScore, scoreBand } = calc;

// A report is on time when it went out within this many hours of the completion record.
const REPORT_ON_TIME_HOURS = 24;
// Callbacks per 100 visits at which the callbacks part reaches 0.
const CALLBACK_RATE_AT_ZERO = 10;

const PART_KEYS = Object.freeze(['onTime', 'audit', 'callbacks', 'truck', 'ownerRating']);
const CUT_LINE_KEYS = Object.freeze(['top', 'mid', 'low']);
const SETTINGS_LOCK_KEY = 'tech-reward-settings';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class TechRewardsScoresError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TechRewardsScoresError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new TechRewardsScoresError(code, message);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// 'YYYY-MM-DD' string or Date -> validated 'YYYY-MM-DD' (ET calendar date).
function requireDate(value, code, label) {
  const raw = value instanceof Date && !Number.isNaN(value.getTime()) ? etDateString(value) : value;
  const ok = typeof raw === 'string' ? validCalendarDate(raw) : null;
  if (!ok) fail(code, `${label} must be a valid YYYY-MM-DD date`);
  return ok;
}

function requireTechnician(technicianId) {
  if (typeof technicianId !== 'string' || !UUID_RE.test(technicianId)) fail('INVALID_TECHNICIAN', 'technicianId must be a technician uuid');
  return technicianId.toLowerCase(); // pg returns lowercase uuids: one spelling for every read and map lookup
}

function requireWindow(window) {
  if (!isPlainObject(window)) fail('INVALID_WINDOW', 'window must be { from, to }');
  const from = requireDate(window.from, 'INVALID_WINDOW', 'window.from');
  const to = requireDate(window.to, 'INVALID_WINDOW', 'window.to');
  if (from > to) fail('INVALID_WINDOW', 'window.from must not be after window.to');
  return { from, to };
}

// First day of the month of a 'YYYY-MM-DD' date.
const monthStart = (dateStr) => `${dateStr.slice(0, 7)}-01`;

// num / den rounded half up to an integer (non-negative integers, exact).
function roundDiv(num, den) {
  return Math.floor((2 * num + den) / (2 * den));
}

// Integer hundredths -> the 2-decimal number the calculator takes.
const fromHundredths = (hundredths) => hundredths / 100;

// share of num in den as 0..100 with 2 decimals, from integer counts, rounded once.
function percent(num, den) {
  return fromHundredths(roundDiv(num * 10000, den));
}

const toCount = (value) => Number(value) || 0;

// ---------------------------------------------------------------------------
// Settings

function checkSettingsShape(weights, cutLines, code) {
  if (!isPlainObject(weights)) fail(code, 'weights must be an object');
  if (!isPlainObject(cutLines)) fail(code, 'cutLines must be an object');
  const extra = Object.keys(cutLines).filter((k) => !CUT_LINE_KEYS.includes(k));
  if (extra.length) fail(code, `cutLines has unknown keys: ${extra.join(', ')}`);
  const zero = Object.fromEntries(PART_KEYS.map((k) => [k, 0]));
  try {
    // The calculator's own validators: weightedScore checks the weights (keys, 0..100,
    // 2 decimals, sum 100); scoreBand checks the cut lines (numbers, top > mid > low).
    weightedScore(zero, weights);
    scoreBand(0, cutLines);
  } catch (err) {
    if (err instanceof calc.TechRewardsCalcError) fail(code, `${err.code}: ${err.message}`);
    throw err;
  }
  return {
    weights: Object.fromEntries(PART_KEYS.map((k) => [k, weights[k]])),
    cutLines: Object.fromEntries(CUT_LINE_KEYS.map((k) => [k, cutLines[k]])),
  };
}

function settingsFromRow(row) {
  if (!row) return null;
  const { weights, cutLines } = checkSettingsShape(row.weights, row.cut_lines, 'MALFORMED_SETTINGS');
  return { version: row.version, weights, cutLines, effectiveFrom: row.effective_from, source: 'stored' };
}

const SETTINGS_COLUMNS = 'version, weights, cut_lines, to_char(effective_from, \'YYYY-MM-DD\') AS effective_from';

/**
 * The settings in force on a date: the highest version with effective_from on or
 * before it. Only when the table has NO row does it fall back to the calculator defaults
 * (version 0); rows that exist but start later throw NO_SETTINGS_IN_FORCE. A stored row that fails the calculator's validators throws
 * TechRewardsScoresError MALFORMED_SETTINGS; it is never repaired or skipped.
 */
async function getSettings(asOfDate, conn = db) {
  const asOf = requireDate(asOfDate, 'INVALID_AS_OF', 'asOfDate');
  // ONE statement, so "table empty" and "row in force" come from the same snapshot.
  const row = (await conn.raw(
    `SELECT c.total, s.version, s.weights, s.cut_lines, s.effective_from
       FROM (SELECT COUNT(*)::int AS total FROM tech_reward_settings) c
       LEFT JOIN LATERAL (
         SELECT version, weights, cut_lines, to_char(effective_from, 'YYYY-MM-DD') AS effective_from
           FROM tech_reward_settings WHERE effective_from <= ?::date ORDER BY version DESC LIMIT 1
       ) s ON true`,
    [asOf],
  )).rows[0];
  if (row.version != null) return settingsFromRow(row);
  // Rows exist but none is in force on that date: a guessed default would change a bonus silently.
  if (row.total > 0) fail('NO_SETTINGS_IN_FORCE', `no tech_reward_settings version is in force on ${asOf}`);
  return { version: 0, weights: { ...DEFAULT_WEIGHTS }, cutLines: { ...DEFAULT_CUT_LINES }, effectiveFrom: null, source: 'default' };
}

/**
 * Insert the next settings version. `actor` is the saving login's technicians.id (uuid)
 * or null. Takes an advisory lock, so two saves get two different versions. A version
 * may not take effect before the one it follows (history is not rewritten).
 */
async function saveSettings(input, actor = null, conn = db) {
  if (!isPlainObject(input)) fail('INVALID_SETTINGS', 'settings must be an object');
  const { weights, cutLines } = checkSettingsShape(input.weights, input.cutLines, 'INVALID_SETTINGS');
  const effectiveFrom = requireDate(input.effectiveFrom, 'INVALID_EFFECTIVE_FROM', 'effectiveFrom');
  if (actor !== null && (typeof actor !== 'string' || !UUID_RE.test(actor))) fail('INVALID_ACTOR', 'actor must be a technician uuid or null');
  return conn.transaction(async (trx) => {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [SETTINGS_LOCK_KEY]);
    const last = (await trx.raw(
      'SELECT version, to_char(effective_from, \'YYYY-MM-DD\') AS effective_from FROM tech_reward_settings ORDER BY version DESC LIMIT 1',
    )).rows[0];
    if (last && effectiveFrom < last.effective_from) {
      fail('INVALID_EFFECTIVE_FROM', `effectiveFrom must not be before ${last.effective_from}, the date of version ${last.version}`);
    }
    const version = last ? last.version + 1 : 1;
    const inserted = (await trx.raw(
      `INSERT INTO tech_reward_settings (version, weights, cut_lines, effective_from, created_by)
       VALUES (?, ?::jsonb, ?::jsonb, ?::date, ?)
       RETURNING ${SETTINGS_COLUMNS}`,
      [version, JSON.stringify(weights), JSON.stringify(cutLines), effectiveFrom, actor],
    )).rows[0];
    return settingsFromRow(inserted);
  });
}

// ---------------------------------------------------------------------------
// Score parts. Each: (technicianId, { from, to }, conn) -> 0..100 (2 decimals) or null.

// The completed report records the technician owes a report on. What each record's customer delivery
// looked like (owed at all, which confirmed sends, when) is decided in ONE place:
// completion-record-invariants.js deliveryEvidenceForRecords.
const ON_TIME_COHORT_SQL = `
  SELECT id, created_at
    FROM service_records
   WHERE technician_id = ?
     AND status = 'completed'
     AND service_date >= ?::date AND service_date <= ?::date
     AND report_template_version = 'service_report_v1'`;

// A delivered-only email's send fell somewhere in [from, to] (queued .. delivered). Against the closeout
// window [start, end]: wholly before = another closeout's, ignored; wholly inside = a send in the window;
// wholly after = a late send; anything else may or may not have gone out in time (unknown).
function classifyInterval({ from, to }, start, end) {
  if (to.getTime() < start) return 'before';
  if (from.getTime() > end) return 'after';
  return from.getTime() >= start && to.getTime() <= end ? 'inside' : 'overlap';
}

/**
 * On-time share, or null when there is nothing to measure OR a record's on-time answer is unknown:
 * a confirmed send with no readable time and no other on-time proof (a send that may have been on
 * time is never counted late). Exempt records (no customer report owed) are left out; any confirmed
 * send of this closeout (not long before its completion) within REPORT_ON_TIME_HOURS of the record being created is on time; otherwise late.
 */
async function readOnTime(rawTechnicianId, window, conn = db) {
  const technicianId = requireTechnician(rawTechnicianId);
  const { from, to } = requireWindow(window);
  const { rows } = await conn.raw(ON_TIME_COHORT_SQL, [technicianId, from, to]);
  if (!rows.length) return null;
  const evidence = await deliveryEvidenceForRecords(rows.map((row) => row.id), conn);
  const limitMs = REPORT_ON_TIME_HOURS * 3600000;
  let owed = 0;
  let onTime = 0;
  for (const row of rows) {
    const found = evidence.get(String(row.id).toLowerCase());
    if (found.exempt) continue;
    owed += 1;
    // the window starts when the visit became complete (a record reused by the pest-recap rail keeps its old created_at)
    const completedMs = (found.completedAt || new Date(row.created_at)).getTime();
    const deadline = completedMs + limitMs;
    // only a send of THIS closeout counts: one long before completion belongs to an earlier closeout of a reused record
    const windowStart = completedMs - CLOSEOUT_SLACK_MS;
    const eligible = found.sendTimes.map((at) => at.getTime()).filter((ms) => ms >= windowStart);
    const intervals = found.deliveredIntervals.map((i) => classifyInterval(i, windowStart, deadline));
    // a delivered-only email wholly inside the window was sent in it
    if (eligible.some((ms) => ms <= deadline) || intervals.includes('inside')) onTime += 1;
    else if (found.confirmedWithoutTime || intervals.includes('overlap')) return null; // may have gone out on time: unknown, not late
  }
  return owed ? percent(onTime, owed) : null;
}

async function readAudit(rawTechnicianId, window, conn = db) {
  const technicianId = requireTechnician(rawTechnicianId);
  const { from, to } = requireWindow(window);
  // Only a mark that still matches its visit's current record counts, at most five per month (tech-protocol-audit.js).
  const counted = await countedMarks(technicianId, { fromMonth: monthStart(from), toMonth: to }, conn);
  return counted.length ? percent(counted.filter((mark) => mark.result === 'match').length, counted.length) : null;
}

async function readCallbacks(rawTechnicianId, window, conn = db) {
  const technicianId = requireTechnician(rawTechnicianId);
  const { from, to } = requireWindow(window);
  // A visit is ONE scheduled service even when the recap and dispatch rails left sibling records for it
  // (an unlinked record is its own visit); a visit with any callback sibling is a callback visit, not a
  // regular one. A visit that performed no application (the shared list in visit-outcomes.js) is no visit.
  const visitRow = (await conn.raw(
    `SELECT COUNT(DISTINCT COALESCE(sr.scheduled_service_id::text, sr.id::text)) AS visits FROM service_records sr
      WHERE sr.technician_id = ? AND sr.status = 'completed'
        AND NOT ${VISIT_IS_CALLBACK_SQL('sr')}
        AND ${PERFORMED_OUTCOME_SQL('sr')}
        AND sr.service_date >= ?::date AND sr.service_date <= ?::date`,
    [technicianId, from, to],
  )).rows[0];
  const visits = toCount(visitRow?.visits);
  if (!visits) return null;
  const credited = await callbackCreditByTechnician(conn, { start: from, endDate: to, distinctVisits: true, performedSourcesOnly: true });
  const callbacks = toCount(credited.get(technicianId));
  // score = 100 - 100 x per100 / CALLBACK_RATE_AT_ZERO, per100 = 100 x callbacks / visits, all in
  // integers: hundredths = (10000 x visits - 10000 x 100 x callbacks / RATE) / visits, half up once.
  const lostNumerator = (10000 * 100 * callbacks) / CALLBACK_RATE_AT_ZERO; // an integer: 10000 x 100 / 10
  const keptNumerator = 10000 * visits - lostNumerator;
  return keptNumerator <= 0 ? 0 : fromHundredths(roundDiv(keptNumerator, visits));
}

async function readTruck(rawTechnicianId, window, conn = db) {
  const technicianId = requireTechnician(rawTechnicianId);
  const { from, to } = requireWindow(window);
  const row = (await conn.raw(
    `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE missing_count = 0 AND damaged_count = 0) AS clean
       FROM equipment_checks
      WHERE technician_id = ?
        AND (checked_at AT TIME ZONE 'America/New_York')::date >= ?::date
        AND (checked_at AT TIME ZONE 'America/New_York')::date <= ?::date`,
    [technicianId, from, to],
  )).rows[0];
  const total = toCount(row?.total);
  return total ? percent(toCount(row.clean), total) : null;
}

async function readOwnerRating(rawTechnicianId, window, conn = db) {
  const technicianId = requireTechnician(rawTechnicianId);
  const { from, to } = requireWindow(window);
  const row = (await conn.raw(
    `SELECT COUNT(*) AS total, SUM(rating) AS sum_rating FROM tech_owner_ratings
      WHERE technician_id = ? AND period_month >= ?::date AND period_month <= ?::date`,
    [technicianId, monthStart(from), to],
  )).rows[0];
  const total = toCount(row?.total);
  return total ? fromHundredths(roundDiv(toCount(row.sum_rating) * 100, total)) : null;
}

const PART_READERS = Object.freeze({
  onTime: readOnTime, audit: readAudit, callbacks: readCallbacks, truck: readTruck, ownerRating: readOwnerRating,
});

/**
 * The season score for one technician: the five parts over seasonWindow(year), then the
 * calculator's weightedScore and scoreBand with the settings in force on the window's last day.
 * Any part without data returns { complete: false, missing: [...] } and no number.
 */
async function seasonScore(rawTechnicianId, year) {
  const technicianId = requireTechnician(rawTechnicianId);
  const season = seasonWindow(year);
  // ONE read-only REPEATABLE READ snapshot for all five parts and the settings, so a closeout
  // committing mid-read cannot count in one part and not another. Always its own transaction.
  return db.transaction(
    (trx) => buildSeasonScore(technicianId, year, season, trx),
    { isolationLevel: 'repeatable read', readOnly: true },
  );
}

async function buildSeasonScore(technicianId, year, season, conn) {
  const window = { from: season.start, to: season.end };
  const values = [];
  for (const key of PART_KEYS) values.push(await PART_READERS[key](technicianId, window, conn)); // one connection: in order
  const parts = Object.fromEntries(PART_KEYS.map((key, i) => [key, values[i]]));
  const missing = PART_KEYS.filter((key) => parts[key] === null);
  if (missing.length) return { complete: false, year, window, parts, missing };
  const settings = await getSettings(window.to, conn);
  const score = weightedScore(parts, settings.weights);
  return {
    complete: true,
    year,
    window,
    parts,
    score,
    rateBps: scoreBand(score, settings.cutLines),
    settings: { version: settings.version, weights: settings.weights, cutLines: settings.cutLines },
  };
}

module.exports = {
  TechRewardsScoresError,
  REPORT_ON_TIME_HOURS,
  CALLBACK_RATE_AT_ZERO,
  getSettings,
  saveSettings,
  readOnTime,
  readAudit,
  readCallbacks,
  readTruck,
  readOwnerRating,
  seasonScore,
  buildSeasonScore,
};
