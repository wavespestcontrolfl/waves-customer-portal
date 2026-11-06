/**
 * Office alert when a customer gets stuck on the estimate page (owner 2026-11-05, "1, 2 and 3": the estimate page
 * audit's fix 3, with fix 1's second step, the expired-return alert).
 *
 * One standing bell per estimate (category estimate_stuck, dedupeKey estimate_stuck:<id>), rung at most once per
 * Eastern day and sent to the admin phones with a sound (bell-banners.js kind estimate_stuck, 7 AM to 9 PM). A second
 * reason on the same day rewrites the row without ringing it. The headline names the customer; the why is the reason:
 *   "No open times in 90 days."          the page's 90-day look-ahead (client slotLookahead.js) came back empty
 *   "Searched 5 dates, all empty."       five date or Waves AI searches in a row found nothing
 *   "Picked Tue 9 AM, did not finish."   a hold the customer started expired with no booking (the 15-minute sweep)
 *   "The time list did not load."        the time list answered an error
 *   "Approve was refused: <reason>."     Approve was refused for a reason the page does not walk them through
 * and "<name> came back to an expired estimate", with when it expired and what the page offers them.
 *
 * Each search, hold start and hold end is a row in audit_log (audit-log.js auditEstimateBookingStep), so the next
 * booking audit can see this step; the empty-search count reads the same rows.
 *
 * Nothing here reaches the customer: every route answers exactly as before. Bots, staff browsers and the office
 * network are skipped (customer-page-views.js shouldRecord), and so is an estimate never sent. An accepted, declined
 * or archived estimate never raises, and its standing bell closes on the 5-minute pass (closeSettledStuckAlerts).
 * Every entry point resolves and never throws. A failure logs its error code alone: a query error's text carries
 * its bound values, and on these routes those can include the link token.
 */
const db = require('../models/db');
const logger = require('./logger');
const { alertEpisodesLive } = require('../config/feature-gates');
const { etDateString } = require('../utils/datetime-et');
const { dateOnlyString } = require('../utils/date-only');
const { composeAdminAlert, raiseAdminAlert, firstSentence, cutAtWord, breaksAlertRules, MAX_WHY_CHARS } = require('./admin-alert-compose');
const { fitAction, shortDateET } = require('./admin-alert-names');
const episodes = require('./admin-alert-episodes');

const STUCK_CATEGORY = 'estimate_stuck';
const KEY_PREFIX = `${STUCK_CATEGORY}:`;
// The page's look-ahead window (client slotLookahead.js LOOKAHEAD_DAYS, the 90-day booking horizon).
const LOOKAHEAD_DAYS = 90;
const EMPTY_SEARCHES = 5;
const SEARCH_TRAIL_ROWS = 20;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
// Answers that book nothing by design (client slotLookahead.js NO_BOOKING_FLAGS): an empty list is expected there.
const NO_BOOKING_FLAGS = ['reviewBeforeBooking', 'commercialManualScheduling', 'invoiceOnlyAcceptance'];
// Approve refusals the page walks the customer through (EstimateViewPage performAccept): one more tap on refreshed
// terms, a busy retry with the time still held, a time to pick again, or a reload into the estimate's no-booking path
// (the Bermuda gate, the area add-on and misting codes of isAreaAddOnNoBookingCode). The office-review park raises
// its own alert. The page's "call the office" billing refusals are not here: the office has to act on those.
// Statuses: 402 is the card, deposit and charge steps, 404 the generic not-found answer, 429 the rate limit.
const ROUTINE_ACCEPT_CODES = new Set([
  'TERMS_VERSION_STALE', 'CONSENT_VARIANT_STALE', 'CONSENT_VERSION_STALE', 'LAWN_LIMITS_STALE', 'ACCEPT_BILLING_CHANGED',
  'PAYMENT_TIMING_REFRESH', 'SETUP_FEE_TERMS_REFRESH', 'PREPAY_QUOTE_STALE', 'consumer_notice_required',
  'ACCEPT_INVOICE_BUSY_RETRY', 'DEPOSIT_LEDGER_BUSY_RETRY',
  'SLOT_UNAVAILABLE', 'RESERVATION_EXPIRED', 'ACCEPT_NEEDS_OFFICE_REVIEW',
  'BERMUDA_SUPPRESSION_GATED', 'AREA_ADDONS_GATED', 'AREA_ADDON_YEARLY_LIMIT_REACHED', 'AREA_ADDON_HISTORY_UNAVAILABLE',
  'AREA_ADDONS_ONE_TIME_ACCEPT_ONLY', 'MOSQUITO_MISTING_GATED', 'MOSQUITO_MISTING_ACCEPT_PENDING',
  'MOSQUITO_MISTING_INSTALL_UNRESOLVED',
]);
const ROUTINE_ACCEPT_STATUSES = new Set([402, 404, 429]);
// The page's own reads of a refusal's words: these two reload the estimate whatever the code, and an uncoded body
// (an older shape) that names a taken time or a lapsed hold goes back to the time picker.
const ROUTINE_REFUSAL_WORDS = /existing appointment is no longer available|estimate is no longer active/i;
const ROUTINE_UNCODED_WORDS = /slot no longer available|expired|no active reservation/i;
const ACTIONS = {
  stuck: [(who) => `${who} is stuck booking a visit`, (who) => `${who} is stuck booking`],
  expired: [(who) => `${who} came back to an expired estimate`, (who) => `${who} came back, estimate expired`],
};
// The why when the reason's own words break the alert rules.
const PLAIN_WHY = {
  stuck: 'The estimate page could not get them to a booking.',
  expired: 'Their estimate expired before they booked.',
};
const REFUSED = 'Approve was refused';

const metaOf = (value) => {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value) || {}; } catch { return {}; }
};

// Runs one entry point: resolves its value, or null after logging the error's code alone (see the header).
async function safely(what, fn) {
  try {
    return await fn();
  } catch (err) {
    logger.warn(`[estimate-stuck] ${what} failed: ${String(err?.code || err?.name || 'error').slice(0, 40)}`);
    return null;
  }
}

// A customer's own browser: not a bot, a staff browser (the admin marker cookie) or the office network.
const customerRequest = (req) => require('./customer-page-views').shouldRecord(req) === true;

function recordStep(action, estimate, metadata) {
  return require('./audit-log').auditEstimateBookingStep({
    action, estimateId: estimate.id, customerId: estimate.customer_id || null, metadata,
  });
}

// Why an estimate's bell is done, or null while it is open: accepted, declined, archived or gone. An expired estimate
// stays open: the office can still help, and the expired-return alert is about one.
function settledReason(row) {
  if (!row) return 'estimate gone';
  const status = String(row.status || '').toLowerCase();
  if (status === 'accepted' || status === 'declined') return `estimate ${status}`;
  return row.archived_at ? 'estimate archived' : null;
}

// The estimate as an alert needs it, or null when none may raise: a bad id, never sent, or settled.
async function openEstimate(estimateId) {
  if (!UUID_RE.test(String(estimateId || ''))) return null;
  const row = await db('estimates').where({ id: estimateId })
    .first('id', 'status', 'sent_at', 'archived_at', 'expires_at', 'customer_id', 'customer_name');
  return row && row.sent_at && !settledReason(row) ? row : null;
}

function stuckSpec(estimate, kind, name, why) {
  return {
    area: 'Estimates',
    action: fitAction('Estimates', String(name || '').trim() || 'A customer', ACTIONS[kind]),
    why,
    severity: 'needs-you',
    // The deep link the estimate bells use (EstimatesPageV2 scrolls to ?estimateId=).
    link: `/admin/estimates?estimateId=${estimate.id}`,
    subject: { type: 'estimate', id: String(estimate.id) },
    doneWhen: 'estimate_booked_or_closed',
    who: 'person',
  };
}

// A name that breaks the alert rules (an emoji, say) becomes "A customer"; a why that still does becomes the plain one.
function composeStuck(estimate, kind, why) {
  let failure;
  for (const [name, text] of [[estimate.customer_name, why], [null, why], [null, PLAIN_WHY[kind]]]) {
    const spec = stuckSpec(estimate, kind, name, text);
    try {
      return { spec, ...composeAdminAlert(spec) };
    } catch (err) {
      failure = err;
    }
  }
  throw failure;
}

// Raise, or refresh, the estimate's one bell. `whyFor(row)` words the reason from the estimate read here.
async function raiseStuck(estimateId, kind, whyFor, { now = new Date() } = {}) {
  const estimate = await openEstimate(estimateId);
  if (!estimate) return { raised: false, reason: 'not_open' };
  const composed = composeStuck(estimate, kind, whyFor(estimate));
  const day = etDateString(now);
  const opts = {
    dedupeKey: `${KEY_PREFIX}${estimate.id}`,
    // The day is the version: the first reason of a new Eastern day refreshes the row even in the same words, and
    // rings it; a later reason the same day rewrites it without a ring. One alert per estimate per day.
    dedupeVersion: day,
    refreshOnDedupe: true,
    bumpOnRefresh: true,
    ringOnRefresh: (existing, existingMeta) => existingMeta?.stuckDay !== day,
    // triggerKey names the phone banner (bell-banners.js); customerId sits at the top level, where
    // notification-service's test-customer suppression reads it.
    metadata: {
      triggerKey: STUCK_CATEGORY, estimateId: estimate.id, customerId: estimate.customer_id || null,
      stuckDay: day, stuckReason: kind,
    },
  };
  const result = alertEpisodesLive()
    ? await episodes.raiseAdminAlertWithReopen(STUCK_CATEGORY, composed.headline, composed.why, {
      ...opts, link: composed.link, metadata: { ...composed.metadata, ...opts.metadata },
    })
    : await raiseAdminAlert(STUCK_CATEGORY, composed.spec, opts);
  if (!result || result.suppressed) return { raised: false, reason: result ? 'suppressed' : 'notify_failed' };
  logger.info(`[estimate-stuck] ${kind} alert for estimate ${estimate.id}${result.deduped ? ' (standing row)' : ''}`);
  return { raised: true, reason: result.deduped ? 'refreshed' : 'sent' };
}

const slotsIn = (result) => ['primary', 'expander', 'availableSlots']
  .some((list) => Array.isArray(result?.[list]) && result[list].length > 0);

// Five searches in a row that found nothing, counted back from the newest of the estimate's search and hold-start
// rows of the last 24 hours. A search that found times, or a hold the customer started, ends the run.
async function raiseOnEmptyRun(estimate) {
  const trail = await db('audit_log')
    .where({ resource_type: 'estimate', resource_id: estimate.id })
    .whereIn('action', ['estimate_slot_search', 'estimate_hold_started'])
    .whereRaw("created_at > NOW() - interval '24 hours'")
    .orderBy('created_at', 'desc')
    .limit(SEARCH_TRAIL_ROWS)
    .select('action', 'metadata');
  const broken = trail.findIndex((row) => row.action !== 'estimate_slot_search' || metaOf(row.metadata).empty !== true);
  const run = broken === -1 ? trail.length : broken;
  return run >= EMPTY_SEARCHES ? raiseStuck(estimate.id, 'stuck', () => `Searched ${run} dates, all empty.`) : null;
}

// GET available-slots and POST find-slots answered (estimate-slots-public.js). `ask` says which read it was: the
// 14-day list (nothing set), the page's look-ahead ({ windowDays: 90 }), a date browse ({ date }) or a Waves AI
// search ({ search: 'ai' }). The look-ahead's own read of the first open day counts as a date browse that found times.
function noteSlotAnswer(req, estimate, { windowDays = null, date = null, search = null } = {}, result = {}) {
  return safely('slot answer', async () => {
    if (!estimate?.id || NO_BOOKING_FLAGS.some((flag) => result?.[flag]) || !customerRequest(req)) return null;
    const empty = !slotsIn(result);
    const via = search || (date ? 'date' : null);
    if (via) {
      await recordStep('estimate_slot_search', estimate, { via, date: date || null, empty });
      return empty ? raiseOnEmptyRun(estimate) : null;
    }
    // The 90-day list is capped and route-ordered: metadata.firstDayAvailability can name an opening the list left
    // out, and the page reads that day next (client slotLookahead.js fetchLookaheadSlots).
    if (!empty || result?.metadata?.firstDayAvailability?.date || !(Number(windowDays) >= LOOKAHEAD_DAYS)) return null;
    return raiseStuck(estimate.id, 'stuck', () => 'No open times in 90 days.');
  });
}

// The time list answered an error (available-slots' catch). A capacity miss asks the page to retry
// (SLOT_UNAVAILABLE, retry: true), so it is not a dead end.
function noteSlotListFailed(req, estimate, err) {
  return safely('slot list failure', async () => {
    if (!estimate?.id || err?.code === 'SLOT_UNAVAILABLE' || !customerRequest(req)) return null;
    return raiseStuck(estimate.id, 'stuck', () => 'The time list did not load.');
  });
}

// POST reserve took a hold. Its day and start come from the row itself.
function noteHoldStarted(req, estimate, { scheduledServiceId, expiresAt = null } = {}) {
  return safely('hold start', async () => {
    if (!estimate?.id || !scheduledServiceId || !customerRequest(req)) return null;
    const hold = await db('scheduled_services').where({ id: scheduledServiceId }).first('scheduled_date', 'window_start');
    return recordStep('estimate_hold_started', estimate, {
      scheduled_service_id: String(scheduledServiceId),
      date: hold ? dateOnlyString(hold.scheduled_date) || null : null,
      window_start: hold?.window_start || null,
      expires_at: expiresAt || null,
    });
  });
}

// DELETE reserve/:id let a hold go (the page drops a time it no longer shows). The start row has its day and time.
function noteHoldReleased(req, estimate, { scheduledServiceId, released } = {}) {
  return safely('hold release', async () => {
    if (!estimate?.id || !released || !customerRequest(req)) return null;
    return recordStep('estimate_hold_ended', estimate, { scheduled_service_id: String(scheduledServiceId), how: 'released' });
  });
}

// "Tue 9 AM", "Sat 11:30 AM": the hold's own calendar day and Eastern wall-clock start.
function holdLabel(date, windowStart) {
  const ymd = dateOnlyString(date);
  const clock = /^(\d{2}):(\d{2})/.exec(String(windowStart || ''));
  if (!YMD_RE.test(String(ymd || '')) || !clock) return null;
  const h = Number(clock[1]);
  const day = new Date(`${ymd}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
  return `${day} ${h % 12 || 12}${clock[2] === '00' ? '' : `:${clock[2]}`} ${h < 12 ? 'AM' : 'PM'}`;
}

const startedByCustomer = async (estimateId, holdId) => Boolean(await db('audit_log')
  .where({ resource_type: 'estimate', resource_id: estimateId, action: 'estimate_hold_started' })
  .whereRaw("metadata->>'scheduled_service_id' = ?", [String(holdId)])
  .first('id'));

const liveHoldOf = async (estimateId) => Boolean(await db('scheduled_services')
  .where({ source_estimate_id: estimateId })
  .whereNull('customer_id')
  .whereRaw('reservation_expires_at > NOW()')
  .first('id'));

// The expiry sweep deleted these holds (slot-reservation.js releaseExpiredReservations, DELETE ... RETURNING). Each
// estimate hold's end is recorded. The newest one per estimate raises "Picked <day time>, did not finish." when a
// customer started it (its start was recorded, so never a staff or bot hold), the estimate is still open, and no
// newer hold of it is live (they are still picking).
function noteExpiredHolds(rows) {
  return safely('expired holds', async () => {
    const newest = new Map();
    for (const hold of (rows || []).filter((row) => UUID_RE.test(String(row?.source_estimate_id || '')))) {
      const estimateId = String(hold.source_estimate_id);
      await recordStep('estimate_hold_ended', { id: estimateId }, {
        scheduled_service_id: String(hold.id), how: 'expired',
        date: dateOnlyString(hold.scheduled_date) || null, window_start: hold.window_start || null,
      });
      const seen = newest.get(estimateId);
      if (!seen || new Date(hold.created_at) > new Date(seen.created_at)) newest.set(estimateId, hold);
    }
    for (const [estimateId, hold] of newest) {
      await safely('expired hold', async () => {
        if (!(await startedByCustomer(estimateId, hold.id)) || await liveHoldOf(estimateId)) return null;
        const picked = holdLabel(hold.scheduled_date, hold.window_start) || 'a time';
        return raiseStuck(estimateId, 'stuck', () => `Picked ${picked}, did not finish.`);
      });
    }
    return newest.size;
  });
}

// "Approve was refused: <the server's first sentence>." Underscores read as spaces (a field name in the words); words
// that still break the alert rules give the plain line.
function refusalWhy(said) {
  const words = firstSentence((typeof said === 'string' ? said : '').replace(/_+/g, ' ')).replace(/[.\s]+$/u, '');
  const cut = words ? cutAtWord(words, MAX_WHY_CHARS - REFUSED.length - 3) : '';
  const why = cut ? `${REFUSED}: ${cut}${cut.endsWith('…') ? '' : '.'}` : '';
  return why && !breaksAlertRules(why) ? why : `${REFUSED}; the page showed them why.`;
}

// True when the page recovers from this refusal by itself (see ROUTINE_ACCEPT_CODES): the customer is not stuck.
function pageRecovers(status, payload) {
  const code = payload?.code || null;
  const said = typeof payload?.error === 'string' ? payload.error : '';
  return ROUTINE_ACCEPT_STATUSES.has(status) || ROUTINE_ACCEPT_CODES.has(code)
    || NO_BOOKING_FLAGS.some((flag) => payload?.[flag])
    || ROUTINE_REFUSAL_WORDS.test(said) || (!code && ROUTINE_UNCODED_WORDS.test(said));
}

// PUT accept answered a refusal (estimate-public.js logAcceptRefusals). One the page recovers from never raises.
function noteAcceptRefused(req, estimateId, status, payload) {
  return safely('accept refusal', async () => {
    if (!estimateId || pageRecovers(status, payload) || !customerRequest(req)) return null;
    return raiseStuck(estimateId, 'stuck', () => refusalWhy(payload?.error));
  });
}

function expiredWhy(expiresAt, offered, selfServe) {
  const day = expiresAt ? shortDateET(expiresAt) : '';
  const when = day ? ` on ${day}` : '';
  if (!offered) return `It expired${when} and the page shows it as not found.`;
  return selfServe
    ? `It expired${when}; they can reopen it for 7 days at the same price.`
    : `It expired${when}; they can ask you for more time.`;
}

// GET data answered an expired estimate's return (estimate-public.js recordExpiredOpen, which already skips staff,
// bots, the office network, PDF renders and the page's own refresh). `offered`: the page showed the reopen or
// ask-for-more-time button; `selfServe`: that button reopens it at once.
function noteExpiredReturn(estimate, { offered = false, selfServe = false } = {}) {
  return safely('expired return', async () => {
    if (!estimate?.id) return null;
    return raiseStuck(estimate.id, 'expired', (row) => expiredWhy(row.expires_at, offered === true, selfServe === true));
  });
}

/**
 * Close every open stuck bell whose estimate settled (accepted, declined, archived or gone), so a booked customer's
 * alert does not stand. Each close runs under the per-key lock raiseAdminAlertWithReopen takes, after reading the
 * estimate again: a raise that wins the lock first is seen open here, and one after the close rings a fresh
 * episode. Runs only while alert episodes are live (closeAdminAlertKeys stamps autoCleared, which only the reopen
 * wrapper reads). Called from the scheduler's 5-minute estimate tick; never throws.
 */
async function closeSettledStuckAlerts({ now = new Date(), conn = db } = {}) {
  const result = { ran: false, open: 0, closed: 0 };
  try {
    if (!alertEpisodesLive()) return result;
    result.ran = true;
    const keys = await episodes.openAdminAlertKeys(conn, KEY_PREFIX);
    result.open = keys.length;
    const idOf = (key) => String(key).slice(KEY_PREFIX.length);
    const ids = [...new Set(keys.map(idOf).filter((id) => UUID_RE.test(id)))];
    const rows = ids.length ? await conn('estimates').whereIn('id', ids).select('id', 'status', 'archived_at') : [];
    const byId = new Map(rows.map((row) => [String(row.id).toLowerCase(), row]));
    const rowOf = (key) => (UUID_RE.test(idOf(key)) ? byId.get(idOf(key).toLowerCase()) : null);
    for (const key of keys.filter((k) => settledReason(rowOf(k)))) {
      const closed = await conn.transaction(async (trx) => {
        await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`admin:${key}`]);
        const id = idOf(key);
        const why = settledReason(UUID_RE.test(id) ? await trx('estimates').where({ id }).first('id', 'status', 'archived_at') : null);
        if (!why) return 0;
        const resolution = `${why.charAt(0).toUpperCase()}${why.slice(1)}`;
        return Number(await episodes.closeAdminAlertKeys(trx, [key], why, { now, resolution })) || 0;
      });
      if (closed > 0) result.closed += 1;
    }
    if (result.closed) logger.info(`[estimate-stuck] closed ${result.closed} stuck alert(s) for settled estimates`);
    return result;
  } catch (err) {
    logger.warn(`[estimate-stuck] settle pass failed: ${String(err?.code || err?.name || 'error').slice(0, 40)}`);
    return result;
  }
}

module.exports = {
  STUCK_CATEGORY,
  noteSlotAnswer,
  noteSlotListFailed,
  noteHoldStarted,
  noteHoldReleased,
  noteExpiredHolds,
  noteAcceptRefused,
  noteExpiredReturn,
  closeSettledStuckAlerts,
  _private: { holdLabel, refusalWhy, expiredWhy, settledReason, ROUTINE_ACCEPT_CODES },
};
