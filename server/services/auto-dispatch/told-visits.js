/**
 * GATE_NIGHT_TOLD_LOCK (owner 2026-11-05, "D1 a"): which visits has the customer actually been told a time for?
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
  const rows = await conn('scheduled_services').whereIn('id', ids).select('id', 'visit_id', 'status');
  const visitIds = [...new Set(rows.map((r) => r.visit_id).filter((v) => v != null).map(String))];
  const members = visitIds.length
    ? await conn('scheduled_services').whereIn('visit_id', visitIds).select('id', 'visit_id', 'status') : [];
  const membersOf = new Map();
  for (const member of members) {
    const key = String(member.visit_id);
    if (!membersOf.has(key)) membersOf.set(key, []);
    membersOf.get(key).push(member);
  }
  const stopOf = new Map(rows.map((r) => [String(r.id), r.visit_id != null ? membersOf.get(String(r.visit_id)) || [] : []]));
  return { stopOf, memberIds: members.map((m) => String(m.id)) };
}

/**
 * The stop-wide resolved promise for each requested id: Map<id, promise|null>. One stop-members read and one
 * loadPromiseEvents read, however many ids. Throws when a read fails.
 */
async function resolvePromises(conn, ids, now) {
  const detector = require('../no-show-detector');
  const wanted = ids.map(String);
  const { stopOf, memberIds } = await loadStopMembers(conn, wanted);
  const events = await detector.loadPromiseEvents(conn, [...new Set([...wanted, ...memberIds])], { now });
  const latest = detector.latestPromises(events, now);
  const eventsByVisit = detector.byVisit(events);
  return new Map(ids.map((id) => {
    const stop = stopOf.get(String(id)) || [];
    const promise = stop.length > 1 ? detector.stopPromise(stop, eventsByVisit, now) : latest.get(String(id));
    return [id, promise || null];
  }));
}

/** Set of the given ids whose communicated window (the visit's own latest promise, or its stop's) has a known slot.
 *  With `anyPromise` (GATE_DAY_ONLY_PROMISE) ANY resolved promise counts: a day-only promise or an unknown window
 *  also freezes the visit, because the customer was still told that day. `conn` may be a knex or a transaction. */
async function loadToldVisitIds(conn, ids, now = new Date(), { anyPromise = false } = {}) {
  if (!ids || ids.length === 0) return new Set();
  const promises = await resolvePromises(conn, ids, now);
  return new Set(ids.filter((id) => {
    const promise = promises.get(id);
    return !!promise && (anyPromise || promise.start_at != null);
  }));
}

/** Map<id, 'none' | 'day' | 'hour'>: what the customer was told about each visit (same stop-wide resolution as
 *  loadToldVisitIds). 'none' = no promise at all. 'day' = the latest promise is a day-only promise (explicit
 *  metadata.promise_level 'day' marker, no slot). 'hour' = anything else: a known slot, OR an unknown window
 *  without the day marker (a legacy move notice, "at a time we'll confirm", a call with no time). Unknown counts
 *  as 'hour' on purpose: it fails closed, since we cannot prove the customer was not told an hour. Throws when a
 *  read fails; every caller must fail closed. */
async function loadPromiseLevels(conn, ids, now = new Date()) {
  const levels = new Map();
  if (!ids || ids.length === 0) return levels;
  const promises = await resolvePromises(conn, ids, now);
  for (const id of ids) {
    const promise = promises.get(id);
    if (!promise) levels.set(id, 'none');
    else if (promise.start_at == null && promise.level === 'day') levels.set(id, 'day');
    else levels.set(id, 'hour');
  }
  return levels;
}

module.exports = { loadToldVisitIds, loadPromiseLevels };
