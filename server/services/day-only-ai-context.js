/**
 * GATE_DAY_ONLY_PROMISE, part D: the AI agents never state an hour the customer was not told.
 *
 * The voice agent, the portal chat assistant, the context aggregator (the texting AI's grounding) and the SMS draft
 * helper read a visit's arrival window from the schedule and say it to the customer. For a visit whose customer was told
 * only the DAY (time-promise.js loadTimeDisplay: showHour false), that hour would be a new, conflicting promise. So each
 * of those builders asks this module ONE question per context build ("which of these visits is day-only?") and, for a
 * day-only visit, states the date plus DAY_ONLY_ARRIVAL_NOTE instead of the hour.
 *
 * Gate off (or an unreadable gate): the answer is "none", no database read, so every builder is byte-for-byte today.
 *
 * Failure rule (differs from the customer-screen rule in loadTimeDisplay): a screen that cannot read the facts keeps
 * showing the hour. An AI context must not leak an hour either way, so with the gate ON a failed read, a visit the read
 * did not judge, or a visit with no id is treated as day-only. With the gate OFF today's text (the hour) stays.
 */

const logger = require('./logger');
const { dayOnlyPromiseOn } = require('./time-promise');

// What the model is told in place of an hour. The builders put "arrival window: " in front of it.
const DAY_ONLY_ARRIVAL_NOTE = 'texted the day before (do not state or guess an hour; if the customer needs a set time, offer the reschedule link or the office)';

const never = () => false;
const always = () => true;

/**
 * One bulk read for a context build. Resolves to a predicate `(row) => boolean`: true when the AI must say only the day
 * for that visit. Rows carry at least id, scheduled_date and window_start. Never throws.
 */
async function loadDayOnlyCheck(conn, rows, now = new Date()) {
  if (!dayOnlyPromiseOn()) return never;
  const list = (Array.isArray(rows) ? rows : []).filter(Boolean);
  if (!list.length) return never;
  let display;
  try {
    // Lazy: keeps this module loadable where the promise reader's dependencies are not.
    display = await require('./time-promise').loadTimeDisplay(conn, list, now);
  } catch (err) {
    logger.warn(`[day-only-ai-context] time display read failed, saying only the day: ${err.message}`);
    return always;
  }
  return (row) => {
    const verdict = row && row.id != null && display ? display.get(row.id) : null;
    return !verdict || verdict.showHour === false;
  };
}

module.exports = { DAY_ONLY_ARRIVAL_NOTE, loadDayOnlyCheck };
