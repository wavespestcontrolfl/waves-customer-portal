/**
 * procurement/reorder-limit-suggestions.js — suggested reorder limits from
 * real usage. READ ONLY: it writes no product, restock request or order.
 *
 * Today every product's low_stock_threshold and reorder_quantity are typed by
 * hand, and a product without them never triggers the 6:10 AM sweep
 * (auto-reorder.js). This module computes a suggested threshold and reorder
 * amount for every active product so the owner can compare them with the
 * hand-set numbers (server/scripts/suggest-reorder-limits.js prints them).
 *
 * Daily use = the highest of:
 *   - recorded 'usage' movements over the last 8 weeks (every protocol),
 *   - the last 4 weeks of the same (catches a recent ramp),
 *   - the lawn WaveGuard forecast for the next 4 weeks / 28 (catches a ramp
 *     before it shows in history; lawn only, see waveguard-inventory-forecast).
 *
 * Threshold = lead days x daily use + safety stock, where safety stock is the
 *   larger of buffer days x daily use and (peak week - average week).
 * Reorder   = reorder days x daily use, rounded UP to whole vendor packs,
 *   at least one pack. The pack is read exactly as the dispatcher reads it
 *   (order-dispatch.vendorOrderQuantity on the eligible price row of the
 *   vendor that would fill the order), so a suggestion it cannot pack is
 *   flagged, never guessed.
 * Fertilizer with N or P in its analysis (e.g. "24-0-11"): most SW Florida
 *   counties ban it June 1 - Sept 30, so in season the reorder is capped to
 *   the whole packs used before June 1, and inside the blackout the row says
 *   hold.
 *
 * Industry basis: reorder point = daily use x lead time + safety stock, order
 * up to a few weeks of supply in whole containers (2-4 weeks on the shelf
 * with a next-day distributor).
 */
const { convertInventoryQuantity, normalizeInventoryUnit } = require('../inventory-units');
const { parsePackSize, parsePackCount, countUnitsCompatible, convertToOz } = require('../product-costing');
const { etDateString } = require('../../utils/datetime-et');
const { dateOnlyString } = require('../../utils/date-only');

const DEFAULTS = Object.freeze({
  historyDays: 56,
  recentDays: 28,
  forecastDays: 28,
  leadDays: 3,
  bufferDays: 7,
  reorderDays: 21,
});
// buildWaveGuardInventoryForecast caps its visit list at 300.
const FORECAST_VISIT_LIMIT = 300;
// The dispatcher's package math, for a vendor that orders by package.
const PACKAGE_ADAPTER = Object.freeze({ key: 'reorder-limit-report', packagedQuantity: true });

// True when the vendor's order adapter orders by item count (Sticker Mule),
// so the price row's quantity is a price tier, not a pack.
function vendorOrdersByCount(vendor) {
  if (!vendor) return false;
  const { _internals } = require('./order-dispatch');
  const key = _internals.adapterKeyFor(vendor);
  if (!key) return false;
  const adapter = require(`./adapters/${key}`);
  return adapter.packagedQuantity === false;
}

const exact = (n) => Number(Number(n).toPrecision(12));
const round4 = (n) => Math.round(n * 10000) / 10000;
const floor4 = (n) => Math.floor(exact(n * 10000)) / 10000;

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * One pack in the inventory unit, read the dispatcher's way. packRaw is the
 * eligible price row's quantity text ("2.5 gal", "10 stations"). Returns
 * { pack } or { error, message }. The dispatcher decides readability and
 * unit compatibility (bare ounces, cross-dimension, container nouns); the
 * shared product-costing parsers give the exact pack amount.
 */
function packInInventoryUnit(packRaw, inventoryUnit) {
  const unit = normalizeInventoryUnit(inventoryUnit);
  if (!String(packRaw || '').trim()) return { error: 'no_pack_size', message: 'No pack size on the price row.' };
  const { vendorOrderQuantity } = require('./order-dispatch');
  const check = vendorOrderQuantity({ adapter: PACKAGE_ADAPTER, request: { requested_quantity: 1e-6, unit }, pricing: { quantity: packRaw } });
  if (check.error) return { error: check.error, message: check.message };
  if (unit === 'each') {
    const count = parsePackCount(packRaw);
    return count && countUnitsCompatible('each', count.unit) ? { pack: count.count } : { error: 'no_pack_size', message: `Pack "${packRaw}" is not a count.` };
  }
  const parsed = parsePackSize(packRaw);
  const packOz = parsed ? convertToOz(parsed.amount, parsed.unit) : null;
  const unitOz = convertToOz(1, unit);
  return packOz && unitOz ? { pack: exact(packOz / unitOz) } : { error: 'no_pack_size', message: `Pack "${packRaw}" cannot be read.` };
}

// Nitrogen or phosphorus fertilizer: the closeout's own blackout test
// (name analysis, then catalog fertilizer_analysis / analysis_n / analysis_p).
function isBlackoutFertilizer(catalog) {
  const { productHasNpFertilizer } = require('../tree-shrub-closeout');
  return productHasNpFertilizer(typeof catalog === 'string' ? { name: catalog } : catalog || {});
}

// Days from `today` (YYYY-MM-DD, ET) to the next June 1, and whether today is
// inside June 1 - Sept 30.
function blackoutWindow(today) {
  const [y, mo, d] = today.split('-').map(Number);
  const inBlackout = mo >= 6 && mo <= 9;
  const start = Date.UTC(y, mo - 1, d);
  const june1 = Date.UTC(mo >= 6 ? y + 1 : y, 5, 1);
  return { inBlackout, daysToJune1: Math.round((june1 - start) / 86400000) };
}

// Calendar days between two YYYY-MM-DD dates (a - b).
function dateDiffDays(a, b) {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(ay, am - 1, ad) - Date.UTC(by, bm - 1, bd)) / 86400000);
}

// Weekly totals over historyDays, newest week last. `usage` = [{ daysAgo, qty }]
// with daysAgo = ET calendar days before today (0 = today).
function weeklyTotals(usage, historyDays) {
  const weeks = Math.floor(historyDays / 7);
  const totals = new Array(weeks).fill(0);
  for (const u of usage) {
    const idx = Math.floor(u.daysAgo / 7);
    if (idx >= 0 && idx < weeks) totals[weeks - 1 - idx] = exact(totals[weeks - 1 - idx] + u.qty);
  }
  return totals;
}

function dailyRate({ usage, forecastDemand, o }) {
  const sum = (days) => usage.filter((u) => u.daysAgo >= 0 && u.daysAgo < days).reduce((s, u) => s + u.qty, 0);
  const rates = [
    { basis: '8-week use', rate: sum(o.historyDays) / o.historyDays },
    { basis: '4-week use', rate: sum(o.recentDays) / o.recentDays },
  ];
  if (forecastDemand != null && forecastDemand > 0) rates.push({ basis: 'lawn schedule', rate: forecastDemand / o.forecastDays });
  return rates.reduce((a, b) => (b.rate > a.rate ? b : a));
}

// Fertilizer blackout: { hold } inside it; otherwise { usable, daysToJune1 }
// = what is used before June 1. The order is capped AFTER rounding to packs.
function blackoutLimit({ catalog, today, daily }) {
  if (!isBlackoutFertilizer(catalog)) return null;
  const { inBlackout, daysToJune1 } = blackoutWindow(today);
  if (inBlackout) return { hold: true };
  return { usable: daily * daysToJune1, daysToJune1 };
}

// Whole packs: round UP normally, DOWN under the blackout cap so the order
// never crosses June 1. The amount is the exact pack multiple, so the
// dispatcher maps it back to the same pack count.
// Whole packs, rounded UP, at least one; never above `cap` (the blackout
// room left) when one is given. The amount is floored to the catalog's 4
// decimals so the dispatcher (ceil(amount / pack)) maps it back to the same
// pack count. countOrder = the vendor orders by item count (no packs).
function packReorder({ packSize, reorderRaw, cap = null, packMessage, countOrder = false }) {
  const capped = (n) => (cap == null ? n : Math.min(n, cap));
  if (countOrder) return { reorder: Math.max(0, Math.floor(capped(Math.ceil(reorderRaw - 1e-9)) + 1e-9)), packs: null, countOrder: true };
  if (!(packSize > 0)) {
    return { reorder: Math.max(0, floor4(capped(reorderRaw))), packs: null, note: `Not rounded to whole packs: ${packMessage || 'no price row with a pack size.'}` };
  }
  let packs = Math.max(1, Math.ceil(exact(reorderRaw / packSize) - 1e-9));
  if (cap != null) packs = Math.min(packs, Math.max(0, Math.floor(exact(cap / packSize) + 1e-9)));
  return { reorder: floor4(exact(packs * packSize)), packs };
}

// Threshold and order limited to what is used before June 1, the order cut
// AFTER rounding to packs. note is set only when the cap changed something.
function capForBlackout({ blackout, threshold, packArgs, uncapped }) {
  const capThreshold = Math.min(threshold, blackout.usable);
  const packed = packReorder({ ...packArgs, cap: Math.max(0, blackout.usable - capThreshold) });
  const changed = packed.reorder < uncapped.reorder || capThreshold < threshold;
  return {
    threshold: capThreshold,
    packed,
    note: changed ? `N/P fertilizer: capped to use before June 1 (${blackout.daysToJune1} days).` : null,
  };
}

// The row when no rate can be set: no stock unit, only unconvertible rows,
// or no use at all. null when a rate exists.
function unratedResult({ base, best, unconvertedNote, o }) {
  if (!best) return { ...base, status: 'no_unit', note: ['No stock unit set; count it in a unit first.', unconvertedNote].filter(Boolean).join(' ') };
  if (best.rate > 0) return null;
  if (unconvertedNote) return { ...base, status: 'needs_unit_review', note: unconvertedNote };
  return { ...base, status: 'no_usage', note: `No use in ${o.historyDays / 7} weeks and none scheduled.` };
}

function baseRow(product) {
  const packSize = product.pack?.pack ?? null;
  return {
    productId: product.id,
    name: product.name,
    unit: product.inventoryUnit || null,
    onHand: num(product.onHand),
    currentThreshold: num(product.lowStockThreshold),
    currentReorder: num(product.reorderQuantity),
    autoReorder: Boolean(product.autoReorderEnabled),
    vendor: product.vendorName || null,
    packSize: packSize != null ? round4(packSize) : null,
    dailyUse: null,
    basis: null,
    suggestedThreshold: null,
    suggestedReorder: null,
    packs: null,
    status: 'ok',
    note: null,
  };
}

/**
 * Pure: one product in, one suggestion out.
 * product: { id, name, inventoryUnit, onHand, lowStockThreshold, reorderQuantity,
 *            autoReorderEnabled, vendorName, pack: { pack } | { error, message } | null }
 * usage: [{ daysAgo, qty }] in the inventory unit
 * forecastDemand: lawn demand over forecastDays in the inventory unit, or null
 * unconverted: usage rows + forecast visits whose unit could not be converted
 */
function unconvertedNoteFor(unconverted, unit) {
  return unconverted ? `${unconverted} usage or scheduled rows are in a unit that does not convert to ${unit || 'the stock unit'}; review units.` : null;
}

function suggestLimitsForProduct(input) {
  const { product, today } = input;
  const usage = input.usage || [];
  const o = { ...DEFAULTS, ...input.options };
  const pack = product.pack || {};
  const base = baseRow(product);
  const unconvertedNote = unconvertedNoteFor(input.unconverted, product.inventoryUnit);
  const best = product.inventoryUnit ? dailyRate({ usage, forecastDemand: input.forecastDemand, o }) : null;
  const unrated = unratedResult({ base, best, unconvertedNote, o });
  if (unrated) return unrated;

  const daily = best.rate;
  const peakWeek = Math.max(0, ...weeklyTotals(usage, o.historyDays));
  const safety = Math.max(o.bufferDays * daily, peakWeek - daily * 7);
  let threshold = o.leadDays * daily + safety;
  const reorderRaw = o.reorderDays * daily;
  let status = 'ok';
  const notes = [];

  const blackout = blackoutLimit({ catalog: product.catalog || { name: product.name }, today, daily });
  if (blackout && blackout.hold) {
    return { ...base, dailyUse: round4(daily), basis: best.basis, status: 'blackout_hold', note: 'N/P fertilizer: county blackout June 1 - Sept 30. Hold; do not reorder.' };
  }
  const packArgs = { packSize: pack.pack, reorderRaw, packMessage: pack.message, countOrder: product.countOrder };
  let packed = packReorder(packArgs);
  if (blackout) {
    const capped = capForBlackout({ blackout, threshold, packArgs, uncapped: packed });
    ({ threshold, packed } = capped);
    if (capped.note) { status = 'blackout_capped'; notes.push(capped.note); }
  }
  if (packed.packs == null && !packed.countOrder) {
    if (status === 'ok') status = 'no_pack_size';
    notes.push(packed.note);
  }
  if (unconvertedNote) notes.push(unconvertedNote);

  return {
    ...base,
    dailyUse: round4(daily),
    basis: best.basis,
    suggestedThreshold: round4(threshold),
    suggestedReorder: packed.reorder,
    packs: packed.packs,
    status,
    note: notes.length ? notes.join(' ') : null,
  };
}

// The price row whose pack the order would use: the configured vendor's
// eligible row; with no vendor configured, the eligible best-price row.
// Never another vendor's pack under the configured vendor's name.
function pickPriceRow(rows, product) {
  if (product.auto_reorder_vendor_id) {
    const own = rows.filter((r) => r.vendor_id === product.auto_reorder_vendor_id);
    return { row: own.find((r) => r.is_best_price) || own[0] || null, vendorName: product.vendor_name, vendor: { code: product.vendor_code, name: product.vendor_name } };
  }
  // No vendor set: only the catalog's current best-price winner. The catalog
  // clears the flag when prices go stale, so no winner = no pack, not a guess.
  const row = rows.find((r) => r.is_best_price) || null;
  return {
    row,
    vendorName: row ? `${row.vendor_name} (best price, no vendor set)` : null,
    vendor: row ? { code: row.vendor_code, name: row.vendor_name } : null,
  };
}

// Usage movements (one product) in its stock unit, by ET days ago.
// A visit-linked movement counts on the visit's date (a late close-out
// entered days later must not make a false peak week); others on their ET
// entry date. Rows outside the window are dropped before anything is counted.
function usageDay(m) {
  // Same order as inventory-count-guard: service record date, then the
  // scheduled date, then the ET entry date.
  return dateOnlyString(m.service_date) || dateOnlyString(m.visit_date) || etDateString(new Date(m.created_at));
}

function usageHistory(rows, unit, day, historyDays) {
  const usage = [];
  let unconverted = 0;
  let records = 0;
  for (const m of rows) {
    const daysAgo = dateDiffDays(day, usageDay(m));
    if (daysAgo < 0 || daysAgo >= historyDays) continue;
    records += 1;
    const qty = unit ? convertInventoryQuantity(Math.abs(Number(m.quantity)), m.unit, unit) : null;
    if (qty == null) { unconverted += 1; continue; }
    usage.push({ daysAgo, qty });
  }
  return { usage, unconverted, records };
}

// Lawn forecast demand (one product) in its stock unit; unit mismatches count
// as unconverted so the row is flagged, not shown as no use.
function forecastDemandFor(f, unit) {
  if (!f) return { demand: null, unconverted: 0 };
  let unconverted = Number(f.unitMismatchCount || 0);
  const qty = num(f.committedDemand);
  let demand = null;
  if (qty > 0) {
    demand = unit ? convertInventoryQuantity(qty, f.inventoryUnit || f.demandUnit, unit) : null;
    if (demand == null) unconverted += (f.appointments || []).length || 1;
  }
  return { demand, unconverted };
}

// Pack and ordering mode from the chosen price row's vendor. A count-ordering
// vendor needs stock kept in each (the dispatcher's count_unit_required).
function packFor({ row, vendorName, vendor }, unit) {
  const byCount = vendorOrdersByCount(vendor);
  if (!unit) return { vendorName, pack: null, countOrder: false };
  if (byCount && normalizeInventoryUnit(unit) !== 'each') {
    return { vendorName, countOrder: false, pack: { error: 'count_unit_required', message: `${vendor.name} orders by item count, but stock is kept in ${unit}; set the unit to each.` } };
  }
  if (byCount) return { vendorName, pack: null, countOrder: true };
  return { vendorName, pack: row ? packInInventoryUnit(row.quantity, unit) : null, countOrder: false };
}

// The dispatcher parks an order with no eligible price row or no vendor SKU
// (no_price). For a configured vendor, flag that so the suggestion is read as
// a manual order, not one the dispatcher can place.
function applyDispatchPriceCheck(suggestion, configured) {
  if (!configured || suggestion.suggestedReorder == null) return;
  const missing = !configured.row ? `no current price row from ${configured.name}` : (!configured.row.vendor_sku ? `the ${configured.name} price row has no vendor SKU` : null);
  if (!missing) return;
  if (suggestion.status === 'ok') suggestion.status = 'no_price';
  suggestion.note = [suggestion.note, `Dispatch cannot order it: ${missing}; order by hand or fix the price row.`].filter(Boolean).join(' ');
}

async function readLawnForecast(conn, o, forecast) {
  if (forecast !== undefined) return { rows: forecast || [], warning: null };
  try {
    const { buildWaveGuardInventoryForecast } = require('../waveguard-inventory-forecast');
    // The forecast counts today through today + days (days + 1 dates), so
    // ask for forecastDays - 1 to get exactly forecastDays dates.
    const result = await buildWaveGuardInventoryForecast({ days: o.forecastDays - 1, limit: FORECAST_VISIT_LIMIT, knex: conn });
    const warnings = [];
    const truncated = (result.serviceCount || 0) >= FORECAST_VISIT_LIMIT;
    if (truncated) warnings.push(`lawn forecast stopped at ${FORECAST_VISIT_LIMIT} visits, so lawn demand may read low`);
    if ((result.errors || []).length) warnings.push(`${result.errors.length} lawn visits could not be planned`);
    return { rows: result.products || [], warning: warnings.join('; ') || null, incomplete: truncated };
  } catch (err) {
    // No rows: no product's scheduled demand is known.
    return { rows: [], warning: `lawn forecast failed: ${err.message}`, incomplete: true };
  }
}

/**
 * DB read: every active product with its usage, pack size and lawn forecast.
 * `forecast` is injectable for tests; by default the lawn WaveGuard forecast
 * over forecastDays is read and a failure there only drops that signal.
 */
// Always today (ET): the movement window and the lawn forecast both read the
// live clock, so a back-dated label would mix seasons.
async function buildReorderLimitSuggestions({ knex, options = {}, forecast } = {}) {
  const conn = knex || require('../../models/db');
  const o = { ...DEFAULTS, ...options };
  const day = etDateString();
  const { eligibleVendorPricing } = require('../vendor-pricing-eligibility');

  const products = await conn('products_catalog as pc')
    .leftJoin('vendors as v', 'v.id', 'pc.auto_reorder_vendor_id')
    .where('pc.active', true)
    .select(
      'pc.id', 'pc.name', 'pc.inventory_unit', 'pc.inventory_on_hand', 'pc.low_stock_threshold',
      'pc.reorder_quantity', 'pc.auto_reorder_enabled', 'pc.auto_reorder_vendor_id',
      'pc.category', 'pc.product_type', 'pc.fertilizer_analysis', 'pc.analysis_n', 'pc.analysis_p',
      'v.name as vendor_name', 'v.code as vendor_code',
    )
    .orderBy('pc.name');

  const ids = products.map((p) => p.id);
  // One extra day so the oldest ET calendar day is whole; rows are bucketed
  // by their ET date below and anything older is ignored.
  const since = new Date(Date.now() - (o.historyDays + 2) * 86400000);
  const movements = ids.length
    ? await conn('product_inventory_movements as pim')
      .leftJoin('scheduled_services as ss', 'ss.id', 'pim.scheduled_service_id')
      .leftJoin('service_records as sr', 'sr.id', 'pim.service_record_id')
      .whereIn('pim.product_id', ids)
      .where('pim.movement_type', 'usage')
      .where('pim.created_at', '>=', since)
      .select('pim.product_id', 'pim.quantity', 'pim.unit', 'pim.created_at', 'ss.scheduled_date as visit_date', 'sr.service_date')
    : [];
  const pricing = ids.length
    ? await eligibleVendorPricing(
      conn('vendor_pricing').leftJoin('vendors as pv', 'pv.id', 'vendor_pricing.vendor_id').whereIn('vendor_pricing.product_id', ids),
    ).select('vendor_pricing.product_id', 'vendor_pricing.vendor_id', 'vendor_pricing.quantity', 'vendor_pricing.is_best_price', 'vendor_pricing.vendor_sku', 'pv.name as vendor_name', 'pv.code as vendor_code')
    : [];

  const lawn = await readLawnForecast(conn, o, forecast);
  const forecastByProduct = new Map((lawn.rows || []).map((row) => [String(row.productId), row]));

  const rows = products.map((p) => {
    const unit = p.inventory_unit;
    const history = usageHistory(movements.filter((m) => m.product_id === p.id), unit, day, o.historyDays);
    const f = forecastByProduct.get(String(p.id));
    const lawnDemand = forecastDemandFor(f, unit);
    const unconverted = history.unconverted + lawnDemand.unconverted;
    const usage = history.usage;
    const usageRecords = history.records;
    const forecastDemand = lawnDemand.demand;
    const picked = pickPriceRow(pricing.filter((r) => r.product_id === p.id), p);
    const pickedVendor = p.auto_reorder_vendor_id ? { name: p.vendor_name, row: picked.row } : null;
    const { vendorName, pack, countOrder } = packFor(picked, unit);
    const suggestion = suggestLimitsForProduct({
      product: {
        id: p.id,
        name: p.name,
        inventoryUnit: unit,
        onHand: p.inventory_on_hand,
        lowStockThreshold: p.low_stock_threshold,
        reorderQuantity: p.reorder_quantity,
        autoReorderEnabled: p.auto_reorder_enabled,
        vendorName,
        pack,
        countOrder,
        catalog: { name: p.name, category: p.category, product_type: p.product_type, fertilizer_analysis: p.fertilizer_analysis, analysis_n: p.analysis_n, analysis_p: p.analysis_p },
      },
      usage,
      forecastDemand,
      unconverted,
      today: day,
      options: o,
    });
    suggestion.usageRecords = usageRecords + (f ? 1 : 0);
    if (f && lawn.warning) suggestion.note = [suggestion.note, `Lawn schedule incomplete: ${lawn.warning}.`].filter(Boolean).join(' ');
    // Failed or cut-off forecast: "none scheduled" is not known, so the row
    // stays visible as unknown demand instead of hiding as no use.
    if (lawn.incomplete && suggestion.status === 'no_usage') {
      suggestion.status = 'demand_unknown';
      suggestion.note = `No use in ${o.historyDays / 7} weeks; scheduled lawn demand unknown (${lawn.warning}).`;
    }
    applyDispatchPriceCheck(suggestion, pickedVendor);
    return suggestion;
  });

  return { today: day, options: o, forecastError: lawn.warning, products: rows };
}

module.exports = {
  DEFAULTS,
  packInInventoryUnit,
  packReorder,
  usageHistory,
  isBlackoutFertilizer,
  blackoutWindow,
  weeklyTotals,
  suggestLimitsForProduct,
  pickPriceRow,
  applyDispatchPriceCheck,
  buildReorderLimitSuggestions,
};
