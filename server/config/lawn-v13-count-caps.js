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
 *   Certainty Turf Herbicide  2   new cap: synthetic limit. Also minIntervalDays 28 (label: a sequential
 *                                 application "may be made 4 or more weeks after the initial treatment").
 *   Blindside Herbicide       2   new cap: synthetic limit. The v13 rate is 0.149 oz a pass (the label's warm-season
 *                                 rate is 0.149 to 0.23 oz) and the label's yearly limit is 0.23 oz per 1,000 sq ft
 *                                 ("do not exceed 10 oz. product per acre per year", EPA 279-3411), so ONE pass a
 *                                 year fits. The entry says so twice: effectiveCap 1 is the count every runtime reader
 *                                 uses, and annualAmount 0.23 oz blocks a second pass by amount. `cap` stays 2 only
 *                                 because the pushed migrations 20261007175000 and 20261007177000 read it when they run.
 *
 * effectiveCap. An entry may carry `effectiveCap`: the count the app enforces and shows (the synthetic count limit, a
 * stored row lowered to it, the plan and visit-brief figures). Every runtime reader goes through capOf(entry) =
 * effectiveCap ?? cap. Only frozen migrations read `cap` itself.
 *
 * Entries that carry no yearly count (v13 final pass, 2026-10-09; V13_MORE_LIMITS below). An entry may carry
 * any of: a count `cap`, a `minIntervalDays`, an `annualAmount`; the module adds only the synthetic rows an
 * entry asks for.
 *   Dylox 6.2 G Granular      3   count cap (label: "limit applications to 3 per calendar year").
 *   Velista                       yearly amount 2.2 oz per 1,000 sq ft (label EPA 100-1534).
 *   Artavia 2 SC (Azoxy)          yearly amount 7.1 fl oz per 1,000 sq ft (label: 9.6 quarts per acre per year).
 *
 * V13_COUNT_CAPS keeps its four entries and nothing else: migrations 20261007175000 and 20261007177000
 * (pushed, frozen) read its names when they RUN, and a fifth name would make them stamp annualMaxApps 2 on
 * that product's staged rows on every fresh database. New entries go in V13_MORE_LIMITS; V13_LIMITS is both.
 *
 * Under v13 every limit is a hard block. A stored count row is lowered to the cap AND made hard_block
 * (in memory; the database row is never rewritten), never raised, never replaced by a synthetic one.
 *
 * Identity. The caps are keyed by catalog product ID, not by name, so a catalog rename does not drop
 * one. The ids are resolved once per connection and cached for a minute, from (1) the staged v13
 * protocol rows that carry gates.annualMaxApps (their product_id survives a rename; migration
 * 20261007175000 writes those keys), (2) the exact catalog name, else (3) an exact alias. A product
 * no resolver found is matched by its current name as the last resort.
 */
const LABEL = 'owner 2026-10-06';
const FINAL_PASS = 'v13 final pass 2026-10-09';

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
  {
    name: 'Certainty Turf Herbicide',
    cap: 2,
    description: `Certainty Turf Herbicide: max 2 applications per lawn per year under the v13 lawn program (${LABEL}).`,
    // Certainty label: "A sequential application of 1.25 ounces per acre may be made 4 or more weeks after the initial treatment."
    minIntervalDays: 28,
    intervalDescription: `Certainty Turf Herbicide: at least 28 days (4 weeks) between applications on a lawn under the v13 lawn program (label: "A sequential application ... may be made 4 or more weeks after the initial treatment"; ${FINAL_PASS}).`,
  },
  {
    name: 'Blindside Herbicide',
    cap: 2,
    // `cap: 2` is what migrations 20261007175000 and 20261007177000 (pushed, frozen) read when they run, so it stays. The count the
    // app enforces and shows is effectiveCap: Blindside label (EPA 279-3411) warm-season single rate 0.149 to 0.23 oz per 1,000 sq ft
    // (6.5 to 10 oz per acre) and "do not exceed 10 oz. product per acre per year" = 0.23 oz per 1,000 sq ft, so at the v13 rate of
    // 0.149 oz one pass fits the year (two would be 0.298 oz). The yearly amount below blocks a second pass by amount as well.
    effectiveCap: 1,
    description: `Blindside Herbicide: max 1 application per lawn per year under the v13 lawn program (${LABEL}; ${FINAL_PASS}): at the program rate of 0.149 oz per 1,000 sq ft one pass fills the label's 0.23 oz yearly amount.`,
    // A spot row's rate is read as recorded (a spot is not scaled to its area).
    annualAmount: {
      cap: 0.23,
      unit: 'oz/1000sf/year',
      fallbackRate: 0.23,
      description: `Blindside Herbicide: no more than 0.23 oz per 1,000 sq ft (10 oz per acre) a year under the v13 lawn program, all applications on the lawn added up (label EPA 279-3411: "do not exceed 10 oz. product per acre per year"). An earlier application with no readable rate counts as 0.23 oz, the whole year. ${FINAL_PASS}.`,
    },
  },
]);

// Limits that are not a yearly count of 2 (v13 final pass). Each entry carries only what it needs: a `cap` (count), a
// `minIntervalDays`, an `annualAmount`. Kept out of V13_COUNT_CAPS (see the header).
const V13_MORE_LIMITS = Object.freeze([
  {
    name: 'Dylox 6.2 G Granular Insecticide',
    cap: 3,
    description: `Dylox 6.2 G Granular Insecticide: max 3 applications per lawn per year under the v13 lawn program (label: "limit applications to 3 per calendar year"; ${FINAL_PASS}).`,
  },
  {
    name: 'Velista',
    // Velista label (EPA 100-1534): "Do not apply more than 2.2 oz of Velista per 1,000 sq ft per year or 6 lb ... per acre per year" and
    // "Do not apply more than 0.7 oz ... per application". An application the ledger cannot size counts at the single-application maximum.
    annualAmount: {
      cap: 2.2,
      unit: 'oz/1000sf/year',
      fallbackRate: 0.7,
      description: `Velista: no more than 2.2 oz per 1,000 sq ft (6 lb per acre) a year under the v13 lawn program, all applications on the lawn added up (label EPA 100-1534). An earlier application with no readable rate counts as 0.7 oz, the label's single-application maximum. ${FINAL_PASS}.`,
    },
  },
  {
    name: 'Artavia 2 SC (Azoxy)',
    // Artavia label: "Do not apply more than 9.6 quarts product/acre/year (7.1 fl. oz. product/1,000 square feet/year)". The catalog rate is
    // 0.77 fl oz (the label's single-application figure), so an unsized application counts at 0.77.
    annualAmount: {
      cap: 7.1,
      unit: 'fl oz/1000sf/year',
      fallbackRate: 0.77,
      description: `Artavia 2 SC (Azoxy): no more than 7.1 fl oz per 1,000 sq ft (9.6 quarts per acre) a year under the v13 lawn program, all applications on the lawn added up (label). An earlier application with no readable rate counts as 0.77 fl oz. ${FINAL_PASS}.`,
    },
  },
]);
const V13_LIMITS = Object.freeze([...V13_COUNT_CAPS, ...V13_MORE_LIMITS]);

// The count every runtime reader uses: effectiveCap when the entry has one, else cap. The frozen migrations read `cap`.
const capOf = (entry) => entry.effectiveCap ?? entry.cap;

const normalize = (name) => String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const BY_NAME = new Map(V13_LIMITS.map((entry) => [normalize(entry.name), entry]));

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
  // (1) the staged protocol rows: their product_id is the stable identity (a row keeps its own product_name when the
  // catalog row is renamed). The rows that carry a cap, and the rows named as a limit entry: Dylox, Velista and
  // Artavia rows carry no gates.annualMaxApps, and a catalog rename must not drop their limit.
  const names = V13_LIMITS.map((entry) => entry.name);
  for (const row of await read(database, (k) => k('lawn_protocol_products').whereRaw("gates->>'annualMaxApps' is not null").orWhereIn('product_name', names).distinct('product_id', 'product_name'))) {
    add(row.product_id, row.product_name);
  }
  // (2) the exact catalog name (active rows first), (3) an exact alias.
  const catalog = await read(database, (k) => k('products_catalog').whereIn('name', V13_LIMITS.map((entry) => entry.name)).select('id', 'name', 'active'));
  for (const row of [...catalog].sort((a, b) => Number(b.active !== false) - Number(a.active !== false))) add(row.id, row.name);
  const aliases = await read(database, (k) => k('product_aliases').whereIn('alias_name', V13_LIMITS.map((entry) => entry.name)).select('product_id', 'alias_name'));
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
  return ids.get(String(productId)) || (ids.size < V13_LIMITS.length ? v13CountCapFor(productName) : null);
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
    limit_value: capOf(entry),
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
  const timed = withEntryInterval(entry, withEntryCount(entry, rows, productId), productId);
  return entry.annualAmount && !timed.some((limit) => limit.match_type === V13_AMOUNT) ? [...timed, syntheticAmountLimit(entry, productId)] : timed;
}

// The count part of an entry. An entry with no `cap` (only an interval or a yearly amount) adds no count row and leaves a
// stored one as it is.
function withEntryCount(entry, rows, productId = null) {
  if (capOf(entry) == null) return rows;
  if (!rows.some(isProductCount)) return [...rows, syntheticCountLimit(entry, productId)];
  return rows.map((limit) => {
    if (!isProductCount(limit)) return limit;
    const stored = Number(limit.limit_value);
    const value = Number.isFinite(stored) ? Math.min(stored, capOf(entry)) : capOf(entry);
    return { ...limit, limit_value: value, severity: 'hard_block' };
  });
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
  // An entry with no count cap (an interval or a yearly amount only) clamps nothing.
  const clamp = (value) => (capOf(entry) != null && typeof value === 'number' && Number.isFinite(value) && value > capOf(entry) ? capOf(entry) : value);
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
const CELSIUS_YTD_CAP = capOf(V13_COUNT_CAPS.find((entry) => entry.name === 'Celsius WG'));
const CELSIUS_YTD_CAP_LEGACY = 3;
const celsiusYtdCap = () => (gateLive() ? CELSIUS_YTD_CAP : CELSIUS_YTD_CAP_LEGACY);

module.exports = {
  CELSIUS_YTD_CAP, CELSIUS_YTD_CAP_LEGACY, celsiusYtdCap,
  withEntryCapMetadata,
  syntheticIntervalLimit,
  syntheticAmountLimit,
  V13_AMOUNT,
  V13_COUNT_CAPS, V13_MORE_LIMITS, V13_LIMITS, v13CountCapFor, v13CapEntryFor, capIdMap, resetV13CapIdentity, withEntryCaps, applyV13CountCaps, syntheticCountLimit,
};
