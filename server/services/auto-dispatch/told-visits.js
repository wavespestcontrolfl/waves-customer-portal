/**
 * Night told-lock (owner 2026-11-05, "D1 a"): which visits has the customer actually been told a time for?
 * GATE_DAY_ONLY_PROMISE (owner 2026-11-05 "D2 a"): and which only the DAY for? loadPromiseLevels answers with
 * 'none' / 'day' / 'hour'; loadToldVisitIds({ anyPromise: true }) is the "told anything" set.
 *
 * The answer is the system's own record of what went out, the no-show detector's promise reader
 * (no-show-detector.js loadPromiseEvents + latestPromises: delivered texts and pushes, emails, call commitments,
 * bookings, applied reschedules, series moves). A visit is TOLD when its latest promise carries a known slot
 * (start_at != null). reminder_72h_sent is NOT used: the sender also sets it when the 72-hour reminder was skipped
 * (customer opted out, booked inside 72 hours, a time change inside 72 hours marks it covered).
 *
 * A latest promise with an unknown window ("at a time we'll confirm", a legacy move notice without a saved time) does
 * NOT count as told by default. With `anyPromise` (GATE_DAY_ONLY_PROMISE, auto-dispatch only) it does: the dispatcher
 * moves DATES, and a customer told only the day was still told that day. The levels reader treats an unknown window
 * as 'hour' (fail closed).
 *
 * A WITHDRAWN latest promise (`withdrawn: true`: Quick Move's "let the customer pick a day" text, no-show-detector.js
 * PICK_HANDOFF_MESSAGE_TYPE_PREFIX) is never told, with `anyPromise` too. That text takes the old time back, tells no new
 * one, and tells the customer the night run books the visit if they do not pick (rain-out.js handOffToCustomer; the
 * owner's 2026-11-17 "pick limit" exemption in move-limit.js). A time picked afterwards is a newer promise and freezes
 * again. The levels reader still answers 'hour' for it (an unknown window, fail closed), so a delayed day-only body for
 * the old date never goes over it (appointment-reminders.js delayedSendIsStale).
 *
 * Throws when a read fails: every caller must fail closed (route-tiers loadReminderFreeze returns failed: true, the
 * day re-plan keeps every stop fixed). no-show-detector is required lazily, inside the function, so this module can be
 * loaded from route-tiers without a require cycle.
 */

/**
 * The requested rows and every member of their stops (same visit_id), in ANY status: a grouped reminder's window is
 * linked to whichever member won the send claim, and that member may since have been cancelled (no-show-detector.js
 * stopPromise, codex P1 round 25), so the evidence must be read from all of them.
 */
async function loadStopMembers(conn, ids) {
  const rows = await conn('scheduled_services').whereIn('id', ids).select('id', 'visit_id', 'status', 'scheduled_date');
  const visitIds = [...new Set(rows.map((r) => r.visit_id).filter((v) => v != null).map(String))];
  const members = visitIds.length
    ? await conn('scheduled_services').whereIn('visit_id', visitIds).select('id', 'visit_id', 'status', 'scheduled_date') : [];
  const membersOf = new Map();
  for (const member of members) {
    const key = String(member.visit_id);
    if (!membersOf.has(key)) membersOf.set(key, []);
    membersOf.get(key).push(member);
  }
  const stopOf = new Map(rows.map((r) => [String(r.id), r.visit_id != null ? membersOf.get(String(r.visit_id)) || [] : []]));
  const dateOf = new Map([...members, ...rows].map((r) => [String(r.id), visitDateOf(r.scheduled_date)]));
  return { stopOf, memberIds: members.map((m) => String(m.id)), dateOf };
}

/** A visit's calendar date as 'YYYY-MM-DD', or null when it is missing or unreadable (the caller then fails closed). */
function visitDateOf(value) {
  try {
    if (value == null || value === '') return null;
    const day = require('../../utils/datetime-et').dateOnlyString(value);
    return typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
  } catch {
    return null;
  }
}

/** The ET calendar date of a promise slot, or null. */
function slotDateOf(start) {
  try {
    return require('../../utils/datetime-et').etDateString(start) || null;
  } catch {
    return null;
  }
}

/** Is this promise about `visitDate` (the REQUESTED visit's own date)? A known slot on another ET date is not (owner
 *  2026-11-24, "fix"). An unknown window, an unknown visit date or an unreadable slot keeps the promise (fail closed). */
function onVisitDate(promise, visitDate) {
  if (!promise || promise.start_at == null || !visitDate) return true;
  const at = new Date(promise.start_at);
  const slotDate = Number.isNaN(at.getTime()) ? null : slotDateOf(at);
  return !slotDate || visitDate === slotDate;
}

/** The stop-wide resolved promise for each requested id: Map<id, promise|null>. One stop-members read and one
 *  loadPromiseEvents read, however many ids. Throws when a read fails. With `sameDateOnly` (loadPromiseFacts only), a
 *  promise whose slot is on another date than the REQUESTED visit's date does not stand: it is dropped AFTER every
 *  supersession rule (a newer notice still replaces an older one, even when the newer one is the off-date one), so
 *  nothing it replaced comes back. A single visit's off-date latest reads null; in a stop, stopPromise's `keep` test
 *  drops off-date candidates before its newest/earliest choice, so a sibling's current hour still stands. */
async function resolvePromises(conn, ids, now, { sameDateOnly = false } = {}) {
  const detector = require('../no-show-detector');
  const wanted = ids.map(String);
  const { stopOf, memberIds, dateOf } = await loadStopMembers(conn, wanted);
  const events = await detector.loadPromiseEvents(conn, [...new Set([...wanted, ...memberIds])], { now });
  const latest = detector.latestPromises(events, now);
  const eventsByVisit = detector.byVisit(events);
  // `sameDateOnly` may be the EXPECTED date (a delayed body's own occurrence, appointment-reminders
  // revalidateDelayedDaySend): the filter then uses that date, and a visit observed on another date (or none) answers an
  // unknown-window promise, read as 'hour' (fail closed: the stale body is suppressed). Pre-push Codex P1, 2026-11-24.
  const expected = typeof sameDateOnly === 'string' ? sameDateOnly : null;
  return new Map(ids.map((id) => {
    const stop = stopOf.get(String(id)) || [];
    if (expected && dateOf.get(String(id)) !== expected) {
      return [id, { visit_id: id, start_at: null, communicated_at: null, date_mismatch: true }];
    }
    const visitDate = sameDateOnly ? expected || dateOf.get(String(id)) || null : null;
    const keep = sameDateOnly ? (promise) => onVisitDate(promise, visitDate) : null;
    const promise = stop.length > 1
      ? detector.stopPromise(stop, eventsByVisit, now, keep ? { keep } : undefined)
      : latest.get(String(id));
    if (promise && keep && !keep(promise)) return [id, null];
    return [id, promise || null];
  }));
}

/** Set of the given ids whose communicated window (the visit's own latest promise, or its stop's) has a known slot.
 *  With `anyPromise` (GATE_DAY_ONLY_PROMISE) ANY resolved promise counts: a day-only promise or an unknown window
 *  also freezes the visit, because the customer was still told that day. A withdrawn promise never counts (header). `conn` may be a knex or a transaction. */
async function loadToldVisitIds(conn, ids, now = new Date(), { anyPromise = false } = {}) {
  if (!ids || ids.length === 0) return new Set();
  const promises = await resolvePromises(conn, ids, now);
  return new Set(ids.filter((id) => {
    const promise = promises.get(id);
    return !!promise && promise.withdrawn !== true && (anyPromise || promise.start_at != null);
  }));
}

/** The level of ONE resolved promise (resolvePromises): 'none' = no promise at all. 'day' = a day-only promise (explicit
 *  metadata.promise_level 'day' marker, no slot). 'hour' = anything else: a known slot, OR an unknown window without the day
 *  marker (a legacy move notice, "at a time we'll confirm", a call with no time). Unknown counts as 'hour' on purpose: it
 *  fails closed, since we cannot prove the customer was not told an hour. THE one rule: loadPromiseLevels and the office's
 *  told badge (time-promise.loadOfficeToldFields) both use it. */
function promiseLevelOf(promise) {
  if (!promise) return 'none';
  if (promise.start_at == null && promise.level === 'day') return 'day';
  return 'hour';
}

/** Map<id, { level, start }>: what the customer was told about each visit (same stop-wide resolution as
 *  loadToldVisitIds; the level rule is promiseLevelOf) and, for an 'hour' level with a known slot, that slot's start
 *  (`start`, a Date; null otherwise, and for a withdrawn promise). ONE promise read gives both facts, so they always
 *  agree (the day re-plan's 2-hour told shift, owner 2026-11-24). Throws when a read fails; every caller must fail closed.
 *
 *  An hour told for ANOTHER date is not an hour for this visit (owner 2026-11-24, "fix"): a standing promise whose known
 *  slot is on another ET date than the requested visit's date is dropped after supersession (resolvePromises
 *  sameDateOnly), so a visit whose latest hour was for another date reads 'none', and in a grouped stop a sibling's
 *  current hour still stands. Seen live after a no-show: the 24-hour text said Nov 14 9-11, the office moved the visit to
 *  Nov 23 with no text, and the 3-day text still quoted an hour. An unknown visit date or slot date keeps the event (fail
 *  closed); so does an unknown window. resolvePromises, the night freeze and the office's told badge are unchanged.
 *
 *  `sameDateOnly: false` keeps the raw rule (an hour for ANY date counts). Delayed day-only sends use it
 *  (appointment-reminders delayedSendIsStale): every stored body, bounce and queued replay was written for its own date,
 *  and the raw rule suppresses it after a move, as before this change. The worst case is a skipped stale resend; the
 *  re-armed sends for the new date still go out (pre-push Codex, 2026-11-24). */
async function loadPromiseFacts(conn, ids, now = new Date(), { sameDateOnly = true } = {}) {
  const facts = new Map();
  if (!ids || ids.length === 0) return facts;
  const promises = await resolvePromises(conn, ids, now, { sameDateOnly });
  for (const id of ids) {
    const promise = promises.get(id);
    const level = promiseLevelOf(promise);
    let start = null;
    if (level === 'hour' && promise.withdrawn !== true && promise.start_at != null) {
      const at = promise.start_at instanceof Date ? promise.start_at : new Date(promise.start_at);
      if (!Number.isNaN(at.getTime())) start = at;
    }
    facts.set(id, { level, start });
  }
  return facts;
}

/** Map<id, 'none' | 'day' | 'hour'>: what the customer was told about each visit (loadPromiseFacts' level). Throws when
 *  a read fails; every caller must fail closed. */
async function loadPromiseLevels(conn, ids, now = new Date(), { sameDateOnly = true } = {}) {
  const facts = await loadPromiseFacts(conn, ids, now, { sameDateOnly });
  return new Map([...facts].map(([id, fact]) => [id, fact.level]));
}

module.exports = { loadToldVisitIds, loadPromiseLevels, loadPromiseFacts, resolvePromises, promiseLevelOf };
