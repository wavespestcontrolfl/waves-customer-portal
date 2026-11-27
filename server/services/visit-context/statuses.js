/**
 * Canonical status vocabularies for visit context.
 *
 * "Is this row still live?" and "does this invoice count toward the balance?"
 * were answered with independently inlined lists across the schedule feeds,
 * visit grouping, the context aggregator, and the Intelligence Bar — each a
 * future divergence bug. This module is the single server-side source; new
 * code imports from here, existing modules re-require these names so their
 * importers are untouched.
 *
 * CLIENT PAIRING: client/src/pages/tech/routeStops.js keeps its own
 * TERMINAL_STATUSES copy (the client cannot import server code). A change to
 * TERMINAL_ROW_STATUSES here must be mirrored there.
 */

// Terminal scheduled_services statuses (CHECK constraint,
// 20260426000004): rows in these states never join a visit.
const TERMINAL_ROW_STATUSES = ['completed', 'cancelled', 'skipped', 'no_show'];
// A 'rescheduled' row is a live visit AWAITING RE-PLACEMENT
// (recurring-appointment-seeder.js:834) — its date/window are stale, so it
// never JOINS a visit; it is not terminal for member counting.
const JOIN_INELIGIBLE_STATUSES = [...TERMINAL_ROW_STATUSES, 'rescheduled'];
// Non-performed history a FROZEN visit keeps as a member: once visit activity
// has frozen the group, handleChildStopChanged preserves a child that is
// cancelled / skipped / no-showed / rescheduled instead of splitting it out.
// The closeout (route access and packet snapshot) works on
// the live members and treats these rows as retained history — a
// rescheduled child is awaiting re-placement elsewhere, so it is never one
// of this visit's forms and never gates access to the others.
// The client consumes the server's requiresForm classification.
const RETAINED_HISTORY_STATUSES = ['cancelled', 'skipped', 'no_show', 'rescheduled'];

// scheduled_services statuses that count as an upcoming visit for
// customer-facing context (context-aggregator, comms drafting).
const UPCOMING_SERVICE_STATUSES = ['pending', 'confirmed', 'en_route', 'on_site'];

// Customer-facing tracker states that mean the visit is happening now. The
// tracker writes track_state first and syncs `status` best-effort, so a row can
// read `rescheduled` (or another non-upcoming status) while the tracking page
// shows the live vehicle (Codex round-14 P2, PR #5334).
const LIVE_TRACK_STATES = ['en_route', 'on_property'];

// The row rule UPCOMING SERVICES lists by (context-aggregator.js
// upcomingServicesBase + liveServicesQuery): an upcoming status, or TODAY with a
// live track_state and no terminal status. The date floor (today onward) is the
// caller's. Shared so the texting AI's schedule recheck accepts the same rows.
function isUpcomingListedRow(row, todayStr) {
  if (!row) return false;
  if (UPCOMING_SERVICE_STATUSES.includes(row.status)) return true;
  // the aggregator's day rule (live-eta-destination.js calendarDay): a pg DATE as a local Date
  const { calendarDay } = require('../live-eta-destination');
  return calendarDay(row.scheduled_date) === todayStr && LIVE_TRACK_STATES.includes(row.track_state) && !TERMINAL_ROW_STATUSES.includes(row.status);
}

// Invoice statuses that count toward what the customer currently owes
// (delivered and collectible; excludes draft/scheduled/paid/void/prepaid).
const OPEN_INVOICE_STATUSES = ['sent', 'viewed', 'overdue'];

module.exports = {
  TERMINAL_ROW_STATUSES,
  JOIN_INELIGIBLE_STATUSES,
  RETAINED_HISTORY_STATUSES,
  UPCOMING_SERVICE_STATUSES,
  OPEN_INVOICE_STATUSES,
  LIVE_TRACK_STATES,
  isUpcomingListedRow,
};
