'use strict';

/**
 * The last pre-emergent herbicide Waves put on THIS home's lawn, for the office's New sod form in
 * Customer 360 (GET /api/admin/customers/:id/new-sod). The office uses it to tell the customer in
 * writing; the system sends nothing and no technician screen reads it.
 *
 * What counts (each rule exists because an earlier version of this lookup got it wrong):
 *   - Turf only: an application made on a LAWN visit (the record's service line, as the service report
 *     reads it), of a product that classesOf() (lawn-sod-sheet.js, the sheet's one classifier) places in
 *     the pre-emergent class, judged from the name, category and ingredient the application row froze at
 *     completion. The current catalog is not read. A pre-emergent used in a bed on a tree-and-shrub or
 *     pest visit is not a lawn application.
 *   - This home only: the visit must be provably at the home the sod record belongs to, by the same
 *     chain the sod holds use (visitIsAtSodHome: the visit's address stamp, property link or creating
 *     estimate; a visit with no evidence counts only on a proven single-premises account). A stamp on
 *     the home's street that omits the unit takes the home's unit first (inheritReferenceUnit).
 *     The property the application ledger froze at completion (property_application_history.property_id)
 *     decides alone when it exists, so a visit repointed later does not move its history.
 *     Anything unproven is left out, and a failed read gives no block at all: never a wrong date.
 *   - The newest day, with no row limit: applications on or before the reference day are read newest
 *     first until a day has one proven at this home; every pre-emergent product of that day is listed.
 *   - A label wait is stated only for the exact EPA registration number frozen on the row (LABEL_WAITS).
 *   - The reference day is the sod date, or today (ET) when none is saved. An application after it is
 *     the sod holds' business, not a warning.
 *
 * The strings are built here; the form only prints them. Read-only.
 */

const logger = require('./logger');
const { classesOf, visitIsAtSodHome } = require('./lawn-sod-sheet');
const { formatDay } = require('./lawn-sod-form-summary');
const { inheritReferenceUnit } = require('./stamped-address');
const { detectServiceLine } = require('./service-report/service-line-configs');
const { etCalendarDayOf, validCalendarDate } = require('../utils/datetime-et');
const { addMonthsSameDay } = require('../utils/date-only');

// The seeding and sprigging wait a label states, by the EXACT EPA registration number frozen on the application row
// (service_products.epa_reg_number), for the labels read on 2026-10-09. A label wait belongs to one registration, never
// to an ingredient or a formulation. An application with any other number, or none, gets NOTE_TEXT: the app never
// states a wait it does not hold.
//   - 10404-87 (LESCO Dimension 0.21% Plus Fertilizer): "delayed until 12 weeks from the time of application".
//   - 62719-542 (Dimension 2EW): "within 3 months after a single application of this product, or within 4 months
//     after a sequential application program totaling more than 2 pints per acre". This lookup does not know the
//     program, so the warning states both waits and stays for the longer one.
// `over(date, referenceDay)` says whether the wait has passed on the reference day: 12 weeks is 84 days; the months
// wait ends on the same day that many calendar months later (date-only.js addMonthsSameDay), never a fixed day count.
const LABEL_WAITS = Object.freeze({
  '10404-87': Object.freeze({ words: '12 weeks after treatment', over: (date, referenceDay) => daysBetween(date, referenceDay) >= 84 }),
  '62719-542': Object.freeze({
    words: '3 months after one application, and 4 months after a sequential program of more than 2 pints per acre',
    over: (date, referenceDay) => referenceDay >= addMonthsSameDay(date, 4),
  }),
});
const warningText = (wait) => `Its label delays seeding or sprigging ${wait.words}. Sod laid on treated soil may root slowly. Tell the customer in writing today.`;
const NOTE_TEXT = 'The app does not hold this product\'s label wait for seeding or sod. Read the label.';
// An incomplete visit still records the products applied before it stopped.
const VISIT_STATUSES = Object.freeze(['completed', 'incomplete']);
const DAY_MS = 86400000;

function ymdOrNull(value) {
  if (value == null || value === '') return null;
  try {
    return validCalendarDate(etCalendarDayOf(value)) || null;
  } catch {
    return null;
  }
}

// Whole calendar days from one 'YYYY-MM-DD' to another.
function daysBetween(fromYmd, toYmd) {
  const ms = (ymd) => {
    const [y, m, d] = ymd.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((ms(toYmd) - ms(fromYmd)) / DAY_MS);
}

const plural = (n) => `${n} day${n === 1 ? '' : 's'}`;

// The strings the form prints for one application row. Once the sod is confirmed rooted, only the line stays.
function wordsFor(row, { date, referenceDay, sodDate, rooted }) {
  const days = daysBetween(date, referenceDay);
  const when = sodDate ? `${plural(days)} before the sod date` : `${plural(days)} ago`;
  const wait = LABEL_WAITS[String(row.epa_reg_number || '').trim()] || null;
  return {
    line: `Last pre-emergent by Waves: ${row.product_name}, ${formatDay(date)} (${when}).`,
    warning: !rooted && wait && !wait.over(date, referenceDay) ? warningText(wait) : null,
    note: !rooted && !wait ? NOTE_TEXT : null,
  };
}

// A pre-emergent, judged from what the application row itself froze at completion (name, category, ingredient) by
// the sheet's one classifier. The current catalog is not read: a later rename or correction cannot rewrite history.
// A row whose snapshot has no ingredient is still known by its exact EPA registration (LABEL_WAITS), or by an ingredient
// word in its frozen product name ("Prodiamine 65 WDG").
const isPreEmergent = (row) => !!LABEL_WAITS[String(row.epa_reg_number || '').trim()]
  || classesOf({ name: row.product_name, category: row.product_category, active_ingredient: row.active_ingredient || row.product_name }).includes('preEmergent');

// Every product applied on this customer's visits on or before the reference day, newest visit first. No product
// filter and no row limit in SQL: the rows are classified from their own snapshots.
function applicationRows(knex, customerId, referenceDay) {
  return knex('service_products as sp')
    .join('service_records as sr', 'sp.service_record_id', 'sr.id')
    .leftJoin('scheduled_services as ss', 'sr.scheduled_service_id', 'ss.id')
    // The application ledger freezes the treated property at completion (one row per service product).
    .leftJoin('property_application_history as pah', 'pah.service_product_id', 'sp.id')
    .whereNull('pah.retracted_at')
    .where('sr.customer_id', customerId)
    .whereIn('sr.status', VISIT_STATUSES)
    .where('sr.service_date', '<=', referenceDay)
    .orderBy('sr.service_date', 'desc')
    .select(
      'sp.product_name', 'sp.product_category', 'sp.active_ingredient', 'sp.epa_reg_number',
      'sr.service_date', 'sr.service_line', 'sr.service_type',
      'ss.service_address_line1', 'ss.service_address_line2', 'ss.service_address_city', 'ss.service_address_zip',
      'ss.property_id', 'ss.source_estimate_id', 'pah.property_id as treated_property_id',
    );
}

const isLawnVisit = (row) => (row.service_line || detectServiceLine(row.service_type)) === 'lawn';

// The visit as visitIsAtSodHome reads it: the customer's own address plus the application's scope. The property the
// ledger froze at completion decides alone when it exists (a visit repointed later must not move its history); a
// legacy row with none falls back to the visit's own stamp, property link and estimate.
function visitAt(customer, row) {
  const home = {
    service_address_line1: customer.address_line1,
    service_address_line2: customer.address_line2,
    service_address_city: customer.city,
    service_address_zip: customer.zip,
  };
  const stamp = {
    service_address_line1: row.service_address_line1,
    service_address_line2: row.service_address_line2,
    service_address_city: row.service_address_city,
    service_address_zip: row.service_address_zip,
  };
  return {
    customer_id: customer.id,
    cust_address_line1: customer.address_line1,
    cust_address_line2: customer.address_line2,
    cust_city: customer.city,
    cust_zip: customer.zip,
    ...(row.treated_property_id
      ? { property_id: row.treated_property_id, source_estimate_id: null, service_address_line1: null, service_address_line2: null, service_address_city: null, service_address_zip: null }
      : { property_id: row.property_id, source_estimate_id: row.source_estimate_id, ...(row.service_address_line1 ? inheritReferenceUnit(stamp, home) : stamp) }),
  };
}

/**
 * The block for the form: one entry for each pre-emergent product applied on the newest day one was applied at this
 * home, or null (none applied, or the read could not be proven).
 * @param {object} args
 * @param {object} args.knex
 * @param {string} args.customerId
 * @param {string|null} args.sodLaidOn  the saved sod date ('YYYY-MM-DD'), or null
 * @param {string|null} [args.sodRootedOn]  the day the sod was confirmed rooted, or null
 * @param {string} args.todayEt  today as 'YYYY-MM-DD' (America/New_York)
 * @returns {Promise<Array<{ line: string, warning: string|null, note: string|null }>|null>}
 */
async function lastPreEmergentBlock({ knex, customerId, sodLaidOn, sodRootedOn = null, todayEt }) {
  try {
    const sodDate = ymdOrNull(sodLaidOn);
    const referenceDay = sodDate || ymdOrNull(todayEt);
    if (!referenceDay) return null;
    const customer = await knex('customers').where({ id: customerId }).first('id', 'address_line1', 'address_line2', 'city', 'zip', 'has_multi_home');
    if (!customer) return null;
    const rows = await applicationRows(knex, customerId, referenceDay);
    const found = new Map();
    let newest = null;
    for (const row of Array.isArray(rows) ? rows : []) {
      const date = ymdOrNull(row.service_date);
      // Newest first: once a day is found, an older row ends the read; every product of that day is kept.
      if (newest && date !== newest) break;
      if (!date || !isLawnVisit(row) || !isPreEmergent(row) || found.has(row.product_name)) continue;
      if (!(await visitIsAtSodHome(visitAt(customer, row), knex))) continue;
      newest = date;
      found.set(row.product_name, wordsFor(row, { date, referenceDay, sodDate, rooted: !!ymdOrNull(sodRootedOn) }));
    }
    return found.size ? [...found.values()] : null;
  } catch (err) {
    // No driver message: it can echo SQL and bound values.
    logger.warn(`[lawn-last-pre-emergent] unavailable for customer ${customerId}: ${err?.code || err?.name || 'Error'}`);
    return null;
  }
}

module.exports = { lastPreEmergentBlock };
