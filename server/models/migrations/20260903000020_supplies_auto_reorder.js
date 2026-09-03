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

// Owner ruling 2026-09-03: a yard sign is left on pest (recurring + one-time),
// mosquito, lawn and tree & shrub visits — not termite, rodent or palm.
const KIT_SERVICE_LINES = ['pest', 'mosquito', 'lawn', 'tree_shrub'];

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

function unitCost(item) {
  return Number((item.pricing.price / Number(item.pricing.quantity)).toFixed(4));
}

// Admin-owned row: fill ONLY the auto-reorder fields that are still null (a
// re-run after a rollback dropped them), never a value an admin may have
// edited. undefined = nothing to fill for this item. A row that never
// tracked stock can never sweep (findLowStockCandidates needs both counts
// non-null) and needs the unit those counts are in, or the sweep reports
// no_unit and the admin form cannot save stock values (GH codex r3 + r4 P2).
const FILL_WHEN_NULL = [
  ['reorder_quantity', (item) => item.reorder_quantity],
  ['per_completion_usage', () => 1],
  ['inventory_on_hand', (item) => item.inventory_on_hand],
  ['low_stock_threshold', (item) => item.low_stock_threshold],
  ['inventory_unit', () => 'each'],
  ['per_completion_service_lines', () => JSON.stringify(KIT_SERVICE_LINES)],
  ['auto_reorder_vendor_id', (item, ctx) => (item.pricing ? ctx.vendorId : undefined)],
  ['cost_per_unit', (item) => (item.pricing ? unitCost(item) : undefined)],
];

function fillFor(existing, item, ctx) {
  const fill = {};
  for (const [col, valueFor] of FILL_WHEN_NULL) {
    const value = existing[col] == null ? valueFor(item, ctx) : undefined;
    if (value !== undefined) fill[col] = value;
  }
  // Enablement follows the same rule: switched on only when the row has
  // never been configured; the cost unit travels with the cost.
  if (fill.reorder_quantity != null) fill.auto_reorder_enabled = true;
  if (fill.cost_per_unit != null) fill.cost_unit = 'each';
  return fill;
}

function newProductRow(item, ctx) {
  return {
    name: item.name,
    category: item.category,
    inventory_unit: 'each',
    inventory_on_hand: item.inventory_on_hand,
    low_stock_threshold: item.low_stock_threshold,
    reorder_quantity: item.reorder_quantity,
    per_completion_usage: 1,
    per_completion_service_lines: JSON.stringify(KIT_SERVICE_LINES),
    auto_reorder_enabled: true,
    auto_reorder_vendor_id: item.pricing ? ctx.vendorId : null,
    // Priced kit items leave the pricing queue; the sticker (no vendor,
    // no price until PR 2) stays in it.
    needs_pricing: !item.pricing,
    // Per-unit cost so completion movements carry cost_used for job
    // costing (pack price / pack size).
    ...(item.pricing ? { cost_per_unit: unitCost(item), cost_unit: 'each' } : {}),
    customer_visibility: 'internal_only',
  };
}

function pricingRow(productId, item, ctx) {
  return {
    product_id: productId,
    vendor_id: ctx.vendorId,
    price: item.pricing.price,
    quantity: item.pricing.quantity,
    unit: 'each',
    vendor_sku: item.pricing.vendor_sku,
    vendor_product_url: item.pricing.vendor_product_url,
    is_best_price: true,
    // Owner-supplied manual price: the best-price recalc only accepts
    // approved / auto_approved rows, and the column defaults to pending
    // (GH codex r3 P2). Same shape as the 20260710 pre-slab seed.
    ...(ctx.hasApproval ? { approval_status: 'approved' } : {}),
  };
}

function openingMovement(productId, onHand) {
  return {
    product_id: productId,
    movement_type: 'restock',
    quantity: onHand,
    unit: 'each',
    stock_before: 0,
    stock_after: onHand,
    metadata: { source: 'seed_migration', reason: 'Opening count from the prior Gemplers purchase (2026-07-28) less ~10 used, owner ruling 2026-09-03' },
  };
}

// The vendor price (SKU + order link) and, when THIS run seeded the opening
// count, the ledger movement that explains it — both idempotent (pre-push
// codex P1). Shared by the new-row and reused-row paths.
async function seedPriceAndOpening(knex, productId, item, ctx, seededOnHand) {
  if (item.pricing && ctx.hasPricing) {
    const priced = await knex('vendor_pricing').where({ product_id: productId, vendor_id: ctx.vendorId }).first('id');
    if (!priced) await knex('vendor_pricing').insert(pricingRow(productId, item, ctx));
  }
  if (ctx.hasMovements && seededOnHand > 0) await knex('product_inventory_movements').insert(openingMovement(productId, seededOnHand));
}

async function seedKitItem(knex, item, ctx) {
  const existing = await knex('products_catalog').whereRaw('LOWER(name) = ?', [item.name.toLowerCase()]).first();
  if (existing) {
    const fill = fillFor(existing, item, ctx);
    if (Object.keys(fill).length) await knex('products_catalog').where({ id: existing.id }).update(fill);
    await seedPriceAndOpening(knex, existing.id, item, ctx, fill.inventory_on_hand ?? 0);
    return;
  }
  const [product] = await knex('products_catalog').insert(newProductRow(item, ctx)).returning('*');
  await seedPriceAndOpening(knex, product.id, item, ctx, item.inventory_on_hand);
}

// A hand-created Gemplers row must still carry the reserved code so
// code-based vendor lookups (.claude/vendor-codes.md) find it; a conflicting
// non-null code is a real inconsistency — fail loudly.
async function ensureGemplers(knex) {
  const hasCode = await knex.schema.hasColumn('vendors', 'code');
  const existing = await knex('vendors').whereRaw('LOWER(name) = ?', [GEMPLERS.name.toLowerCase()]).first();
  if (!existing) {
    const row = { ...GEMPLERS };
    if (!hasCode) delete row.code;
    const [inserted] = await knex('vendors').insert(row).returning('*');
    return inserted;
  }
  if (hasCode && existing.code == null) await knex('vendors').where({ id: existing.id }).update({ code: GEMPLERS.code });
  if (hasCode && existing.code != null && Number(existing.code) !== GEMPLERS.code) {
    throw new Error(`vendors row "${existing.name}" has code ${existing.code}; expected ${GEMPLERS.code} (.claude/vendor-codes.md)`);
  }
  return existing;
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;

  const cols = await knex('products_catalog').columnInfo();
  await knex.schema.alterTable('products_catalog', (t) => {
    if (!cols.reorder_quantity) t.decimal('reorder_quantity', 12, 4);
    if (!cols.auto_reorder_vendor_id) t.uuid('auto_reorder_vendor_id').references('id').inTable('vendors').onDelete('SET NULL');
    if (!cols.auto_reorder_enabled) t.boolean('auto_reorder_enabled').notNullable().defaultTo(false);
    if (!cols.per_completion_usage) t.decimal('per_completion_usage', 12, 4);
    // null = every service line; else an array of detectServiceLine ids
    // (pest|lawn|mosquito|termite|rodent|tree_shrub|palm).
    if (!cols.per_completion_service_lines) t.jsonb('per_completion_service_lines');
  });

  const hasMovements = await knex.schema.hasTable('product_inventory_movements');
  if (hasMovements) {
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
  const gemplers = await ensureGemplers(knex);
  const hasPricing = await knex.schema.hasTable('vendor_pricing');
  const ctx = {
    vendorId: gemplers.id,
    hasPricing,
    hasApproval: hasPricing && await knex.schema.hasColumn('vendor_pricing', 'approval_status'),
    hasMovements,
  };
  for (const item of KIT) await seedKitItem(knex, item, ctx);
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
    if (cols.per_completion_service_lines) t.dropColumn('per_completion_service_lines');
    if (cols.per_completion_usage) t.dropColumn('per_completion_usage');
    if (cols.auto_reorder_enabled) t.dropColumn('auto_reorder_enabled');
    if (cols.auto_reorder_vendor_id) t.dropColumn('auto_reorder_vendor_id');
    if (cols.reorder_quantity) t.dropColumn('reorder_quantity');
  });
};
