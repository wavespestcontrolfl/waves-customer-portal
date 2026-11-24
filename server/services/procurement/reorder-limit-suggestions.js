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

const exact = (n) => Number(Number(n).toPrecision(12));
const round4 = (n) => Math.round(n * 10000) / 10000;

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

// N-P-K analysis with nitrogen or phosphorus above zero.
function isBlackoutFertilizer(name) {
  const m = String(name || '').match(/\b(\d{1,2})-(\d{1,2})-(\d{1,2})\b/);
  return Boolean(m && (Number(m[1]) > 0 || Number(m[2]) > 0));
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

// Fertilizer blackout: { hold } inside it, else the threshold and raw reorder
// capped to what is used before June 1, and the pack count rounded DOWN.
function applyBlackout({ name, today, daily, threshold, reorderRaw }) {
  if (!isBlackoutFertilizer(name)) return null;
  const { inBlackout, daysToJune1 } = blackoutWindow(today);
  if (inBlackout) return { hold: true };
  const usable = daily * daysToJune1;
  if (usable >= threshold + reorderRaw) return null;
  return {
    threshold: Math.min(threshold, usable),
    reorderRaw: Math.max(0, usable - threshold),
    note: `N/P fertilizer: capped to use before June 1 (${daysToJune1} days).`,
  };
}

// Whole packs: round UP normally, DOWN under the blackout cap so the order
// never crosses June 1. The amount is the exact pack multiple, so the
// dispatcher maps it back to the same pack count.
function packReorder({ packSize, reorderRaw, capped, packMessage }) {
  if (!(packSize > 0)) {
    return { reorder: round4(reorderRaw), packs: null, note: `Not rounded to whole packs: ${packMessage || 'no price row with a pack size.'}` };
  }
  const ratio = exact(reorderRaw / packSize);
  const packs = capped ? Math.floor(ratio + 1e-9) : Math.max(1, Math.ceil(ratio - 1e-9));
  return { reorder: exact(packs * packSize), packs };
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
function suggestLimitsForProduct({ product, usage = [], forecastDemand = null, unconverted = 0, today, options = {} }) {
  const o = { ...DEFAULTS, ...options };
  const packSize = product.pack?.pack ?? null;
  const base = baseRow(product);
  const unconvertedNote = unconverted ? `${unconverted} usage or scheduled rows are in a unit that does not convert to ${product.inventoryUnit || 'the stock unit'}; review units.` : null;
  if (!product.inventoryUnit) return { ...base, status: 'no_unit', note: ['No stock unit set; count it in a unit first.', unconvertedNote].filter(Boolean).join(' ') };

  const best = dailyRate({ usage, forecastDemand, o });
  if (!(best.rate > 0)) {
    if (unconverted) return { ...base, status: 'needs_unit_review', note: unconvertedNote };
    return { ...base, status: 'no_usage', note: `No use in ${o.historyDays / 7} weeks and none scheduled.` };
  }

  const daily = best.rate;
  const peakWeek = Math.max(0, ...weeklyTotals(usage, o.historyDays));
  const safety = Math.max(o.bufferDays * daily, peakWeek - daily * 7);
  let threshold = o.leadDays * daily + safety;
  let reorderRaw = o.reorderDays * daily;
  let status = 'ok';
  const notes = [];

  const blackout = applyBlackout({ name: product.name, today, daily, threshold, reorderRaw });
  if (blackout?.hold) {
    return { ...base, dailyUse: round4(daily), basis: best.basis, status: 'blackout_hold', note: 'N/P fertilizer: county blackout June 1 - Sept 30. Hold; do not reorder.' };
  }
  if (blackout) {
    ({ threshold, reorderRaw } = blackout);
    status = 'blackout_capped';
    notes.push(blackout.note);
  }

  const packed = packReorder({ packSize, reorderRaw, capped: Boolean(blackout), packMessage: product.pack?.message });
  if (packed.packs == null) {
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
    return { row: own.find((r) => r.is_best_price) || own[0] || null, vendorName: product.vendor_name };
  }
  const row = rows.find((r) => r.is_best_price) || rows[0] || null;
  return { row, vendorName: row ? `${row.vendor_name} (best price, no vendor set)` : null };
}

async function readLawnForecast(conn, o, forecast) {
  if (forecast !== undefined) return { rows: forecast || [], warning: null };
  try {
    const { buildWaveGuardInventoryForecast } = require('../waveguard-inventory-forecast');
    const result = await buildWaveGuardInventoryForecast({ days: o.forecastDays, limit: FORECAST_VISIT_LIMIT, knex: conn });
    const warnings = [];
    if ((result.serviceCount || 0) >= FORECAST_VISIT_LIMIT) warnings.push(`lawn forecast stopped at ${FORECAST_VISIT_LIMIT} visits, so lawn demand may read low`);
    if ((result.errors || []).length) warnings.push(`${result.errors.length} lawn visits could not be planned`);
    return { rows: result.products || [], warning: warnings.join('; ') || null };
  } catch (err) {
    return { rows: [], warning: `lawn forecast failed: ${err.message}` };
  }
}

/**
 * DB read: every active product with its usage, pack size and lawn forecast.
 * `forecast` is injectable for tests; by default the lawn WaveGuard forecast
 * over forecastDays is read and a failure there only drops that signal.
 */
async function buildReorderLimitSuggestions({ knex, today, options = {}, forecast } = {}) {
  const conn = knex || require('../../models/db');
  const o = { ...DEFAULTS, ...options };
  const day = today || etDateString();
  const { eligibleVendorPricing } = require('../vendor-pricing-eligibility');

  const products = await conn('products_catalog as pc')
    .leftJoin('vendors as v', 'v.id', 'pc.auto_reorder_vendor_id')
    .where('pc.active', true)
    .select(
      'pc.id', 'pc.name', 'pc.inventory_unit', 'pc.inventory_on_hand', 'pc.low_stock_threshold',
      'pc.reorder_quantity', 'pc.auto_reorder_enabled', 'pc.auto_reorder_vendor_id',
      'v.name as vendor_name',
    )
    .orderBy('pc.name');

  const ids = products.map((p) => p.id);
  // One extra day so the oldest ET calendar day is whole; rows are bucketed
  // by their ET date below and anything older is ignored.
  const since = new Date(Date.now() - (o.historyDays + 2) * 86400000);
  const movements = ids.length
    ? await conn('product_inventory_movements')
      .whereIn('product_id', ids)
      .where('movement_type', 'usage')
      .where('created_at', '>=', since)
      .select('product_id', 'quantity', 'unit', 'created_at')
    : [];
  const pricing = ids.length
    ? await eligibleVendorPricing(
      conn('vendor_pricing').leftJoin('vendors as pv', 'pv.id', 'vendor_pricing.vendor_id').whereIn('vendor_pricing.product_id', ids),
    ).select('vendor_pricing.product_id', 'vendor_pricing.vendor_id', 'vendor_pricing.quantity', 'vendor_pricing.is_best_price', 'pv.name as vendor_name')
    : [];

  const lawn = await readLawnForecast(conn, o, forecast);
  const forecastByProduct = new Map((lawn.rows || []).map((row) => [String(row.productId), row]));

  const rows = products.map((p) => {
    const unit = p.inventory_unit;
    const usage = [];
    let unconverted = 0;
    let usageRecords = 0;
    for (const m of movements) {
      if (m.product_id !== p.id) continue;
      usageRecords += 1;
      const qty = unit ? convertInventoryQuantity(Math.abs(Number(m.quantity)), m.unit, unit) : null;
      if (qty == null) { unconverted += 1; continue; }
      usage.push({ daysAgo: dateDiffDays(day, etDateString(new Date(m.created_at))), qty });
    }
    const f = forecastByProduct.get(String(p.id));
    let forecastDemand = null;
    if (f) {
      unconverted += Number(f.unitMismatchCount || 0);
      const qty = num(f.committedDemand);
      if (qty > 0) {
        forecastDemand = unit ? convertInventoryQuantity(qty, f.inventoryUnit || f.demandUnit, unit) : null;
        if (forecastDemand == null) unconverted += (f.appointments || []).length || 1;
      }
    }
    const { row: priceRow, vendorName } = pickPriceRow(pricing.filter((r) => r.product_id === p.id), p);
    const pack = unit && priceRow ? packInInventoryUnit(priceRow.quantity, unit) : null;
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
      },
      usage,
      forecastDemand,
      unconverted,
      today: day,
      options: o,
    });
    suggestion.usageRecords = usageRecords + (f ? 1 : 0);
    if (f && lawn.warning) suggestion.note = [suggestion.note, `Lawn schedule incomplete: ${lawn.warning}.`].filter(Boolean).join(' ');
    return suggestion;
  });

  return { today: day, options: o, forecastError: lawn.warning, products: rows };
}

module.exports = {
  DEFAULTS,
  packInInventoryUnit,
  isBlackoutFertilizer,
  blackoutWindow,
  weeklyTotals,
  suggestLimitsForProduct,
  pickPriceRow,
  buildReorderLimitSuggestions,
};
