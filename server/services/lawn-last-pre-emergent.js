'use strict';

/**
 * The last pre-emergent herbicide Waves put on THIS home's lawn, for the office's New sod form in
 * Customer 360 (GET /api/admin/customers/:id/new-sod). The office uses it to tell the customer in
 * writing; the system sends nothing and no technician screen reads it.
 *
 * What counts (each rule exists because an earlier version of this lookup got it wrong):
 *   - Turf only: an application made on a LAWN visit (the record's service line, as the service report
 *     reads it), of a catalog product that classesOf() (lawn-sod-sheet.js, the sheet's one classifier)
 *     places in the pre-emergent class. A pre-emergent used in a bed on a tree-and-shrub or pest visit
 *     is not a lawn application.
 *   - This home only: the visit must be provably at the home the sod record belongs to, by the same
 *     chain the sod holds use (visitIsAtSodHome: the visit's address stamp, property link or creating
 *     estimate; a visit with no evidence counts only on a proven single-premises account). A stamp on
 *     the home's street that omits the unit takes the home's unit first (inheritReferenceUnit).
 *     Anything unproven is left out, and a failed read gives no block at all: never a wrong date.
 *   - The newest one, with no row limit: every matching application on or before the reference day is
 *     read newest first until one is proven at this home.
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

// The seeding and sprigging wait each label states, for the products whose label was read (2026-10-09). The warning
// names only the matched product's own wait. A pre-emergent with no entry here (prodiamine and the rest, or a legacy
// row with no catalog product) gets NOTE_TEXT in its place: the app never states a wait it does not hold.
//   - dithiopyr on fertilizer (LESCO Dimension 0.21% Plus Fertilizer, EPA 10404-87): "delayed until 12 weeks".
//   - dithiopyr liquid (Dimension 2EW, EPA 62719-542): "within 3 months after a single application".
const LABEL_WAITS = Object.freeze({
  dithiopyrGranular: Object.freeze({ underDays: 84, words: '12 weeks' }),
  dithiopyrLiquid: Object.freeze({ underDays: 92, words: '3 months' }),
});
const warningText = (wait) => `Its label delays seeding or sprigging ${wait.words} after treatment. Sod laid on treated soil may root slowly. Tell the customer in writing today.`;
const NOTE_TEXT = 'The app does not hold this product\'s label wait for seeding or sod. Read the label.';

// The label wait of a catalog row, or null when the app holds none for it.
function labelWaitOf(row) {
  if (!row || !String(row.active_ingredient || '').toLowerCase().includes('dithiopyr')) return null;
  const granular = String(row.formulation || '').toLowerCase().includes('granul') || Number(row.analysis_n) > 0;
  return granular ? LABEL_WAITS.dithiopyrGranular : LABEL_WAITS.dithiopyrLiquid;
}
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

// The strings the form prints for one application. Once the sod is confirmed rooted, only the line stays.
function wordsFor({ product, date, referenceDay, sodDate, rooted }) {
  const days = daysBetween(date, referenceDay);
  const when = sodDate ? `${plural(days)} before the sod date` : `${plural(days)} ago`;
  const wait = rooted ? null : product.wait;
  return {
    line: `Last pre-emergent by Waves: ${product.name}, ${formatDay(date)} (${when}).`,
    warning: wait && days < wait.underDays ? warningText(wait) : null,
    note: !rooted && !product.wait ? NOTE_TEXT : null,
  };
}

// Every catalog product the sheet's classifier calls a pre-emergent, by lower-case id.
async function preEmergentProducts(knex) {
  const rows = await knex('products_catalog')
    .whereNotNull('active_ingredient')
    .select('id', 'name', 'display_name', 'category', 'active_ingredient', 'analysis_n', 'formulation');
  return new Map((Array.isArray(rows) ? rows : [])
    .filter((row) => classesOf(row).includes('preEmergent'))
    .map((row) => [String(row.id).toLowerCase(), { name: row.display_name || row.name, wait: labelWaitOf(row) }]));
}

// The product of one application row: its catalog product, else (a legacy row with no catalog id) the row's own
// name and ingredient snapshot when the same classifier calls it a pre-emergent. Null = not a pre-emergent.
function productOf(row, products) {
  if (row.product_id) return products.get(String(row.product_id).toLowerCase()) || null;
  const snapshot = { name: row.product_name, category: row.product_category, active_ingredient: row.active_ingredient };
  return classesOf(snapshot).includes('preEmergent') ? { name: row.product_name, wait: null } : null;
}

// Applications of those products (and legacy rows with no catalog id, classified later from their own snapshot) on
// this customer's visits on or before the reference day, newest first.
function applicationRows(knex, customerId, productIds, referenceDay) {
  return knex('service_products as sp')
    .join('service_records as sr', 'sp.service_record_id', 'sr.id')
    .leftJoin('scheduled_services as ss', 'sr.scheduled_service_id', 'ss.id')
    .where('sr.customer_id', customerId)
    .where(function known() { this.whereIn('sp.product_id', productIds).orWhereNull('sp.product_id'); })
    .whereIn('sr.status', VISIT_STATUSES)
    .where('sr.service_date', '<=', referenceDay)
    .orderBy('sr.service_date', 'desc')
    .orderBy('sr.created_at', 'desc')
    .select(
      'sp.product_id', 'sp.product_name', 'sp.product_category', 'sp.active_ingredient', 'sr.service_date', 'sr.service_line', 'sr.service_type',
      'ss.service_address_line1', 'ss.service_address_line2', 'ss.service_address_city', 'ss.service_address_zip',
      'ss.property_id', 'ss.source_estimate_id',
    );
}

const isLawnVisit = (row) => (row.service_line || detectServiceLine(row.service_type)) === 'lawn';

// The visit as visitIsAtSodHome reads it: the customer's own address plus the visit's scope columns.
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
    property_id: row.property_id,
    source_estimate_id: row.source_estimate_id,
    ...(row.service_address_line1 ? inheritReferenceUnit(stamp, home) : stamp),
  };
}

/**
 * The block for the form, or null (nothing to show: none applied, or the read could not be proven).
 * @param {object} args
 * @param {object} args.knex
 * @param {string} args.customerId
 * @param {string|null} args.sodLaidOn  the saved sod date ('YYYY-MM-DD'), or null
 * @param {string|null} [args.sodRootedOn]  the day the sod was confirmed rooted, or null
 * @param {string} args.todayEt  today as 'YYYY-MM-DD' (America/New_York)
 * @returns {Promise<{ line: string, warning: string|null, note: string|null }|null>}
 */
async function lastPreEmergentBlock({ knex, customerId, sodLaidOn, sodRootedOn = null, todayEt }) {
  try {
    const sodDate = ymdOrNull(sodLaidOn);
    const referenceDay = sodDate || ymdOrNull(todayEt);
    if (!referenceDay) return null;
    const customer = await knex('customers').where({ id: customerId }).first('id', 'address_line1', 'address_line2', 'city', 'zip', 'has_multi_home');
    if (!customer) return null;
    const products = await preEmergentProducts(knex);
    const rows = await applicationRows(knex, customerId, [...products.keys()], referenceDay);
    for (const row of Array.isArray(rows) ? rows : []) {
      const date = ymdOrNull(row.service_date);
      const product = productOf(row, products);
      if (!date || !product || !isLawnVisit(row)) continue;
      // Newest first: stops at the first application proven at this home.
      if (!(await visitIsAtSodHome(visitAt(customer, row), knex))) continue;
      return wordsFor({ product, date, referenceDay, sodDate, rooted: !!ymdOrNull(sodRootedOn) });
    }
    return null;
  } catch (err) {
    // No driver message: it can echo SQL and bound values.
    logger.warn(`[lawn-last-pre-emergent] unavailable for customer ${customerId}: ${err?.code || err?.name || 'Error'}`);
    return null;
  }
}

module.exports = { lastPreEmergentBlock };
