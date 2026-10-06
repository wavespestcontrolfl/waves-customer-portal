/**
 * Lawn protocol v13, before the GATE_LAWN_V13 flip: Codex round 3 on #6084.
 * Migrations 20261007120000, 20261007130000 and 20261007134000 are pushed and frozen.
 * This one sorts BEFORE 20261007134000 and fixes what that one would trip on, plus two
 * limit rows 20261007130000 left.
 *
 * 1. An existing, ineligible SiteOne vendor row. 20261007134000 inserts the SiteOne
 *    member price row ($44.23 per 50 lb, SKU 702032) when the Dimension 0.21% 18-0-10
 *    product has no ELIGIBLE vendor row. vendor_pricing is unique on (product_id,
 *    vendor_id), so a product that already holds a pending, rejected, expired or
 *    zero-priced SiteOne row would make that insert fail and the deploy with it. Here, where
 *    the product has no eligible vendor row (the shared vendor-pricing-eligibility
 *    predicate) but does have a SiteOne row, that row is updated IN PLACE to the
 *    approved, active, manual $44.23 / '50 lb' / 702032 shape (as the owner's supplier-cost
 *    migration 20260907000020 writes it), with its price_history and price_snapshots
 *    rows, then recalcBestPrice sets the catalog winner. 20261007134000 then finds an
 *    eligible row and skips its insert. Same guards as 134000: the product must be
 *    measured (unit_size_oz > 0, or filled with 800 where container_size reads "50 lb"),
 *    and there must be exactly one SiteOne vendor. A database where 134000 already ran
 *    has an eligible row: nothing happens.
 *
 * 2. Weaker existing product limits. 20261007130000 only changed the severity and text of
 *    a product-level annual_max_apps or min_interval_days row that already existed. A row
 *    that allows more than 3 applications a year, or fewer than 60 days between them,
 *    now takes the label's 3 applications and 60 days (EPA 10404-87 commercial label).
 *    A stricter row is left alone.
 *
 * 3. The liquid cap text. The Dimension 2EW dithiopyr cap row (fl oz) carried the
 *    granular's 16.38 lb of product per 1,000 sq ft in its description. It now says the
 *    formulation-neutral label limit, 1.5 lb dithiopyr per acre per year. The granular
 *    row keeps its 16.38 lb text.
 *
 * Idempotent. down(): each value goes back only while it still holds what this wrote;
 * the vendor row goes back to its prior values (and the rows created here are removed)
 * only while the catalog still points at it.
 */

const crypto = require('crypto');
const oct = require('./20261007120000_lawn_v13_october_dimension');

const ACTION = 'v13_dimension_siteone_row_reconcile';
const NAME = oct.NEW_NAME;
const VENDOR = 'SiteOne';
const SKU = '702032';
const PRICE = 44.23;
const QUANTITY = '50 lb';
const OUNCES = 800;
const SOURCE = 'v13_dimension_siteone_member_price_20261007';
const MAX_APPS = 3;
const MIN_DAYS = 60;
const CAP_GRANULAR_TEXT = '(EPA 10404-87 commercial label: no more than 16.38 lb of product per 1,000 sq ft per year = 1.5 lb dithiopyr per acre)';
const CAP_NEUTRAL_TEXT = '(1.5 lb dithiopyr per acre per year, the label\'s yearly maximum)';
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

// ── 2. weaker product limits ────────────────────────────────────────────────
const LIMIT_TARGETS = [
  { type: 'annual_max_apps', value: MAX_APPS, unit: 'applications', weaker: (current) => current > MAX_APPS },
  { type: 'min_interval_days', value: MIN_DAYS, unit: 'days', weaker: (current) => current < MIN_DAYS },
];

async function tightenLimits(knex, productId) {
  const rows = await knex('product_limits').where({ product_id: productId, match_type: 'product' }).select('id', 'limit_type', 'limit_value', 'limit_unit');
  const changes = [];
  for (const row of rows) {
    const target = LIMIT_TARGETS.find((candidate) => candidate.type === row.limit_type);
    if (!target || !target.weaker(Number(row.limit_value))) continue;
    changes.push({ id: row.id, before: { limit_value: row.limit_value, limit_unit: row.limit_unit }, after: { limit_value: target.value, limit_unit: target.unit } });
    await knex('product_limits').where({ id: row.id }).update({ limit_value: target.value, limit_unit: target.unit });
  }
  return changes;
}

async function restoreLimits(knex, changes) {
  for (const change of changes || []) {
    const row = await knex('product_limits').where({ id: change.id }).first('id', 'limit_value', 'limit_unit');
    if (row && same(row.limit_value, change.after.limit_value) && row.limit_unit === change.after.limit_unit) {
      await knex('product_limits').where({ id: change.id }).update(change.before);
    }
  }
}

// ── 3. the liquid cap text ──────────────────────────────────────────────────
async function neutralizeLiquidCapText(knex) {
  const caps = await knex('product_limits')
    .where({ match_type: 'active_ingredient', match_value: 'dithiopyr', limit_type: 'annual_max_rate' }).select('id', 'description', 'limit_unit');
  const changes = [];
  for (const cap of caps) {
    const text = String(cap.description || '');
    if (!String(cap.limit_unit).startsWith('fl oz') || !text.includes(CAP_GRANULAR_TEXT)) continue;
    const after = text.replace(CAP_GRANULAR_TEXT, CAP_NEUTRAL_TEXT);
    changes.push({ id: cap.id, before: text, after });
    await knex('product_limits').where({ id: cap.id }).update({ description: after });
  }
  return changes;
}

async function restoreCapText(knex, changes) {
  for (const change of changes || []) {
    const row = await knex('product_limits').where({ id: change.id }).first('id', 'description');
    if (row && row.description === change.after) await knex('product_limits').where({ id: change.id }).update({ description: change.before });
  }
}

// ── 1. the SiteOne row ──────────────────────────────────────────────────────
async function hasEligibleRow(knex, productId) {
  const { eligibleVendorPricing } = require('../../services/vendor-pricing-eligibility');
  const rows = await eligibleVendorPricing(knex('vendor_pricing').where({ product_id: productId })).select('vendor_pricing.id').limit(1);
  return rows.length > 0;
}

function measuredSize(product) {
  if (Number(product.unit_size_oz) > 0) return { ok: true, fill: null };
  return /^\s*50\s*lb\s*$/i.test(String(product.container_size || '')) ? { ok: true, fill: OUNCES } : { ok: false, fill: null };
}

function eligibleShape(now) {
  const perOz = PRICE / OUNCES;
  return {
    price: PRICE, price_amount: PRICE, quantity: QUANTITY, vendor_sku: SKU, price_type: 'manual', source_type: 'manual',
    approval_status: 'approved', is_active: true, currency: 'USD', last_checked_at: now, price_per_oz: perOz,
    normalized_unit_price: perOz, unit_normalized: 'oz', expires_at: null, availability_status: 'unknown',
  };
}

async function writeHistory(knex, productId, vendorId, vendorPricingId, now) {
  const perOz = PRICE / OUNCES;
  const [history] = await knex('price_history').insert({ product_id: productId, vendor_id: vendorId, price: PRICE, quantity: QUANTITY, source: 'manual' }).returning('id');
  const [snapshot] = await knex('price_snapshots').insert({
    product_id: productId, vendor_id: vendorId, vendor_pricing_id: vendorPricingId, price: PRICE, price_amount: PRICE, quantity: QUANTITY,
    normalized_unit_price: perOz, normalized_unit: 'oz', fetched_at: now, captured_at: now, source_type: 'manual', price_type: 'manual',
    availability_status: 'unknown', metadata: { source: SOURCE, memberPrice: true, reconciledRow: true },
  }).returning('id');
  return { priceHistoryId: history.id, snapshotId: snapshot.id };
}

async function reconcileSiteOneRow(knex, productId) {
  const vendors = await knex('vendors').where({ name: VENDOR }).select('id');
  if (vendors.length !== 1) return null;
  const existing = await knex('vendor_pricing').where({ product_id: productId, vendor_id: vendors[0].id }).first();
  const product = await knex('products_catalog').where({ id: productId }).first();
  const size = measuredSize(product);
  if (!existing || !size.ok || await hasEligibleRow(knex, productId)) return null;

  const now = new Date();
  const shape = eligibleShape(now);
  const columns = [...Object.keys(shape), 'latest_snapshot_id', 'previous_price', 'is_best_price'];
  const rowBefore = Object.fromEntries(columns.map((column) => [column, existing[column] ?? null]));
  const catalogBefore = Object.fromEntries(CATALOG_COLUMNS.map((column) => [column, product[column] ?? null]));
  if (size.fill) await knex('products_catalog').where({ id: productId }).update({ unit_size_oz: size.fill });
  await knex('vendor_pricing').where({ id: existing.id }).update({ ...shape, previous_price: existing.price });
  const created = await writeHistory(knex, productId, vendors[0].id, existing.id, now);
  await knex('vendor_pricing').where({ id: existing.id }).update({ latest_snapshot_id: created.snapshotId });
  const { recalcBestPrice } = require('../../routes/admin-inventory');
  await recalcBestPrice(productId, knex);
  const after = await knex('products_catalog').where({ id: productId }).first();
  return {
    productId, vendorPricingId: existing.id, ...created, rowBefore, catalogBefore,
    catalogAfter: Object.fromEntries(CATALOG_COLUMNS.map((column) => [column, after[column] ?? null])),
  };
}

async function revertSiteOneRow(knex, snapshot) {
  const catalog = await knex('products_catalog').where({ id: snapshot.productId }).first('id', 'best_vendor_pricing_id');
  // A later re-price (the catalog points at another row) keeps the row as it is.
  if (!catalog || String(catalog.best_vendor_pricing_id) !== String(snapshot.vendorPricingId)) return;
  await knex('products_catalog').where({ id: snapshot.productId }).update(snapshot.catalogBefore);
  await knex('vendor_pricing').where({ id: snapshot.vendorPricingId }).update(snapshot.rowBefore);
  await knex('price_snapshots').where({ id: snapshot.snapshotId }).del();
  await knex('price_history').where({ id: snapshot.priceHistoryId }).del();
}

const LIMIT_TABLES = ['product_limits', 'products_catalog', 'lawn_protocol_audit_log'];
const PRICE_TABLES = ['vendor_pricing', 'vendors', 'price_history', 'price_snapshots'];

exports.up = async function up(knex) {
  if (!(await hasTables(knex, LIMIT_TABLES))) return;
  const caps = await neutralizeLiquidCapText(knex);
  const productId = await resolveDimensionId(knex);
  const limits = productId ? await tightenLimits(knex, productId) : [];
  const price = productId && await hasTables(knex, PRICE_TABLES) ? await reconcileSiteOneRow(knex, productId) : null;
  if (!caps.length && !limits.length && !price) return;
  await knex('lawn_protocol_audit_log').insert({
    lawn_protocol_id: null,
    actor_name: 'migration 20261007133000',
    entity_type: 'catalog',
    entity_id: crypto.randomUUID(),
    action: ACTION,
    changed_fields: JSON.stringify(['limits', 'caps', 'vendor_pricing']),
    before_snapshot: JSON.stringify({}),
    after_snapshot: JSON.stringify({ caps, limits, price }),
    metadata: JSON.stringify({ migration: '20261007133000_lawn_v13_dimension_siteone_row_reconcile' }),
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('lawn_protocol_audit_log'))) return;
  const logs = await knex('lawn_protocol_audit_log').where({ action: ACTION }).select('id', 'after_snapshot');
  for (const log of logs) {
    const after = asObject(log.after_snapshot);
    await restoreCapText(knex, after.caps);
    await restoreLimits(knex, after.limits);
    if (after.price) await revertSiteOneRow(knex, after.price);
    await knex('lawn_protocol_audit_log').where({ id: log.id }).del();
  }
};

exports.ACTION = ACTION;
exports.CAP_NEUTRAL_TEXT = CAP_NEUTRAL_TEXT;
exports.CAP_GRANULAR_TEXT = CAP_GRANULAR_TEXT;
