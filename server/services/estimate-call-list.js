/**
 * Viewed-estimate call list (GATE_ESTIMATE_CALL_LIST, admin only).
 *
 * The estimates list carries `lastCalledAt` on every VIEWED row while the gate is on:
 * the newest outbound call_log row to that estimate's customer phone that the CUSTOMER answered.
 * The admin page uses it to drop an offer from "Call today" once somebody has reached the customer
 * (the click-to-call bridge in call-bridge.js writes `direction = 'outbound'` with `to_phone` in E.164).
 *
 * One batched query for the whole page, never one per row. Read-only: it dials, texts and
 * emails nobody, and costs nothing.
 */

const { toE164 } = require('../utils/phone');

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
  const rows = await database('call_log')
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

/**
 * May PATCH /api/admin/estimates/:id stamp a staff loss reason on this row WITHOUT a status change?
 * Only while the gate is on, only on a row whose status is `expired` (the request leaves the
 * status alone), and never on a never-sent internal draft that aged out (`expired_unsent`:
 * process debris, not a customer loss). Every live row keeps the old refusal.
 */
function staffReasonOnExpiredAllowed(estimate, body = {}) {
  if (require('../config/feature-gates').estimateCallListLive?.() !== true) return false;
  if (estimate?.status !== 'expired') return false;
  if (body.status !== undefined && body.status !== 'expired') return false;
  if (!estimate.sent_at && !estimate.viewed_at) return false;
  return (estimate.disposition || '') !== 'expired_unsent';
}

module.exports = { lastCalledAtByEstimateId, callLogPhoneFor, staffReasonOnExpiredAllowed, CUSTOMER_ANSWERED_SQL };
