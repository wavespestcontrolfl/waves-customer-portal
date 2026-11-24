/**
 * First-visit request from the estimate page (GATE_ESTIMATE_APPROVE_PREFERRED_TIME, owner 2026-11-23 "do all").
 *
 * Under the time picker, a customer whose offered times do not work gives the days (Mon to Sat) and the part of the day
 * that suit them, plus an optional note. This is a REQUEST, never an acceptance: the estimate keeps its status, nothing
 * is converted, invoiced, scheduled or charged, no card step runs and no customer text or email goes out. The office books
 * the visit with the existing accept-on-book from the estimate, which does the acceptance, the invoice and the card step.
 *
 * One transaction (the caller's, estimate row locked) writes two things together, so a crash can lose neither:
 *   1. estimate_data.firstVisitRequest = { days, window, note?, at }   (no migration: a jsonb key)
 *   2. ONE office bell, written on the same transaction (notifyAdmin's `trx` option), keyed by estimate AND request time
 * The request does NOT extend the estimate: its expiry is untouched, and the bell says when it expires. A second request
 * while one is pending changes nothing and raises nothing. Once the settle pass has closed the bell (the estimate was
 * accepted, declined, expired or archived) it stamps `settledAt` on the request; a settled request counts as absent, so a
 * reopened estimate takes a fresh request and rings a fresh bell.
 */

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_LABELS = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat' };
const WINDOWS = ['morning', 'afternoon', 'either'];
const MAX_NOTE_CHARS = 300;

const INVALID_MESSAGE = 'Please pick at least one day that works for you, and whether mornings or afternoons are better.';

/**
 * Validate and normalize the customer's request body.
 * Returns { ok: true, value } or { ok: false, error }. Unknown days are refused (never silently dropped); days come back
 * in week order, deduped.
 */
function normalizeFirstVisitRequest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: INVALID_MESSAGE };
  const days = Array.isArray(raw.days) ? raw.days.map((d) => String(d || '').trim().toLowerCase()) : [];
  if (!days.length || days.some((d) => !DAYS.includes(d))) return { ok: false, error: INVALID_MESSAGE };
  const window = typeof raw.window === 'string' ? raw.window.trim().toLowerCase() : '';
  if (!WINDOWS.includes(window)) return { ok: false, error: INVALID_MESSAGE };
  const note = typeof raw.note === 'string' ? raw.note.replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE_CHARS) : '';
  return { ok: true, value: { days: DAYS.filter((d) => days.includes(d)), window, ...(note ? { note } : {}) } };
}

// "Mon, Wed, Fri, mornings" for the office.
function describeRequest({ days = [], window = 'either' } = {}) {
  const dayText = days.length === DAYS.length ? 'Any day Mon to Sat' : days.map((d) => DAY_LABELS[d] || d).join(', ');
  const part = { morning: 'mornings', afternoon: 'afternoons', either: 'mornings or afternoons' }[window] || 'any time of day';
  return `${dayText}, ${part}`;
}

// The PENDING request, or null: none stored, or the stored one is settled (its bell was closed with the estimate).
function storedRequest(estimateData) {
  const req = estimateData && typeof estimateData === 'object' ? estimateData.firstVisitRequest : null;
  return req && Array.isArray(req.days) && req.days.length && !req.settledAt ? req : null;
}

// One bell per request: the key carries the request's own time, so a fresh request after a reopen is a fresh bell.
const KEY_PREFIX = 'estimate-first-visit-request:';
const requestKey = (estimateId, request) => `${KEY_PREFIX}${estimateId}:${Date.parse(request.at) || 0}`;

// The ONE office bell, written on the caller's transaction. Errors propagate so the request and its bell commit together or
// not at all; the caller owns the rollback.
async function raiseFirstVisitRequestBell({ estimate, request, trx }) {
  const { fitAction, redactedWords, shortDateET } = require('./admin-alert-names');
  const { raiseAdminAlert, cutAtWord } = require('./admin-alert-compose');
  const when = describeRequest(request);
  const note = request.note ? redactedWords(request.note) : '';
  const detail = [
    `${estimate.customer_name || 'The customer'} asked for a first visit on the estimate page and has NOT accepted. Nothing is booked, no invoice was made and no card was taken.`,
    `Preferred days and time: ${when}.`,
    note ? `Their note: “${note}”` : null,
    estimate.expires_at ? `Estimate expires ${shortDateET(estimate.expires_at)}; book before then or extend it from the estimate.` : null,
    'Book it from the estimate so it counts as accepted.',
    `Estimate: /admin/estimates?estimateId=${estimate.id}`,
  ].filter(Boolean).join('\n');
  const filed = await raiseAdminAlert('estimate', {
    area: 'Schedule',
    action: fitAction('Schedule', estimate.customer_name || 'this customer', [
      (n) => `book ${n}'s first visit`,
      (n) => `book ${n}`,
    ]),
    why: cutAtWord(`Asked for a first visit, not accepted yet; prefers ${when}.`, 110),
    severity: 'needs-you',
    link: `/admin/estimates?estimateId=${encodeURIComponent(estimate.id)}`,
    subject: { type: 'estimate', id: String(estimate.id) },
    doneWhen: 'visit_booked',
    who: 'person',
    contact: true,
  }, {
    bell: true,
    trx,
    dedupeKey: requestKey(estimate.id, request),
    detail,
    metadata: { estimateId: String(estimate.id), source: 'estimate_first_visit_request' },
  });
  if (!filed || filed.id == null || filed.suppressed === true) throw new Error('first-visit request bell was not written');
}

/**
 * Store the request on the LOCKED estimate row (`locked` was read FOR UPDATE inside `trx`) and raise the one bell.
 * Returns { deduped: false, request } for a fresh request, or { deduped: true, request } when one is already pending
 * (nothing is written and no second bell rings).
 */
async function storeFirstVisitRequest({ trx, locked, request, now = new Date() }) {
  const raw = typeof locked.estimate_data === 'string' ? JSON.parse(locked.estimate_data) : locked.estimate_data;
  const existing = storedRequest(raw);
  if (existing) return { deduped: true, request: existing };
  const stored = { ...request, at: now.toISOString() };
  await trx('estimates').where({ id: locked.id }).update({
    estimate_data: trx.raw("jsonb_set(COALESCE(estimate_data, '{}'::jsonb), '{firstVisitRequest}', ?::jsonb)", [JSON.stringify(stored)]),
    updated_at: trx.fn.now(),
  });
  await raiseFirstVisitRequestBell({ estimate: locked, request: stored, trx });
  return { deduped: false, request: stored };
}

// Close the request bell once the estimate settled (accepted = the office booked it, declined, expired, archived or gone), so a
// booked customer's task does not stand, and stamp `settledAt` on that request in the same transaction so a reopened
// estimate takes a fresh request. The same settle pass the stuck and hot-view bells use: the key set is read, each close
// re-reads the estimate under the per-key lock, and only while alert episodes are live (closeAdminAlertKeys stamps
// autoCleared). Called from the scheduler's 5-minute estimate tick; never throws.
const KEY_RE = /^estimate-first-visit-request:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(\d+)$/i;
function settledReason(row) {
  if (!row) return 'estimate gone';
  const status = String(row.status || '').toLowerCase();
  if (['accepted', 'declined', 'expired'].includes(status)) return `estimate ${status}`;
  return row.archived_at ? 'estimate archived' : null;
}
async function closeSettledRequestBells({ now = new Date(), conn = require('../models/db') } = {}) {
  const result = { ran: false, open: 0, closed: 0 };
  try {
    if (!require('../config/feature-gates').alertEpisodesLive()) return result;
    result.ran = true;
    const episodes = require('./admin-alert-episodes');
    const keys = await episodes.openAdminAlertKeys(conn, KEY_PREFIX);
    result.open = keys.length;
    for (const key of keys) {
      const match = KEY_RE.exec(key);
      if (!match) continue;
      const [, id, atMs] = match;
      const closed = await conn.transaction(async (trx) => {
        await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`admin:${key}`]);
        const row = await trx('estimates').where({ id }).forUpdate().first('id', 'status', 'archived_at', 'estimate_data');
        const why = settledReason(row);
        if (!why) return 0;
        // Settle the request this bell was for (not a newer one a reopen took), in the same transaction as the close.
        const data = row && (typeof row.estimate_data === 'string' ? JSON.parse(row.estimate_data) : row.estimate_data);
        const stored = data && data.firstVisitRequest;
        if (row && stored && !stored.settledAt && String(Date.parse(stored.at) || 0) === atMs) {
          await trx('estimates').where({ id }).update({
            estimate_data: trx.raw("jsonb_set(estimate_data, '{firstVisitRequest,settledAt}', to_jsonb(?::text))", [now.toISOString()]),
          });
        }
        return Number(await episodes.closeAdminAlertKeys(trx, [key], why, { now, resolution: `${why.charAt(0).toUpperCase()}${why.slice(1)}` })) || 0;
      });
      if (closed > 0) result.closed += 1;
    }
    return result;
  } catch (err) {
    require('./logger').warn(`[estimate-first-visit-request] settle pass failed: ${String(err?.code || err?.name || 'error').slice(0, 40)}`);
    return result;
  }
}

module.exports = {
  closeSettledRequestBells, KEY_PREFIX,
  DAYS, WINDOWS, MAX_NOTE_CHARS, requestKey,
  normalizeFirstVisitRequest, describeRequest, storedRequest, storeFirstVisitRequest, raiseFirstVisitRequestBell,
};
