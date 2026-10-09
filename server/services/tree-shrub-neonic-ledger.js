/**
 * Tree & Shrub neonicotinoid yearly cap, per property (GATE_TS_NEONIC_CAP, owner 2026-10-09).
 *
 * The label caps live in config/tree-shrub-neonic-caps.js (per acre per year, in each product's
 * unit). This file scales them to the property's bed area, adds up what the property already had
 * put down this calendar year (property_application_history), and answers one reader: the Fast
 * Complete sheet, which shows how much is left and holds Complete on an amount over it. Like the
 * live-insect check (GATE_TS_PEST_CHECK), the hold is the sheet's; /complete does not refuse. An
 * application that was made is always recorded.
 *
 * Products that share an active ingredient share one cap: an application is a share of its own
 * product's yearly amount, and a year's shares add up to 1. A ledger row that cannot be sized
 * (no quantity, a unit that does not convert, an imidacloprid or dinotefuran product with no
 * strength in the config) is counted in `unsized` and named, never counted as nothing in silence.
 * No usable bed area: the yearly amount cannot be computed, the answer says so and the amount check
 * blocks nothing. The application count and the no-limit-on-file hold need no bed area and still apply.
 */
const db = require('../models/db');
const logger = require('./logger');
const { convertInventoryQuantity } = require('./inventory-units');
const { NEONIC_CAPS, SQFT_PER_ACRE } = require('../config/tree-shrub-neonic-caps');
const { detectServiceLine } = require('./service-report/service-line-configs');
const { etCalendarDayOf } = require('../utils/datetime-et');

const BED_AREA_NEEDED = 'bed_area_needed';
const PROPERTY_NEEDED = 'property_needed';

function tsNeonicCapLive() {
  const gates = require('../config/feature-gates');
  return typeof gates.tsNeonicCapLive === 'function' && gates.tsNeonicCapLive() === true;
}

const round4 = (n) => Math.round(n * 10000) / 10000;
const positive = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};

// The cap a product (catalog row, or a ledger row's recorded name and ingredient) falls under:
// { cap, entry }. `entry` is null for an ingredient with no strength in the config for this name.
function capFor(name, activeIngredient) {
  const ai = String(activeIngredient || '').trim().toLowerCase();
  // Anywhere in the ingredient text, as a word: a two-active product ("Beta-cyfluthrin + Imidacloprid")
  // is still an imidacloprid product.
  const cap = ai ? NEONIC_CAPS.find((c) => new RegExp(`(^|[^a-z])${c.activeIngredientPrefix}`).test(ai)) : null;
  if (!cap) return null;
  const label = String(name || '').trim();
  const injection = (cap.injectionPatterns || []).some((pattern) => pattern.test(label));
  return { cap, entry: cap.products.find((p) => p.namePattern.test(label)) || null, injection };
}

const yearlyAmountFor = (entry, bedSqft) => round4((entry.perAcreYear * bedSqft) / SQFT_PER_ACRE);

// A product with a label limit on the NUMBER of applications: remember this one. An application is
// one visit (its service record): two rows of one visit are one application, two visits on one day
// are two. A row with no record is its own application.
function noteApplicationDay(applicationDays, entry, row) {
  if (!entry?.maxApplicationsPerYear) return;
  const seen = applicationDays.get(entry) || new Set();
  seen.add(row.service_record_id ? `record-${row.service_record_id}` : `row-${row.id ?? seen.size}`);
  applicationDays.set(entry, seen);
}

function productCap(product, entry, area, usedShare, applicationDays) {
  const yearlyAmount = area ? yearlyAmountFor(entry, area) : null;
  const counted = Boolean(entry.maxApplicationsPerYear);
  return {
    productId: product.id,
    name: entry.shortName,
    unit: entry.unit,
    yearlyAmount,
    remainingAmount: area ? round4(Math.max(0, 1 - usedShare) * yearlyAmount) : null,
    maxApplications: counted ? entry.maxApplicationsPerYear : null,
    applicationsUsed: counted ? (applicationDays.get(entry)?.size || 0) : null,
  };
}

/**
 * Pure. `rows` are this property's Tree & Shrub ledger rows for the year ({ product_name,
 * active_ingredient, quantity_applied, quantity_unit }), `catalog` the products to report a
 * remaining amount for ({ id, name, active_ingredient }). One entry per cap:
 * { key, label, usedShare, capByProduct: [{ productId, name, unit, yearlyAmount, remainingAmount,
 *   maxApplications, applicationsUsed }], uncapped: [{ productId, name }], unsized, reason }.
 * usedShare and the amounts are null with reason 'bed_area_needed'. `uncapped` names the catalog
 * products of this ingredient with no strength in the config: the sheet holds them, except a
 * trunk-injection product (`injection: true`), which is dosed per tree and only gets a line. A product with
 * a label limit on the NUMBER of applications carries maxApplications and applicationsUsed (the
 * visits that applied it this year, sized or not); the others carry null.
 */
function computeNeonicLedger({ rows = [], bedSqft = null, catalog = [] } = {}) {
  const area = positive(bedSqft);
  return NEONIC_CAPS.map((cap) => {
    let usedShare = 0;
    let unsized = 0;
    const applicationDays = new Map();
    for (const row of rows) {
      const found = capFor(row.product_name, row.active_ingredient);
      if (!found || found.cap !== cap || found.injection) continue;
      noteApplicationDay(applicationDays, found.entry, row);
      const quantity = found.entry && convertInventoryQuantity(row.quantity_applied, row.quantity_unit, found.entry.unit);
      if (!quantity) { unsized += 1; continue; }
      if (area) usedShare += quantity / yearlyAmountFor(found.entry, area);
    }
    const capByProduct = [];
    const uncapped = [];
    for (const product of catalog) {
      const found = capFor(product.name, product.active_ingredient);
      if (!found || found.cap !== cap) continue;
      if (!found.entry) {
        uncapped.push({ productId: product.id, name: String(product.name || '').trim(), ...(found.injection ? { injection: true } : {}) });
        continue;
      }
      capByProduct.push(productCap(product, found.entry, area, usedShare, applicationDays));
    }
    return {
      key: cap.key,
      label: cap.label,
      // Unrounded: a rounded share could tip an amount that lands exactly on the cap over it.
      usedShare: area ? usedShare : null,
      capByProduct,
      uncapped,
      unsized,
      reason: area ? null : BED_AREA_NEEDED,
    };
  });
}

// A ledger row that counts against the bed cap. Zylam and Safari (the configured dinotefuran
// products) are ornamental products only here, so their rows count from any visit: a lawn visit
// that also treated the shrubs spent the same allowance. Every other row counts only from a tree &
// shrub visit: imidacloprid is also a lawn product (another treated area), and another dinotefuran
// product (Alpine WSG on a pest visit is structural) is not an ornamental application at all.
// `service_line` is the record's own column; an older record without one is read from its service type.
function isTreeShrubLedgerRow(row) {
  const found = capFor(row.product_name, row.active_ingredient);
  if (found?.cap.key === 'dinotefuran' && found.entry) return true;
  const line = row.service_line || (row.service_type ? detectServiceLine(row.service_type) : null);
  return line === 'tree_shrub';
}

/**
 * This property's Tree & Shrub neonicotinoid applications in the calendar year of `serviceDate`
 * (ET), retracted rows out, the visit being completed left out. Rows that count: isTreeShrubLedgerRow. Property scope is the one every
 * per-property cap reader uses (application-limits scopeHistoryToTreatment).
 */
async function loadNeonicLedgerRows(database, svc, serviceDate) {
  const { scopeHistoryToTreatment } = require('./application-limits');
  const year = String(etCalendarDayOf(serviceDate)).slice(0, 4);
  const query = database('property_application_history as pah')
    .leftJoin('products_catalog as pc', 'pc.id', 'pah.product_id')
    .leftJoin('service_products as sp', 'sp.id', 'pah.service_product_id')
    // LEFT join: a ledger row with no service record (an import, a hand entry) still counts when its
    // product does; the property scope below keeps such rows on purpose.
    .leftJoin('service_records as sr', 'sr.id', 'pah.service_record_id')
    .where('pah.customer_id', svc.customer_id)
    .whereNull('pah.retracted_at')
    .where('pah.application_date', '>=', `${year}-01-01`)
    .where('pah.application_date', '<=', `${year}-12-31`)
    .where(function dinotefuranOrImidacloprid() {
      for (const cap of NEONIC_CAPS) {
        const like = `%${cap.activeIngredientPrefix}%`;
        this.orWhereRaw('COALESCE(pah.active_ingredient, sp.active_ingredient, pc.active_ingredient) ILIKE ?', [like]);
      }
    });
  scopeHistoryToTreatment(query, database, { propertyId: svc.property_id || null, excludeScheduledServiceId: svc.id }, 'pah');
  const rows = await query.select(
    'pah.id', 'pah.service_record_id', 'pah.quantity_applied', 'pah.quantity_unit',
    // The name and ingredient FROZEN when the application was recorded win over the catalog's
    // current ones: renaming a product or editing its ingredient must not re-class its history.
    database.raw('COALESCE(sp.product_name, pc.name) as product_name'),
    database.raw('COALESCE(pah.active_ingredient, sp.active_ingredient, pc.active_ingredient) as active_ingredient'),
    'sr.service_line', 'sr.service_type',
  );
  return rows.filter(isTreeShrubLedgerRow);
}

// The property's ornamental bed area (null when it has none on file).
async function loadBedSqft(database, svc) {
  const property = await database('customer_properties').where({ id: svc.property_id }).first('bed_sqft');
  return positive(property?.bed_sqft);
}

/**
 * The fast-context `neonicCap` block: { year, bedSqft, ingredients } with a remaining amount for
 * every capped catalog product, or { available: false, reason } when the read failed (the sheet
 * then shows nothing and blocks nothing). `catalog` is the sheet's catalog list.
 */
async function buildNeonicCapContext(svc, serviceDate, catalog, database = db) {
  const year = Number(String(etCalendarDayOf(serviceDate)).slice(0, 4));
  // A visit with no property link has no one bed area, and its history would span every property
  // of the customer: the cap cannot be computed for it. The sheet shows nothing and holds nothing.
  if (!svc.property_id) return { available: false, reason: PROPERTY_NEEDED, year, ingredients: [] };
  try {
    const [bedSqft, rows] = await Promise.all([
      loadBedSqft(database, svc),
      loadNeonicLedgerRows(database, svc, serviceDate),
    ]);
    return { available: true, year, bedSqft, ingredients: computeNeonicLedger({ rows, bedSqft, catalog }) };
  } catch (err) {
    // No driver message: it can echo SQL and bound values.
    logger.warn(`[ts-neonic-cap] context unavailable for ${svc.id}: ${err?.code || err?.name || 'Error'}`);
    return { available: false, reason: 'ledger_unavailable', year, ingredients: [] };
  }
}

module.exports = {
  BED_AREA_NEEDED,
  PROPERTY_NEEDED,
  tsNeonicCapLive,
  capFor,
  computeNeonicLedger,
  isTreeShrubLedgerRow,
  loadNeonicLedgerRows,
  loadBedSqft,
  buildNeonicCapContext,
};
