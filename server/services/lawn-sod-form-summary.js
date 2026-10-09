'use strict';

/**
 * What the office sees beside the new-sod fields in Customer 360 (Access &
 * Preferences). Read-only, computed here so the client never restates a rule:
 *
 *   - holdLines: the plain hold lines for a recorded sod, from sodHolds()
 *   - lastPreEmergent: the last pre-emergent Waves applied at this customer's
 *     home, and a warning when it was less than 12 weeks before the sod date
 *     (the Dimension granular label says to delay sprigging 12 weeks, so the
 *     office tells the customer; no automated message of any kind)
 *
 * Nothing here writes, texts or emails.
 */

const { sodHolds, validateSodLaidOn, MAX_SOD_AGE_MONTHS } = require('./lawn-sod-holds');
const { premiseStampConflicts, inheritReferenceUnit } = require('./stamped-address');
const { isPreEmergent } = require('./service-report/lawn-watering-rule');
const { etCalendarDayOf, validCalendarDate, etDateString, addETDays } = require('../utils/datetime-et');

// Dimension granular label: delay sprigging 12 weeks after the pre-emergent.
const PRE_EMERGENT_BEFORE_SOD_DAYS = 84;
const PRE_EMERGENT_WARNING = 'Pre-emergent was applied less than 12 weeks before this sod. Tell the customer.';
// How far back the history is read: the oldest sod date the form accepts (MAX_SOD_AGE_MONTHS) plus the 12 weeks
// before it, with a margin. A date window, never a row limit: a busy file must not push the pre-emergent out.
const HISTORY_DAYS_READ = (MAX_SOD_AGE_MONTHS + 4) * 31;

const DAY_MS = 86400000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function ymdOrNull(value) {
  if (value == null || value === '') return null;
  try {
    return validCalendarDate(etCalendarDayOf(value)) || null;
  } catch {
    return null;
  }
}

// 'YYYY-MM-DD' as 'Oct 1, 2027'.
function formatDay(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

function daysBetween(fromYmd, toYmd) {
  const ms = (ymd) => {
    const [y, m, d] = ymd.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((ms(toYmd) - ms(fromYmd)) / DAY_MS);
}

// This home only: a visit stamped with another premise (a former home, a second property, another unit at the same
// street) is not this lawn's history. The repo's one premise comparator decides (street, unit, ZIP, city); a stamp
// that omits the unit takes the home's. A visit with no stamp is kept: nothing proves it was elsewhere.
function atAnotherPremise(row) {
  if (!row?.service_address_line1) return false;
  const home = { service_address_line1: row.home_line1, service_address_line2: row.home_line2, service_address_city: row.home_city, service_address_zip: row.home_zip };
  return premiseStampConflicts(inheritReferenceUnit(row, home), home);
}

/**
 * The newest pre-emergent application at the customer's current home (completed or incomplete visits: both
 * record what was applied).
 * Uses the same product test as the lawn watering rule (isPreEmergent), on the
 * product name plus what the catalog says about it.
 * @returns {Promise<{ date: string, product: string }|{ unreadable: true }|null>} null when none;
 *   { unreadable: true } when the history could not be read (the form says so: a failed read is not "none")
 */
async function lastWavesPreEmergent(knex, customerId) {
  let rows;
  try {
    rows = await knex('service_products as sp')
      .join('service_records as sr', 'sp.service_record_id', 'sr.id')
      .join('customers as c', 'sr.customer_id', 'c.id')
      .leftJoin('scheduled_services as ss', 'sr.scheduled_service_id', 'ss.id')
      .leftJoin('products_catalog as pc', 'sp.product_name', 'pc.name')
      .where('sr.customer_id', customerId)
      // An incomplete visit still records the products that were applied before it stopped.
      .whereIn('sr.status', ['completed', 'incomplete'])
      .where('sr.service_date', '>=', etDateString(addETDays(new Date(), -HISTORY_DAYS_READ)))
      .orderBy('sr.service_date', 'desc')
      .select(
        'sr.service_date',
        'sp.product_name',
        'sp.active_ingredient as applied_ingredient',
        'sp.product_category as applied_category',
        'pc.active_ingredient as catalog_ingredient',
        'pc.category as catalog_category',
        'pc.subcategory as catalog_subcategory',
        'ss.service_address_line1', 'ss.service_address_line2', 'ss.service_address_city', 'ss.service_address_zip',
        'c.address_line1 as home_line1', 'c.address_line2 as home_line2', 'c.city as home_city', 'c.zip as home_zip',
      );
  } catch {
    return { unreadable: true };
  }
  // Newest first. The first one is what the form names; the warning needs the newest one on or before the sod
  // date, so every pre-emergent read is kept.
  const applications = [];
  for (const row of rows || []) {
    if (atAnotherPremise(row)) continue;
    const date = ymdOrNull(row.service_date);
    if (!date) continue;
    const product = {
      name: row.product_name,
      active_ingredient: row.catalog_ingredient || row.applied_ingredient,
      subcategory: row.catalog_subcategory,
      category: row.catalog_category || row.applied_category,
    };
    if (isPreEmergent(product)) applications.push({ date, product: row.product_name });
  }
  return applications.length ? { ...applications[0], applications } : null;
}

/**
 * The warning for an entered sod date, or null. A pre-emergent put down 0 to 83
 * days before the sod date warns; one after the sod date, or 84+ days before,
 * does not. With several applications the newest one on or before the sod date decides. An unreadable sod date gives no warning.
 */
function preEmergentWarning(sodLaidOn, lastPreEmergent) {
  const sod = ymdOrNull(sodLaidOn);
  if (!sod || !lastPreEmergent) return null;
  // The newest application on or before the sod date: a later one must not hide it.
  const dates = (lastPreEmergent.applications || [lastPreEmergent]).map((row) => ymdOrNull(row?.date)).filter((date) => date && date <= sod).sort();
  const before = dates[dates.length - 1];
  return before && daysBetween(before, sod) < PRE_EMERGENT_BEFORE_SOD_DAYS ? PRE_EMERGENT_WARNING : null;
}

// The three plain lines for a recorded sod. Dates are the fixed hold end days
// (read as of the sod date); "hold is over" is added once today is past them.
function holdLinesFor(prefsRow, todayEt) {
  const laid = ymdOrNull(prefsRow?.sod_laid_on);
  if (!laid) return [];
  const base = {
    sodLaidOn: laid,
    sodCovers: prefsRow.sod_covers,
    sodArea: prefsRow.sod_area,
    sodRootedOn: prefsRow.sod_rooted_on,
  };
  // The first sod day gives each hold's end date; today gives where it stands.
  const atStart = sodHolds({ ...base, visitDate: laid });
  const today = ymdOrNull(todayEt);
  const now = today && today >= laid ? sodHolds({ ...base, visitDate: today }) : atStart;
  if (!atStart || !now) return [];

  const overNote = (stillHeld) => (stillHeld ? '' : ' (this hold is over)');
  const lines = [];

  lines.push(atStart.fertilizer.held
    ? {
      key: 'fertilizer',
      active: now.fertilizer.held,
      text: `Fertilizer is held until ${formatDay(atStart.fertilizer.until)}${overNote(now.fertilizer.held)}.`,
    }
    : {
      key: 'fertilizer',
      active: false,
      text: 'Fertilizer is not held. The new sod covers only part of the lawn.',
    });

  const rootedNote = now.weedKiller.held ? '' : ' (this hold is over)';
  const areaNote = atStart.covers === 'part' ? ' The hold covers the named area only.' : '';
  lines.push({
    key: 'weedKiller',
    active: now.weedKiller.held,
    text: `Weed killer is held until ${formatDay(atStart.weedKiller.until)} and until the technician confirms the sod is rooted${rootedNote}.${areaNote}`,
  });

  lines.push({
    key: 'preEmergent',
    active: now.preEmergent.held,
    text: `Pre-emergent is held until ${formatDay(atStart.preEmergent.until)}${overNote(now.preEmergent.held)}.${areaNote}`,
  });
  return lines;
}

/**
 * The whole read-only object the form needs.
 * @param {object} args
 * @param {object|null} args.prefsRow  property_preferences row (or null)
 * @param {{ date: string, product: string }|null} args.lastPreEmergent
 * @param {string} args.todayEt  today as 'YYYY-MM-DD' (America/New_York)
 * @param {string|null} [args.enteredSodLaidOn]  a date typed in the form and not
 *   saved yet; the pre-emergent warning is judged against it (none when it is
 *   empty or not a valid sod date), else against the saved date
 */
function buildNewSodSummary({ prefsRow, lastPreEmergent, todayEt, enteredSodLaidOn = null }) {
  // undefined/null: judge the saved date. A typed value (even empty or invalid)
  // is what the office is looking at, so it alone decides.
  const typed = enteredSodLaidOn !== undefined && enteredSodLaidOn !== null;
  const checked = typed ? validateSodLaidOn(enteredSodLaidOn, todayEt) : null;
  const judgedDate = typed ? (checked.ok ? checked.value : null) : ymdOrNull(prefsRow?.sod_laid_on);
  const unreadable = lastPreEmergent?.unreadable === true;
  const last = unreadable ? null : lastPreEmergent;
  return {
    holdLines: holdLinesFor(prefsRow, todayEt),
    lastPreEmergent: last
      ? { date: last.date, dateText: formatDay(last.date), product: last.product }
      : null,
    // true: the history read failed, so "none on record" must not be shown.
    lastPreEmergentUnreadable: unreadable,
    preEmergentWarning: judgedDate ? preEmergentWarning(judgedDate, last) : null,
  };
}

module.exports = {
  PRE_EMERGENT_BEFORE_SOD_DAYS,
  PRE_EMERGENT_WARNING,
  formatDay,
  lastWavesPreEmergent,
  preEmergentWarning,
  holdLinesFor,
  buildNewSodSummary,
};
