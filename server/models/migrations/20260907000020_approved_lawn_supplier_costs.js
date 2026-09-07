/**
 * Owner-supplied SiteOne sticker prices, captured 2026-09-07T06:49:31.678Z.
 * No purchase, stock receipt, tax/freight assumption, or application-rate change.
 * Catalog winner updates use the existing inventory price recalculation.
 */
const SOURCE = 'owner_siteone_20260907';
const QUOTED_AT = new Date('2026-09-07T06:49:31.678Z');
const QUOTES = [
  { name: 'Celsius WG', sku: 'D00001204', price: 133.20, quantity: '0.625 lb', ounces: 10, unit: 'lb',
    url: 'https://www.siteone.com/en/d00001204-celsius-wg-post-emergent-water-dispersible-granule-herbicide-10-oz-agency/p/1033922' },
  { name: 'Acelepryn Xtra', sku: '79572', price: 150, quantity: '30 fl oz', ounces: 30, unit: 'fl_oz',
    url: 'https://www.siteone.com/en/79572-acelepryn-xtra-liquid-insecticide-30-fl-oz-bottle-agency/p/894924' },
];

exports.up = async function up(knex) {
  const { recalcBestPrice } = require('../../routes/admin-inventory');
  const { applyInventoryUnitFix } = require('../../services/inventory-unit-review');
  const { unitDefinition } = require('../../services/inventory-units');
  const { recordAuditEvent } = require('../../services/audit-log');
  const vendors = await knex('vendors').where({ name: 'SiteOne' });
  if (vendors.length !== 1) throw new Error('Expected one SiteOne vendor');
  for (const quote of QUOTES) {
    const matches = await knex('products_catalog').where({ name: quote.name });
    if (matches.length !== 1) throw new Error(`Expected one catalog product: ${quote.name}`);
    const productId = matches[0].id;
    await knex.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?))', ['inventory.best_price', String(productId)]);
    const product = await knex('products_catalog').where({ id: productId }).forUpdate().first();
    const prior = await knex('audit_log').where({ action: SOURCE, resource_id: String(productId) }).first();
    if (prior) continue;
    const existingRows = await knex('vendor_pricing').where({ product_id: productId, vendor_id: vendors[0].id }).forUpdate();
    if (existingRows.length > 1) throw new Error(`Multiple SiteOne rows: ${quote.name}`);
    const existing = existingRows[0];
    // Preserve a subsequently entered manual quote. Seed timestamps are not
    // evidence of a newer supplier observation.
    if (existing?.price_type === 'manual' && existing.last_checked_at > QUOTED_AT) continue;
    // Never reinterpret an unknown stock quantity or overwrite an incompatible
    // package/cost basis. Such rows need the existing inventory review flow.
    const { dimension } = unitDefinition(product.inventory_unit) || {};
    const expectedDimension = unitDefinition(quote.unit).dimension;
    if ((['weight', 'volume', 'count'].includes(dimension) && dimension !== expectedDimension)
      || (!dimension && (product.inventory_on_hand != null || product.low_stock_threshold != null))
      || (product.unit_size_oz != null && Number(product.unit_size_oz) !== quote.ounces)
      || product.cost_per_unit != null) {
      throw new Error(`Inventory basis needs review: ${quote.name}`);
    }
    await applyInventoryUnitFix({ dbi: knex, productId, nextUnit: quote.unit,
      expectedCurrentUnit: product.inventory_unit, movementSource: SOURCE });
    await knex('products_catalog').where({ id: productId }).update({
      container_size: quote.quantity, unit_size_oz: quote.ounces,
    });
    const perOz = quote.price / quote.ounces;
    const fields = {
      price: quote.price, price_amount: quote.price, quantity: quote.quantity,
      vendor_sku: quote.sku, vendor_product_url: quote.url,
      price_type: 'manual', source_type: 'manual', approval_status: 'approved',
      is_active: true, currency: 'USD', last_checked_at: QUOTED_AT,
      price_per_oz: perOz, normalized_unit_price: perOz, unit_normalized: 'oz',
      shipping_cost: null, shipping_estimate: null, tax_rate: null,
      landed_cost: null, landed_unit_price: null, expires_at: null,
      availability: null, availability_status: 'unknown',
    };
    let savedRows;
    if (existing) {
      savedRows = await knex('vendor_pricing').where({ id: existing.id })
        .update({ ...fields, previous_price: existing.price }).returning('id');
    } else {
      savedRows = await knex('vendor_pricing')
        .insert({ ...fields, product_id: productId, vendor_id: vendors[0].id }).returning('id');
    }
    await knex('price_history').insert({ product_id: productId, vendor_id: vendors[0].id,
      price: quote.price, quantity: quote.quantity, source: 'manual' });
    const [snapshot] = await knex('price_snapshots').insert({
      product_id: productId, vendor_id: vendors[0].id, vendor_pricing_id: savedRows[0].id,
      price: quote.price, price_amount: quote.price, quantity: quote.quantity,
      normalized_unit_price: perOz, normalized_unit: 'oz',
      fetched_at: QUOTED_AT, captured_at: QUOTED_AT,
      source_type: 'manual', price_type: 'manual', source_url: quote.url,
      availability_status: 'unknown', metadata: { source: SOURCE, stickerPriceOnly: true },
    }).returning('id');
    await knex('vendor_pricing').where({ id: savedRows[0].id }).update({ latest_snapshot_id: snapshot.id });
    await recalcBestPrice(productId, knex);
    await recordAuditEvent({ actor_type: 'system', action: SOURCE, resource_type: 'product',
      resource_id: String(productId), critical: true, trx: knex,
      metadata: { quote, quotedAt: QUOTED_AT.toISOString(), priorPrice: existing ? existing.price : null,
        priorContainerSize: product.container_size, priorInventoryUnit: product.inventory_unit,
        basis: 'Supplier sticker price only; shipping, tax and purchase quantity not supplied' } });
    console.info(`[approved_lawn_supplier_costs] ${quote.name}: SiteOne ${quote.price.toFixed(2)} USD / ${quote.quantity}; rates and purchase quantities untouched`);
  }
};

// Supplier observations and subsequent admin edits are historical evidence.
// A rollback must not erase them or restore stale prices.
exports.down = async function down() {};
