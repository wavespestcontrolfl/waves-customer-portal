'use strict';

/**
 * Visit on hold, "customer will call" (GATE_VISIT_HOLD, owner 2026-11-27, "build hold").
 *
 * The customer told us twice "I will call you when ready", yet the visit stayed on the route and kept
 * getting reminder texts; another customer's visit moved four times and each move texted her. A held
 * visit is OFF the route and QUIET until the office releases it or the plan moves on.
 *
 * Storage (migration 20261127150000): scheduled_services.held_at / held_by / hold_note / hold_released_at.
 * The status stays pending / confirmed, so every plan-count reader still sees the visit. THE predicate is
 * `held_at IS NULL` = not held. Readers that send, move or show a visit call excludeHeld(query, alias),
 * heldSqlGuard(alias) or rowIsHeld(row). All three read the gate at call time and do nothing while
 * GATE_VISIT_HOLD is off, so a gate-off server runs exactly the SQL it ran before this feature (and a
 * test with no gate mock sees no change). Flipping the gate off therefore makes held visits behave as
 * normal visits again: documented in docs/gates-and-env.md.
 *
 * The same module owns the writers (hold, release) and the daily sweep (series close, day-14 bell). It
 * texts and emails no customer, anywhere.
 */

const db = require('../models/db');
const logger = require('./logger');
const { etDateString, etCalendarDaysUntil } = require('../utils/datetime-et');
const { dateOnlyString } = require('../utils/date-only');

// A visit can only be put on hold while it is plain scheduled work: not underway, not finished, not dead.
const HOLDABLE_STATUSES = Object.freeze(['pending', 'confirmed']);
const NOTE_MAX_CHARS = 280;
// The bell at day 14 (owner ruling): one bell, never repeated.
const BELL_DAY = 14;
const BELL_CATEGORY = 'schedule';
const BELL_KEY_PREFIX = 'visit-hold-day14:';
const HOLD_EXPIRED_NOTE = 'hold expired';

function visitHoldLive() {
  return require('../config/feature-gates').visitHoldLive?.() === true;
}

// Builder helper: skip held rows. `alias` is the table or alias the builder reads scheduled_services as; `applies` false
// leaves the builder untouched (a caller that must still see a held visit passes its own condition here).
function excludeHeld(builder, alias = 'scheduled_services', applies = true) {
  if (applies && visitHoldLive()) builder.whereNull(`${alias}.held_at`);
  return builder;
}

// Raw-SQL twin: ' AND ss.held_at IS NULL' while the gate is live, '' otherwise.
function heldSqlGuard(alias = 'ss') {
  return visitHoldLive() ? ` AND ${alias}.held_at IS NULL` : '';
}

// In-memory twin for rows already loaded (SELECT * rows carry held_at; a row loaded with named columns that omit
// held_at reads as not held, so a caller that filters in memory must select the column).
function rowIsHeld(row) {
  return visitHoldLive() && !!row && !!row.held_at;
}

// The projection twin: ['held_at'] only while the gate is live, so a gate-off server never names the column (a
// pre-migration schema must keep working). Spread it into a select / first list.
function heldColumn(prefix = '') {
  return visitHoldLive() ? [`${prefix}held_at`] : [];
}

// Is this one visit held right now? A lookup error answers "held" so a sender stays quiet on a blip (the street-level
// hold's rule); every caller treats it as a retryable deferral.
async function isVisitHeld(visitId, conn = db) {
  if (!visitId || !visitHoldLive()) return false;
  try {
    const row = await conn('scheduled_services').where({ id: visitId }).whereNotNull('held_at').first('id');
    return !!row;
  } catch (err) {
    logger.warn(`[visit-hold] hold lookup failed for ${visitId}: ${err.code || err.name || 'error'}`);
    return true;
  }
}

// The held subset of a list of visit ids, as a Set of strings. Fails closed (every id held) on an error.
async function heldVisitIds(ids, conn = db) {
  const list = [...new Set((ids || []).filter(Boolean).map(String))];
  if (!list.length || !visitHoldLive()) return new Set();
  try {
    const rows = await conn('scheduled_services').whereIn('id', list).whereNotNull('held_at').select('id');
    return new Set(rows.map((r) => String(r.id)));
  } catch (err) {
    logger.warn(`[visit-hold] hold lookup failed: ${err.code || err.name || 'error'}`);
    return new Set(list);
  }
}

function holdError(status, code, message) {
  return Object.assign(new Error(message), { status, statusCode: status, code, isOperational: true });
}

function cleanNote(note) {
  if (note == null) return null;
  const text = String(note).replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.slice(0, NOTE_MAX_CHARS);
}

/**
 * Put one visit on hold. Idempotent: a visit already held answers { changed: false }. Refuses a visit that is not
 * pending / confirmed. `scopeReq` is the request: for a technician the ownership predicate (his own live visit) is
 * re-checked here on the LOCKED row, so a reassignment between the route's pre-check and this write cannot let the
 * former technician hold the visit (404, like every other per-visit miss). An admin request is unscoped.
 */
async function putVisitOnHold({ visitId, note, heldBy = null, scopeReq = null, now = new Date(), conn = db } = {}) {
  if (!visitHoldLive()) throw holdError(404, 'visit_hold_off', 'Visit hold is not enabled');
  const cleaned = cleanNote(note);
  return conn.transaction(async (trx) => {
    const row = await trx('scheduled_services').where({ id: visitId }).forUpdate()
      .first('id', 'status', 'held_at', 'customer_id', 'scheduled_date', 'reservation_expires_at', 'visit_id');
    if (!row) throw holdError(404, 'not_found', 'Scheduled service not found');
    if (scopeReq) {
      const { technicianLiveVisitFilter } = require('./technician-visit-scope');
      const owned = await technicianLiveVisitFilter(scopeReq, trx('scheduled_services').where({ 'scheduled_services.id': visitId }))
        .first('scheduled_services.id');
      if (!owned) throw holdError(404, 'not_found', 'Scheduled service not found');
    }
    if (row.held_at) return { changed: false, visitId: row.id, heldAt: row.held_at };
    // A visit that shares a stop with another service (a grouped visit, created before grouping was retired) cannot be held:
    // the stop moves, notifies and completes as one unit, and no grouping writer remains that could join a held row.
    if (row.visit_id) {
      throw holdError(409, 'not_holdable_grouped', 'This visit shares a stop with another service. Reschedule it instead.');
    }
    // An unclaimed estimate slot reservation (no customer, a reservation expiry) is not a customer's visit: holding it
    // would hand its reserved hour to another booking. A real address-only visit has no expiry and can be held.
    if (!row.customer_id && row.reservation_expires_at) {
      throw holdError(409, 'not_holdable', 'An unclaimed estimate reservation cannot be put on hold');
    }
    if (!HOLDABLE_STATUSES.includes(String(row.status || '').toLowerCase())) {
      throw holdError(409, 'not_holdable', `A ${row.status || 'unknown'} visit cannot be put on hold`);
    }
    await trx('scheduled_services').where({ id: visitId }).update({
      held_at: now,
      held_by: heldBy || null,
      hold_note: cleaned,
      hold_released_at: null,
      updated_at: now,
    });
    // Close open overdue & not-closed-out alerts inside this transaction so a
    // held visit does not leave stale late/NCO cards in the Action Queue (P1-18).
    await require('./dispatch-alerts').autoResolveOverdueAlertsForJob({
      jobId: visitId,
      resolvedBy: heldBy || null,
      trx,
      toStatus: 'cancelled',
    });
    await require('./not-closed-out').resolveForService({
      serviceId: visitId,
      resolution: 'held',
      resolvedBy: heldBy || 'system',
      trx,
    });
    return { changed: true, visitId: row.id, heldAt: now, customerId: row.customer_id };
  });
}

// Close the day-14 bell of a visit whose hold ended. Never throws: the release itself already committed.
async function closeHoldBell(visitId, reason, { now = new Date(), conn = db } = {}) {
  try {
    return Number(await require('./admin-alert-episodes').closeAdminAlertKeys(conn, [`${BELL_KEY_PREFIX}${visitId}`], reason, {
      now, resolution: 'The hold ended',
    })) || 0;
  } catch (err) {
    logger.warn(`[visit-hold] bell close failed for ${visitId}: ${err.code || err.name || 'error'}`);
    return 0;
  }
}

/**
 * Take one visit off hold (office release). Idempotent. The visit keeps its date and window, and the reminder rows it
 * kept armed resume on the next sweep. While it was held its hour counted as free, so a booking may have taken the
 * hour: the release re-checks the original slot under the booking day lock and refuses (409 SLOT_TAKEN) when it is
 * taken. The office then reschedules the visit, which releases the hold in the same write.
 */
async function releaseVisitHold({ visitId, now = new Date(), reason = 'released', conn = db } = {}) {
  if (!visitHoldLive()) throw holdError(404, 'visit_hold_off', 'Visit hold is not enabled');
  const cols = ['id', 'status', 'held_at', 'scheduled_date', 'window_start', 'window_end', 'estimated_duration_minutes', 'technician_id'];
  const pre = await conn('scheduled_services').where({ id: visitId }).first(...cols);
  if (!pre) throw holdError(404, 'not_found', 'Scheduled service not found');
  if (!pre.held_at) return { changed: false, visitId: pre.id };
  const dateStr = dateOnlyString(pre.scheduled_date);
  const todayStr = etDateString(now);
  const result = await conn.transaction(async (trx) => {
    const occupancy = require('./scheduling/occupancy');
    // Rung 1 (the booking day lock) before the row lock, the order every booking writer takes.
    if (dateStr) await occupancy.acquireOccupancyLock(trx, dateStr);
    const row = await trx('scheduled_services').where({ id: visitId }).forUpdate().first(...cols);
    if (!row || !row.held_at) return { changed: false, visitId };
    // Refuse releasing a visit that is no longer holdable (cancelled/skipped/completed)
    // or whose original date has already passed — reschedule it instead (P2).
    if (!HOLDABLE_STATUSES.includes(String(row.status || '').toLowerCase())) {
      throw holdError(409, 'not_releasable', `A ${row.status || 'non-active'} visit cannot be released from hold.`);
    }
    // The day lock was taken for the unlocked read's date: a visit moved or held again since is not the one checked.
    const same = (a, b) => String(a ?? '') === String(b ?? '');
    if (new Date(row.held_at).getTime() !== new Date(pre.held_at).getTime() || dateOnlyString(row.scheduled_date) !== dateStr
      || !same(row.window_start, pre.window_start) || !same(row.window_end, pre.window_end)
      || !same(row.estimated_duration_minutes, pre.estimated_duration_minutes) || !same(row.technician_id, pre.technician_id)) {
      throw holdError(409, 'hold_changed', 'The visit changed while the hold was being released. Try again.');
    }
    if (dateStr && dateStr < todayStr) {
      throw holdError(409, 'past_date', 'This held visit is for a past date. Reschedule it to a new date to release the hold.');
    }
    if (row.technician_id) {
      await require('./technician-eligibility').assertAssignableTechnician(row.technician_id, { conn: trx, date: dateStr });
    }
    // Same span booking gives the visit: a start with no end occupies its estimated duration.
    if (dateStr >= todayStr && row.window_start) {
      let windowEnd;
      try {
        windowEnd = require('./rebooker').occupancyProbeEnd(row.window_start, row.window_end, row.estimated_duration_minutes);
      } catch { windowEnd = '23:59'; }
      const clash = await occupancy.findConflictingVisits({
        db: trx, date: dateStr, windowStart: row.window_start, windowEnd, excludeServiceIds: [visitId], technicianId: row.technician_id,
        includeInterviews: true,
      });
      if (clash.length) throw holdError(409, 'SLOT_TAKEN', 'That time was booked while the visit was on hold. Reschedule the visit to release the hold.');
    }
    await trx('scheduled_services').where({ id: visitId }).update({ held_at: null, hold_released_at: now, updated_at: now });
    return { changed: true, visitId: row.id };
  });
  if (result.changed) await closeHoldBell(visitId, reason, { now, conn });
  return result;
}

// The backstop every mover passes (services/rebooker.js reschedule and rescheduleSeries). A held visit is refused with
// 409 VISIT_ON_HOLD unless the caller is a person who chose to move it (options.releaseHold === true: the office
// reschedule routes and the customer's own reschedule link). It writes nothing: a person's move releases the hold in
// the SAME UPDATE that moves the visit (the rebooker adds the columns to its own write), and every other write carries
// `held_at IS NULL`, so a hold that commits after this read still stops the move. Returns true when the visit is held
// and this caller releases it (the caller closes the bell after the move commits), else false.
async function guardHeldMove(visitId, { releaseHold = false, conn = db } = {}) {
  if (!visitId || !visitHoldLive()) return false;
  const row = await conn('scheduled_services').where({ id: visitId }).first('id', 'held_at');
  if (!row || !row.held_at) return false;
  if (releaseHold !== true) {
    throw holdError(409, 'VISIT_ON_HOLD', 'That visit is on hold: the customer will call. Release the hold first.');
  }
  return true;
}

// Series sweeps count a held NON-anchor sibling but never move it: its status reads as the sentinel below, which no
// RESCHEDULABLE set holds, so the existing "counted, not moved" branches apply (the same way a skipped sibling is).
const HELD_SIBLING_STATUS = 'on_hold';
function markHeldSiblings(rows, anchorId) {
  if (!visitHoldLive()) return rows;
  return rows.map((row) => (row.held_at && String(row.id) !== String(anchorId) ? { ...row, status: HELD_SIBLING_STATUS } : row));
}

// The update patch a slot move adds so the office's own reschedule ends the hold. {} when the row is not held or
// the gate is off.
function releasePatchFor(row, now = new Date()) {
  return rowIsHeld(row) ? { held_at: null, hold_released_at: now } : {};
}

// The office list: every held visit, oldest hold first, with what the office needs to call back.
async function listHeldVisits({ conn = db, limit = 200 } = {}) {
  if (!visitHoldLive()) return [];
  const rows = await conn('scheduled_services as ss')
    .leftJoin('customers as c', 'ss.customer_id', 'c.id')
    .leftJoin('technicians as t', 'ss.technician_id', 't.id')
    .leftJoin('technicians as hb', 'ss.held_by', 'hb.id')
    .whereNotNull('ss.held_at')
    .whereIn('ss.status', HOLDABLE_STATUSES)
    .orderBy('ss.held_at', 'asc')
    .limit(Math.min(Math.max(Number(limit) || 200, 1), 500))
    .select(
      'ss.id', 'ss.customer_id', 'ss.technician_id', 'ss.estimated_duration_minutes', 'ss.service_type', 'ss.scheduled_date', 'ss.window_start', 'ss.window_end', 'ss.status',
      'ss.held_at', 'ss.hold_note', 'ss.is_recurring', 'ss.recurring_parent_id', 'ss.recurring_pattern',
      'c.first_name', 'c.last_name', 'c.phone as customer_phone',
      't.name as tech_name', 'hb.name as held_by_name',
    );
  const now = new Date();
  return rows.map((r) => ({
    id: r.id,
    customerId: r.customer_id,
    customerName: [r.first_name, r.last_name].filter(Boolean).join(' ') || null,
    customerPhone: r.customer_phone || null,
    serviceType: r.service_type,
    technicianId: r.technician_id || null,
    estimatedDuration: r.estimated_duration_minutes || null,
    scheduledDate: r.scheduled_date,
    windowStart: r.window_start,
    windowEnd: r.window_end,
    status: r.status,
    techName: r.tech_name || null,
    heldAt: r.held_at,
    heldByName: r.held_by_name || null,
    holdNote: r.hold_note || null,
    daysOnHold: daysBetweenET(r.held_at, now),
    // Same predicate the sweep closes on: a recurring plan visit (a booster month never closes by itself).
    inSeries: r.is_recurring === true,
  }));
}

// Whole ET calendar days from the day the hold began to today (0 on the day itself).
function daysBetweenET(heldAt, now = new Date()) {
  return Math.max(0, -etCalendarDaysUntil(etDateString(new Date(heldAt)), now));
}

// ---------------------------------------------------------------------------------------------------------------
// Series close (owner: "if the next plan visit comes first, the held visit closes, and the plan goes on").
// ---------------------------------------------------------------------------------------------------------------

// A recurring visit of the same plan series AFTER the held visit's date that is either completed, or live and already
// due (its date is today or earlier). Only a recurring plan visit counts, on both sides: a booster month
// (recurring_parent_id set, is_recurring false) and a one-time visit are never a series visit, so a held booster never
// expires and a due booster never expires a held plan visit. `lock` takes the successor's row lock (inside the close
// transaction). Returns the next visit row or null.
async function nextSeriesVisitReached(held, todayEt, conn = db, { lock = false } = {}) {
  if (held.is_recurring !== true) return null;
  const parentId = held.recurring_parent_id || held.id;
  // Series order is the cadence position (a date exception moves a visit's date, not its place in the plan); the
  // successor's own date then says whether it is due.
  const heldPosition = dateOnlyString(held.date_exception_cadence_date || held.scheduled_date);
  const query = conn('scheduled_services as n')
    .where(function () { this.where('n.recurring_parent_id', parentId).orWhere('n.id', parentId); })
    .where('n.is_recurring', true)
    .whereNot('n.id', held.id)
    .whereRaw('COALESCE(n.date_exception_cadence_date, n.scheduled_date) > ?::date', [heldPosition])
    .whereNull('n.held_at')
    .where(function () {
      this.where('n.status', 'completed')
        .orWhere(function () {
          this.whereIn('n.status', ['pending', 'confirmed', 'en_route', 'on_site']).where('n.scheduled_date', '<=', todayEt);
        });
    })
    .orderByRaw('COALESCE(n.date_exception_cadence_date, n.scheduled_date) asc');
  if (lock) query.forUpdate();
  return query.first('n.id', 'n.status', 'n.scheduled_date');
}

// Close one held visit as skipped: no customer text, no make-up visit. transitionJobStatus is the plan-hold
// lifecycle's own skip writer (cancellation-resolution/holds.js); reseedRecurringSeriesAfterCancel runs only from the
// cancel routes, so a skip adds no visit. The sweep's earlier read is only a prefilter: under the held visit's row lock
// this re-reads the visit (same hold timestamp, still pending / confirmed) and locks and re-reads its successor, so a
// dispatch move, cancel or hold of either one in between ends the close. The hold columns end in the same transaction.
// Returns the successor row when the visit closed, else null.
async function closeHeldVisitAsSkipped(held, todayEt, { now = new Date(), conn = db } = {}) {
  const { transitionJobStatus } = require('./job-status');
  const next = await conn.transaction(async (trx) => {
    const fresh = await trx('scheduled_services').where({ id: held.id }).forUpdate()
      .first('id', 'status', 'held_at', 'scheduled_date', 'is_recurring', 'recurring_parent_id', 'date_exception_cadence_date');
    if (!fresh || !fresh.held_at || !HOLDABLE_STATUSES.includes(String(fresh.status))) return null;
    if (held.held_at && new Date(fresh.held_at).getTime() !== new Date(held.held_at).getTime()) return null;
    const successor = await nextSeriesVisitReached(fresh, todayEt, trx, { lock: true });
    if (!successor) return null;
    await trx('scheduled_services').where({ id: held.id }).update({ held_at: null, hold_released_at: now, updated_at: now });
    await transitionJobStatus({
      jobId: held.id, fromStatus: fresh.status, toStatus: 'skipped', transitionedBy: null,
      notes: HOLD_EXPIRED_NOTE, notifyCustomer: false, suppressTechNotice: true, trx,
    });
    return successor;
  });
  if (!next) return null;
  await closeHoldBell(held.id, 'hold_expired', { now, conn });
  logger.info(`[visit-hold] closed held visit ${held.id} as skipped: plan visit ${next.id} (${next.status}) came first`);
  return next;
}

async function closeExpiredSeriesHolds({ now = new Date(), conn = db } = {}) {
  const todayEt = etDateString(now);
  const held = await conn('scheduled_services')
    .whereNotNull('held_at')
    .whereIn('status', HOLDABLE_STATUSES)
    .where('is_recurring', true)
    .select('id', 'status', 'scheduled_date', 'is_recurring', 'recurring_parent_id', 'held_at', 'date_exception_cadence_date');
  const closed = [];
  for (const row of held) {
    try {
      if (await nextSeriesVisitReached(row, todayEt, conn) && await closeHeldVisitAsSkipped(row, todayEt, { now, conn })) closed.push(row.id);
    } catch (err) {
      logger.error(`[visit-hold] series close failed for ${row.id}: ${err.message}`);
    }
  }
  return closed;
}

// ---------------------------------------------------------------------------------------------------------------
// Day-14 bell: ONE per visit. No dedupeOpenOnly (a closed row keeps its key, so the bell can never ring twice for
// the same visit), so no RERING entry. The row closes itself when the hold ends (release, reschedule, series close).
// ---------------------------------------------------------------------------------------------------------------

function shortDate(heldAt) {
  try {
    return new Date(heldAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' });
  } catch { return ''; }
}

async function ringDay14Bells({ now = new Date(), conn = db } = {}) {
  const { raiseAdminAlert } = require('./admin-alert-compose');
  const { fitAction, tidyName } = require('./admin-alert-names');
  const held = await conn('scheduled_services as ss')
    .leftJoin('customers as c', 'ss.customer_id', 'c.id')
    .whereNotNull('ss.held_at')
    .whereIn('ss.status', HOLDABLE_STATUSES)
    .select('ss.id', 'ss.customer_id', 'ss.held_at', 'c.first_name', 'c.last_name');
  const rang = [];
  for (const row of held) {
    const days = daysBetweenET(row.held_at, now);
    if (days < BELL_DAY) continue;
    const name = tidyName([row.first_name, row.last_name].filter(Boolean).join(' ')) || 'A customer';
    try {
      const result = await raiseAdminAlert(BELL_CATEGORY, {
        area: 'Schedule',
        action: fitAction('Schedule', name, [(who) => `call ${who} to rebook`]),
        why: `${name} is still on hold since ${shortDate(row.held_at)} (${days} days).`,
        severity: 'needs-you',
        link: row.customer_id ? `/admin/customers?customerId=${row.customer_id}` : '/admin/schedule?view=on-hold',
        subject: { type: 'visit', id: String(row.id) },
        doneWhen: 'hold_ended',
        who: 'person',
      }, { dedupeKey: `${BELL_KEY_PREFIX}${row.id}`, bellDefault: true });
      if (result && !result.deduped && !result.suppressed) rang.push(row.id);
    } catch (err) {
      logger.error(`[visit-hold] day-14 bell failed for ${row.id}: ${err.message}`);
    }
  }
  return rang;
}

// Close a day-14 bell whose visit is no longer on hold (a release path that did not run closeHoldBell, a cancel).
async function closeStaleBells({ now = new Date(), conn = db } = {}) {
  const open = await conn('notifications')
    .where({ recipient_type: 'admin' })
    .whereRaw("starts_with(metadata->>'dedupeKey', ?)", [BELL_KEY_PREFIX])
    .whereRaw("metadata->>'autoCleared' IS DISTINCT FROM 'true'")
    .select(conn.raw("metadata->>'dedupeKey' as dedupe_key"));
  const keys = [...new Set(open.map((r) => r.dedupe_key))];
  if (!keys.length) return 0;
  const ids = keys.map((k) => k.slice(BELL_KEY_PREFIX.length));
  const stillHeld = await conn('scheduled_services').whereIn('id', ids).whereNotNull('held_at')
    .whereIn('status', HOLDABLE_STATUSES).select('id');
  const heldSet = new Set(stillHeld.map((r) => String(r.id)));
  const toClose = keys.filter((k) => !heldSet.has(k.slice(BELL_KEY_PREFIX.length)));
  if (!toClose.length) return 0;
  return Number(await require('./admin-alert-episodes').closeAdminAlertKeys(conn, toClose, 'hold_ended', {
    now, resolution: 'The hold ended',
  })) || 0;
}

/**
 * Daily sweep (scheduler.js): series close first, then the day-14 bell, then any bell whose hold already ended.
 * Inert while the gate is off.
 */
async function runVisitHoldSweep({ now = new Date(), conn = db } = {}) {
  if (!visitHoldLive()) return { skipped: true };
  const closed = await closeExpiredSeriesHolds({ now, conn });
  const rang = await ringDay14Bells({ now, conn });
  const bellsClosed = await closeStaleBells({ now, conn });
  return { skipped: false, closed: closed.length, rang: rang.length, bellsClosed };
}

module.exports = {
  HOLDABLE_STATUSES,
  NOTE_MAX_CHARS,
  BELL_DAY,
  BELL_KEY_PREFIX,
  HOLD_EXPIRED_NOTE,
  visitHoldLive,
  excludeHeld,
  heldSqlGuard,
  rowIsHeld,
  isVisitHeld,
  heldVisitIds,
  heldColumn,
  closeHoldBell,
  putVisitOnHold,
  releaseVisitHold,
  releasePatchFor,
  guardHeldMove,
  markHeldSiblings,
  HELD_SIBLING_STATUS,
  listHeldVisits,
  daysBetweenET,
  nextSeriesVisitReached,
  closeExpiredSeriesHolds,
  ringDay14Bells,
  closeStaleBells,
  runVisitHoldSweep,
  _private: { cleanNote, closeHeldVisitAsSkipped },
};
