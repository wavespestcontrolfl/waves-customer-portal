/**
 * Lawn protocol v13, before the GATE_LAWN_V13 flip: the SiteOne price seed, finalized
 * (Codex round 4 on #6084). 20261007120000, 20261007130000, 20261007133000 and
 * 20261007134000 are pushed and frozen. The price seed has been patched three rounds in a
 * row for edge cases; this migration closes the three remaining structural gaps.
 *
 * up(), for the alias-resolved Dimension 0.21% 18-0-10 product:
 *   (a) Stale landed costs. 133000 updated a pre-existing SiteOne row to the $44.23 / 702032
 *       shape but, unlike the owner's supplier-cost migration (20260907000020), did not clear
 *       the landed and shipping fields. A row left over from an old scrape could still carry a
 *       landed unit price, shipping or tax, and the ranking prefers landed over sticker. Where
 *       the row 133000 reconciled still holds the $44.23 / 702032 values, landed_unit_price,
 *       landed_cost, shipping_cost, shipping_estimate and tax_rate are cleared (the fields
 *       20260907000020 clears for a sticker-price quote).
 *   (b) A canonical winner. 130000 wrote best_price on the catalog row directly; 133000 and
 *       134000 call recalcBestPrice only where they write a row. A product that already had
 *       another eligible vendor row (so neither wrote) kept 130000's direct price with no
 *       winner or cache fields. Wherever the product has an eligible vendor row,
 *       recalcBestPrice now runs: the one writer of best_price, best_vendor,
 *       best_vendor_pricing_id, the cache fields and the status. With NO eligible row it is
 *       not called: it would null the only price the catalog has.
 *   What changed is audited.
 *
 * down(), non-destructive for later edits:
 *   - undoes only what this migration wrote: a cleared landed field goes back while it is
 *     still empty; the catalog goes back while it still holds what the recalculation wrote.
 *   - 133000 and 134000 delete the vendor row they wrote when the catalog still points at it,
 *     even if an admin has since re-quoted it. Before their frozen downs run, if the row no
 *     longer holds what they wrote (price, package, SKU, status, or a newer snapshot), the
 *     price entry of their audit row is neutralized, so their downs leave the row, its
 *     history and snapshots, and the catalog alone. Their cap and limit reverts still run.
 * Roll back in order: this one, then 134000, 133000.
 */

const crypto = require('crypto');
const siteOne = require('./20261007133000_lawn_v13_dimension_siteone_row_reconcile');
const priceCap = require('./20261007134000_lawn_v13_dimension_price_and_cap_clamp');
const oct = require('./20261007120000_lawn_v13_october_dimension');

const ACTION = 'v13_dimension_price_finalize';
const NAME = oct.NEW_NAME;
const PRICE = priceCap.PRICE;
const SKU = '702032';
const QUANTITY = '50 lb';
const LANDED_COLUMNS = ['landed_unit_price', 'landed_cost', 'shipping_cost', 'shipping_estimate', 'tax_rate'];
const CATALOG_COLUMNS = [
  'best_price', 'best_vendor', 'best_vendor_pricing_id', 'best_price_amount_cached', 'best_price_vendor_id_cached',
  'best_price_updated_at', 'best_price_status', 'needs_pricing', 'cost_per_unit', 'cost_unit',
];
// The recalculation restamps this on every run; it does not make a change.
const VOLATILE = new Set(['best_price_updated_at']);
const TABLES = ['products_catalog', 'vendor_pricing', 'lawn_protocol_audit_log'];

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

async function hasEligibleRow(knex, productId) {
  const { eligibleVendorPricing } = require('../../services/vendor-pricing-eligibility');
  const rows = await eligibleVendorPricing(knex('vendor_pricing').where({ product_id: productId })).select('vendor_pricing.id').limit(1);
  return rows.length > 0;
}

// Does a vendor row still hold the sticker quote 133000 / 134000 wrote?
function holdsSeededQuote(row, snapshotId) {
  return Boolean(row)
    && same(row.price, PRICE) && same(row.price_amount, PRICE) && row.quantity === QUANTITY && row.vendor_sku === SKU
    && row.price_type === 'manual' && row.approval_status === 'approved' && row.is_active === true
    && (snapshotId == null || String(row.latest_snapshot_id) === String(snapshotId));
}

// ── up (a): landed fields on the row 133000 reconciled ──────────────────────
async function clearLandedFields(knex) {
  const logs = await knex('lawn_protocol_audit_log').where({ action: siteOne.ACTION }).select('after_snapshot');
  const cleared = [];
  for (const log of logs) {
    const price = asObject(log.after_snapshot).price;
    const row = price ? await knex('vendor_pricing').where({ id: price.vendorPricingId }).first() : null;
    if (!holdsSeededQuote(row, null)) continue;
    const before = Object.fromEntries(LANDED_COLUMNS.filter((column) => row[column] != null).map((column) => [column, row[column]]));
    if (!Object.keys(before).length) continue;
    await knex('vendor_pricing').where({ id: row.id }).update(Object.fromEntries(Object.keys(before).map((column) => [column, null])));
    cleared.push({ vendorPricingId: row.id, before });
  }
  return cleared;
}

// ── up (b): the canonical winner ────────────────────────────────────────────
function catalogColumns(row) {
  return Object.fromEntries(CATALOG_COLUMNS.map((column) => [column, row[column] ?? null]));
}

function catalogDiffers(a, b) {
  return CATALOG_COLUMNS.some((column) => !VOLATILE.has(column) && !same(a[column], b[column]));
}

async function recalcWhereEligible(knex, productId) {
  if (!(await hasEligibleRow(knex, productId))) return null;
  const before = catalogColumns(await knex('products_catalog').where({ id: productId }).first());
  const { recalcBestPrice } = require('../../routes/admin-inventory');
  await recalcBestPrice(productId, knex);
  const after = catalogColumns(await knex('products_catalog').where({ id: productId }).first());
  return catalogDiffers(before, after) ? { productId, before, after } : null;
}

// ── down ────────────────────────────────────────────────────────────────────
async function restoreLandedFields(knex, cleared) {
  for (const entry of cleared || []) {
    const row = await knex('vendor_pricing').where({ id: entry.vendorPricingId }).first();
    if (!row) continue;
    const restore = Object.fromEntries(Object.entries(entry.before).filter(([column]) => row[column] == null));
    if (Object.keys(restore).length) await knex('vendor_pricing').where({ id: row.id }).update(restore);
  }
}

async function restoreCatalog(knex, catalog) {
  if (!catalog) return;
  const row = await knex('products_catalog').where({ id: catalog.productId }).first();
  if (row && !catalogDiffers(catalogColumns(row), catalog.after)) await knex('products_catalog').where({ id: catalog.productId }).update(catalog.before);
}

// A frozen migration's down deletes the vendor row it wrote while the catalog points at it,
// even after an admin re-quoted that row. Drop the price entry of its audit row when the row
// no longer holds the seeded quote, so its down leaves the row, history and catalog alone.
async function neutralizeRequoted(knex, action) {
  const logs = await knex('lawn_protocol_audit_log').where({ action }).select('id', 'after_snapshot');
  for (const log of logs) {
    const after = asObject(log.after_snapshot);
    if (!after.price) continue;
    const row = await knex('vendor_pricing').where({ id: after.price.vendorPricingId }).first();
    if (holdsSeededQuote(row, after.price.snapshotId)) continue;
    await knex('lawn_protocol_audit_log').where({ id: log.id }).update({ after_snapshot: JSON.stringify({ ...after, price: null }) });
  }
}

exports.up = async function up(knex) {
  if (!(await hasTables(knex, TABLES))) return;
  const productId = await resolveDimensionId(knex);
  if (!productId) return;
  const landed = await clearLandedFields(knex);
  const catalog = await recalcWhereEligible(knex, productId);
  if (!landed.length && !catalog) return;
  await knex('lawn_protocol_audit_log').insert({
    lawn_protocol_id: null,
    actor_name: 'migration 20261007136000',
    entity_type: 'catalog',
    entity_id: crypto.randomUUID(),
    action: ACTION,
    changed_fields: JSON.stringify(['vendor_pricing', 'catalog']),
    before_snapshot: JSON.stringify({}),
    after_snapshot: JSON.stringify({ landed, catalog }),
    metadata: JSON.stringify({ migration: '20261007136000_lawn_v13_dimension_price_finalize' }),
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('lawn_protocol_audit_log'))) return;
  const logs = await knex('lawn_protocol_audit_log').where({ action: ACTION }).select('id', 'after_snapshot');
  for (const log of logs) {
    const after = asObject(log.after_snapshot);
    await restoreLandedFields(knex, after.landed);
    await restoreCatalog(knex, after.catalog);
    await knex('lawn_protocol_audit_log').where({ id: log.id }).del();
  }
  if (!(await knex.schema.hasTable('vendor_pricing'))) return;
  await neutralizeRequoted(knex, siteOne.ACTION);
  await neutralizeRequoted(knex, priceCap.ACTION);
};

exports.ACTION = ACTION;
exports.LANDED_COLUMNS = LANDED_COLUMNS;
