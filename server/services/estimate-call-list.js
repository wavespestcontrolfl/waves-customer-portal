/**
 * Viewed-estimate call list (admin only).
 *
 * The estimates list carries `lastCalledAt` on every VIEWED row:
 * the newest outbound call_log row to that estimate's customer phone that the CUSTOMER answered.
 * The admin page uses it to drop an offer from "Call today" once somebody has reached the customer
 * (the click-to-call bridge in call-bridge.js writes `direction = 'outbound'` with `to_phone` in E.164).
 *
 * One batched query for the whole page, never one per row. Read-only: it dials, texts and
 * emails nobody, and costs nothing.
 */

const { toE164 } = require('../utils/phone');
const { whereNotSandboxCall } = require('./voice-agent/relay-protocol');
const { CALL_OUTCOMES } = require('../../shared/estimate-call-today.cjs');

// Only a call the customer ANSWERED counts. call_log.status and bridged_at describe the STAFF
// leg (bridged_at = staff pressed 1, before the customer leg is dialed; status can read
// 'completed' when the customer never picked up), so neither proves contact. This is the proof
// the missed-call bell retires on (missed-call-bell.js CALLED_BACK_ANSWERED_SQL, owner
// 2026-10-20): the customer leg the <Dial action> recorded completed with seconds > 0, or, with no
// customer_leg on the row, a recording (the bridge records from answer, so a recording exists
// only once the customer leg picked up). No literal question mark: knex reads one as a binding.
const CUSTOMER_ANSWERED_SQL = 'bridged_at IS NOT NULL AND ('
  + "(metadata->'customer_leg'->>'status' = 'completed' AND CASE WHEN metadata->'customer_leg'->>'duration_seconds' ~ '^[0-9]+$'"
  + " THEN (metadata->'customer_leg'->>'duration_seconds')::numeric > 0 ELSE FALSE END)"
  + " OR (metadata->'customer_leg' IS NULL AND recording_duration_seconds > 0 AND (recording_sid IS NOT NULL OR recording_url IS NOT NULL)))";
// The list only compares a call with an open of the last 48 h; 30 days bounds the scan.
const CALL_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

// The phone a call_log.to_phone would hold for this estimate's customer, or null.
function callLogPhoneFor(estimate) {
  const raw = estimate?.customer_phone;
  if (!raw || !String(raw).trim()) return null;
  const phone = toE164(raw);
  return phone && /^\+\d{8,15}$/.test(String(phone)) ? String(phone) : null;
}

/**
 * @param {Function} database  knex-like handle
 * @param {Array} estimates    estimates rows (snake_case columns)
 * @param {number} [nowMs]    clock, for tests
 * @returns {Promise<Map<string, Date|string|null>>} estimate id -> newest connected outbound call
 *   time in the last 30 days; only VIEWED rows with a callable phone are looked up, others are absent.
 */
async function lastCalledAtByEstimateId(database, estimates, nowMs = Date.now()) {
  const out = new Map();
  const phoneByEstimate = new Map();
  for (const estimate of Array.isArray(estimates) ? estimates : []) {
    if (estimate?.status !== 'viewed') continue;
    const phone = callLogPhoneFor(estimate);
    if (phone) phoneByEstimate.set(estimate.id, phone);
  }
  if (!phoneByEstimate.size) return out;
  const phones = [...new Set(phoneByEstimate.values())];
  // A voice-agent sandbox call is a test, never a call to the customer.
  const rows = await whereNotSandboxCall(database('call_log'))
    .where({ direction: 'outbound' })
    .whereIn('to_phone', phones)
    .whereRaw(CUSTOMER_ANSWERED_SQL)
    .where('created_at', '>=', new Date(nowMs - CALL_LOOKBACK_MS))
    .groupBy('to_phone')
    .select('to_phone')
    .max({ last_called_at: 'created_at' });
  const lastByPhone = new Map(rows.map((row) => [row.to_phone, row.last_called_at]));
  for (const [id, phone] of phoneByEstimate) out.set(id, lastByPhone.get(phone) || null);
  return out;
}

// A call outcome (owner 2026-11-20, D1 A) is an activity_log row on the estimate: estimate_id, admin_user_id (who
// tapped), created_at (when) and metadata.outcome (a CALL_OUTCOMES key). No new table: the action column is indexed.
const CALL_OUTCOME_ACTION = 'estimate_call_outcome';
const CALL_OUTCOME_KEYS = new Set(CALL_OUTCOMES.map((o) => o.key));

// The first word of a staff name, as the row shows it: "No answer · 9:42 AM · Virginia".
function staffFirstName(name) {
  return String(name || '').trim().split(/\s+/)[0] || null;
}

/**
 * The newest call outcome on each estimate, one batched query for the list route and the 9 AM push (the Call today
 * rule takes a row off the list once an outcome is newer than the customer's last touch).
 *
 * @param {Function} database  knex-like handle
 * @param {Array<string>} ids  estimate ids
 * @returns {Promise<Map<string, {outcome: string, at: Date|string, by: string|null}>>} estimate id -> its newest
 *   outcome; an estimate with none is absent.
 */
async function lastCallOutcomeByEstimateId(database, ids) {
  const out = new Map();
  if (!Array.isArray(ids) || !ids.length) return out;
  const rows = await database('activity_log as a')
    .leftJoin('technicians as t', 't.id', 'a.admin_user_id')
    .where('a.action', CALL_OUTCOME_ACTION)
    .whereIn('a.estimate_id', ids)
    .distinctOn('a.estimate_id')
    .orderBy([{ column: 'a.estimate_id' }, { column: 'a.created_at', order: 'desc' }, { column: 'a.id', order: 'desc' }])
    .select('a.estimate_id', 'a.created_at', 'a.metadata', 't.name as by_name');
  for (const row of rows) {
    const outcome = row.metadata?.outcome;
    if (CALL_OUTCOME_KEYS.has(outcome)) out.set(row.estimate_id, { outcome, at: row.created_at, by: staffFirstName(row.by_name) });
  }
  return out;
}

/**
 * The newest reason each customer sent under "What would help you decide?" on the estimate page, one batched query
 * for the list route and the 9 AM push (the Call today rule shows such a row at once). The row is the still-deciding
 * activity_log row of that day (estimate-change-request.js recordEstimateStillDeciding): metadata.reason is the key
 * and metadata.reason_at is when the customer sent it. A tap with no reason is not read.
 *
 * @param {Function} database  knex-like handle
 * @param {Array<string>} ids  estimate ids
 * @returns {Promise<Map<string, {reason: string, at: Date|string}>>} estimate id -> its newest reason; an estimate
 *   with none is absent.
 */
async function stillDecidingByEstimateId(database, ids) {
  const out = new Map();
  if (!Array.isArray(ids) || !ids.length) return out;
  const { STILL_DECIDING_ACTION, STILL_DECIDING_REASONS } = require('./estimate-change-request');
  const rows = await database('activity_log')
    .where('action', STILL_DECIDING_ACTION)
    .whereIn('estimate_id', ids)
    .whereRaw("metadata->>'reason' IS NOT NULL")
    .distinctOn('estimate_id')
    .orderBy([{ column: 'estimate_id' }, { column: 'created_at', order: 'desc' }, { column: 'id', order: 'desc' }])
    .select('estimate_id', 'created_at', 'metadata');
  for (const row of rows) {
    const reason = row.metadata?.reason;
    if (Object.hasOwn(STILL_DECIDING_REASONS, String(reason))) {
      out.set(row.estimate_id, { reason, at: row.metadata.reason_at || row.created_at });
    }
  }
  return out;
}

// Hard ceiling for limit=all list fetches. The estimates pipeline computes all-time KPIs client-side from this list; if
// the table ever outgrows this cap the analytics silently truncate to the newest rows, so keep generous headroom
// (pricing-risk batch is pure compute after one inventory preload).
const ESTIMATE_LIST_LIMIT = 2000;
const SENT_ONLY_DELIVERY_ATTEMPT_STATUSES = ['scheduled', 'sending', 'send_failed'];

// Short-link click telemetry per estimate, one batched query. One estimate can hold several short_codes rows when
// /send runs again (a re-send or a follow-up), so the click counts are SUMMED and the last-clicked time is the MAX.
// Bot taps are filtered upstream in public-shortlinks, so the numbers are real customer taps. The list route reads
// both fields and the Call today push reads last_clicked_at, so the page and the push count the same clicks.
async function clickStatsByEstimateId(database, ids) {
  if (!ids.length) return new Map();
  const rows = await database('short_codes')
    .where({ entity_type: 'estimates' })
    .whereIn('entity_id', ids)
    .groupBy('entity_id')
    .select('entity_id')
    .sum({ click_count: 'click_count' })
    .max({ last_clicked_at: 'last_clicked_at' });
  return new Map(rows.map((r) => [r.entity_id, r]));
}

/**
 * The base row selection of GET /admin/estimates: ONE home for the list route and the 9 AM Call today push, so the
 * push counts only rows the Estimates page can load. The page loads sentOnly rows (limit=all, the newest
 * ESTIMATE_LIST_LIMIT by created_at) plus drafts; the caller applies the limit (`.limit(ESTIMATE_LIST_LIMIT)`) or a page.
 *
 * @param {Function} database  knex-like handle
 * @param {{status?: string, sentOnly?: boolean, sources?: string[]|null, archived?: 'hide'|'only'|'all'}} [filters]
 *   archived 'hide' (default) drops archived rows, 'only' keeps only them, 'all' keeps both.
 */
function estimateListQuery(database, { status, sentOnly = false, sources = null, archived = 'hide' } = {}) {
  let query = database('estimates')
    .leftJoin('technicians', 'estimates.created_by_technician_id', 'technicians.id')
    .select('estimates.*', 'technicians.name as created_by_name')
    // The id breaks created_at ties, so every caller's limit cuts at the same rows (the push's narrow select and the
    // page's full one must count the same 2,000).
    .orderBy('estimates.created_at', 'desc')
    .orderBy('estimates.id', 'desc');
  if (status) query = query.where('estimates.status', status);
  if (sentOnly) {
    query = query.where(function () {
      this.whereNotNull('estimates.sent_at')
        .orWhereIn('estimates.status', SENT_ONLY_DELIVERY_ATTEMPT_STATUSES);
    });
  }
  if (sources) query = query.whereIn('estimates.source', sources);
  if (archived === 'only') query = query.whereNotNull('estimates.archived_at');
  else if (archived !== 'all') query = query.whereNull('estimates.archived_at');
  return query;
}

/**
 * The follow-up fields of an estimates row, in the shape the list API sends: what the "Call today" rule
 * (shared/estimate-call-today.cjs) and the page's other follow-up checks read. ONE mapping for the list route
 * and the 9 AM push, so the page and the push judge the same row. viewedAt and lastViewedAt stay null on a
 * row that was never sent (the list's own rule). sentAt stays null on a self-serve quote nobody delivered:
 * its sent_at is the mint stamp, not a send (codex pre-push P1). Once staff deliver one, it reads as
 * stored, as any estimate does.
 *
 * @param {object} row  estimates row (snake_case columns)
 * @param {{lastClickedAt?: *, lastCalledAt?: *, lastCallOutcome?: object, undeliveredSelfServe?: boolean}} [extra]  the
 *   three values read in batches (short_codes, call_log, activity_log), and the self-serve rule's answer for the row
 *   (services/self-serve-estimates.js)
 */
function callTodayFields(row, { lastClickedAt = null, lastCalledAt = null, lastCallOutcome = null, callOutcomeUnknown = false, stillDeciding = null, undeliveredSelfServe = false } = {}) {
  const hasBeenSent = !!row.sent_at;
  return {
    status: row.status,
    customerPhone: row.customer_phone,
    archivedAt: row.archived_at,
    sentAt: undeliveredSelfServe ? null : row.sent_at,
    viewedAt: hasBeenSent ? row.viewed_at : null,
    lastViewedAt: hasBeenSent ? row.last_viewed_at : null,
    lastClickedAt: lastClickedAt || null,
    lastFollowUpAt: row.last_follow_up_at,
    lastCalledAt: lastCalledAt || null,
    // The newest outcome tapped on the row, { outcome, at, by }, or null.
    lastCallOutcome: lastCallOutcome || null,
    // The outcome read failed, so null above proves nothing: the shared rule withholds the row from Call today.
    callOutcomeUnknown: Boolean(callOutcomeUnknown),
    // The newest reason the customer sent under "What would help you decide?", { reason, at }, or null.
    stillDeciding: stillDeciding || null,
    // A self-serve quote nobody delivered (plan restart, plan start, report card) never makes the
    // list: the zero-follow-up contract (services/self-serve-estimates.js). The caller passes the
    // rule's answer.
    undeliveredSelfServe: Boolean(undeliveredSelfServe),
  };
}

/**
 * May PATCH /api/admin/estimates/:id stamp a staff loss reason on this row WITHOUT a status change?
 * Only on a row whose status is `expired` (the request leaves the
 * status alone), and never on a never-sent internal draft that aged out (`expired_unsent`:
 * process debris, not a customer loss). Every live row keeps the old refusal.
 */
function staffReasonOnExpiredAllowed(estimate, body = {}) {
  if (estimate?.status !== 'expired') return false;
  if (body.status !== undefined && body.status !== 'expired') return false;
  if (!estimate.sent_at && !estimate.viewed_at) return false;
  return (estimate.disposition || '') !== 'expired_unsent';
}

module.exports = {
  ESTIMATE_LIST_LIMIT, SENT_ONLY_DELIVERY_ATTEMPT_STATUSES, estimateListQuery, clickStatsByEstimateId, lastCalledAtByEstimateId,
  CALL_OUTCOME_ACTION, staffFirstName, lastCallOutcomeByEstimateId, stillDecidingByEstimateId, callTodayFields, callLogPhoneFor, staffReasonOnExpiredAllowed,
  CUSTOMER_ANSWERED_SQL,
};
