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
 *   onTime       Of the technician's completed service_records with a service_report_v1
 *                report dated in the window, the share whose report went out within
 *                REPORT_ON_TIME_HOURS of the record being created. "Went out" reuses the
 *                sources the Intelligence Bar report-engagement read uses
 *                (intelligence-bar/dashboard-tools.js): the earliest of a sent
 *                service_report_deliveries row, a sent service_report_ready email (key
 *                service_report_ready:<record>:<role>[:<suffix>], matched on the record segment),
 *                the confirmed video recap text (service_recaps.sent_at), the completion text
 *                (completionSmsDeferredDeliveredAt, else sentSmsAt, when
 *                completionSmsStatus is 'sent'), and the combined-visit summary send
 *                (visit_effects completion_sms / completion_email, as closeout-status.js reads
 *                it; the send record counts even if the summary link is revoked later).
 *                No send on record counts as not on time. An on-time send on any channel credits
 *                the record. A record with a malformed text timestamp and no on-time send is
 *                unknown (it may have gone out on time): the whole part is null (missing
 *                data), never late. Records that expect no customer report are left out, by the
 *                customer summary's own rule (publishableSummaryItems in
 *                visit-completion-summary.js: no backfill, only an auto_send or absent
 *                typedReportDelivery, so 'internal_only' and 'disabled' are out) and by the
 *                frozen internalOnlyCompletion flag.
 *                bi-tech-scorecard.js carries no on-time rule; the 24 hours is this module's
 *                own, in one constant.
 *   audit        Share of the technician's tech_protocol_audits rows with result 'match',
 *                for audit months in the window.
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
const { callbackCreditByTechnician } = require('./callback-credit');
const { publishableSummaryItems } = require('./visit-completion-summary');

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

// Per cohort record: the first send from the stored send records, and the completion text's
// raw timestamp. The text timestamp is checked in JS (firstTextSend), never cast in SQL: a bad
// stored value must not fail the whole read.
const ON_TIME_SQL = `
  WITH cohort AS (
    SELECT id, scheduled_service_id, created_at, structured_notes
      FROM service_records
     WHERE technician_id = ?
       AND status = 'completed'
       AND service_date >= ?::date AND service_date <= ?::date
       AND report_template_version = 'service_report_v1'
  ),
  sends AS (
    SELECT service_record_id, MIN(sent_at) AS first_sent_at
      FROM (
        SELECT d.service_record_id, d.sent_at
          FROM service_report_deliveries d JOIN cohort c ON c.id = d.service_record_id
         WHERE d.status = 'sent' AND d.sent_at IS NOT NULL
        UNION ALL
        SELECT c.id, m.sent_at
          FROM email_messages m
          JOIN cohort c ON split_part(m.idempotency_key, ':', 2) = c.id::text
         WHERE split_part(m.idempotency_key, ':', 1) = 'service_report_ready'
           AND m.sent_at IS NOT NULL -- the recorded send time stands whatever the status became later (unsubscribed, spam_report, ...)
        UNION ALL
        -- the video recap text: service_recaps.sent_at is set only on provider confirmation
        -- (recap-delivery.js; completion-record-invariants.js reads it the same way)
        SELECT c.id, rc.sent_at
          FROM cohort c
          JOIN service_recaps rc ON rc.scheduled_service_id = c.scheduled_service_id
         WHERE rc.sent_at IS NOT NULL
        UNION ALL
        -- a combined visit: ONE summary text or email for every member (visit_effects, as closeout-status
        -- reads it). The send record is the evidence: a link revoked later does not undo a delivery.
        SELECT c.id, e.sent_at
          FROM cohort c
          JOIN visit_completion_packet_items i ON i.service_record_id = c.id AND i.status = 'done'
          JOIN visit_completion_packets p ON p.id = i.packet_id AND p.status IN ('processing', 'done')
          JOIN visit_effects e ON e.visit_id = p.visit_id AND e.effect_type IN ('completion_sms', 'completion_email')
         WHERE e.status = 'sent' AND e.sent_at IS NOT NULL
      ) snd
     GROUP BY service_record_id
  )
  SELECT c.id, c.created_at, c.structured_notes, s.first_sent_at,
         CASE WHEN c.structured_notes->>'completionSmsStatus' = 'sent'
              THEN COALESCE(c.structured_notes->>'completionSmsDeferredDeliveredAt', c.structured_notes->>'sentSmsAt') END AS text_sent_at
    FROM cohort c LEFT JOIN sends s ON s.service_record_id = c.id`;

const TEXT_TS_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

// The text's send time as ms, or null when the value is absent or not a real timestamp
// (a calendar date that does not exist, an hour over 23, no zone).
function firstTextSend(raw) {
  const m = typeof raw === 'string' ? TEXT_TS_RE.exec(raw) : null;
  if (!m) return null;
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number);
  const calendar = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const real = calendar.getUTCFullYear() === year && calendar.getUTCMonth() === month - 1 && calendar.getUTCDate() === day
    && hour <= 23 && minute <= 59 && second <= 59;
  const ms = real ? Date.parse(raw) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

/**
 * On-time share, or null when there is no record to measure OR a record's only send evidence is a
 * malformed completion-text timestamp (unreadable is not late: the part counts as missing data).
 */
async function readOnTime(rawTechnicianId, window, conn = db) {
  const technicianId = requireTechnician(rawTechnicianId);
  const { from, to } = requireWindow(window);
  const { rows } = await conn.raw(ON_TIME_SQL, [technicianId, from, to]);
  if (!rows.length) return null;
  const limitMs = REPORT_ON_TIME_HOURS * 3600000;
  // Records that expect no customer report are left out. One definition, the customer summary's own
  // (visit-completion-summary.js): never a backfill, only an auto_send (or absent) report posture;
  // plus the frozen internal-only flag.
  const owed = rows.filter((row) => publishableSummaryItems([row]).length > 0 && row.structured_notes?.internalOnlyCompletion !== true);
  if (!owed.length) return null;
  let onTime = 0;
  for (const row of owed) {
    const textMs = firstTextSend(row.text_sent_at);
    const tableMs = row.first_sent_at ? new Date(row.first_sent_at).getTime() : null;
    const first = [tableMs, textMs].filter((ms) => ms !== null).sort((a, b) => a - b)[0];
    const deadline = new Date(row.created_at).getTime() + limitMs;
    if (first !== undefined && first <= deadline) {
      onTime += 1; // an on-time send on any channel credits the record
    } else if (row.text_sent_at != null && textMs === null) {
      return null; // the unreadable text may have gone out on time: unknown, not late
    }
  }
  return percent(onTime, owed.length);
}

async function readAudit(rawTechnicianId, window, conn = db) {
  const technicianId = requireTechnician(rawTechnicianId);
  const { from, to } = requireWindow(window);
  const row = (await conn.raw(
    `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE result = 'match') AS matched
       FROM tech_protocol_audits
      WHERE technician_id = ? AND audit_month >= ?::date AND audit_month <= ?::date`,
    [technicianId, monthStart(from), to],
  )).rows[0];
  const total = toCount(row?.total);
  return total ? percent(toCount(row.matched), total) : null;
}

async function readCallbacks(rawTechnicianId, window, conn = db) {
  const technicianId = requireTechnician(rawTechnicianId);
  const { from, to } = requireWindow(window);
  const visitRow = (await conn.raw(
    `SELECT COUNT(*) AS visits FROM service_records
      WHERE technician_id = ? AND status = 'completed' AND is_callback IS NOT TRUE
        AND COALESCE(structured_notes->>'visitOutcome', '') <> 'customer_declined'
        AND service_date >= ?::date AND service_date <= ?::date`,
    [technicianId, from, to],
  )).rows[0];
  const visits = toCount(visitRow?.visits);
  if (!visits) return null;
  const credited = await callbackCreditByTechnician(conn, { start: from, endDate: to });
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
};
