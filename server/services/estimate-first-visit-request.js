/**
 * First-visit request from the estimate page (GATE_ESTIMATE_APPROVE_PREFERRED_TIME, owner 2026-11-23 "do all").
 *
 * Under the time picker, a customer whose offered times do not work gives the days (Mon to Sat) and the part of the day
 * that suit them, plus an optional note. This is a REQUEST, never an acceptance, and it is STATELESS: the estimate row is not
 * written at all (no status, no estimate_data, no expiry), nothing is converted, invoiced, scheduled or charged, no card step
 * runs and no customer text or email goes out. The only effect is ONE office bell (days, window, masked note, the estimate's
 * expiry date), deduped open-only on `estimate-first-visit-request:<estimateId>`: while that bell is open a repeat request
 * rings nothing; once the office has closed it, a new request rings a new one. The office books the visit with the existing
 * accept-on-book from the estimate, which does the acceptance, the invoice and the card step.
 *
 * The settle pass closes the open bell once the estimate is no longer open (status not sent or viewed, archived, past its
 * expiry date, or gone). Nothing else is stamped.
 */

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_LABELS = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat' };
const WINDOWS = ['morning', 'afternoon', 'either'];
const MAX_NOTE_CHARS = 300;
const KEY_PREFIX = 'estimate-first-visit-request:';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

/**
 * The ONE office bell, written on the caller's transaction (errors propagate so the caller rolls back and the customer can
 * retry). Open-only dedupe: while the estimate's bell is open this rings nothing and answers { deduped: true }.
 * Returns { deduped: boolean }.
 */
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
    dedupeKey: `${KEY_PREFIX}${estimate.id}`,
    dedupeOpenOnly: true,
    detail,
    metadata: { estimateId: String(estimate.id), source: 'estimate_first_visit_request' },
  });
  if (!filed || filed.id == null || filed.suppressed === true) throw new Error('first-visit request bell was not written');
  return { deduped: filed.deduped === true };
}

// Why the estimate no longer takes a request (so its open bell is done), or null while it is open. `now` is the pass's clock.
function settledReason(row, now) {
  if (!row) return 'estimate gone';
  if (row.archived_at) return 'estimate archived';
  const status = String(row.status || '').toLowerCase();
  if (status !== 'sent' && status !== 'viewed') return `estimate ${status || 'closed'}`;
  if (row.expires_at && new Date(row.expires_at) < now) return 'estimate expired';
  return null;
}

// Close the open request bell once its estimate is no longer open. The same settle pass the stuck and hot-view bells use: the key
// set is read, each close re-reads the estimate under the per-key lock, and only while alert episodes are live (closeAdminAlertKeys
// stamps autoCleared). Called from the scheduler's 5-minute estimate tick; never throws.
async function closeSettledRequestBells({ now = new Date(), conn = require('../models/db') } = {}) {
  const result = { ran: false, open: 0, closed: 0 };
  try {
    if (!require('../config/feature-gates').alertEpisodesLive()) return result;
    result.ran = true;
    const episodes = require('./admin-alert-episodes');
    const keys = await episodes.openAdminAlertKeys(conn, KEY_PREFIX);
    result.open = keys.length;
    for (const key of keys) {
      const id = key.slice(KEY_PREFIX.length);
      if (!UUID_RE.test(id)) continue;
      const closed = await conn.transaction(async (trx) => {
        await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`admin:${key}`]);
        const why = settledReason(await trx('estimates').where({ id }).first('id', 'status', 'archived_at', 'expires_at'), now);
        if (!why) return 0;
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
  DAYS, WINDOWS, MAX_NOTE_CHARS, KEY_PREFIX,
  normalizeFirstVisitRequest, describeRequest, raiseFirstVisitRequestBell, settledReason, closeSettledRequestBells,
};
