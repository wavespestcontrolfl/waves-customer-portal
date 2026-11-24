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
 *   at least one pack.
 * Fertilizer with N or P in its analysis (e.g. "24-0-11"): most SW Florida
 *   counties ban it June 1 - Sept 30, so in season the reorder is capped to
 *   what is used before June 1, and inside the blackout the row says hold.
 *
 * Industry basis: reorder point = daily use x lead time + safety stock, order
 * up to a few weeks of supply in whole containers (2-4 weeks on the shelf
 * with a next-day distributor).
 */
const { convertInventoryQuantity, normalizeInventoryUnit } = require('../inventory-units');

const DEFAULTS = Object.freeze({
  historyDays: 56,
  recentDays: 28,
  forecastDays: 28,
  leadDays: 3,
  bufferDays: 7,
  reorderDays: 21,
});

const exact = (n) => Number(Number(n).toPrecision(12));
const round2 = (n) => Math.round(n * 100) / 100;
const round4 = (n) => Math.round(n * 10000) / 10000;

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// "2.5 gal", "78 fl oz", "50 lb", "1 gallon", "10 oz bottle". Returns
// { amount, unit } or null. Multi-pack text ("4 x 1 gal", "case of 4") is
// left unread on purpose: a wrong case size would over-order.
function parsePackText(text) {
  const raw = String(text || '').trim().toLowerCase();
  if (!raw || /\bx\b|case|pack of|\//.test(raw)) return null;
  const m = raw.match(/^(\d+(?:\.\d+)?)\s*(fl\.?\s*oz|fluid ounces?|gal(?:lons?)?|qts?|quarts?|pts?|pints?|ml|l|liters?|oz|ounces?|lbs?|pounds?|g|grams?|kg|each|ea|ct|count)\b/);
  if (!m) return null;
  let unit = m[2].replace(/\./g, '').replace(/\s+/g, ' ');
  if (/^fl ?oz|^fluid/.test(unit)) unit = 'fl_oz';
  else if (/^gal/.test(unit)) unit = 'gal';
  else if (/^q/.test(unit)) unit = 'qt';
  else if (/^p(?!ound)/.test(unit)) unit = 'pt';
  else if (/^lit/.test(unit)) unit = 'l';
  else if (/^lb|^pound/.test(unit)) unit = 'lb';
  else if (/^gram/.test(unit)) unit = 'g';
  else if (/^ounce/.test(unit)) unit = 'oz';
  else if (/^(ea|ct|count)$/.test(unit)) unit = 'each';
  return { amount: Number(m[1]), unit };
}

// One pack of the product, in its inventory unit. Vendor row (quantity +
// unit) first, then the catalog container_size. null when unreadable.
function packSizeInInventoryUnit({ inventoryUnit, vendorQuantity, vendorUnit, containerSize }) {
  const candidates = [];
  const q = num(vendorQuantity);
  if (q != null && q > 0 && vendorUnit) candidates.push({ amount: q, unit: vendorUnit });
  else if (vendorQuantity) {
    const parsed = parsePackText(`${vendorQuantity} ${vendorUnit || ''}`);
    if (parsed) candidates.push(parsed);
  }
  const fromContainer = parsePackText(containerSize);
  if (fromContainer) candidates.push(fromContainer);
  for (const c of candidates) {
    const converted = convertInventoryQuantity(c.amount, c.unit, inventoryUnit);
    if (converted != null && converted > 0) return converted;
  }
  return null;
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

// Weekly totals over historyDays, newest week last. `usage` = [{ day, qty }]
// with day = days ago (0 = today). Partial weeks are dropped.
function weeklyTotals(usage, historyDays) {
  const weeks = Math.floor(historyDays / 7);
  const totals = new Array(weeks).fill(0);
  for (const u of usage) {
    const idx = Math.floor(u.daysAgo / 7);
    if (idx >= 0 && idx < weeks) totals[weeks - 1 - idx] = exact(totals[weeks - 1 - idx] + u.qty);
  }
  return totals;
}

/**
 * Pure: one product in, one suggestion out.
 * product: { id, name, inventoryUnit, onHand, lowStockThreshold, reorderQuantity,
 *            autoReorderEnabled, vendorName, packSize }
 * usage: [{ daysAgo, qty }] in the inventory unit
 * forecastDemand: lawn demand over forecastDays in the inventory unit, or null
 */
function suggestLimitsForProduct({ product, usage = [], forecastDemand = null, today, options = {} }) {
  const o = { ...DEFAULTS, ...options };
  const base = {
    productId: product.id,
    name: product.name,
    unit: product.inventoryUnit || null,
    onHand: num(product.onHand),
    currentThreshold: num(product.lowStockThreshold),
    currentReorder: num(product.reorderQuantity),
    autoReorder: Boolean(product.autoReorderEnabled),
    vendor: product.vendorName || null,
    packSize: product.packSize != null ? round2(product.packSize) : null,
    dailyUse: null,
    basis: null,
    suggestedThreshold: null,
    suggestedReorder: null,
    status: 'ok',
    note: null,
  };
  if (!product.inventoryUnit) return { ...base, status: 'no_unit', note: 'No stock unit set; count it in a unit first.' };

  const historyTotal = usage.filter((u) => u.daysAgo < o.historyDays).reduce((s, u) => s + u.qty, 0);
  const recentTotal = usage.filter((u) => u.daysAgo < o.recentDays).reduce((s, u) => s + u.qty, 0);
  const rates = [
    { basis: '8-week use', rate: historyTotal / o.historyDays },
    { basis: '4-week use', rate: recentTotal / o.recentDays },
  ];
  if (forecastDemand != null && forecastDemand > 0) rates.push({ basis: 'lawn schedule', rate: forecastDemand / o.forecastDays });
  const best = rates.reduce((a, b) => (b.rate > a.rate ? b : a));
  if (!(best.rate > 0)) return { ...base, status: 'no_usage', note: `No use in ${o.historyDays / 7} weeks and none scheduled.` };

  const daily = best.rate;
  const weeks = weeklyTotals(usage, o.historyDays);
  const avgWeek = daily * 7;
  const peakWeek = Math.max(0, ...weeks);
  const safety = Math.max(o.bufferDays * daily, peakWeek - avgWeek);
  let threshold = o.leadDays * daily + safety;
  let reorderRaw = o.reorderDays * daily;
  let status = 'ok';
  let note = null;

  if (isBlackoutFertilizer(product.name)) {
    const { inBlackout, daysToJune1 } = blackoutWindow(today);
    if (inBlackout) {
      return { ...base, dailyUse: round4(daily), basis: best.basis, status: 'blackout_hold', note: 'N/P fertilizer: county blackout June 1 - Sept 30. Hold; do not reorder.' };
    }
    const usableBeforeJune = daily * daysToJune1;
    if (usableBeforeJune < threshold + reorderRaw) {
      reorderRaw = Math.max(0, usableBeforeJune - threshold);
      threshold = Math.min(threshold, usableBeforeJune);
      status = 'blackout_capped';
      note = `N/P fertilizer: capped to use before June 1 (${daysToJune1} days).`;
    }
  }

  let reorder;
  if (product.packSize && product.packSize > 0) {
    reorder = reorderRaw > 0 ? Math.max(1, Math.ceil(exact(reorderRaw / product.packSize))) * product.packSize : 0;
  } else {
    reorder = reorderRaw;
    status = status === 'ok' ? 'no_pack_size' : status;
    note = note || 'Pack size unreadable; reorder amount is not rounded to whole packs.';
  }

  return {
    ...base,
    dailyUse: round4(daily),
    basis: best.basis,
    suggestedThreshold: round2(threshold),
    suggestedReorder: round2(reorder),
    status,
    note,
  };
}

function daysBetween(today, date) {
  const [y, m, d] = today.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d);
  const dt = new Date(date);
  const et = Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate());
  return Math.max(0, Math.floor((t - et) / 86400000));
}

/**
 * DB read: every active product with its usage, pack size and lawn forecast.
 * `forecast` is injectable for tests; by default the lawn WaveGuard forecast
 * over forecastDays is read and a failure there only drops that signal.
 */
async function buildReorderLimitSuggestions({ knex, today, options = {}, forecast } = {}) {
  const conn = knex || require('../../models/db');
  const o = { ...DEFAULTS, ...options };
  const { etDateString } = require('../../utils/datetime-et');
  const day = today || etDateString();

  const products = await conn('products_catalog as pc')
    .leftJoin('vendors as v', 'v.id', 'pc.auto_reorder_vendor_id')
    .where('pc.active', true)
    .select(
      'pc.id', 'pc.name', 'pc.inventory_unit', 'pc.inventory_on_hand', 'pc.low_stock_threshold',
      'pc.reorder_quantity', 'pc.auto_reorder_enabled', 'pc.auto_reorder_vendor_id', 'pc.container_size',
      'v.name as vendor_name',
    )
    .orderBy('pc.name');

  const ids = products.map((p) => p.id);
  const since = new Date(Date.now() - (o.historyDays + 1) * 86400000);
  const movements = ids.length
    ? await conn('product_inventory_movements')
      .whereIn('product_id', ids)
      .where('movement_type', 'usage')
      .where('created_at', '>=', since)
      .select('product_id', 'quantity', 'unit', 'created_at')
    : [];
  const pricing = ids.length
    ? await conn('vendor_pricing').whereIn('product_id', ids).select('product_id', 'vendor_id', 'quantity', 'unit', 'is_best_price')
    : [];

  let forecastRows = forecast;
  let forecastError = null;
  if (forecastRows === undefined) {
    try {
      const { buildWaveGuardInventoryForecast } = require('../waveguard-inventory-forecast');
      const result = await buildWaveGuardInventoryForecast({ days: o.forecastDays, limit: 300, knex: conn });
      forecastRows = result.products || [];
      if ((result.errors || []).length) forecastError = `${result.errors.length} lawn visits could not be planned`;
    } catch (err) {
      forecastRows = [];
      forecastError = err.message;
    }
  }
  const forecastByProduct = new Map();
  for (const row of forecastRows || []) {
    const qty = num(row.committedDemand);
    if (qty != null) forecastByProduct.set(String(row.productId), { qty, unit: row.inventoryUnit || row.demandUnit });
  }

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
      usage.push({ daysAgo: daysBetween(day, m.created_at), qty });
    }
    const vendorRows = pricing.filter((r) => r.product_id === p.id);
    const vendorRow = vendorRows.find((r) => p.auto_reorder_vendor_id && r.vendor_id === p.auto_reorder_vendor_id)
      || vendorRows.find((r) => r.is_best_price)
      || vendorRows[0];
    const packSize = unit ? packSizeInInventoryUnit({
      inventoryUnit: unit,
      vendorQuantity: vendorRow?.quantity,
      vendorUnit: vendorRow?.unit,
      containerSize: p.container_size,
    }) : null;
    const f = forecastByProduct.get(String(p.id));
    const forecastDemand = f && unit && normalizeInventoryUnit(f.unit) ? convertInventoryQuantity(f.qty, f.unit, unit) : null;
    const suggestion = suggestLimitsForProduct({
      product: {
        id: p.id,
        name: p.name,
        inventoryUnit: unit,
        onHand: p.inventory_on_hand,
        lowStockThreshold: p.low_stock_threshold,
        reorderQuantity: p.reorder_quantity,
        autoReorderEnabled: p.auto_reorder_enabled,
        vendorName: p.vendor_name,
        packSize,
      },
      usage,
      forecastDemand,
      today: day,
      options: o,
    });
    suggestion.usageRecords = usageRecords;
    if (unconverted) suggestion.note = [suggestion.note, `${unconverted} usage rows in another unit were skipped.`].filter(Boolean).join(' ');
    return suggestion;
  });

  return { today: day, options: o, forecastError, products: rows };
}

module.exports = {
  DEFAULTS,
  parsePackText,
  packSizeInInventoryUnit,
  isBlackoutFertilizer,
  blackoutWindow,
  weeklyTotals,
  suggestLimitsForProduct,
  buildReorderLimitSuggestions,
};
