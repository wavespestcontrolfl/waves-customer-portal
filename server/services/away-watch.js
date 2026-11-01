'use strict';

/**
 * Away Watch + Welcome Home (GATE_AWAY_WATCH, owner approved 2026-10-31).
 *
 * A WaveGuard member sets two ET calendar days on property_preferences:
 * away_watch_from (the day they leave) and away_watch_until (the day they are
 * back). A visit whose own scheduled day falls in [from, until) is an away
 * visit: the tech job card says to photograph the outside of the home and note
 * standing water, and a performed closeout needs AWAY_WATCH_MIN_PHOTOS uploaded
 * photos. The last scheduled visit before the back day also carries the
 * Welcome Home line (lanai cobweb sweep, no product).
 *
 * Service continues while the member is away (owner 2026-09-29: pause is not a
 * product). The photos reach the member in the normal completion text and
 * service report, so nothing here sends a message. The cancel-flow Away Mode
 * (property_preferences.away_mode_until, services/cancellation-resolution) is a
 * different feature and is not read or written here.
 *
 * Gate off = every function here answers "no window", so every caller behaves
 * as it did before. The gate is read at call time through the guarded reader
 * below, so a suite that mocks feature-gates as a bare object reads it as off.
 */

const gates = require('../config/feature-gates');
const { etCalendarDayOf, etDateString } = require('../utils/datetime-et');

const AWAY_WATCH_MIN_PHOTOS = 3;
// The longest stretch one window may cover (about eight months: a full
// summer away plus travel days).
const AWAY_WATCH_MAX_DAYS = 240;
const AWAY_WATCH_FIELDS = ['awayWatchFrom', 'awayWatchUntil'];
const AWAY_WATCH_COLUMNS = ['away_watch_from', 'away_watch_until'];

// Not-performed outcomes: no work was done, so no photo is owed.
const NOT_PERFORMED_OUTCOMES = ['inspection_only', 'customer_declined', 'incomplete'];
// A visit that no longer counts as "scheduled" when looking for the next one.
const INACTIVE_STATUSES = ['cancelled', 'canceled', 'completed', 'rescheduled', 'skipped', 'no_show'];

// Tech-facing strings (job card).
const TECH_AWAY_LINE = (until) => `Away Watch: member away until ${until}. Take 3 photos of the outside of the home from the ground and note standing water.`;
const TECH_WELCOME_HOME_LINE = 'Welcome Home: last visit before the member is back. Do a lanai cobweb sweep (no product).';

// Writer messages (customer app and Customer 360 show them as-is).
const MESSAGES = {
  together: 'Away dates must be set or cleared together.',
  order: 'The day you leave must be on or before the day you are back.',
  tooLong: `Away Watch can cover at most ${AWAY_WATCH_MAX_DAYS} days.`,
  past: 'The day you are back cannot be in the past.',
  badDay: 'Use a real calendar day, like 2026-06-01.',
};

const CLOSEOUT_PHOTO_MESSAGE = `Away Watch visit: at least ${AWAY_WATCH_MIN_PHOTOS} photos of the outside of the home must upload before closeout.`;

function awayWatchLive() {
  return typeof gates.awayWatchLive === 'function' && gates.awayWatchLive();
}

// The member's window from a property_preferences row: { from, until } as ET
// day strings, or null (gate off, either date missing, or no row).
function awayWatchWindow(prefs) {
  if (!awayWatchLive() || !prefs?.away_watch_from || !prefs?.away_watch_until) return null;
  return { from: etCalendarDayOf(prefs.away_watch_from), until: etCalendarDayOf(prefs.away_watch_until) };
}

function dayInWindow(window, day) {
  return Boolean(window && day && window.from <= day && day < window.until);
}

async function loadAwayWatchWindow(dbh, customerId) {
  if (!awayWatchLive() || !customerId) return null;
  const prefs = await dbh('property_preferences').where({ customer_id: customerId }).first('away_watch_from', 'away_watch_until');
  return awayWatchWindow(prefs);
}

// Closeout: is this visit's own scheduled day inside the member's window?
async function visitInAwayWatchWindow(dbh, customerId, scheduledDate) {
  const window = await loadAwayWatchWindow(dbh, customerId);
  return dayInWindow(window, etCalendarDayOf(scheduledDate));
}

// Job card: the lines for one visit day. Welcome Home goes on the last
// scheduled visit before the back day (no later active visit before it).
async function awayWatchCardLines(dbh, customerId, visitDay) {
  const window = await loadAwayWatchWindow(dbh, customerId);
  if (!dayInWindow(window, visitDay)) return null;
  const next = await dbh('scheduled_services')
    .where('customer_id', customerId)
    .where('scheduled_date', '>', visitDay)
    .whereNotIn('status', INACTIVE_STATUSES)
    .orderBy('scheduled_date')
    .first('scheduled_date');
  const nextDay = next ? etCalendarDayOf(next.scheduled_date) : null;
  const lines = [TECH_AWAY_LINE(window.until)];
  if (!nextDay || nextDay >= window.until) lines.push(TECH_WELCOME_HOME_LINE);
  return { lines };
}

// Writer rule for the pair, given the values that validated alone. `sent` is
// how many of the two keys the request carried. Returns a message or null.
function awayWatchPairError(from, until, sent, today = etDateString()) {
  if (sent === 1 || (from === null) !== (until === null)) return MESSAGES.together;
  if (from === null) return null;
  if (from > until) return MESSAGES.order;
  if ((Date.parse(until) - Date.parse(from)) / 86400000 > AWAY_WATCH_MAX_DAYS) return MESSAGES.tooLong;
  if (until < today) return MESSAGES.past;
  return null;
}

// Gate off: the two fields are not part of any response.
function withoutAwayWatch(obj) {
  if (awayWatchLive() || !obj) return obj;
  const copy = { ...obj };
  AWAY_WATCH_FIELDS.forEach((k) => delete copy[k]);
  AWAY_WATCH_COLUMNS.forEach((k) => delete copy[k]);
  return copy;
}

// Gate on: the two days as plain ET day strings (a pg date can arrive as a Date).
function withAwayWatchDays(obj) {
  if (!awayWatchLive() || !obj) return obj;
  const copy = { ...obj };
  AWAY_WATCH_FIELDS.forEach((k) => { if (copy[k]) copy[k] = etCalendarDayOf(copy[k]); });
  AWAY_WATCH_COLUMNS.forEach((k) => { if (copy[k]) copy[k] = etCalendarDayOf(copy[k]); });
  return copy;
}

module.exports = {
  AWAY_WATCH_MIN_PHOTOS,
  AWAY_WATCH_MAX_DAYS,
  AWAY_WATCH_FIELDS,
  AWAY_WATCH_COLUMNS,
  NOT_PERFORMED_OUTCOMES,
  CLOSEOUT_PHOTO_MESSAGE,
  awayWatchLive,
  awayWatchWindow,
  dayInWindow,
  loadAwayWatchWindow,
  visitInAwayWatchWindow,
  awayWatchCardLines,
  awayWatchPairError,
  withoutAwayWatch,
  withAwayWatchDays,
  MESSAGES,
};
