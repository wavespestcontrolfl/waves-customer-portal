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

// Builder helper: skip held rows. `alias` is the table or alias the builder reads scheduled_services as.
function excludeHeld(query, alias = 'scheduled_services') {
  if (visitHoldLive()) query.whereNull(`${alias}.held_at`);
  return query;
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
 * Put one visit on hold. The caller has already checked who may (admin any visit; a technician only his own).
 * Idempotent: a visit already held answers { changed: false }. Refuses a visit that is not pending / confirmed.
 */
async function putVisitOnHold({ visitId, note, heldBy = null, now = new Date(), conn = db } = {}) {
  if (!visitHoldLive()) throw holdError(404, 'visit_hold_off', 'Visit hold is not enabled');
  const cleaned = cleanNote(note);
  return conn.transaction(async (trx) => {
    const row = await trx('scheduled_services').where({ id: visitId }).forUpdate()
      .first('id', 'status', 'held_at', 'customer_id', 'scheduled_date');
    if (!row) throw holdError(404, 'not_found', 'Scheduled service not found');
    if (row.held_at) return { changed: false, visitId: row.id, heldAt: row.held_at };
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
 * Take one visit off hold (office release). Idempotent. The visit keeps its date and window; the reminder rows it
 * kept armed resume on the next sweep.
 */
async function releaseVisitHold({ visitId, now = new Date(), reason = 'released', conn = db } = {}) {
  if (!visitHoldLive()) throw holdError(404, 'visit_hold_off', 'Visit hold is not enabled');
  const result = await conn.transaction(async (trx) => {
    const row = await trx('scheduled_services').where({ id: visitId }).forUpdate().first('id', 'held_at');
    if (!row) throw holdError(404, 'not_found', 'Scheduled service not found');
    if (!row.held_at) return { changed: false, visitId: row.id };
    await trx('scheduled_services').where({ id: visitId }).update({ held_at: null, hold_released_at: now, updated_at: now });
    return { changed: true, visitId: row.id };
  });
  if (result.changed) await closeHoldBell(visitId, reason, { now, conn });
  return result;
}

// The one backstop every mover passes (services/rebooker.js reschedule + rescheduleSeries). A held visit is refused with
// 409 VISIT_ON_HOLD unless the caller is a person who chose to move it (options.releaseHold === true: the office
// reschedule routes and the customer's own reschedule link). That person's move releases the hold first; the returned
// restore() puts the hold back if the move then fails. Returns null when the visit is not held (the usual case: one
// indexed read while the gate is on, nothing while it is off).
async function guardHeldMove(visitId, { releaseHold = false, conn = db } = {}) {
  if (!visitId || !visitHoldLive()) return null;
  const row = await conn('scheduled_services').where({ id: visitId }).first('id', 'held_at', 'held_by', 'hold_note');
  if (!row || !row.held_at) return null;
  if (releaseHold !== true) {
    throw holdError(409, 'VISIT_ON_HOLD', 'That visit is on hold: the customer will call. Release the hold first.');
  }
  await releaseVisitHold({ visitId, conn });
  return {
    restore: async () => {
      try {
        await conn('scheduled_services').where({ id: visitId }).whereNull('held_at')
          .update({ held_at: row.held_at, held_by: row.held_by, hold_note: row.hold_note, hold_released_at: null });
      } catch (err) {
        logger.warn(`[visit-hold] could not restore the hold on ${visitId} after a failed move: ${err.code || err.name || 'error'}`);
      }
    },
  };
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
      'ss.id', 'ss.customer_id', 'ss.service_type', 'ss.scheduled_date', 'ss.window_start', 'ss.window_end', 'ss.status',
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
    scheduledDate: r.scheduled_date,
    windowStart: r.window_start,
    windowEnd: r.window_end,
    status: r.status,
    techName: r.tech_name || null,
    heldAt: r.held_at,
    heldByName: r.held_by_name || null,
    holdNote: r.hold_note || null,
    daysOnHold: daysBetweenET(r.held_at, now),
    inSeries: !!(r.is_recurring || r.recurring_parent_id),
  }));
}

// Whole ET calendar days from the day the hold began to today (0 on the day itself).
function daysBetweenET(heldAt, now = new Date()) {
  return Math.max(0, -etCalendarDaysUntil(etDateString(new Date(heldAt)), now));
}

// ---------------------------------------------------------------------------------------------------------------
// Series close (owner: "if the next plan visit comes first, the held visit closes, and the plan goes on").
// ---------------------------------------------------------------------------------------------------------------

// A visit of the same plan series AFTER the held visit's date that is either completed, or live and already due
// (its date is today or earlier). One-time visits (no series) never close. Returns the next visit row or null.
async function nextSeriesVisitReached(held, todayEt, conn = db) {
  const parentId = held.recurring_parent_id || (held.is_recurring ? held.id : null);
  if (!parentId) return null;
  return conn('scheduled_services as n')
    .where(function () { this.where('n.recurring_parent_id', parentId).orWhere('n.id', parentId); })
    .whereNot('n.id', held.id)
    .where('n.scheduled_date', '>', held.scheduled_date)
    .whereNull('n.held_at')
    .where(function () {
      this.where('n.status', 'completed')
        .orWhere(function () {
          this.whereIn('n.status', ['pending', 'confirmed', 'en_route', 'on_site']).where('n.scheduled_date', '<=', todayEt);
        });
    })
    .orderBy('n.scheduled_date', 'asc')
    .first('n.id', 'n.status', 'n.scheduled_date');
}

// Close one held visit as skipped: no customer text, no make-up visit. transitionJobStatus is the plan-hold
// lifecycle's own skip writer (cancellation-resolution/holds.js); reseedRecurringSeriesAfterCancel runs only from the
// cancel routes, so a skip adds no visit. The hold columns end in the same transaction.
async function closeHeldVisitAsSkipped(held, next, { now = new Date(), conn = db } = {}) {
  const { transitionJobStatus } = require('./job-status');
  await conn.transaction(async (trx) => {
    const fresh = await trx('scheduled_services').where({ id: held.id }).forUpdate().first('id', 'status', 'held_at');
    if (!fresh || !fresh.held_at || !HOLDABLE_STATUSES.includes(String(fresh.status))) return;
    await trx('scheduled_services').where({ id: held.id }).update({ held_at: null, hold_released_at: now, updated_at: now });
    await transitionJobStatus({
      jobId: held.id, fromStatus: fresh.status, toStatus: 'skipped', transitionedBy: null,
      notes: HOLD_EXPIRED_NOTE, notifyCustomer: false, suppressTechNotice: true, trx,
    });
  });
  await closeHoldBell(held.id, 'hold_expired', { now, conn });
  logger.info(`[visit-hold] closed held visit ${held.id} as skipped: plan visit ${next.id} (${next.status}) came first`);
}

async function closeExpiredSeriesHolds({ now = new Date(), conn = db } = {}) {
  const todayEt = etDateString(now);
  const held = await conn('scheduled_services')
    .whereNotNull('held_at')
    .whereIn('status', HOLDABLE_STATUSES)
    .select('id', 'status', 'scheduled_date', 'is_recurring', 'recurring_parent_id');
  const closed = [];
  for (const row of held) {
    try {
      const next = await nextSeriesVisitReached(row, todayEt, conn);
      if (!next) continue;
      await closeHeldVisitAsSkipped(row, next, { now, conn });
      closed.push(row.id);
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
