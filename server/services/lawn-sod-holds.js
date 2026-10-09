'use strict';

/**
 * Sod holds: what a lawn visit holds back on the one standard lawn program while
 * new sod roots. Waves does not install sod; the office records sod someone else
 * laid on the customer's property preferences (sod_laid_on, sod_covers,
 * sod_area, sod_rooted_on). There is no separate protocol: the program runs as
 * written and these holds skip a product class, or the named area, until the
 * sod is ready for it. (Owner ruling 2026-10-09: one program with holds.)
 *
 * Rules and their sources (day 1 is the day the sod went down):
 *   - Fertilizer: held through day 30. Manatee County ordinance 11-21 allows no
 *     nitrogen in the first 30 days of new turf; UF/IFAS says 30-60 days. Never
 *     held when only part of the lawn is new sod.
 *   - Weed killer: held through day 30 AND until a technician confirms the sod
 *     has been mowed twice and does not lift (sod_rooted_on). Blindside and
 *     Dismiss labels: "following the second mowing". Gravex follows the same hold
 *     (Gravex label: established turfgrass).
 *   - Pre-emergent: held until the sod has had one full summer, that is Oct 1 of
 *     the sod year when the sod went down January-May, otherwise Oct 1 of the
 *     next year (Waves rule; program note "no pre-emergent on first-year sod").
 *   - Tetrino: held through day 21 (Tetrino label: not on saturated soil).
 *   - Dylox: same window and scope rule as fertilizer.
 *   - Large patch watch: St. Augustine and zoysia sod laid October 1 - March 31
 *     is watched for large patch until March 31 ends that cool season.
 *
 * Pure: no database, no environment, no clock. Every input is an argument and
 * every day is a 'YYYY-MM-DD' string compared as a calendar day.
 */

const { validCalendarDate, etCalendarDayOf } = require('../utils/datetime-et');

// The sod record is one fact about one home: set, cleared, kept or dropped together.
const NEW_SOD_COLUMNS = Object.freeze(['sod_laid_on', 'sod_covers', 'sod_area', 'sod_rooted_on']);
// The two calendar-day columns of the record (the others are text).
const NEW_SOD_DATE_COLUMNS = Object.freeze(['sod_laid_on', 'sod_rooted_on']);

const FERTILIZER_HOLD_DAYS = 30;
const WEED_KILLER_HOLD_DAYS = 30;
const TETRINO_HOLD_DAYS = 21;
const DYLOX_HOLD_DAYS = 30;
const MAX_SOD_AGE_MONTHS = 24;
const SOD_AREA_MAX = 120;

// The fertilizer bag that replaces the pre-emergent fertilizer bag when the
// pre-emergent is held but the fertilizer is not (name as in lawn-protocol-v13.json).
const SOD_SWAP_BAG = Object.freeze({ name: 'LESCO 24-0-11 with PolyPlus OPTI', lbPer1000: 2.5, lbN: 0.6 });

const DAY_MS = 86400000;
const LARGE_PATCH_GRASSES = new Set(['st_augustine', 'zoysia']);

// All columns set to null, for the writers that clear the record together.
function clearedNewSodColumns() {
  const cleared = {};
  for (const column of NEW_SOD_COLUMNS) cleared[column] = null;
  return cleared;
}

// A calendar day as 'YYYY-MM-DD', or null. Accepts a plain day string, an ISO
// string at UTC midnight and a pg `date` (a Date at UTC midnight). Never throws.
function ymdOrNull(value) {
  if (value == null || value === '') return null;
  try {
    return validCalendarDate(etCalendarDayOf(value)) || null;
  } catch {
    return null;
  }
}

function utcMs(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function addDaysYmd(ymd, days) {
  return new Date(utcMs(ymd) + days * DAY_MS).toISOString().slice(0, 10);
}

// Whole calendar days from `fromYmd` to `toYmd`.
function daysBetween(fromYmd, toYmd) {
  return Math.round((utcMs(toYmd) - utcMs(fromYmd)) / DAY_MS);
}

// The same calendar day `months` earlier; a day past the end of the shorter month
// lands on its last day (Feb 29 minus 24 months is Feb 28).
function subtractMonthsYmd(ymd, months) {
  const [y, m, d] = ymd.split('-').map(Number);
  const total = y * 12 + (m - 1) - months;
  const year = Math.floor(total / 12);
  const month = total % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(year, 4)}-${pad(month + 1)}-${pad(Math.min(d, lastDay))}`;
}

/**
 * The office entry check for the sod date: a real calendar day, not after today
 * (America/New_York, passed in as `todayEt`), not older than 24 months. null and
 * '' clear the date.
 * @returns {{ ok: true, value: string|null } | { ok: false, message: string }}
 */
function validateSodLaidOn(raw, todayEt) {
  if (raw == null || String(raw).trim() === '') return { ok: true, value: null };
  const day = validCalendarDate(String(raw).trim());
  if (!day) return { ok: false, message: 'Sod date must be a real date (YYYY-MM-DD).' };
  const today = ymdOrNull(todayEt);
  if (!today) return { ok: false, message: 'Could not check the sod date against today.' };
  if (day > today) return { ok: false, message: 'Sod date cannot be in the future.' };
  if (day < subtractMonthsYmd(today, MAX_SOD_AGE_MONTHS)) {
    return { ok: false, message: 'Sod date cannot be more than 24 months ago.' };
  }
  return { ok: true, value: day };
}

/**
 * The first day pre-emergent is allowed again: Oct 1 of the sod year when the
 * sod went down January-May, otherwise Oct 1 of the next year.
 * @returns {string|null} 'YYYY-10-01', or null for an unreadable date
 */
function preEmergentHoldUntil(sodLaidOn) {
  const day = ymdOrNull(sodLaidOn);
  if (!day) return null;
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7));
  return `${month <= 5 ? year : year + 1}-10-01`;
}

function grassKey(grass) {
  if (typeof grass !== 'string') return null;
  const key = grass.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return key || null;
}

// The cool season a sod date falls in, for the large patch watch: sod laid
// October 1 - March 31 is watched until the March 31 that ends that season.
function largePatchWatchUntil(sodLaidOn) {
  const month = Number(sodLaidOn.slice(5, 7));
  const year = Number(sodLaidOn.slice(0, 4));
  if (month >= 10) return `${year + 1}-03-31`;
  if (month <= 3) return `${year}-03-31`;
  return null;
}

/**
 * What a visit on `visitDate` holds back for a home with new sod. `until` on a
 * hold is the first day the product class is allowed again (the hold runs while
 * the visit is before it); null means it has no date (the weed killer waits for
 * the technician's rooted check) or it never applies.
 *
 * @param {object} input
 * @param {string} input.sodLaidOn  day the sod went down
 * @param {string} [input.sodCovers]  'whole' (default) or 'part'
 * @param {string} [input.sodArea]  named area when part
 * @param {string} [input.sodRootedOn]  day a technician confirmed the sod is rooted
 * @param {string} input.visitDate
 * @param {string} [input.grass]  'st_augustine' | 'zoysia' | 'bermuda' | ...
 * @returns {object|null} null when there is no sod date, the visit is before it,
 *   or an input is unreadable
 */
function sodHolds(input) {
  try {
    const { sodLaidOn: rawLaid, sodCovers, sodArea, sodRootedOn, visitDate: rawVisit, grass } = input || {};
    const laid = ymdOrNull(rawLaid);
    const visit = ymdOrNull(rawVisit);
    if (!laid || !visit) return null;
    const day = daysBetween(laid, visit) + 1;
    if (day < 1) return null;

    // Anything but 'part' is the whole lawn: the cautious reading for every class.
    const covers = sodCovers === 'part' ? 'part' : 'whole';
    const whole = covers === 'whole';
    const area = whole ? null : ((typeof sodArea === 'string' && sodArea.trim()) || null);
    const scope = whole ? 'whole' : 'area';

    // A rooted check dated before the sod or after the visit does not count.
    const rootedDay = ymdOrNull(sodRootedOn);
    const rooted = !!rootedDay && rootedDay >= laid && rootedDay <= visit;

    const fertilizerUntil = addDaysYmd(laid, FERTILIZER_HOLD_DAYS);
    const fertilizer = whole && visit < fertilizerUntil
      ? { held: true, until: fertilizerUntil, scope: 'whole' }
      : { held: false, until: null, scope: 'whole' };

    const weedWindowUntil = addDaysYmd(laid, WEED_KILLER_HOLD_DAYS);
    const inWeedWindow = visit < weedWindowUntil;
    const weedKiller = {
      held: inWeedWindow || !rooted,
      until: inWeedWindow ? weedWindowUntil : null,
      needsRootedCheck: !inWeedWindow && !rooted,
      scope,
    };

    const preEmergentUntil = preEmergentHoldUntil(laid);
    const preEmergent = { held: visit < preEmergentUntil, until: preEmergentUntil, scope };

    const tetrinoUntil = addDaysYmd(laid, TETRINO_HOLD_DAYS);
    const tetrino = { held: visit < tetrinoUntil, until: tetrinoUntil, scope };

    const dyloxUntil = addDaysYmd(laid, DYLOX_HOLD_DAYS);
    const dylox = whole && visit < dyloxUntil
      ? { held: true, until: dyloxUntil, scope: 'whole' }
      : { held: false, until: null, scope: 'whole' };

    const fungicideGravex = { ...weedKiller };

    const watchUntil = largePatchWatchUntil(laid);
    const watchGrass = LARGE_PATCH_GRASSES.has(grassKey(grass));
    const largePatchWatch = {
      on: !!watchUntil && watchGrass && visit <= watchUntil,
      until: watchUntil && watchGrass ? watchUntil : null,
    };

    const swapPreEmergentBag = preEmergent.held && preEmergent.scope === 'whole' && !fertilizer.held;
    const active = fertilizer.held || weedKiller.held || preEmergent.held || tetrino.held
      || dylox.held || fungicideGravex.held || largePatchWatch.on;

    return {
      sodLaidOn: laid,
      covers,
      area,
      day,
      fertilizer,
      weedKiller,
      preEmergent,
      tetrino,
      dylox,
      fungicideGravex,
      largePatchWatch,
      swapPreEmergentBag,
      active,
    };
  } catch {
    return null;
  }
}

/**
 * Merge a prefs write with the current row into the one consistent sod record.
 * `current` is the stored property_preferences row (or null); `input` holds only
 * the snake_case sod fields the caller sent (sod_laid_on, sod_covers, sod_area;
 * sod_rooted_on is never accepted from a caller). The sod date itself is checked
 * by validateSodLaidOn before this runs.
 *
 *   - no date: covers, area and rooted day are cleared with it
 *   - a different date than the stored one clears the rooted day
 *   - covers defaults to 'whole' when a date is set; area is dropped for 'whole'
 *     and required (trimmed, up to 120 characters) for 'part'
 *
 * @returns {{ ok: true, columns: object } | { ok: false, field: string, message: string }}
 *   columns holds every column to write, in NEW_SOD_COLUMNS order
 */
function resolveSodRecord(current, input) {
  const sent = (key) => Object.prototype.hasOwnProperty.call(input || {}, key);
  const row = current || {};
  const storedLaid = ymdOrNull(row.sod_laid_on);

  const laid = sent('sod_laid_on') ? ymdOrNull(input.sod_laid_on) : storedLaid;
  if (!laid) {
    const wantsMore = (sent('sod_covers') && input.sod_covers != null && input.sod_covers !== '')
      || (sent('sod_area') && String(input.sod_area ?? '').trim() !== '');
    if (wantsMore) return { ok: false, field: 'sodLaidOn', message: 'Set the sod date before saying how much of the lawn it covers.' };
    return { ok: true, columns: clearedNewSodColumns() };
  }

  let covers = sent('sod_covers') ? input.sod_covers : row.sod_covers;
  if (covers == null || covers === '') covers = 'whole';
  if (covers !== 'whole' && covers !== 'part') {
    return { ok: false, field: 'sodCovers', message: "Sod covers must be 'whole' or 'part'." };
  }

  let area = sent('sod_area') ? input.sod_area : row.sod_area;
  area = area == null ? null : String(area).trim();
  if (area === '') area = null;
  if (area && area.length > SOD_AREA_MAX) {
    return { ok: false, field: 'sodArea', message: `Sod area must be ${SOD_AREA_MAX} characters or fewer.` };
  }
  if (covers === 'whole') area = null;
  else if (!area) return { ok: false, field: 'sodArea', message: 'Name the part of the lawn that has new sod.' };

  // The rooted day belongs to one sod date: a different date starts over.
  const rooted = storedLaid === laid ? (ymdOrNull(row.sod_rooted_on) || null) : null;

  return { ok: true, columns: { sod_laid_on: laid, sod_covers: covers, sod_area: area, sod_rooted_on: rooted } };
}

module.exports = {
  NEW_SOD_COLUMNS,
  NEW_SOD_DATE_COLUMNS,
  FERTILIZER_HOLD_DAYS,
  WEED_KILLER_HOLD_DAYS,
  TETRINO_HOLD_DAYS,
  DYLOX_HOLD_DAYS,
  MAX_SOD_AGE_MONTHS,
  SOD_AREA_MAX,
  SOD_SWAP_BAG,
  clearedNewSodColumns,
  validateSodLaidOn,
  preEmergentHoldUntil,
  sodHolds,
  resolveSodRecord,
};
