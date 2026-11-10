'use strict';

// Daily check: an open estimate whose booking page shows no time within 7 days (owner 2026-11-09, option C).
// On 11-09 every open estimate's page showed nothing before Nov 21 and one customer had to text to ask. The page now
// tells the customer to text or call (client SlotPicker.jsx); this job tells the office, with ONE Estimates bell per
// estimate (category estimate_stuck, dedupeKey `estimate-no-time-soon:<id>`), and closes it when the problem is gone.
//
// Each run (7:35 AM ET):
//   1. READ: every open estimate (sent, not archived, not accepted/declined/expired/void, not expired by date, not an
//      internal test customer) gets the list its page's first read gets: getAvailableSlots with offer: true,
//      windowDays 14 and the route's default service mode. An estimate the page shows no booking for (a refusal, a
//      parked, commercial or invoice-only answer) is not judged. "No time soon" = the first open day, the earlier of
//      metadata.firstDayAvailability and the earliest listed slot, is missing or after ET today + SOON_DAYS.
//   2. CLOSE: every open bell whose estimate settled, left the open set, shows a time within 7 days, became a
//      no-booking answer, or whose category the owner silenced, closes with a one-line resolution (per-key advisory
//      lock, as closeSettledStuckAlerts). A lookup that throws fails CLOSED for that row (no raise, no close).
//   3. RAISE: a late first day rings once per episode (raiseAdminAlertWithReopen): a standing row is a silent
//      dedupe, a person's Done stays done while the problem stands, a comeback after our own close rings again.
//
// NO PAID CALLS: getAvailableSlots runs with paidCalls: false (no geocode, no Google road time, no make-room row) and
// bypassCache: true (the page's result cache is neither read nor written). An estimate whose stored coordinates
// cannot be used (COORDS_NEED_GEOCODE) is skipped and counted. Weather (api.weather.gov) is free and stays.
// Read-only except admin notification rows; texts, emails and calls no one. No GATE_* (owner rule 2026-11-05).
// A lookup that throws counts as failed and the run throws after the other rows, so job_health shows it.
// closeSettledNoTimeSoonAlerts is the cheap 5-minute pass for settled estimates (no picker run).

const db = require('../models/db');
const logger = require('./logger');
const { alertEpisodesLive } = require('../config/feature-gates');
const { etDateString, addETDays, formatETDayDate } = require('../utils/datetime-et');
const { composeAdminAlert, raiseAdminAlert } = require('./admin-alert-compose');
const { fitAction } = require('./admin-alert-names');
const { SOON_DAYS } = require('./scheduling/customer-move-limits');
const { isInternalTestCustomerId } = require('./internal-test-customers');
const episodes = require('./admin-alert-episodes');
const stuck = require('./estimate-stuck-alert');

const KEY_PREFIX = 'estimate-no-time-soon:';
const AREA = 'Estimates';
// The page's first read (client SlotPicker.jsx windowDays=14).
const WINDOW_DAYS = 14;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const DONE_STATES = new Set(['accepted', 'declined', 'expired', 'void']);
// Answers that book nothing by design (client slotLookahead.js NO_BOOKING_FLAGS).
const NO_BOOKING_FLAGS = ['reviewBeforeBooking', 'commercialManualScheduling', 'invoiceOnlyAcceptance'];
const SILENCED = 'silenced in Push Settings';
const idOf = (key) => String(key).slice(KEY_PREFIX.length);

// Why an estimate is no longer open, or null while it is: gone, never sent, archived, finished or expired by date.
function settledReason(row, now) {
  if (!row) return 'estimate gone';
  const status = String(row.status || '').toLowerCase();
  if (DONE_STATES.has(status)) return `estimate ${status}`;
  if (row.archived_at) return 'estimate archived';
  if (!row.sent_at) return 'estimate not sent';
  if (row.expires_at && new Date(row.expires_at) <= now) return 'estimate expired';
  return null;
}

const firstOpenDay = (result) => {
  const days = [result?.metadata?.firstDayAvailability?.date,
    ...['primary', 'expander'].flatMap((list) => (Array.isArray(result?.[list]) ? result[list] : []).map((slot) => slot?.date))]
    .map((day) => String(day || '').slice(0, 10)).filter((day) => YMD_RE.test(day));
  return days.length ? days.sort()[0] : null;
};

// One estimate's verdict: { kind: 'late', firstDay } | { kind: 'soon' } | { kind: 'no_booking' } | { kind: 'coords' }.
// Anything else throws (the caller fails closed).
async function judge(row, { now }) {
  const route = require('../routes/estimate-slots-public')._internals;
  const { getAvailableSlots } = require('./estimate-slot-availability');
  const refusal = await route.slotBrowseRefusal(row);
  if (refusal) return { kind: 'no_booking' };
  let result;
  try {
    result = await getAvailableSlots(row.id, {
      offer: true, bypassCache: true, paidCalls: false, windowDays: WINDOW_DAYS,
      serviceMode: route.resolveSlotServiceMode(row, ''),
    });
  } catch (err) {
    if (err?.code === 'COORDS_NEED_GEOCODE') return { kind: 'coords' };
    throw err;
  }
  if (NO_BOOKING_FLAGS.some((flag) => result?.[flag])) return { kind: 'no_booking' };
  const firstDay = firstOpenDay(result);
  const horizon = etDateString(addETDays(now, SOON_DAYS));
  return firstDay && firstDay <= horizon ? { kind: 'soon' } : { kind: 'late', firstDay };
}

function specFor(row, firstDay) {
  const name = String(row.customer_name || '').trim() || 'A customer';
  const where = firstDay ? `First open time on their estimate page: ${formatETDayDate(new Date(`${firstDay}T12:00:00Z`))}.`
    : `Nothing open in the next ${WINDOW_DAYS} days.`;
  return {
    area: AREA,
    action: fitAction(AREA, name, [(who) => `${who} has no open time in the next 7 days`, (who) => `${who}: no open time within 7 days`]),
    why: where,
    severity: 'needs-you',
    link: `/admin/estimates?estimateId=${row.id}`,
    subject: { type: 'estimate', id: String(row.id) },
    doneWhen: 'estimate_has_soon_time',
    who: 'person',
  };
}

async function raiseBell(row, firstDay) {
  let composed;
  try {
    composed = { spec: specFor(row, firstDay) };
    Object.assign(composed, composeAdminAlert(composed.spec));
  } catch {
    // A name that breaks the alert rules (an emoji, say) becomes "A customer".
    composed = { spec: specFor({ ...row, customer_name: null }, firstDay) };
    Object.assign(composed, composeAdminAlert(composed.spec));
  }
  const opts = {
    dedupeKey: `${KEY_PREFIX}${row.id}`,
    // Triggers the phone banner kind of the category (bell-banners.js); customerId sits at the top level for the
    // central test-customer suppression.
    metadata: { triggerKey: stuck.STUCK_CATEGORY, estimateId: row.id, customerId: row.customer_id || null },
  };
  const result = alertEpisodesLive()
    ? await episodes.raiseAdminAlertWithReopen(stuck.STUCK_CATEGORY, composed.headline, composed.why, {
      ...opts, link: composed.link, metadata: { ...composed.metadata, ...opts.metadata },
    })
    : await raiseAdminAlert(stuck.STUCK_CATEGORY, composed.spec, opts);
  if (!result) throw new Error('estimate no-time-soon bell was not written');
  return result.suppressed ? 0 : 1;
}

const capital = (text) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

// Close one key under the per-key lock raiseAdminAlertWithReopen takes. `stillTrue(trx)` re-reads the fact the close
// rests on (an estimate that settled); a raise that wins the lock first is seen open here. Returns 1 when closed.
async function closeKey(conn, key, why, now, stillTrue = null) {
  return conn.transaction(async (trx) => {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`admin:${key}`]);
    if (stillTrue && !(await stillTrue(trx))) return 0;
    return Number(await episodes.closeAdminAlertKeys(trx, [key], why, { now, resolution: capital(why) })) || 0;
  });
}

const settledNow = (id, now) => async (trx) => Boolean(settledReason(UUID_RE.test(id)
  ? await trx('estimates').where({ id }).first('id', 'status', 'sent_at', 'archived_at', 'expires_at') : null, now));

// Open keys whose estimate settled (or is gone): [key, reason]. One read of every open key's estimate.
async function settledKeyReasons(conn, keys, now) {
  const ids = [...new Set(keys.map(idOf).filter((id) => UUID_RE.test(id)))];
  const rows = ids.length ? await conn('estimates').whereIn('id', ids).select('id', 'status', 'sent_at', 'archived_at', 'expires_at') : [];
  const byId = new Map(rows.map((row) => [String(row.id).toLowerCase(), row]));
  return keys.map((key) => [key, settledReason(byId.get(idOf(key).toLowerCase()), now)]).filter(([, why]) => why);
}

/**
 * The 5-minute pass (scheduler estimate tick): close every open no-time-soon bell whose estimate is accepted,
 * declined, archived, expired or gone. No picker run. Never throws.
 */
async function closeSettledNoTimeSoonAlerts({ now = new Date(), conn = db } = {}) {
  const result = { ran: false, open: 0, closed: 0 };
  try {
    if (!alertEpisodesLive()) return result;
    result.ran = true;
    const keys = await episodes.openAdminAlertKeys(conn, KEY_PREFIX);
    result.open = keys.length;
    for (const [key, why] of await settledKeyReasons(conn, keys, now)) {
      result.closed += await closeKey(conn, key, why, now, settledNow(idOf(key), now));
    }
    if (result.closed) logger.info(`[estimate-no-time-soon] closed ${result.closed} alert(s) for settled estimates`);
  } catch (err) {
    logger.warn(`[estimate-no-time-soon] settle pass failed: ${String(err?.code || err?.name || 'error').slice(0, 40)}`);
  }
  return result;
}

// Every open estimate the check judges. The table keeps every estimate ever sent, so the open filter runs in SQL;
// settledReason stays the rule (a mixed-case status or a clock edge is caught there).
async function loadCandidates(conn, now) {
  const route = require('../routes/estimate-slots-public')._internals;
  const rows = await conn('estimates').whereNotNull('sent_at').whereNull('archived_at')
    .whereRaw("coalesce(lower(status), '') not in (?, ?, ?, ?)", [...DONE_STATES])
    .where((q) => q.whereNull('expires_at').orWhere('expires_at', '>', now))
    .select(...new Set([...route.SLOT_ESTIMATE_COLUMNS, 'sent_at']));
  return rows.filter((row) => !settledReason(row, now) && !isInternalTestCustomerId(row.customer_id));
}

// The verdict of each candidate, by id. A lookup that throws is counted and left out (fail closed).
async function judgeAll(rows, now, tally) {
  const verdicts = new Map();
  for (const row of rows) {
    try {
      const verdict = await judge(row, { now });
      if (verdict.kind === 'coords') tally.coordsSkipped += 1;
      verdicts.set(String(row.id), verdict);
    } catch (err) {
      tally.failed += 1;
      logger.warn(`[estimate-no-time-soon] check failed for estimate ${row.id}: ${String(err?.code || err?.name || 'error').slice(0, 40)}`);
    }
  }
  return verdicts;
}

// Why an open key's bell is done, or null while it stands. A key whose lookup failed or that was skipped stands.
function keyCloseReason(key, { silenced, verdicts, rows, settled }) {
  if (silenced) return SILENCED;
  if (settled.has(key)) return settled.get(key);
  const id = idOf(key).toLowerCase();
  if (!rows.has(id)) return 'estimate no longer open';
  const kind = verdicts.get(id)?.kind;
  if (kind === 'soon') return 'a time is open within 7 days';
  return kind === 'no_booking' ? 'the estimate page offers no booking' : null;
}

/**
 * Cron entry point (daily 7:35 AM ET). Returns { candidates, late, raised, closed, coordsSkipped } and throws after
 * finishing when a lookup failed, so runExclusive records it in job_health. `now` and `conn` are for tests.
 */
async function runEstimateNoTimeSoonCheck({ now = new Date(), conn = db } = {}) {
  const tally = { candidates: 0, late: 0, raised: 0, closed: 0, coordsSkipped: 0, failed: 0 };
  const silenced = await stuck.categorySilenced();
  const rows = await loadCandidates(conn, now);
  tally.candidates = rows.length;
  // A silenced category judges nothing: it raises nothing and closes what stands.
  const verdicts = silenced ? new Map() : await judgeAll(rows, now, tally);
  const rowById = new Map(rows.map((row) => [String(row.id).toLowerCase(), row]));
  if (alertEpisodesLive()) {
    const keys = await episodes.openAdminAlertKeys(conn, KEY_PREFIX);
    const settled = new Map(await settledKeyReasons(conn, keys, now));
    for (const key of keys) {
      const why = keyCloseReason(key, { silenced, verdicts, rows: rowById, settled });
      if (why) tally.closed += await closeKey(conn, key, why, now, settled.has(key) ? settledNow(idOf(key), now) : null);
    }
  }
  for (const row of silenced ? [] : rows) {
    const verdict = verdicts.get(String(row.id));
    if (verdict?.kind !== 'late') continue;
    tally.late += 1;
    try {
      tally.raised += await raiseBell(row, verdict.firstDay);
    } catch (err) {
      tally.failed += 1;
      logger.warn(`[estimate-no-time-soon] bell failed for estimate ${row.id}: ${String(err?.code || err?.name || 'error').slice(0, 40)}`);
    }
  }
  logger.info(`[estimate-no-time-soon] ${tally.candidates} open, ${tally.late} no time soon, ${tally.closed} closed, ${tally.coordsSkipped} skipped for coordinates, ${tally.failed} failed`);
  if (tally.failed) throw new Error(`${tally.failed} estimate no-time-soon check${tally.failed === 1 ? '' : 's'} failed`);
  return tally;
}

module.exports = {
  runEstimateNoTimeSoonCheck,
  closeSettledNoTimeSoonAlerts,
  KEY_PREFIX,
  _private: { settledReason, firstOpenDay, specFor, judge, keyCloseReason },
};
