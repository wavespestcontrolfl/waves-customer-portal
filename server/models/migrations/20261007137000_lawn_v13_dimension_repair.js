/**
 * Lawn protocol v13, before the GATE_LAWN_V13 flip: repair of the Dimension 0.21% 18-0-10
 * limit and price seeds (Codex round 5 on #6084). 20261007120000 through 20261007136000 are
 * pushed and frozen. Everything below is audited, and down() undoes only what this wrote.
 *
 * 1. Label limits are hard blocks. The product-level annual_max_apps and min_interval_days
 *    rows (the label's 3 applications a year, 2 to 4 months apart) are restrictions, not
 *    advice. 130000 hardened only the rows that carried its own description and 133000
 *    tightened values only; a row already at or inside the label values but marked
 *    'warning' stayed advisory. Every such row of the product becomes hard_block.
 *
 * 2. A seed priced for the wrong bag. The seed is $44.23 for a 50 lb (800 oz) bag. Where the
 *    resolved catalog row's unit_size_oz is positive and not 800, that price does not describe
 *    the catalog's container. Where a SiteOne row is one 133000 or 134000 seeded and it still
 *    holds the seeded quote and snapshot, the seed is taken back: a row 133000 reconciled goes
 *    back to the values it had before (its snapshot and history rows removed); a row 134000
 *    inserted is removed with them. A catalog price that is still 130000's direct figure is
 *    treated the same way. recalcBestPrice then re-ranks what is left: with no eligible
 *    vendor row it sets needs_pricing and 'no_valid_price', which is what the pricing review
 *    reads (the inventory-unit review queue only covers a missing or unsupported
 *    inventory_unit, never a bag size, so there is no second queue to route through).
 *
 * 3. Costing from the winner. 130000 wrote cost_per_unit 0.8846 per lb with the seeded price.
 *    The canonical measured-product path (recalcBestPrice leaves cost_per_unit empty and
 *    product-costing costLineFromUsage derives the cost from best_price over unit_size_oz)
 *    would then cost a product another vendor now wins with the seeded vendor's figure.
 *    Where cost_per_unit still holds the seeded 0.8846 / lb and the catalog's winner is not a
 *    surviving seeded row (or there is no price any more), cost_per_unit and cost_unit are
 *    cleared so costing reads the winner.
 *
 * down(), in rollback order (this one runs before 136000, 134000, 133000 and 130000):
 *   - puts back the severities, the seed rows it removed or reverted (only where the slot is
 *     still free or the row still holds its pre-seed state), then the catalog fields while
 *     they still hold what this wrote;
 *   - then, if the SiteOne row or the catalog has been re-quoted since the seed (the seeded
 *     row no longer holds its quote and snapshot, or the catalog price moved off what the
 *     seed chain last wrote), drops the entries that would roll that re-quote back: the
 *     landed-field restore of 136000 and the price entries of 130000's catalog snapshot,
 *     leaving a later re-quote whole and consistent.
 */

const crypto = require('crypto');
const commercial = require('./20261007130000_lawn_v13_october_dimension_commercial_rate');
const siteOne = require('./20261007133000_lawn_v13_dimension_siteone_row_reconcile');
const priceCap = require('./20261007134000_lawn_v13_dimension_price_and_cap_clamp');
const finalize = require('./20261007136000_lawn_v13_dimension_price_finalize');
const oct = require('./20261007120000_lawn_v13_october_dimension');

const ACTION = 'v13_dimension_repair';
const NAME = oct.NEW_NAME;
const PRICE = priceCap.PRICE;
const SEEDED_OUNCES = 800;
const SEEDED_COST = { cost_per_unit: 0.8846, cost_unit: 'lb' };
const LIMIT_TYPES = ['annual_max_apps', 'min_interval_days'];
const CATALOG_COLUMNS = [
  'best_price', 'best_vendor', 'best_vendor_pricing_id', 'best_price_amount_cached', 'best_price_vendor_id_cached',
  'best_price_updated_at', 'best_price_status', 'needs_pricing', 'cost_per_unit', 'cost_unit',
];
const PRICE_ENTRY_COLUMNS = new Set(['best_price', 'best_vendor', 'cost_per_unit', 'cost_unit', 'needs_pricing']);
const VOLATILE = new Set(['best_price_updated_at']);
const TABLES = ['products_catalog', 'vendor_pricing', 'price_history', 'price_snapshots', 'product_limits', 'lawn_protocol_audit_log'];

const normalize = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function asObject(value) {
  if (typeof value === 'string') {
    try { return JSON.parse(value) || {}; } catch { return {}; }
  }
  return value && typeof value === 'object' ? value : {};
}

// Numbers by value (pg decimals arrive as strings), dates by instant, the rest as they are.
function same(a, b) {
  if (a == null || b == null) return a == null && b == null;
  if (a instanceof Date || b instanceof Date) return new Date(a).getTime() === new Date(b).getTime();
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb) && String(a).trim() !== '' && String(b).trim() !== '') return na === nb;
  return a === b;
}

async function hasTables(knex, tables) {
  for (const table of tables) if (!(await knex.schema.hasTable(table))) return false;
  return true;
}

async function resolveDimensionId(knex) {
  const catalog = await knex('products_catalog').select('id', 'name', 'active');
  const hit = [...catalog].sort((a, b) => Number(b.active !== false) - Number(a.active !== false))
    .find((row) => normalize(row.name) === normalize(NAME));
  if (hit) return hit.id;
  if (!(await knex.schema.hasTable('product_aliases'))) return null;
  const alias = (await knex('product_aliases').select('product_id', 'alias_name')).find((row) => normalize(row.alias_name) === normalize(NAME));
  return alias ? alias.product_id : null;
}

// Does a vendor row still hold the sticker quote 133000 / 134000 wrote (and its snapshot)?
function holdsSeededQuote(row, snapshotId) {
  return Boolean(row)
    && same(row.price, PRICE) && same(row.price_amount, PRICE) && row.quantity === '50 lb' && row.vendor_sku === '702032'
    && row.price_type === 'manual' && row.approval_status === 'approved' && row.is_active === true
    && (snapshotId == null || String(row.latest_snapshot_id) === String(snapshotId));
}

function catalogColumns(row) {
  return Object.fromEntries(CATALOG_COLUMNS.map((column) => [column, row[column] ?? null]));
}

function catalogDiffers(a, b) {
  return CATALOG_COLUMNS.some((column) => !VOLATILE.has(column) && !same(a[column], b[column]));
}

// The vendor rows 133000 (reconciled) and 134000 (inserted) seeded, from their audit rows.
async function seedRefs(knex) {
  const refs = [];
  for (const [action, kind] of [[siteOne.ACTION, 'reconciled'], [priceCap.ACTION, 'inserted']]) {
    const logs = await knex('lawn_protocol_audit_log').where({ action }).select('after_snapshot');
    for (const log of logs) {
      const price = asObject(log.after_snapshot).price;
      if (price) refs.push({ kind, ...price });
    }
  }
  return refs;
}

// ── 1. hard blocks ──────────────────────────────────────────────────────────
async function hardenLimits(knex, productId) {
  const rows = await knex('product_limits').where({ product_id: productId, match_type: 'product' }).select('id', 'limit_type', 'severity');
  const soft = rows.filter((row) => LIMIT_TYPES.includes(row.limit_type) && row.severity !== 'hard_block');
  for (const row of soft) await knex('product_limits').where({ id: row.id }).update({ severity: 'hard_block' });
  return soft.map((row) => ({ id: row.id, before: row.severity }));
}

async function restoreLimits(knex, limits) {
  for (const entry of limits || []) {
    const row = await knex('product_limits').where({ id: entry.id }).first('id', 'severity');
    if (row && row.severity === 'hard_block') await knex('product_limits').where({ id: entry.id }).update({ severity: entry.before });
  }
}

// ── 2. the seed priced for the wrong bag ────────────────────────────────────
async function takeBackSeed(knex, ref) {
  const row = await knex('vendor_pricing').where({ id: ref.vendorPricingId }).first();
  if (!holdsSeededQuote(row, ref.snapshotId)) return null;
  const snapshot = await knex('price_snapshots').where({ id: ref.snapshotId }).first();
  const history = await knex('price_history').where({ id: ref.priceHistoryId }).first();
  const entry = { kind: ref.kind, row, snapshot: snapshot || null, history: history || null, rowBefore: ref.rowBefore || null };
  if (ref.kind === 'reconciled') await knex('vendor_pricing').where({ id: row.id }).update(ref.rowBefore);
  else await knex('vendor_pricing').where({ id: row.id }).update({ latest_snapshot_id: null });
  if (snapshot) await knex('price_snapshots').where({ id: snapshot.id }).del();
  if (history) await knex('price_history').where({ id: history.id }).del();
  if (ref.kind === 'inserted') {
    // The catalog may still point at the row (its winner column); free it before the row goes.
    await knex('products_catalog').where({ best_vendor_pricing_id: row.id }).update({ best_vendor_pricing_id: null });
    await knex('vendor_pricing').where({ id: row.id }).del();
  }
  return entry;
}

async function directSeedStands(knex, productId) {
  const row = await knex('products_catalog').where({ id: productId }).first();
  return row.best_vendor_pricing_id == null && same(row.best_price, PRICE) && row.best_vendor === 'SiteOne';
}

async function repairWrongBag(knex, productId) {
  const product = await knex('products_catalog').where({ id: productId }).first();
  const ounces = Number(product.unit_size_oz);
  if (!(ounces > 0) || ounces === SEEDED_OUNCES) return { taken: [], recalculated: false };
  const taken = [];
  for (const ref of await seedRefs(knex)) {
    const entry = await takeBackSeed(knex, ref);
    if (entry) taken.push(entry);
  }
  const recalculated = taken.length > 0 || await directSeedStands(knex, productId);
  if (recalculated) await require('../../routes/admin-inventory').recalcBestPrice(productId, knex);
  return { taken, recalculated };
}

async function reinstateReconciled(knex, entry) {
  const row = await knex('vendor_pricing').where({ id: entry.row.id }).first();
  if (!row || !entry.rowBefore || !same(row.price, entry.rowBefore.price) || row.approval_status !== entry.rowBefore.approval_status) return;
  const { latest_snapshot_id: latest, id, ...columns } = entry.row;
  await knex('vendor_pricing').where({ id }).update(columns);
  if (entry.snapshot) await knex('price_snapshots').insert(entry.snapshot);
  if (entry.history) await knex('price_history').insert(entry.history);
  await knex('vendor_pricing').where({ id }).update({ latest_snapshot_id: latest });
}

async function reinstateInserted(knex, entry) {
  const taken = await knex('vendor_pricing').where({ product_id: entry.row.product_id, vendor_id: entry.row.vendor_id }).first();
  if (taken) return;
  const { latest_snapshot_id: latest, ...columns } = entry.row;
  await knex('vendor_pricing').insert(columns);
  if (entry.snapshot) await knex('price_snapshots').insert(entry.snapshot);
  if (entry.history) await knex('price_history').insert(entry.history);
  await knex('vendor_pricing').where({ id: entry.row.id }).update({ latest_snapshot_id: latest });
}

async function reinstateSeeds(knex, taken) {
  for (const entry of taken || []) {
    if (entry.kind === 'reconciled') await reinstateReconciled(knex, entry);
    else await reinstateInserted(knex, entry);
  }
}

// ── 3. costing from the winner ──────────────────────────────────────────────
async function survivingSeededIds(knex) {
  const ids = new Set();
  for (const ref of await seedRefs(knex)) {
    const row = await knex('vendor_pricing').where({ id: ref.vendorPricingId }).first();
    if (holdsSeededQuote(row, ref.snapshotId)) ids.add(String(row.id));
  }
  return ids;
}

async function clearStaleCost(knex, productId) {
  const row = await knex('products_catalog').where({ id: productId }).first();
  const seeded = same(row.cost_per_unit, SEEDED_COST.cost_per_unit) && row.cost_unit === SEEDED_COST.cost_unit;
  if (!seeded || !(Number(row.unit_size_oz) > 0)) return;
  const winner = row.best_vendor_pricing_id;
  const winnerIsSeeded = winner != null && (await survivingSeededIds(knex)).has(String(winner));
  if (winnerIsSeeded || (winner == null && row.best_price != null)) return;
  await knex('products_catalog').where({ id: productId }).update({ cost_per_unit: null, cost_unit: null });
}

// ── down: keep a later re-quote whole ───────────────────────────────────────
// The catalog state the seed chain last wrote, from the audit rows that still exist.
async function lastSeededCatalog(knex) {
  const finalizeLog = (await knex('lawn_protocol_audit_log').where({ action: finalize.ACTION }).select('after_snapshot'))[0];
  const afterFinalize = finalizeLog && asObject(finalizeLog.after_snapshot).catalog;
  if (afterFinalize) return afterFinalize.after;
  const refs = await seedRefs(knex);
  const inserted = refs.find((ref) => ref.kind === 'inserted' && ref.after);
  if (inserted) return inserted.after;
  const reconciled = refs.find((ref) => ref.kind === 'reconciled' && ref.catalogAfter);
  return reconciled ? reconciled.catalogAfter : null;
}

async function wasRequoted(knex, productId) {
  for (const ref of await seedRefs(knex)) {
    const row = await knex('vendor_pricing').where({ id: ref.vendorPricingId }).first();
    if (row && !holdsSeededQuote(row, ref.snapshotId)) return true;
  }
  const expected = await lastSeededCatalog(knex);
  if (!expected) return false;
  const row = await knex('products_catalog').where({ id: productId }).first();
  return Boolean(row) && catalogDiffers(catalogColumns(row), expected);
}

async function dropLandedRestore(knex) {
  const logs = await knex('lawn_protocol_audit_log').where({ action: finalize.ACTION }).select('id', 'after_snapshot');
  for (const log of logs) {
    const after = asObject(log.after_snapshot);
    if (after.landed && after.landed.length) await knex('lawn_protocol_audit_log').where({ id: log.id }).update({ after_snapshot: JSON.stringify({ ...after, landed: [] }) });
  }
}

async function dropCatalogPriceEntries(knex) {
  const logs = await knex('lawn_protocol_audit_log').where({ action: commercial.ACTION }).select('id', 'after_snapshot');
  for (const log of logs) {
    const after = asObject(log.after_snapshot);
    if (!after.catalog) continue;
    const kept = Object.fromEntries(Object.entries(after.catalog).filter(([column]) => !PRICE_ENTRY_COLUMNS.has(column)));
    await knex('lawn_protocol_audit_log').where({ id: log.id }).update({ after_snapshot: JSON.stringify({ ...after, catalog: kept }) });
  }
}

async function restoreCatalog(knex, catalog) {
  if (!catalog) return;
  const row = await knex('products_catalog').where({ id: catalog.productId }).first();
  if (row && !catalogDiffers(catalogColumns(row), catalog.after)) await knex('products_catalog').where({ id: catalog.productId }).update(catalog.before);
}

exports.up = async function up(knex) {
  if (!(await hasTables(knex, TABLES))) return;
  const productId = await resolveDimensionId(knex);
  if (!productId) return;
  const limits = await hardenLimits(knex, productId);
  const before = catalogColumns(await knex('products_catalog').where({ id: productId }).first());
  const wrongBag = await repairWrongBag(knex, productId);
  await clearStaleCost(knex, productId);
  const after = catalogColumns(await knex('products_catalog').where({ id: productId }).first());
  const catalog = catalogDiffers(before, after) ? { productId, before, after } : null;
  if (!limits.length && !wrongBag.taken.length && !catalog) return;
  await knex('lawn_protocol_audit_log').insert({
    lawn_protocol_id: null,
    actor_name: 'migration 20261007137000',
    entity_type: 'catalog',
    entity_id: crypto.randomUUID(),
    action: ACTION,
    changed_fields: JSON.stringify(['product_limits', 'vendor_pricing', 'catalog']),
    before_snapshot: JSON.stringify({}),
    after_snapshot: JSON.stringify({ limits, taken: wrongBag.taken, catalog }),
    metadata: JSON.stringify({ migration: '20261007137000_lawn_v13_dimension_repair' }),
  });
};

exports.down = async function down(knex) {
  if (!(await hasTables(knex, TABLES))) return;
  const logs = await knex('lawn_protocol_audit_log').where({ action: ACTION }).select('id', 'after_snapshot');
  for (const log of logs) {
    const after = asObject(log.after_snapshot);
    await restoreLimits(knex, after.limits);
    await reinstateSeeds(knex, after.taken);
    await restoreCatalog(knex, after.catalog);
    await knex('lawn_protocol_audit_log').where({ id: log.id }).del();
  }
  const productId = await resolveDimensionId(knex);
  if (productId && await wasRequoted(knex, productId)) {
    await dropLandedRestore(knex);
    await dropCatalogPriceEntries(knex);
  }
};

exports.ACTION = ACTION;
