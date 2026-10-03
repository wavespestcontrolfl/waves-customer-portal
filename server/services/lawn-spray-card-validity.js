/**
 * The one rule for the life of a pre-day spray hold card (lawn_spray_hold),
 * shared by the sweep that writes it (lawn-preday-spray-check.js: initial
 * visit query, publish step, post-commit re-check, stale cleanup) and the
 * status hook that retires it (dispatch-alerts.js), so they cannot drift.
 */
const { etCalendarDayOf } = require('../utils/datetime-et');
const { NONTERMINAL_SCHEDULED_SERVICE_STATUSES } = require('./scheduled-service-statuses');

// The statuses a visit can hold a card in: live and not yet arrived. The
// shared vocabulary's non-terminal set minus on_site (the tech is already
// there). Every other status, closed or unknown, is outside this list.
const OPEN_PRE_ARRIVAL_STATUSES = NONTERMINAL_SCHEDULED_SERVICE_STATUSES.filter((status) => status !== 'on_site');

const normWindow = (v) => (v == null || v === '' ? null : String(v).slice(0, 8));
const normDay = (v) => (v == null || v === '' ? null : (typeof v === 'string' ? v.slice(0, 10) : etCalendarDayOf(v)));

/**
 * THE rule for a card's life: it may exist only while this is true. The
 * visit exists, its status is an open pre-arrival one, it is still scheduled
 * on the card's day, at the window the forecast was computed for, and that
 * day has not passed (`today`). The initial visit query, the publish step,
 * the post-commit re-check and the stale cleanup all answer through it, so
 * they cannot drift. `visit` is { status, scheduled_date, window_start } or
 * null; `card` is { for_date, window_start }.
 */
function cardStillValid(visit, card, today = null) {
  if (!visit || !card?.for_date) return false;
  if (!OPEN_PRE_ARRIVAL_STATUSES.includes(visit.status)) return false;
  if (today && card.for_date < today) return false;
  return normDay(visit.scheduled_date) === card.for_date
    && normWindow(visit.window_start) === normWindow(card.window_start);
}

// A plain SELECT of the visit (no row lock, so settlement never waits on it).
const readVisit = (conn, jobId) => conn('scheduled_services')
  .where({ id: jobId })
  .first('id', 'status', 'scheduled_date', 'window_start');

module.exports = { OPEN_PRE_ARRIVAL_STATUSES, cardStillValid, readVisit };
