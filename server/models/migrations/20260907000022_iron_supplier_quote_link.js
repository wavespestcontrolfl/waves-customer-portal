/**
 * Forward correction for the published 000019 supplier quote. SiteOne lists
 * family 9999903964 with 2.5-gallon item 084043. Preserve the original quote
 * snapshot and append the verified source link; no price or stock changes.
 */
const SOURCE = 'migration.20260907000022.iron_supplier_link';
const QUOTE_SOURCE = 'migration.20260907000019.iron_supplier_quote';
const QUOTED_AT = new Date('2026-09-07T09:30:07.566Z');
const URL = 'https://www.siteone.com/en/9999903964-lesco-chelated-iron-plus-12-0-0-6fe-2mn-all-purpose-liquid-fertilizer/p/571634';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;
  const { recordAuditEvent } = require('../../services/audit-log');
  const applied = await knex('audit_log').where({ action: QUOTE_SOURCE }).first();
  if (!applied) return;
  const productId = applied.resource_id;
  await knex.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?))', ['inventory.best_price', String(productId)]);
  if (await knex('audit_log').where({ action: SOURCE, resource_id: productId }).first()) return;
  // Exact quote provenance and timestamp fence: a later manual edit wins.
  const quote = await knex('vendor_pricing').where({ product_id: productId, vendor_sku: '9999903964',
    price_type: 'manual', source_type: 'manual', quantity: '2.5 gal', price_amount: 36.15,
    last_checked_at: QUOTED_AT }).forUpdate().first();
  if (!quote) return;
  const original = await knex('price_snapshots').where({ id: quote.latest_snapshot_id,
    product_id: productId, vendor_id: quote.vendor_id }).first();
  if (original?.metadata?.source !== QUOTE_SOURCE) return;
  const [snapshot] = await knex('price_snapshots').insert({
    product_id: productId, vendor_id: quote.vendor_id, vendor_pricing_id: quote.id,
    price: original.price, price_amount: original.price_amount, quantity: original.quantity,
    normalized_unit_price: original.normalized_unit_price, normalized_unit: original.normalized_unit,
    fetched_at: original.fetched_at, captured_at: original.captured_at,
    source_type: original.source_type, price_type: original.price_type,
    availability_status: original.availability_status, source_url: URL,
    metadata: { ...original.metadata, source: SOURCE, familyCode: '9999903964', sku: '084043',
      supersedesSnapshotId: original.id },
  }).returning('id');
  await knex('vendor_pricing').where({ id: quote.id }).update({ vendor_product_url: URL,
    vendor_sku: '084043', latest_snapshot_id: snapshot.id, updated_at: knex.fn.now() });
  await recordAuditEvent({ actor_type: 'system', action: SOURCE, resource_type: 'product',
    resource_id: productId, critical: true, trx: knex,
    metadata: { vendorPricingId: quote.id, priorSku: quote.vendor_sku,
      priorUrl: quote.vendor_product_url, familyCode: '9999903964', sku: '084043', url: URL,
      originalSnapshotId: original.id, snapshotId: snapshot.id,
      basis: 'SiteOne product page and 084043 label identify the 2.5-gallon item; price unchanged' } });
  console.info('[iron_supplier_quote_link] verified SiteOne item and source link recorded');
};

// Keep source corrections and subsequent manual edits in the historical record.
exports.down = async function down() {};
