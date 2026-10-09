/**
 * Tree & Shrub neonicotinoid yearly cap, per property (GATE_TS_NEONIC_CAP, owner 2026-10-09).
 *
 * The label caps live in config/tree-shrub-neonic-caps.js (per acre per year, in each product's
 * unit). This file scales them to the property's bed area, adds up what the property's Tree &
 * Shrub visits already put down this calendar year (property_application_history), and answers
 * two readers: the Fast Complete sheet (how much is left) and /complete (a completion whose
 * entered amounts would pass the cap is refused before any write).
 *
 * Products that share an active ingredient share one cap: an application is a share of its own
 * product's yearly amount, and a year's shares add up to 1. A ledger row that cannot be sized
 * (no quantity, a unit that does not convert, an imidacloprid or dinotefuran product with no
 * strength in the config) is counted in `unsized` and named, never counted as nothing in silence.
 * No usable bed area: the cap cannot be computed, the answer says so and nothing is blocked.
 */
const db = require('../models/db');
const logger = require('./logger');
const { convertInventoryQuantity, baseQuantityUnit } = require('./inventory-units');
const { NEONIC_CAPS, SQFT_PER_ACRE } = require('../config/tree-shrub-neonic-caps');
const { detectServiceLine } = require('./service-report/service-line-configs');
const { etCalendarDayOf } = require('../utils/datetime-et');

const CODE = 'tree_shrub_neonic_cap_exceeded';
const UNAVAILABLE_CODE = 'tree_shrub_neonic_cap_unavailable';
const BED_AREA_NEEDED = 'bed_area_needed';
// Shares are floats of a ratio; a hair of slack keeps an amount that lands exactly on the cap legal.
const SHARE_EPSILON = 1e-9;

function tsNeonicCapLive() {
  const gates = require('../config/feature-gates');
  return typeof gates.tsNeonicCapLive === 'function' && gates.tsNeonicCapLive() === true;
}

const UNSIZED_CODE = 'tree_shrub_neonic_cap_amount_needed';
const idOf = (value) => String(value ?? '').trim().toLowerCase();
const unitWords = (unit) => (unit === 'fl_oz' ? 'fl oz' : unit);
const round4 = (n) => Math.round(n * 10000) / 10000;
const positive = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};

// The cap a product (catalog row, or a ledger row's recorded name and ingredient) falls under:
// { cap, entry }. `entry` is null for an ingredient with no strength in the config for this name.
function capFor(name, activeIngredient) {
  const ai = String(activeIngredient || '').trim().toLowerCase();
  const cap = ai ? NEONIC_CAPS.find((c) => ai.startsWith(c.activeIngredientPrefix)) : null;
  if (!cap) return null;
  const label = String(name || '').trim();
  return { cap, entry: cap.products.find((p) => p.namePattern.test(label)) || null };
}

const yearlyAmountFor = (entry, bedSqft) => round4((entry.perAcreYear * bedSqft) / SQFT_PER_ACRE);

/**
 * Pure. `rows` are this property's Tree & Shrub ledger rows for the year ({ product_name,
 * active_ingredient, quantity_applied, quantity_unit }), `catalog` the products to report a
 * remaining amount for ({ id, name, active_ingredient }). One entry per cap:
 * { key, label, usedShare, capByProduct: [{ productId, name, unit, yearlyAmount, remainingAmount }],
 *   unsized, reason }. usedShare and the amounts are null with reason 'bed_area_needed'.
 */
function computeNeonicLedger({ rows = [], bedSqft = null, catalog = [] } = {}) {
  const area = positive(bedSqft);
  return NEONIC_CAPS.map((cap) => {
    let usedShare = 0;
    let unsized = 0;
    for (const row of rows) {
      const found = capFor(row.product_name, row.active_ingredient);
      if (!found || found.cap !== cap) continue;
      const quantity = found.entry && convertInventoryQuantity(row.quantity_applied, row.quantity_unit, found.entry.unit);
      if (!quantity) { unsized += 1; continue; }
      if (area) usedShare += quantity / yearlyAmountFor(found.entry, area);
    }
    const capByProduct = [];
    for (const product of catalog) {
      const found = capFor(product.name, product.active_ingredient);
      if (!found || found.cap !== cap || !found.entry) continue;
      const yearlyAmount = area ? yearlyAmountFor(found.entry, area) : null;
      capByProduct.push({
        productId: product.id,
        name: found.entry.shortName,
        unit: found.entry.unit,
        yearlyAmount,
        remainingAmount: area ? round4(Math.max(0, 1 - usedShare) * yearlyAmount) : null,
      });
    }
    return {
      key: cap.key,
      label: cap.label,
      // Unrounded: a rounded share could tip an amount that lands exactly on the cap over it.
      usedShare: area ? usedShare : null,
      capByProduct,
      unsized,
      reason: area ? null : BED_AREA_NEEDED,
    };
  });
}

// A Tree & Shrub ledger row: the service record that wrote it is a tree & shrub visit. A lawn
// visit's imidacloprid is another treated area and never counts against the bed cap. A row with
// no service record cannot be tied to a visit, so it is out. `service_line` is the record's own
// column; an older record without one is read from its service type.
function isTreeShrubLedgerRow(row) {
  const line = row.service_line || (row.service_type ? detectServiceLine(row.service_type) : null);
  return line === 'tree_shrub';
}

/**
 * This property's Tree & Shrub neonicotinoid applications in the calendar year of `serviceDate`
 * (ET), retracted rows out, the visit being completed left out. Property scope is the one every
 * per-property cap reader uses (application-limits scopeHistoryToTreatment).
 */
async function loadNeonicLedgerRows(database, svc, serviceDate) {
  const { scopeHistoryToTreatment } = require('./application-limits');
  const year = String(etCalendarDayOf(serviceDate)).slice(0, 4);
  const query = database('property_application_history as pah')
    .leftJoin('products_catalog as pc', 'pc.id', 'pah.product_id')
    .leftJoin('service_products as sp', 'sp.id', 'pah.service_product_id')
    .join('service_records as sr', 'sr.id', 'pah.service_record_id')
    .where('pah.customer_id', svc.customer_id)
    .whereNull('pah.retracted_at')
    .where('pah.application_date', '>=', `${year}-01-01`)
    .where('pah.application_date', '<=', `${year}-12-31`)
    .where(function dinotefuranOrImidacloprid() {
      for (const cap of NEONIC_CAPS) {
        const like = `${cap.activeIngredientPrefix}%`;
        this.orWhereRaw('COALESCE(pc.active_ingredient, sp.active_ingredient, pah.active_ingredient) ILIKE ?', [like]);
      }
    });
  scopeHistoryToTreatment(query, database, { propertyId: svc.property_id || null, excludeScheduledServiceId: svc.id }, 'pah');
  const rows = await query.select(
    'pah.quantity_applied', 'pah.quantity_unit',
    database.raw('COALESCE(pc.name, sp.product_name) as product_name'),
    database.raw('COALESCE(pc.active_ingredient, sp.active_ingredient, pah.active_ingredient) as active_ingredient'),
    'sr.service_line', 'sr.service_type',
  );
  return rows.filter(isTreeShrubLedgerRow);
}

// The property's ornamental bed area. A visit with a property reads that property's own figure
// (a null there is a null: the customer row mirrors only the primary property); a visit with no
// property link reads the customer's.
async function loadBedSqft(database, svc) {
  if (svc.property_id) {
    const property = await database('customer_properties').where({ id: svc.property_id }).first('bed_sqft');
    return positive(property?.bed_sqft);
  }
  const customer = await database('customers').where({ id: svc.customer_id }).first('bed_sqft');
  return positive(customer?.bed_sqft);
}

/**
 * The fast-context `neonicCap` block: { year, bedSqft, ingredients } with a remaining amount for
 * every capped catalog product, or { available: false, reason } when the read failed (the sheet
 * then shows nothing and blocks nothing). `catalog` is the sheet's catalog list.
 */
async function buildNeonicCapContext(svc, serviceDate, catalog, database = db) {
  const year = Number(String(etCalendarDayOf(serviceDate)).slice(0, 4));
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

// An amount typed or left: one decimal from 1 up, two below. The entered amount rounds up and what
// is left rounds down, so the message never understates the overage.
const decimals = (n) => (n >= 1 ? 1 : 2);
const fmtEntered = (n) => (Math.ceil(n * 10 ** decimals(n) - 1e-9) / 10 ** decimals(n)).toFixed(decimals(n));
const fmtLeft = (n) => (Math.floor(n * 10 ** decimals(n) + 1e-9) / 10 ** decimals(n)).toFixed(decimals(n));

/**
 * The /complete check. `products` are the submitted rows ({ productId, totalAmount, amountUnit }).
 * Returns the blocks to refuse with ([] = may go on): one per capped submitted row when the
 * property's year so far plus this visit's rows pass an ingredient's cap. Gate off, no capped
 * product with an amount, or no bed area: [] and no ledger read. A failed read throws; the
 * caller refuses with 503 (a label limit is not skipped on a transient error).
 */
async function treeShrubNeonicCapBlocks(database, svc, products, { serviceDate = svc.scheduled_date } = {}) {
  if (!tsNeonicCapLive() || !Array.isArray(products) || !products.length) return [];
  const { savepointRead } = require('../utils/savepoint-read');
  // Every submitted product row, with or without an amount: a capped row that cannot be sized is
  // refused below, never skipped. Ids compare in one case (the writer accepts either).
  const submitted = products.filter((p) => p && p.productId).map((p) => ({ ...p, productId: idOf(p.productId) }));
  if (!submitted.length) return [];
  const catalog = await savepointRead(database, (k) => k('products_catalog')
    .whereIn('id', [...new Set(submitted.map((p) => p.productId))]).select('id', 'name', 'active_ingredient'));
  const capped = catalog.filter((c) => capFor(c.name, c.active_ingredient)?.entry);
  if (!capped.length) return [];
  const bedSqft = await savepointRead(database, (k) => loadBedSqft(k, svc));
  if (!bedSqft) {
    logger.info(`[ts-neonic-cap] ${svc.id}: no bed area, cap not checked`);
    return [];
  }
  const rows = await savepointRead(database, (k) => loadNeonicLedgerRows(k, svc, serviceDate));
  const ledger = computeNeonicLedger({ rows, bedSqft, catalog: capped });
  return neonicCapBlocks({ ledger, rows: submitted.map((p) => ({ ...p, unit: baseQuantityUnit(p.amountUnit || p.rateUnit || null) })) });
}

// Pure. The blocks for submitted rows ({ productId, totalAmount, unit }) against a computed ledger.
function neonicCapBlocks({ ledger, rows }) {
  const blocks = [];
  for (const ingredient of ledger) {
    const lines = [];
    for (const row of rows) {
      const product = ingredient.capByProduct.find((p) => idOf(p.productId) === idOf(row.productId));
      if (!product?.yearlyAmount) continue;
      const amount = positive(row.totalAmount) && convertInventoryQuantity(row.totalAmount, row.unit, product.unit);
      // A capped row with no amount, or one in a unit that does not convert ("each"), cannot be
      // checked: refuse it rather than let it through unchecked.
      if (!amount) {
        blocks.push({
          code: UNSIZED_CODE,
          productId: row.productId,
          message: `${product.name}: enter the amount in ${unitWords(product.unit)} so the yearly limit can be checked.`,
        });
        continue;
      }
      lines.push({ row, product, amount, share: amount / product.yearlyAmount });
    }
    const total = (ingredient.usedShare || 0) + lines.reduce((sum, line) => sum + line.share, 0);
    if (total <= 1 + SHARE_EPSILON) continue;
    for (const line of lines) {
      const otherShare = total - (ingredient.usedShare || 0) - line.share;
      const left = Math.max(0, 1 - (ingredient.usedShare || 0) - otherShare) * line.product.yearlyAmount;
      const unit = unitWords(line.product.unit);
      blocks.push({
        code: CODE,
        productId: line.row.productId,
        message: `${line.product.name}: ${fmtEntered(line.amount)} ${unit} is over the ${fmtLeft(left)} ${unit} left this year for this property.`,
      });
    }
  }
  return blocks;
}

// The 400 body a completion over the cap returns. `error` is what the technician reads, so it
// carries the amounts; `details` and `blocks` are the same lines for a caller that wants them apart.
function neonicCapBlockPayload(blocks) {
  return {
    error: blocks.map((block) => block.message).join(' '),
    code: blocks.some((block) => block.code === CODE) ? CODE : blocks[0].code,
    details: blocks.map((block) => block.message),
    blocks,
  };
}

module.exports = {
  CODE,
  UNSIZED_CODE,
  UNAVAILABLE_CODE,
  BED_AREA_NEEDED,
  tsNeonicCapLive,
  capFor,
  computeNeonicLedger,
  neonicCapBlocks,
  isTreeShrubLedgerRow,
  loadNeonicLedgerRows,
  loadBedSqft,
  buildNeonicCapContext,
  treeShrubNeonicCapBlocks,
  neonicCapBlockPayload,
};
