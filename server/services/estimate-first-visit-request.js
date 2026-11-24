/**
 * First-visit request from the estimate page (GATE_ESTIMATE_APPROVE_PREFERRED_TIME, owner 2026-11-23 "do all").
 *
 * Under the time picker, a customer whose offered times do not work gives the days (Mon to Sat) and the part of the day
 * that suit them, plus an optional note. This is a REQUEST, never an acceptance: the estimate keeps its status, nothing
 * is converted, invoiced, scheduled or charged, no card step runs and no customer text or email goes out. The office books
 * the visit with the existing accept-on-book from the estimate, which does the acceptance, the invoice and the card step.
 *
 * One transaction (the caller's, estimate row locked) writes three things together, so a crash can lose none of them:
 *   1. estimate_data.firstVisitRequest = { days, window, note?, at }   (no migration: a jsonb key)
 *   2. expires_at pushed out to at least HOLD_DAYS from now          (the expiry sweep keys on expires_at, so the
 *      estimate stays open while the office works the request; the same field an operator extension moves)
 *   3. ONE office bell, deduped per estimate, written on the same transaction (notifyAdmin's `trx` option)
 * A second request on the same estimate changes nothing and raises nothing.
 */

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_LABELS = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat' };
const WINDOWS = ['morning', 'afternoon', 'either'];
const MAX_NOTE_CHARS = 300;
const HOLD_DAYS = 14;

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

function storedRequest(estimateData) {
  const req = estimateData && typeof estimateData === 'object' ? estimateData.firstVisitRequest : null;
  return req && Array.isArray(req.days) && req.days.length ? req : null;
}

// The ONE office bell, written on the caller's transaction. Errors propagate so the request and its bell commit together or
// not at all; the caller owns the rollback.
async function raiseFirstVisitRequestBell({ estimate, request, trx }) {
  const { fitAction, redactedWords } = require('./admin-alert-names');
  const { raiseAdminAlert, cutAtWord } = require('./admin-alert-compose');
  const when = describeRequest(request);
  const note = request.note ? redactedWords(request.note) : '';
  const detail = [
    `${estimate.customer_name || 'The customer'} asked for a first visit on the estimate page and has NOT accepted. Nothing is booked, no invoice was made and no card was taken.`,
    `Preferred days and time: ${when}.`,
    note ? `Their note: “${note}”` : null,
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
    dedupeKey: `estimate-first-visit-request:${estimate.id}`,
    detail,
    metadata: { estimateId: String(estimate.id), source: 'estimate_first_visit_request' },
  });
  if (!filed || filed.id == null || filed.suppressed === true) throw new Error('first-visit request bell was not written');
}

/**
 * Store the request on the LOCKED estimate row (`locked` was read FOR UPDATE inside `trx`) and raise the one bell.
 * Returns { deduped: false, request } for a fresh request, or { deduped: true, request } when one is already stored
 * (nothing is written and no second bell rings).
 */
async function storeFirstVisitRequest({ trx, locked, request, now = new Date() }) {
  const raw = typeof locked.estimate_data === 'string' ? JSON.parse(locked.estimate_data) : locked.estimate_data;
  const existing = storedRequest(raw);
  if (existing) return { deduped: true, request: existing };
  const stored = { ...request, at: now.toISOString() };
  await trx('estimates').where({ id: locked.id }).update({
    estimate_data: trx.raw("jsonb_set(COALESCE(estimate_data, '{}'::jsonb), '{firstVisitRequest}', ?::jsonb)", [JSON.stringify(stored)]),
    // Hold the estimate open: never shortened, and never left null (a null expiry ages out on the send date instead).
    expires_at: trx.raw("GREATEST(COALESCE(expires_at, NOW()), NOW() + (? * interval '1 day'))", [HOLD_DAYS]),
    updated_at: trx.fn.now(),
  });
  await raiseFirstVisitRequestBell({ estimate: locked, request: stored, trx });
  return { deduped: false, request: stored };
}

module.exports = {
  DAYS, WINDOWS, MAX_NOTE_CHARS, HOLD_DAYS,
  normalizeFirstVisitRequest, describeRequest, storedRequest, storeFirstVisitRequest, raiseFirstVisitRequestBell,
};
