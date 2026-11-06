/**
 * GATE_NIGHT_TOLD_LOCK (owner 2026-11-05, "D1 a"): which visits has the customer actually been told a time for?
 *
 * The answer is the system's own record of what went out, the no-show detector's promise reader
 * (no-show-detector.js loadPromiseEvents + latestPromises: delivered texts and pushes, emails, call commitments,
 * bookings, applied reschedules, series moves). A visit is TOLD when its latest promise carries a known slot
 * (start_at != null). reminder_72h_sent is NOT used: the sender also sets it when the 72-hour reminder was skipped
 * (customer opted out, booked inside 72 hours, a time change inside 72 hours marks it covered).
 *
 * A latest promise with an unknown window ("at a time we'll confirm", a legacy move notice without a saved time) does
 * NOT freeze in this change; a later change handles day-only promises.
 *
 * Throws when a read fails: every caller must fail closed (route-tiers loadReminderFreeze returns failed: true, the
 * day re-plan keeps every stop fixed). no-show-detector is required lazily, inside the function, so this module can be
 * loaded from route-tiers without a require cycle.
 */

/** Set of the given ids whose latest promise has a known slot. `conn` may be a knex or a transaction. */
async function loadToldVisitIds(conn, ids, now = new Date()) {
  if (!ids || ids.length === 0) return new Set();
  const detector = require('../no-show-detector');
  const events = await detector.loadPromiseEvents(conn, ids.map(String), { now });
  const latest = detector.latestPromises(events, now);
  return new Set(ids.filter((id) => {
    const promise = latest.get(String(id));
    return !!promise && promise.start_at != null;
  }));
}

module.exports = { loadToldVisitIds };
