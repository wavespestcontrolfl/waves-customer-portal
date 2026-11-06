/**
 * GATE_DAY_ONLY_PROMISE, part C1: the shared piece every customer screen uses to show only the DAY of a visit.
 *
 * One bulk call per payload: `dayOnlyIds(conn, rows)` asks time-promise.js `loadTimeDisplay` once for all the rows a
 * payload carries and returns the ids whose HOUR must not be shown. The payload builder then blanks the hour fields the
 * client renders (the date stays) and adds `dayOnlyFields(true)`: `day_only: true` plus `arrival_note`. The server does
 * the blanking, so an older client bundle that knows nothing about `day_only` still shows the date and no hour.
 *
 * Gate off (or any failure): the set is empty and `dayOnlyFields(false)` is `{}`, so a payload is byte-for-byte what it
 * was before this part. A failure reads as "show the hour" (the safe side for a screen, same rule as loadTimeDisplay).
 */

const { loadTimeDisplay } = require('./time-promise');
const logger = require('./logger');

// The one shared wording every customer screen shows in place of the hour (owner 2026-11-05 "D2 a").
const ARRIVAL_NOTE = 'Arrival window texted the day before';

/**
 * Ids (as strings) of the rows whose hour a customer screen must NOT show. `rows` carry at least id, scheduled_date and
 * window_start. Never throws.
 */
async function dayOnlyIds(conn, rows, now = new Date()) {
  const hidden = new Set();
  try {
    const list = (Array.isArray(rows) ? rows : []).filter((r) => r && r.id != null && r.window_start);
    if (!list.length) return hidden;
    const display = await loadTimeDisplay(conn, list, now);
    for (const r of list) {
      const verdict = display.get(r.id);
      if (verdict && verdict.showHour === false) hidden.add(String(r.id));
    }
  } catch (err) {
    logger.warn(`[time-display] day-only lookup failed, showing the hour: ${err.message}`);
  }
  return hidden;
}

/** The two fields a day-only payload adds. `{}` when the hour is shown, so nothing changes for those payloads. */
function dayOnlyFields(dayOnly) {
  return dayOnly ? { day_only: true, arrival_note: ARRIVAL_NOTE } : {};
}

/**
 * The slot a confirm POST proves, for a client that was shown a day-only visit. That client has no hour to echo
 * (`windowStart` blank), so the match would fail forever. When the body carries no windowStart and the server still
 * shows this visit as day-only, the row's CURRENT start stands in: the confirm lands on the visit's current slot and the
 * date still has to match. Every other body (an hour was echoed, gate off, hour shown now, any failure) is returned as
 * it came, so the comparison is exactly today's. A visit that crossed the 24-hour cutoff after the page loaded now shows
 * its hour, so the blank body fails the match and the customer reloads to see it.
 */
async function shownSlotFor(conn, row, shown) {
  const body = shown || {};
  if (body.windowStart != null && body.windowStart !== '') return body;
  if (!row || !row.window_start) return body;
  const hidden = await dayOnlyIds(conn, [row]);
  return hidden.has(String(row.id)) ? { ...body, windowStart: String(row.window_start).slice(0, 5) } : body;
}

module.exports = { ARRIVAL_NOTE, dayOnlyIds, dayOnlyFields, shownSlotFor };
