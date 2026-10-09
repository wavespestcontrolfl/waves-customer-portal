/**
 * The yearly COUNT caps of the v13 lawn program (GATE_LAWN_V13; owner 2026-10-06), kept entirely
 * behind the gate: no product_limits row carries them, so with the gate off every reader behaves as
 * it did before v13.
 *
 *   Celsius WG                2   stored row is the legacy 3 (compliance seed 20260401000020); the
 *                                 cap LOWERS it while the gate is on.
 *   Arena 50 WDG              2   new cap, no legacy value: while the gate is on a synthetic
 *                                 hard_block annual_max_apps limit is ADDED. The v13 chinch rate is
 *                                 0.147 oz per 1,000 sq ft (6.4 oz per acre), the low end of the label's
 *                                 turf range (6.4 to 12.8 oz per acre; "multiple applications can be made
 *                                 but do not exceed 12.8 oz per acre per year", 0.4 lb clothianidin per
 *                                 acre), so two passes reach the yearly limit. The 56 days (8 weeks)
 *                                 between passes is the company's own rule, not a label interval (it follows
 *                                 the manufacturer's former Florida recommendation). The label's limit is
 *                                 an AMOUNT, so the entry also carries annualAmount (0.294 oz per 1,000 sq ft
 *                                 a year, hard block): the lawn's recorded Arena rates plus the one being
 *                                 planned must fit it (an unreadable rate counts as the old 0.29 oz). An entry's
 *                                 minIntervalDays adds a synthetic hard_block min_interval_days limit the
 *                                 same way (a stored product-level row is raised to it, never lowered).
 *   Certainty Turf Herbicide  2   new cap: synthetic limit.
 *   Blindside Herbicide       2   new cap: synthetic limit.
 *
 * Under v13 the cap is always a hard block: a stored row is lowered to the cap AND made hard_block
 * (in memory; the database row is never rewritten), never raised, never replaced by a synthetic one.
 *
 * Identity. The caps are keyed by catalog product ID, not by name, so a catalog rename does not drop
 * one. The four ids are resolved once per connection and cached for a minute, from (1) the staged v13
 * protocol rows that carry gates.annualMaxApps (their product_id survives a rename; migration
 * 20261007175000 writes those keys), (2) the exact catalog name, else (3) an exact alias. A product
 * no resolver found is matched by its current name as the last resort.
 */
const LABEL = 'owner 2026-10-06';

const V13_COUNT_CAPS = Object.freeze([
  { name: 'Celsius WG', cap: 2, description: `Celsius WG: max 2 applications per lawn per year under the v13 lawn program (${LABEL}).` },
  {
    name: 'Arena 50 WDG',
    cap: 2,
    description: `Arena 50 WDG: max 2 applications per lawn per year under the v13 lawn program (${LABEL}), at 0.147 oz per 1,000 sq ft (6.4 oz per acre, the low end of the label's turf range): two applications reach the label's yearly limit of 12.8 oz per acre (0.4 lb clothianidin per acre).`,
    // The label's limit is an AMOUNT (12.8 oz per acre = 0.294 oz per 1,000 sq ft a year, 0.4 lb clothianidin per acre), so
    // the count of 2 alone would let a lawn that took the old 0.29 oz rate take a second pass. A history row that cannot be
    // sized counts at fallbackRate (the old rate = the whole year).
    annualAmount: {
      cap: 0.294,
      unit: 'oz/1000sf/year',
      fallbackRate: 0.29,
      description: 'Arena 50 WDG: no more than 12.8 oz per acre (0.294 oz per 1,000 sq ft) a year under the v13 lawn program, all applications on the lawn added up (label: 0.4 lb clothianidin per acre per year). An earlier application with no readable rate counts as 0.29 oz.',
    },
    minIntervalDays: 56,
    intervalDescription: `Arena 50 WDG: at least 56 days (8 weeks) between applications on a lawn under the v13 lawn program (${LABEL}; the company's own spacing, not a label interval).`,
  },
  { name: 'Certainty Turf Herbicide', cap: 2, description: `Certainty Turf Herbicide: max 2 applications per lawn per year under the v13 lawn program (${LABEL}).` },
  { name: 'Blindside Herbicide', cap: 2, description: `Blindside Herbicide: max 2 applications per lawn per year under the v13 lawn program (${LABEL}).` },
]);

const normalize = (name) => String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const BY_NAME = new Map(V13_COUNT_CAPS.map((entry) => [normalize(entry.name), entry]));

const gateLive = () => require('./feature-gates').lawnV13Live?.() === true;
const v13CountCapFor = (productName) => BY_NAME.get(normalize(productName)) || null;

// ── Identity ────────────────────────────────────────────────────────────────

const CACHE_MS = 60 * 1000;
let cache = new WeakMap(); // database handle -> { at, ids: Map(productId -> entry) }

// savepointScope, never savepointRead: callers (the plan's v13Limits, the closeout audit) already run
// this inside a queued savepointRead on the same transaction, and a nested savepointRead would wait on
// its own outer read forever (grouped completion packets). A scope nests freely and still isolates a
// failed query, so it cannot abort the caller's transaction.
async function read(database, query) {
  const { savepointScope } = require('../utils/savepoint-read');
  try { return await savepointScope(database, query); } catch { return []; }
}

// productId -> cap entry, for every product a resolver found.
async function resolveCapIds(database) {
  const ids = new Map();
  const add = (productId, name) => {
    const entry = v13CountCapFor(name);
    if (productId && entry) ids.set(String(productId), entry);
  };
  // (1) the staged protocol rows that carry the cap: their product_id is the stable identity.
  for (const row of await read(database, (k) => k('lawn_protocol_products').whereRaw("gates->>'annualMaxApps' is not null").distinct('product_id', 'product_name'))) {
    add(row.product_id, row.product_name);
  }
  // (2) the exact catalog name (active rows first), (3) an exact alias.
  const catalog = await read(database, (k) => k('products_catalog').whereIn('name', V13_COUNT_CAPS.map((entry) => entry.name)).select('id', 'name', 'active'));
  for (const row of [...catalog].sort((a, b) => Number(b.active !== false) - Number(a.active !== false))) add(row.id, row.name);
  const aliases = await read(database, (k) => k('product_aliases').whereIn('alias_name', V13_COUNT_CAPS.map((entry) => entry.name)).select('product_id', 'alias_name'));
  for (const row of aliases) add(row.product_id, row.alias_name);
  return ids;
}

async function capIdMap(database) {
  const hit = cache.get(database);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.ids;
  const ids = await resolveCapIds(database);
  cache.set(database, { at: Date.now(), ids });
  return ids;
}

// Tests (and a catalog edit that must show at once) drop the cached identity.
function resetV13CapIdentity() {
  cache = new WeakMap();
}

// The cap entry that applies to a product, or null: by id first, by current name as the last resort.
async function v13CapEntryFor(database, productId, productName) {
  if (!gateLive()) return null;
  const ids = await capIdMap(database);
  return ids.get(String(productId)) || (ids.size < V13_COUNT_CAPS.length ? v13CountCapFor(productName) : null);
}

// ── Applying a cap ──────────────────────────────────────────────────────────

const isProductCount = (limit) => limit.limit_type === 'annual_max_apps' && (limit.match_type || 'product') === 'product';

function syntheticCountLimit(entry, productId = null) {
  return {
    id: null,
    product_id: productId,
    match_type: 'product',
    match_value: null,
    limit_type: 'annual_max_apps',
    limit_value: entry.cap,
    limit_unit: 'applications',
    severity: 'hard_block',
    description: entry.description,
    synthetic: true,
  };
}

// The product's limit rows under its cap entry: a stored product-level annual_max_apps row is lowered
// to the cap and made hard_block (in memory); with none stored, a synthetic hard_block row is added.
function withEntryCaps(entry, limits, productId = null) {
  const rows = limits || [];
  if (!entry) return rows;
  const counted = !rows.some(isProductCount)
    ? [...rows, syntheticCountLimit(entry, productId)]
    : rows.map((limit) => {
      if (!isProductCount(limit)) return limit;
      const stored = Number(limit.limit_value);
      const value = Number.isFinite(stored) ? Math.min(stored, entry.cap) : entry.cap;
      return { ...limit, limit_value: value, severity: 'hard_block' };
    });
  const timed = withEntryInterval(entry, counted, productId);
  return entry.annualAmount && !timed.some((limit) => limit.match_type === V13_AMOUNT) ? [...timed, syntheticAmountLimit(entry, productId)] : timed;
}

const isProductInterval = (limit) => limit.limit_type === 'min_interval_days' && (limit.match_type || 'product') === 'product';

function syntheticIntervalLimit(entry, productId = null) {
  return {
    id: null,
    product_id: productId,
    match_type: 'product',
    match_value: null,
    limit_type: 'min_interval_days',
    limit_value: entry.minIntervalDays,
    limit_unit: 'days',
    severity: 'hard_block',
    description: entry.intervalDescription,
    synthetic: true,
  };
}

// An entry with a minimum interval: a stored product-level min_interval_days row is raised to it and made
// hard_block (in memory), never lowered; with none stored, a synthetic hard_block row is added.
function withEntryInterval(entry, rows, productId = null) {
  if (!entry.minIntervalDays) return rows;
  if (!rows.some(isProductInterval)) return [...rows, syntheticIntervalLimit(entry, productId)];
  return rows.map((limit) => {
    if (!isProductInterval(limit)) return limit;
    const stored = Number(limit.limit_value);
    const value = Number.isFinite(stored) ? Math.max(stored, entry.minIntervalDays) : entry.minIntervalDays;
    return { ...limit, limit_value: value, severity: 'hard_block' };
  });
}

// The match_type of the synthetic yearly-amount row. application-limits evaluates it; no stored row ever carries it.
const V13_AMOUNT = 'v13_amount';

function syntheticAmountLimit(entry, productId = null) {
  const amount = entry.annualAmount;
  return {
    id: null,
    product_id: productId,
    match_type: V13_AMOUNT,
    match_value: null,
    limit_type: 'annual_max_rate',
    limit_value: amount.cap,
    limit_unit: amount.unit,
    severity: 'hard_block',
    description: amount.description,
    fallback_rate: amount.fallbackRate,
    synthetic: true,
  };
}

// withEntryCaps for a product, resolving its entry through the id map.
async function applyV13CountCaps(database, product, limits, productId = product?.id) {
  return withEntryCaps(await v13CapEntryFor(database, productId, product?.name), limits, productId);
}

// A stale row cannot advertise a shorter wait than the app enforces.
const staleInterval = (entry, gates) => !!(entry.minIntervalDays && gates && typeof gates.minIntervalDays === 'number' && gates.minIntervalDays < entry.minIntervalDays);

// The cap figures a staged protocol row advertises (gates.annualMaxApps, annual_counter.maxApplications),
// clamped to the entry's cap: min(row figure, cap), never raised, never added. A stale row cannot show
// the field more than the app enforces. Returns the product itself when nothing changes.
function withEntryCapMetadata(entry, product) {
  if (!entry || !product) return product;
  const clamp = (value) => (typeof value === 'number' && Number.isFinite(value) && value > entry.cap ? entry.cap : value);
  const gates = product.gates && typeof product.gates === 'object' ? product.gates : null;
  const counter = product.annual_counter && typeof product.annual_counter === 'object' ? product.annual_counter : null;
  const gateValue = gates ? clamp(gates.annualMaxApps) : undefined;
  const counterValue = counter ? clamp(counter.maxApplications) : undefined;
  const gateChanged = gates && gateValue !== gates.annualMaxApps;
  const counterChanged = counter && counterValue !== counter.maxApplications;
  const intervalChanged = staleInterval(entry, gates);
  if (!gateChanged && !counterChanged && !intervalChanged) return product;
  return {
    ...product,
    ...(gateChanged || intervalChanged ? { gates: { ...gates, ...(gateChanged ? { annualMaxApps: gateValue } : {}), ...(intervalChanged ? { minIntervalDays: entry.minIntervalDays } : {}) } } : {}),
    ...(counterChanged ? { annual_counter: { ...counter, maxApplications: counterValue } } : {}),
  };
}

// ── The Celsius yearly figure, as the report copy and the portal read it ───────────────────────────
// CELSIUS_YTD_CAP is the v13 value, CELSIUS_YTD_CAP_LEGACY the one before v13; celsiusYtdCap() is the ONE
// reader that follows GATE_LAWN_V13 (the service report's expectations, the portal stats route).
const CELSIUS_YTD_CAP = V13_COUNT_CAPS.find((entry) => entry.name === 'Celsius WG').cap;
const CELSIUS_YTD_CAP_LEGACY = 3;
const celsiusYtdCap = () => (gateLive() ? CELSIUS_YTD_CAP : CELSIUS_YTD_CAP_LEGACY);

module.exports = {
  CELSIUS_YTD_CAP, CELSIUS_YTD_CAP_LEGACY, celsiusYtdCap,
  withEntryCapMetadata,
  syntheticIntervalLimit,
  syntheticAmountLimit,
  V13_AMOUNT,
  V13_COUNT_CAPS, v13CountCapFor, v13CapEntryFor, capIdMap, resetV13CapIdentity, withEntryCaps, applyV13CountCaps, syntheticCountLimit,
};
