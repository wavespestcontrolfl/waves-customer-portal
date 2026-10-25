/**
 * The time the van leaves its start point in the morning (owner 2026-10-24:
 * "we need to make it a 30 minute drive time buffer, so if we leave at 7:30,
 * and get there at 7:59, we are good", then "make this ediatble in the admin
 * portal, so we can move it, from 7:30, to 7:00 for instance").
 *
 * Stored in system_settings `schedule_departure_time` as a JSON "HH:MM"
 * string, edited in admin Settings → Scheduling. It moves the DEPARTURE only:
 * a stop with a promised window never starts before the window opens (08:00
 * at the earliest), so an earlier departure lets a farther first stop make an
 * 08:00 start and every later stop run earlier. A stop with no window at all
 * starts when the van arrives (11 of 382 upcoming visits on 2026-10-24, none
 * completed untimed in the 90 days before: the night tool gives them a time).
 *
 * Read only while GATE_AUTO_DISPATCH_DAY_RULES is on, by the night tool's
 * arrival search (auto-dispatch), the 04:20 route pass (route-reorder.js) and
 * the day reports (day-quality.js, gap-candidates.js, day-scorecard.js). Off,
 * all of them keep 08:00. Booking pages and the staff route tools (Optimize,
 * the Intelligence Bar) keep 08:00 in every case.
 */
const logger = require('../logger');

const DEPARTURE_TIME_KEY = 'schedule_departure_time';
// Every reader's clock with the gate off, and on a failed or broken read.
const LEGACY_DEPARTURE_MINUTES = 8 * 60;
// The owner's ruling: the clock before anyone saves one in Settings.
const DEFAULT_DEPARTURE_MINUTES = 7 * 60 + 30;
// What Settings accepts: 06:00 to 08:00 in 15-minute steps.
const EARLIEST_DEPARTURE_MINUTES = 6 * 60;
const LATEST_DEPARTURE_MINUTES = 8 * 60;
const DEPARTURE_STEP_MINUTES = 15;

// "HH:MM" (or the stored JSON string of it) -> minutes after midnight, or
// null when it is not a time Settings accepts.
function parseDepartureTime(value) {
  let text = value;
  if (typeof text === 'string' && text.trim().startsWith('"')) {
    try { text = JSON.parse(text); } catch { return null; }
  }
  if (typeof text !== 'string') return null;
  const match = text.trim().match(/^(\d{1,2}):([0-5]\d)$/);
  if (!match) return null;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  if (minutes < EARLIEST_DEPARTURE_MINUTES || minutes > LATEST_DEPARTURE_MINUTES) return null;
  return minutes % DEPARTURE_STEP_MINUTES === 0 ? minutes : null;
}

function formatDepartureTime(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

// A failed read inside a caller's transaction must not abort it: run it in a
// savepoint, the rule blackout-dates.js readOptional follows.
const readInSavepoint = (conn, fn) => (conn && conn.isTransaction && typeof conn.transaction === 'function'
  ? conn.transaction((sp) => fn(sp))
  : fn(conn));

/** The saved setting: { saved, minutes } (minutes null = saved but not valid). Throws when the read fails. */
async function readDepartureSetting(conn = require('../../models/db')) {
  const row = await readInSavepoint(conn, (dbh) => dbh('system_settings').where('key', DEPARTURE_TIME_KEY).first('value'));
  if (!row || row.value == null || row.value === '') return { saved: false, minutes: null };
  return { saved: true, minutes: parseDepartureTime(row.value) };
}

/** The minute readers use while the gate is on, for a read setting: the saved
 *  time, the owner's 07:30 before any save, 08:00 for a saved value that is broken. */
function effectiveDepartureMinutes(setting) {
  if (!setting.saved) return DEFAULT_DEPARTURE_MINUTES;
  return setting.minutes == null ? LEGACY_DEPARTURE_MINUTES : setting.minutes;
}

/** The minute of the day the van leaves, for a reader that models a future day. Never throws.
 *  `enabled` defaults to the gate; the night tool passes its run config's own answer. */
async function dayDepartureMinutes(conn = require('../../models/db'), {
  enabled = require('../../config/feature-gates').autoDispatchDayRulesLive(),
} = {}) {
  if (enabled !== true) return LEGACY_DEPARTURE_MINUTES;
  try {
    const setting = await readDepartureSetting(conn);
    if (setting.saved && setting.minutes == null) logger.warn('[departure-time] the saved departure time is not valid; using 08:00');
    return effectiveDepartureMinutes(setting);
  } catch (err) {
    logger.warn(`[departure-time] departure time read failed; using 08:00: ${err.message}`);
    return LEGACY_DEPARTURE_MINUTES;
  }
}

module.exports = {
  DEPARTURE_TIME_KEY,
  LEGACY_DEPARTURE_MINUTES,
  DEFAULT_DEPARTURE_MINUTES,
  EARLIEST_DEPARTURE_MINUTES,
  LATEST_DEPARTURE_MINUTES,
  DEPARTURE_STEP_MINUTES,
  parseDepartureTime,
  formatDepartureTime,
  readDepartureSetting,
  effectiveDepartureMinutes,
  dayDepartureMinutes,
};
