'use strict';

/**
 * New-sod mode (lawn report rebuild P35, GATE_LAWN_NEW_SOD_MODE).
 *
 * `property_preferences.sod_laid_on` is the calendar day sod someone else laid
 * went down (Waves does not install sod; owner ruling). From that day through
 * day 21 inclusive, judged in America/New_York calendar days against the VISIT's
 * day (never the clock, so a permanent report token reads the same forever), the
 * lawn report stops telling the customer what the normal engine would:
 *
 *   - the watering banner, the week plan and the expectation lines are replaced
 *     by the FIXED sentences below (no model text): water lightly every day and
 *     hold off on mowing until the sod has rooted;
 *   - the "skip watering" forecast sentence, the observed-rain close-out and the
 *     separate watering text never fire (the engine's own watering instruction
 *     is not built, so there is nothing frozen to forecast against or to send).
 *
 * Copy rules (pinned by server/tests/lawn-new-sod.test.js): plain, under 25
 * words a sentence, and NO number the business has not stated: no minutes, no
 * inches, no day counts ("21 days" never prints). The mode makes NO claim about
 * weed control: whatever the visit did or the weed card says stands on its own.
 *
 * Pure: no database, no clock except the optional `now` the validator takes.
 */

const { etCalendarDayOf, etDateString, addETDays, validCalendarDate } = require('../../utils/datetime-et');

// Day 0 is the day the sod went down; the mode is active through day 21.
const NEW_SOD_WINDOW_DAYS = 21;
// "Not older than a year": the office cannot enter a date further back than this.
const MAX_SOD_AGE_DAYS = 365;
const DAY_MS = 86400000;

const NEW_SOD_STATE = 'new_sod';
const NEW_SOD_RULE_SOURCE = 'new_sod';

// The customer sentences, verbatim. Every one is under 25 words. The expectation
// line carries no watering/moisture/rain wording on purpose: under a banner the
// lead drops any field that does (lawn-report-lead.js WATERING_WORDS).
const NEW_SOD_COPY = Object.freeze({
  water: 'Water your new sod lightly every day.',
  mow: 'Please hold off on mowing until the sod has rooted.',
  planTitle: 'New sod: water lightly every day',
  planDetail: 'Keep the sod moist with a light watering each day until it has rooted.',
  expect: 'Once the sod has rooted, you can start mowing and we can begin your regular lawn care.',
});

const INACTIVE = Object.freeze({ active: false, laidOn: null, dayNumber: null });

// A calendar day as 'YYYY-MM-DD', or null. Accepts a pg `date` (a Date at UTC
// midnight, or a string) and a real timestamp (read as its ET day); anything
// unreadable is null. Never throws.
function ymdOrNull(value) {
  if (value == null || value === '') return null;
  try {
    const day = etCalendarDayOf(value);
    return validCalendarDate(day) || null;
  } catch {
    return null;
  }
}

function dayNumberBetween(fromYmd, toYmd) {
  const [fy, fm, fd] = fromYmd.split('-').map(Number);
  const [ty, tm, td] = toYmd.split('-').map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / DAY_MS);
}

/**
 * Is new-sod mode active for a visit on `visitDate`?
 *
 * @param {object|null} prefs  a property_preferences row (reads `sod_laid_on`)
 * @param {string|Date} visitDate  the visit's day
 * @returns {{ active: boolean, laidOn: string|null, dayNumber: number|null }}
 *   Fail closed: a missing row, an unreadable date, a visit before the sod went
 *   down or past day 21 is `{ active: false }`, i.e. the normal report.
 */
function newSodMode(prefs, visitDate) {
  try {
    const laidOn = ymdOrNull(prefs && prefs.sod_laid_on);
    const visit = ymdOrNull(visitDate);
    if (!laidOn || !visit) return INACTIVE;
    const dayNumber = dayNumberBetween(laidOn, visit);
    if (dayNumber < 0 || dayNumber > NEW_SOD_WINDOW_DAYS) return INACTIVE;
    return { active: true, laidOn, dayNumber };
  } catch {
    return INACTIVE;
  }
}

/**
 * The office entry check: a real calendar day, not in the future (ET), not
 * older than a year. `null` / '' clear the date.
 * @returns {{ ok: true, value: string|null } | { ok: false, message: string }}
 */
function validateSodLaidOn(raw, now = new Date()) {
  if (raw == null || String(raw).trim() === '') return { ok: true, value: null };
  const day = validCalendarDate(String(raw).trim());
  if (!day) return { ok: false, message: 'Sod date must be a real date (YYYY-MM-DD).' };
  const today = etDateString(now);
  if (day > today) return { ok: false, message: 'Sod date cannot be in the future.' };
  const oldest = etDateString(addETDays(now, -MAX_SOD_AGE_DAYS));
  if (day < oldest) return { ok: false, message: 'Sod date cannot be more than a year ago.' };
  return { ok: true, value: day };
}

// "New sod laid Oct 1": the short note a technician sees. The date is printed
// from the calendar string, never through a viewer time zone.
function sodLaidLabel(laidOn) {
  const day = ymdOrNull(laidOn);
  if (!day) return null;
  const label = new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return `New sod laid ${label}`;
}

// reportV2.banner for an active new-sod visit. Same shape the watering banner
// uses, with state 'new_sod': no clock times, no expiry, no mow-hold object.
function buildNewSodBanner() {
  return {
    state: NEW_SOD_STATE,
    lines: [NEW_SOD_COPY.water, NEW_SOD_COPY.mow],
    holdUntil: null,
    waterInBy: null,
    expiresAt: null,
    ruleSource: NEW_SOD_RULE_SOURCE,
  };
}

// water.weekPlan for an active new-sod visit: the one card, fixed words.
function buildNewSodWeekPlan() {
  return {
    title: NEW_SOD_COPY.planTitle,
    detail: NEW_SOD_COPY.planDetail,
    action: NEW_SOD_STATE,
    visitInPlanWeek: true,
    prescribesRun: false,
  };
}

module.exports = {
  NEW_SOD_WINDOW_DAYS,
  MAX_SOD_AGE_DAYS,
  NEW_SOD_STATE,
  NEW_SOD_RULE_SOURCE,
  NEW_SOD_COPY,
  newSodMode,
  validateSodLaidOn,
  sodLaidLabel,
  ymdOrNull,
  buildNewSodBanner,
  buildNewSodWeekPlan,
};
