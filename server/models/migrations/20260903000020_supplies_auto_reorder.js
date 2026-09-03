/**
 * Migration — supplies auto-reorder (PR 1 of the supplies auto-purchase lane)
 *
 * 1. products_catalog gains the auto-reorder + per-completion consumable
 *    columns the daily sweep and the closeout hook read.
 * 2. product_inventory_movements gains a partial UNIQUE expression index so
 *    the completion-consumable movement is at-most-once per
 *    (product, visit) — the closeout resume path re-runs the hook and must
 *    not double-decrement. The table has no `source` column; existing
 *    writers keep it in metadata.source, so the predicate does too.
 *    product_restock_requests gains a partial UNIQUE index (one live
 *    open|ordered auto_reorder request per product) so the sweep's dedupe
 *    is a DB invariant, not a read-then-write.
 * 3. Seeds: vendor Gemplers (code 24) and the yard-sign kit — the 4×5
 *    pesticide-application sign card (Gemplers 127544), its 16" plastic
 *    stake (Gemplers 222377), and the "Serviced by Waves" sticker (vendor
 *    row lands in PR 2 with the Sticker Mule item id). Opening counts are
 *    the owner's 2026-09-03 ruling: 650 bought 2026-07-28, ~10 used.
 *    Seeds are idempotent by name: an existing row only gets its NULL
 *    auto-reorder fields filled, so admin edits survive a re-run.
 *
 * down(): drops the columns + index. The seed rollback is a DOCUMENTED
 * NO-OP — a blanket delete would erase exactly the admin edits up()
 * preserves (waves-db §4).
 */
const GEMPLERS = { name: 'Gemplers', code: 24, type: 'online', website: 'https://gemplers.com', notes: 'Pesticide application signs + stakes (yard-sign kit). Shopify store, no reorder API.', scraping_priority: 'skip' };

const KIT = [
  {
    name: 'Pesticide application sign 4x5 (yard sign card)',
    category: 'supplies',
    inventory_on_hand: 640,
    low_stock_threshold: 100,
    reorder_quantity: 650,
    pricing: { vendor_sku: '127544', price: 13.39, quantity: '25', vendor_product_url: 'https://gemplers.com/products/universal-pesticide-application-signs' },
  },
  {
    name: 'Yard sign stake 16in plastic (Blackburn)',
    category: 'supplies',
    inventory_on_hand: 640,
    low_stock_threshold: 100,
    reorder_quantity: 100,
    pricing: { vendor_sku: '222377', price: 3.99, quantity: '25', vendor_product_url: 'https://gemplers.com/products/blackburn-plastic-stakes-for-pesticide-application-warning-signs' },
  },
  {
    name: 'Yard sign sticker 4x5 "Serviced by Waves"',
    category: 'supplies',
    inventory_on_hand: 0,
    low_stock_threshold: 50,
    reorder_quantity: 500,
    pricing: null,
  },
];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;

  const cols = await knex('products_catalog').columnInfo();
  await knex.schema.alterTable('products_catalog', (t) => {
    if (!cols.reorder_quantity) t.decimal('reorder_quantity', 12, 4);
    if (!cols.auto_reorder_vendor_id) t.uuid('auto_reorder_vendor_id').references('id').inTable('vendors').onDelete('SET NULL');
    if (!cols.auto_reorder_enabled) t.boolean('auto_reorder_enabled').notNullable().defaultTo(false);
    if (!cols.per_completion_usage) t.decimal('per_completion_usage', 12, 4);
  });

  if (await knex.schema.hasTable('product_inventory_movements')) {
    await knex.raw(`
      CREATE UNIQUE INDEX IF NOT EXISTS product_inventory_movements_completion_consumable_uniq
        ON product_inventory_movements (product_id, scheduled_service_id)
        WHERE (metadata->>'source') = 'completion_consumable'
    `);
  }

  if (await knex.schema.hasTable('product_restock_requests')) {
    // The sweep's dedupe is enforced HERE, not by its read-then-write:
    // at most one live (open|ordered) auto_reorder request per product.
    await knex.raw(`
      CREATE UNIQUE INDEX IF NOT EXISTS product_restock_requests_auto_reorder_live_uniq
        ON product_restock_requests (product_id)
        WHERE status IN ('open', 'ordered') AND source = 'auto_reorder'
    `);
  }

  if (!(await knex.schema.hasTable('vendors'))) return;

  let gemplers = await knex('vendors').whereRaw('LOWER(name) = ?', [GEMPLERS.name.toLowerCase()]).first();
  if (!gemplers) {
    const hasCode = await knex.schema.hasColumn('vendors', 'code');
    const row = { ...GEMPLERS };
    if (!hasCode) delete row.code;
    [gemplers] = await knex('vendors').insert(row).returning('*');
  }

  const hasPricing = await knex.schema.hasTable('vendor_pricing');
  const hasMovements = await knex.schema.hasTable('product_inventory_movements');
  for (const item of KIT) {
    const existing = await knex('products_catalog').whereRaw('LOWER(name) = ?', [item.name.toLowerCase()]).first();
    if (existing) {
      // Admin-owned row: fill ONLY the auto-reorder fields that are still
      // null (a re-run after a rollback dropped them), never a value an
      // admin may have edited. Enablement follows the same rule: switched
      // on only when the row has never been configured.
      const fill = {};
      if (existing.reorder_quantity == null) { fill.reorder_quantity = item.reorder_quantity; fill.auto_reorder_enabled = true; }
      if (existing.per_completion_usage == null) fill.per_completion_usage = 1;
      if (existing.auto_reorder_vendor_id == null && item.pricing) fill.auto_reorder_vendor_id = gemplers.id;
      if (Object.keys(fill).length) await knex('products_catalog').where({ id: existing.id }).update(fill);
      continue;
    }
    const [product] = await knex('products_catalog').insert({
      name: item.name,
      category: item.category,
      inventory_unit: 'each',
      inventory_on_hand: item.inventory_on_hand,
      low_stock_threshold: item.low_stock_threshold,
      reorder_quantity: item.reorder_quantity,
      per_completion_usage: 1,
      auto_reorder_enabled: true,
      auto_reorder_vendor_id: item.pricing ? gemplers.id : null,
      needs_pricing: false,
      customer_visibility: 'internal_only',
    }).returning('*');

    if (item.pricing && hasPricing) {
      await knex('vendor_pricing').insert({
        product_id: product.id,
        vendor_id: gemplers.id,
        price: item.pricing.price,
        quantity: item.pricing.quantity,
        unit: 'each',
        vendor_sku: item.pricing.vendor_sku,
        vendor_product_url: item.pricing.vendor_product_url,
        is_best_price: true,
      });
    }
    if (hasMovements && item.inventory_on_hand > 0) {
      await knex('product_inventory_movements').insert({
        product_id: product.id,
        movement_type: 'restock',
        quantity: item.inventory_on_hand,
        unit: 'each',
        stock_before: 0,
        stock_after: item.inventory_on_hand,
        metadata: { source: 'seed_migration', reason: 'Opening count — Gemplers order #666365 (2026-07-28) less ~10 used, owner ruling 2026-09-03' },
      });
    }
  }
};

exports.down = async function down(knex) {
  // Seeded vendor/product/pricing/movement rows are intentionally left in
  // place (documented no-op — they may carry admin edits by now).
  if (await knex.schema.hasTable('product_inventory_movements')) {
    await knex.raw('DROP INDEX IF EXISTS product_inventory_movements_completion_consumable_uniq');
  }
  if (await knex.schema.hasTable('product_restock_requests')) {
    await knex.raw('DROP INDEX IF EXISTS product_restock_requests_auto_reorder_live_uniq');
  }
  if (!(await knex.schema.hasTable('products_catalog'))) return;
  const cols = await knex('products_catalog').columnInfo();
  await knex.schema.alterTable('products_catalog', (t) => {
    if (cols.per_completion_usage) t.dropColumn('per_completion_usage');
    if (cols.auto_reorder_enabled) t.dropColumn('auto_reorder_enabled');
    if (cols.auto_reorder_vendor_id) t.dropColumn('auto_reorder_vendor_id');
    if (cols.reorder_quantity) t.dropColumn('reorder_quantity');
  });
};
