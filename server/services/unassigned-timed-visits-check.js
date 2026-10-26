'use strict';

// Unassigned timed visits, reported ahead of the day (census M13, owner 2026-10-25,
// GATE_UNASSIGNED_VISIT_GUARD). The only earlier alert for a visit with no technician,
// services/unassigned-overdue-detector.js, fires 30 minutes AFTER the promised window.
// A visit with no technician is on no field app, so with two technicians nobody hears
// about it until the customer is already waiting.
//
// One check, daily at 6:10 PM ET (scheduler.js): timed visits (window_start set) from
// tomorrow through 3 days out, with no technician and a live status. It is a STANDING
// CONDITION under docs/admin-notifications.md: one Schedule row for the whole set,
// carrying count and itemKeys (the visit ids). It rings when a visit joins the set,
// refreshes quietly when one leaves, and closes itself (done) at zero.
//
// Left out: a visit the combined-booking check already owns (a booking whose open bell
// there names missing time/technician), so one visit never rings twice, and an estimate
// hold (a held slot, not a booked visit). Internal test customers never join.
// Reads scheduled_services; writes nothing but the one admin row. Sends nothing to a
// customer. Gate off: no query at all.

const db = require('../models/db');
const logger = require('./logger');
const { unassignedVisitGuardLive, alertEpisodesLive } = require('../config/feature-gates');
const { composeAdminAlert, raiseAdminAlert, cutAtWord, MAX_WHY_CHARS } = require('./admin-alert-compose');
const { fullName, tidyName } = require('./admin-alert-names');
const { NONTERMINAL_SCHEDULED_SERVICE_STATUSES } = require('./scheduled-service-statuses');
const { etDateString } = require('../utils/datetime-et');

const CATEGORY = 'alert'; // the schedule-integrity watchdog's own category (bell: true below)
const DEDUPE_KEY = 'unassigned-timed-visits';
const AREA = 'Schedule';
const DONE_WHEN = 'count_zero';
const DAYS_AHEAD_FIRST = 1; // tomorrow
const DAYS_AHEAD_LAST = 3;
const LIST_LIMIT = 50;
const DETAIL_MAX_CHARS = 2000;

const addDays = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const dateOnly = (value) => (value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10));

// "Tue Oct 27" for a calendar day (not an instant: noon UTC keeps the day).
const dayWords = (day) => {
  const at = new Date(`${dateOnly(day)}T12:00:00Z`);
  const part = (opts) => at.toLocaleDateString('en-US', { timeZone: 'UTC', ...opts });
  return `${part({ weekday: 'short' })} ${part({ month: 'short' })} ${part({ day: 'numeric' })}`;
};
// "9:00 AM" from a TIME value ("09:00:00").
function timeWords(value) {
  const [h, m] = String(value || '').split(':').map(Number);
  if (!Number.isFinite(h)) return '';
  return `${h % 12 || 12}:${String(m || 0).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}
const whenWords = (row) => `${dayWords(row.scheduled_date)} at ${timeWords(row.window_start)}`;

// The visits to report, soonest first. `conn` is the writing transaction.
async function loadUnassignedTimedVisits(conn, todayET) {
  const { isInternalTestCustomerId } = require('./internal-test-customers');
  const rows = await conn('scheduled_services as s')
    .leftJoin('customers as c', 'c.id', 's.customer_id')
    .whereBetween('s.scheduled_date', [addDays(todayET, DAYS_AHEAD_FIRST), addDays(todayET, DAYS_AHEAD_LAST)])
    .whereNotNull('s.window_start')
    .whereNull('s.technician_id')
    .whereIn('s.status', NONTERMINAL_SCHEDULED_SERVICE_STATUSES)
    .whereNull('s.reservation_expires_at')
    // The combined-booking check (combined-booking-check.js) rings its own bell for a
    // booking whose visits lack a time or technician: do not ring those twice.
    .whereNotExists(function ownedByCombinedBookingCheck() {
      this.select(conn.raw('1')).from('notifications as n')
        .where({ 'n.recipient_type': 'admin', 'n.category': 'alert' })
        .whereNull('n.done_at')
        .whereRaw("starts_with(n.metadata->>'dedupeKey', 'combined-booking-check:')")
        .whereRaw("n.metadata->>'autoCleared' IS DISTINCT FROM 'true'")
        .whereRaw("jsonb_exists(COALESCE(n.metadata->'problemCodes', '[]'::jsonb), 'missing_time_tech')")
        .whereRaw(`n.metadata->>'estimateId' IN (
          s.source_estimate_id::text,
          (SELECT p.source_estimate_id::text FROM scheduled_services p WHERE p.id = s.recurring_parent_id))`);
    })
    .orderBy([{ column: 's.scheduled_date' }, { column: 's.window_start' }, { column: 's.id' }])
    .select('s.id', 's.customer_id', 's.scheduled_date', 's.window_start', 's.service_type', 's.status',
      'c.first_name', 'c.last_name');
  return rows.filter((row) => !isInternalTestCustomerId(row.customer_id));
}

// The row for the visits: `rows` is every unassigned timed visit, soonest first.
function composeUnassignedVisits(rows) {
  const count = rows.length;
  const first = rows[0];
  const who = tidyName(fullName(first)) || 'a customer';
  const lines = rows.slice(0, LIST_LIMIT).map((row) => `- ${whenWords(row)}: ${tidyName(fullName(row)) || 'Customer'}, ${row.service_type || 'visit'}`);
  if (count > LIST_LIMIT) lines.push(`- and ${count - LIST_LIMIT} more`);
  const lead = `${count === 1 ? '1 visit has' : `${count} visits have`} a time and no technician, so it is on no technician's route. `
    + 'Assign a technician on the schedule board.';
  return {
    spec: {
      area: AREA,
      action: `assign a technician to ${count} visit${count === 1 ? '' : 's'}`,
      why: cutAtWord(`${count === 1 ? 'It is' : 'The first is'} ${whenWords(first)} for ${who}, with no technician.`, MAX_WHY_CHARS),
      severity: 'needs-you',
      link: `/admin/schedule?date=${dateOnly(first.scheduled_date)}`,
      subject: { type: 'check', id: DEDUPE_KEY },
      doneWhen: DONE_WHEN,
      who: 'person',
    },
    detail: [lead, ...lines].join('\n').slice(0, DETAIL_MAX_CHARS),
    itemKeys: rows.map((row) => String(row.id)).sort(),
    count,
  };
}

// A refresh rings only when a visit joins the set. (A comeback after the row closed rings
// through raiseAdminAlertWithReopen, which ignores this.)
function ringOnNewVisit(itemKeys) {
  return (_existing, existingMeta) => {
    const prior = new Set(Array.isArray(existingMeta?.itemKeys) ? existingMeta.itemKeys.map(String) : []);
    return itemKeys.some((key) => !prior.has(key));
  };
}

async function raiseVisits(trx, composed) {
  const opts = {
    dedupeKey: DEDUPE_KEY,
    trx,
    // Under GATE_ADMIN_BELL_POLICY the 'alert' category is denied unless the call site tags it.
    bell: true,
    refreshOnDedupe: true,
    ringOnRefresh: ringOnNewVisit(composed.itemKeys),
    // A refresh that rings moves the row to the top of the newest-first bell.
    bumpOnRefresh: true,
    detail: composed.detail,
    metadata: { itemKeys: composed.itemKeys, count: composed.count },
  };
  if (!alertEpisodesLive()) return raiseAdminAlert(CATEGORY, composed.spec, opts);
  const alert = composeAdminAlert(composed.spec);
  return require('./admin-alert-episodes').raiseAdminAlertWithReopen(CATEGORY, alert.headline, alert.why, {
    ...opts, link: alert.link, metadata: { ...opts.metadata, ...alert.metadata },
  });
}

/**
 * Daily entry point. Returns { skipped } when the gate is off, else
 * { count, outcome }: raised | refreshed | unchanged | suppressed | closed | clear.
 * A read or write failure throws and never closes the row. One run at a time across
 * instances: it holds the advisory lock notifyAdmin takes for this row.
 * `gateEnabled`, `load` and `dedupeKey` are for tests.
 */
async function runUnassignedTimedVisitsCheck({ now = new Date(), conn = db, gateEnabled, load } = {}) {
  if (!(gateEnabled ?? unassignedVisitGuardLive())) return { skipped: 'disabled' };
  const todayET = etDateString(now);
  return conn.transaction(async (trx) => {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`admin:${DEDUPE_KEY}`]);
    const rows = await (load || loadUnassignedTimedVisits)(trx, todayET);
    if (!rows.length) {
      const closed = alertEpisodesLive()
        ? Number(await require('./admin-alert-episodes').closeAdminAlertKeys(trx, [DEDUPE_KEY], 'count_zero', {
          now, resolution: 'Cleared: every timed visit in the next 3 days has a technician',
        })) || 0
        : 0;
      return { count: 0, outcome: closed ? 'closed' : 'clear' };
    }
    const composed = composeUnassignedVisits(rows);
    const result = await raiseVisits(trx, composed);
    if (!result) throw new Error('unassigned timed visits row was not written');
    let outcome = 'unchanged';
    if (result.suppressed) outcome = 'suppressed';
    else if (!result.deduped) outcome = 'raised';
    else if (result.refreshed) outcome = result.rung === false ? 'refreshed' : 'raised';
    logger.info(`[unassigned-timed-visits] ${composed.count} timed visit(s) with no technician: ${outcome}`);
    return { count: composed.count, outcome };
  });
}

module.exports = {
  runUnassignedTimedVisitsCheck,
  DEDUPE_KEY,
  _private: { composeUnassignedVisits, ringOnNewVisit, loadUnassignedTimedVisits, whenWords },
};
