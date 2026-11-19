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

// Hard ceiling for limit=all list fetches. The estimates pipeline computes all-time KPIs client-side from this list; if
// the table ever outgrows this cap the analytics silently truncate to the newest rows, so keep generous headroom
// (pricing-risk batch is pure compute after one inventory preload).
const ESTIMATE_LIST_LIMIT = 2000;
const SENT_ONLY_DELIVERY_ATTEMPT_STATUSES = ['scheduled', 'sending', 'send_failed'];

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
    .orderBy('estimates.created_at', 'desc');
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
 * The fields the "Call today" rule reads (shared/estimate-call-today.cjs), in the shape the list API sends.
 * ONE mapping for the list route and the 9 AM push, so the page and the push judge the same row.
 * viewedAt and lastViewedAt stay null on a row that was never sent (the list's own rule).
 *
 * @param {object} row  estimates row (snake_case columns)
 * @param {{lastClickedAt?: *, lastCalledAt?: *}} [extra]  the two values read in batches (short_codes, call_log)
 */
function callTodayFields(row, { lastClickedAt = null, lastCalledAt = null } = {}) {
  const hasBeenSent = !!row.sent_at;
  return {
    status: row.status,
    customerPhone: row.customer_phone,
    archivedAt: row.archived_at,
    viewedAt: hasBeenSent ? row.viewed_at : null,
    lastViewedAt: hasBeenSent ? row.last_viewed_at : null,
    lastClickedAt: lastClickedAt || null,
    lastFollowUpAt: row.last_follow_up_at,
    lastCalledAt: lastCalledAt || null,
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

module.exports = { ESTIMATE_LIST_LIMIT, SENT_ONLY_DELIVERY_ATTEMPT_STATUSES, estimateListQuery, lastCalledAtByEstimateId, callTodayFields, callLogPhoneFor, staffReasonOnExpiredAllowed, CUSTOMER_ANSWERED_SQL };
