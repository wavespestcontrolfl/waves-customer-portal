/**
 * Lawn protocol v13, before the GATE_LAWN_V13 flip: Codex round 2 on #6084.
 * Migrations 20261007120000 and 20261007130000 are pushed and frozen; this one
 * corrects two things they left.
 *
 * 1. The granular dithiopyr yearly cap. 20261007120000 derived it from 1.5 lb ai per
 *    acre at 0.21%: 16.3977 lb per 1,000 sq ft. The label's own yearly maximum is 16.38
 *    lb of product per 1,000 sq ft (EPA 10404-87, Sub-Label B Commercial), and a cap
 *    above the label is not a cap. The row goes 16.3977 -> 16.38, only where it still
 *    holds 16.3977, and the change is audited. (2EW's 2.2039 fl oz is derived the same
 *    way but the label states no figure for it in fl oz here; it stays.)
 *
 * 2. The SiteOne price through the canonical vendor-pricing path. 20261007130000 wrote
 *    best_price on the catalog row directly. The catalog price is a cache of the winning
 *    vendor_pricing row (best_vendor_pricing_id, best_price_amount_cached, status), and
 *    the next recalcBestPrice with no eligible vendor row sets the product back to
 *    'no_valid_price' and needs_pricing. So, only where the Dimension 0.21% 18-0-10
 *    product has NO eligible vendor row (the shared vendor-pricing-eligibility
 *    predicate), this writes the SiteOne row the way the owner's supplier-cost
 *    migration (20260907000020) does: an approved, active, manual vendor_pricing row
 *    for $44.23 per 50 lb bag (SiteOne 702032, the member price), its price_history
 *    and price_snapshots rows, then calls recalcBestPrice, the one writer of the
 *    catalog's best_price, best_vendor, best_vendor_pricing_id, cache and status
 *    fields. A later recalcBestPrice re-ranks the same row and keeps the price.
 *    The product must be measured (unit_size_oz > 0; an empty unit_size_oz is filled
 *    with 800 only where container_size reads "50 lb"), else the recalculation could
 *    not scale the price and the migration leaves the row alone with a warning.
 *
 * Catalog and limit rows are found by the product id the staged rows link to (exact
 * name, else alias), as in 20261007130000.
 * Idempotent. down(): puts the cap back to 16.3977 only while it holds 16.38; removes the
 * vendor_pricing, price_history and price_snapshots rows this created and restores the
 * catalog fields recalcBestPrice wrote, but only while the catalog still points at the
 * row this created (a later re-price is kept, and so are its rows).
 */

const crypto = require('crypto');
const oct = require('./20261007120000_lawn_v13_october_dimension');

const ACTION = 'v13_dimension_price_and_cap_clamp';
const NAME = oct.NEW_NAME;
const MATCH_VALUE = 'dithiopyr';
const CAP_FROM = 16.3977;
const CAP_TO = 16.38;
const VENDOR = 'SiteOne';
const SKU = '702032';
const PRICE = 44.23;
const QUANTITY = '50 lb';
const OUNCES = 800;
const SOURCE = 'v13_dimension_siteone_member_price_20261007';
// The catalog columns recalcBestPrice writes (and the unit size this may fill).
const CATALOG_COLUMNS = [
  'best_price', 'best_vendor', 'best_vendor_pricing_id', 'best_price_amount_cached', 'best_price_vendor_id_cached',
  'best_price_updated_at', 'best_price_status', 'needs_pricing', 'cost_per_unit', 'cost_unit', 'unit_size_oz',
];

const normalize = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function asObject(value) {
  if (typeof value === 'string') {
    try { return JSON.parse(value) || {}; } catch { return {}; }
  }
  return value && typeof value === 'object' ? value : {};
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

function writeAudit(knex, snapshot) {
  return knex('lawn_protocol_audit_log').insert({
    lawn_protocol_id: null,
    actor_name: 'migration 20261007134000',
    entity_type: 'catalog',
    entity_id: crypto.randomUUID(),
    action: ACTION,
    changed_fields: JSON.stringify(Object.keys(snapshot)),
    before_snapshot: JSON.stringify({}),
    after_snapshot: JSON.stringify(snapshot),
    metadata: JSON.stringify({ migration: '20261007134000_lawn_v13_dimension_price_and_cap_clamp' }),
  });
}

// ── 1. the granular cap ──────────────────────────────────────────────────────
async function clampGranularCap(knex) {
  const caps = await knex('product_limits')
    .where({ match_type: 'active_ingredient', match_value: MATCH_VALUE, limit_type: 'annual_max_rate' })
    .select('id', 'limit_value', 'limit_unit');
  const ids = caps.filter((cap) => String(cap.limit_unit).startsWith('lb/') && Number(cap.limit_value) === CAP_FROM).map((cap) => cap.id);
  for (const id of ids) await knex('product_limits').where({ id }).update({ limit_value: CAP_TO });
  return ids;
}

async function restoreGranularCap(knex, ids) {
  for (const id of ids || []) {
    const row = await knex('product_limits').where({ id }).first('id', 'limit_value');
    if (row && Number(row.limit_value) === CAP_TO) await knex('product_limits').where({ id }).update({ limit_value: CAP_FROM });
  }
}

// ── 2. the price ─────────────────────────────────────────────────────────────
async function hasEligibleRow(knex, productId) {
  const { eligibleVendorPricing } = require('../../services/vendor-pricing-eligibility');
  const rows = await eligibleVendorPricing(knex('vendor_pricing').where({ product_id: productId })).select('vendor_pricing.id').limit(1);
  return rows.length > 0;
}

// The product's measured size: its unit_size_oz, else 800 where the container reads "50 lb".
function measuredSize(product) {
  if (Number(product.unit_size_oz) > 0) return { ok: true, fill: null };
  return /^\s*50\s*lb\s*$/i.test(String(product.container_size || '')) ? { ok: true, fill: OUNCES } : { ok: false, fill: null };
}

async function insertVendorRows(knex, productId, vendorId) {
  const now = new Date();
  const perOz = PRICE / OUNCES;
  const [row] = await knex('vendor_pricing').insert({
    product_id: productId, vendor_id: vendorId, price: PRICE, price_amount: PRICE, quantity: QUANTITY, vendor_sku: SKU,
    price_type: 'manual', source_type: 'manual', approval_status: 'approved', is_active: true, currency: 'USD', last_checked_at: now,
    price_per_oz: perOz, normalized_unit_price: perOz, unit_normalized: 'oz', availability_status: 'unknown',
  }).returning('id');
  const [history] = await knex('price_history').insert({ product_id: productId, vendor_id: vendorId, price: PRICE, quantity: QUANTITY, source: 'manual' }).returning('id');
  const [snapshot] = await knex('price_snapshots').insert({
    product_id: productId, vendor_id: vendorId, vendor_pricing_id: row.id, price: PRICE, price_amount: PRICE, quantity: QUANTITY,
    normalized_unit_price: perOz, normalized_unit: 'oz', fetched_at: now, captured_at: now, source_type: 'manual', price_type: 'manual',
    availability_status: 'unknown', metadata: { source: SOURCE, memberPrice: true },
  }).returning('id');
  await knex('vendor_pricing').where({ id: row.id }).update({ latest_snapshot_id: snapshot.id });
  return { vendorPricingId: row.id, priceHistoryId: history.id, snapshotId: snapshot.id };
}

async function loadSiteOneVendor(knex) {
  const vendors = await knex('vendors').where({ name: VENDOR }).select('id');
  return vendors.length === 1 ? vendors[0].id : null;
}

// Returns the audit snapshot, or null when nothing was done.
async function seedPrice(knex, productId) {
  const product = await knex('products_catalog').where({ id: productId }).first();
  const size = measuredSize(product);
  const vendorId = size.ok ? await loadSiteOneVendor(knex) : null;
  if (!size.ok || !vendorId || await hasEligibleRow(knex, productId)) {
    if (!size.ok || !vendorId) console.warn(`[lawn-v13-dimension-price] "${NAME}" needs a measured size and one ${VENDOR} vendor row; price not seeded`);
    return null;
  }
  const before = Object.fromEntries(CATALOG_COLUMNS.map((column) => [column, product[column] ?? null]));
  if (size.fill) await knex('products_catalog').where({ id: productId }).update({ unit_size_oz: size.fill });
  const created = await insertVendorRows(knex, productId, vendorId);
  const { recalcBestPrice } = require('../../routes/admin-inventory');
  await recalcBestPrice(productId, knex);
  const after = await knex('products_catalog').where({ id: productId }).first();
  return { productId, ...created, before, after: Object.fromEntries(CATALOG_COLUMNS.map((column) => [column, after[column] ?? null])) };
}

async function revertPrice(knex, snapshot) {
  const catalog = await knex('products_catalog').where({ id: snapshot.productId }).first('id', 'best_vendor_pricing_id');
  // A later re-price (the catalog points at another row) is kept, with its rows.
  if (!catalog || String(catalog.best_vendor_pricing_id) !== String(snapshot.vendorPricingId)) return;
  await knex('products_catalog').where({ id: snapshot.productId }).update(snapshot.before);
  await knex('vendor_pricing').where({ id: snapshot.vendorPricingId }).update({ latest_snapshot_id: null });
  await knex('price_snapshots').where({ id: snapshot.snapshotId }).del();
  await knex('vendor_pricing').where({ id: snapshot.vendorPricingId }).del();
  await knex('price_history').where({ id: snapshot.priceHistoryId }).del();
}

const CAP_TABLES = ['product_limits', 'lawn_protocol_audit_log'];
const PRICE_TABLES = ['products_catalog', 'vendor_pricing', 'vendors', 'price_history', 'price_snapshots'];

async function hasTables(knex, tables) {
  for (const table of tables) if (!(await knex.schema.hasTable(table))) return false;
  return true;
}

exports.up = async function up(knex) {
  if (!(await hasTables(knex, CAP_TABLES))) return;
  const capIds = await clampGranularCap(knex);
  const productId = await hasTables(knex, PRICE_TABLES) ? await resolveDimensionId(knex) : null;
  const price = productId ? await seedPrice(knex, productId) : null;
  if (!capIds.length && !price) return;
  await writeAudit(knex, { capIds, price });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('lawn_protocol_audit_log'))) return;
  const logs = await knex('lawn_protocol_audit_log').where({ action: ACTION }).select('id', 'after_snapshot');
  for (const log of logs) {
    const after = asObject(log.after_snapshot);
    await restoreGranularCap(knex, after.capIds);
    if (after.price) await revertPrice(knex, after.price);
    await knex('lawn_protocol_audit_log').where({ id: log.id }).del();
  }
};

exports.ACTION = ACTION;
exports.CAP_TO = CAP_TO;
exports.PRICE = PRICE;
