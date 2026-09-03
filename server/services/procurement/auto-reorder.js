/**
 * procurement/auto-reorder.js — daily low-stock → restock-request sweep.
 *
 * For every product with auto_reorder_enabled whose inventory_on_hand is at
 * or below low_stock_threshold and that has no open|ordered restock request,
 * insert ONE product_restock_requests row (source 'auto_reorder') carrying
 * the vendor, its SKU and product URL, then ring the office bell once per
 * request (deduped on the request id) so the reorder is a one-click job
 * until an order-placing adapter exists (PR 2).
 *
 * Gate: GATE_AUTO_REORDER, parsed at CALL time (gateEnvValue) — unset or any
 * non-truthy value is the live kill switch; the sweep returns
 * { skipped: 'gated' } before any DB read.
 *
 * Dedupe is on ANY open|ordered request for the product, not only the
 * sweep's own — a manual request the office already raised must not get an
 * automatic twin.
 */
const db = require('../../models/db');
const logger = require('../logger');
const { gateEnvValue } = require('../../config/feature-gates');

const GATE = 'GATE_AUTO_REORDER';
const SOURCE = 'auto_reorder';

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function findLowStockCandidates(conn = db) {
  return conn('products_catalog as pc')
    .leftJoin('vendors as v', 'v.id', 'pc.auto_reorder_vendor_id')
    .where('pc.auto_reorder_enabled', true)
    .whereNotNull('pc.inventory_on_hand')
    .whereNotNull('pc.low_stock_threshold')
    .whereRaw('pc.inventory_on_hand <= pc.low_stock_threshold')
    .select(
      'pc.id', 'pc.name', 'pc.inventory_on_hand', 'pc.inventory_unit', 'pc.low_stock_threshold',
      'pc.reorder_quantity', 'pc.auto_reorder_vendor_id',
      'v.name as vendor_name',
    )
    .orderBy('pc.name');
}

async function vendorPricingFor(conn, productId, vendorId) {
  if (!vendorId) return null;
  try {
    return await conn('vendor_pricing')
      .where({ product_id: productId, vendor_id: vendorId })
      .orderBy('is_best_price', 'desc')
      .first();
  } catch {
    return null;
  }
}

async function runSuppliesAutoReorderSweep({ conn = db, notify = null } = {}) {
  if (!gateEnvValue(GATE)) return { skipped: 'gated', created: [], deduped: [], unconfigured: [] };
  const result = { created: [], deduped: [], unconfigured: [], errors: [] };

  const candidates = await findLowStockCandidates(conn);
  for (const p of candidates) {
    try {
      const reorderQty = num(p.reorder_quantity);
      if (!reorderQty || reorderQty <= 0 || !p.inventory_unit) {
        result.unconfigured.push({ productId: p.id, name: p.name, reason: !p.inventory_unit ? 'no_unit' : 'no_reorder_quantity' });
        continue;
      }
      const existing = await conn('product_restock_requests')
        .where({ product_id: p.id })
        .whereIn('status', ['open', 'ordered'])
        .first();
      if (existing) { result.deduped.push({ productId: p.id, name: p.name, requestId: existing.id }); continue; }

      const pricing = await vendorPricingFor(conn, p.id, p.auto_reorder_vendor_id);
      const onHand = num(p.inventory_on_hand);
      const threshold = num(p.low_stock_threshold);
      const now = new Date();
      const [request] = await conn('product_restock_requests').insert({
        product_id: p.id,
        status: 'open',
        priority: 'normal',
        requested_quantity: reorderQty,
        unit: p.inventory_unit,
        current_stock: onHand,
        target_stock: threshold != null ? Number((threshold + reorderQty).toFixed(4)) : reorderQty,
        vendor: p.vendor_name || null,
        reason: `Auto-reorder: ${p.name} at ${onHand} ${p.inventory_unit} (low-stock threshold ${threshold} ${p.inventory_unit})`,
        source: SOURCE,
        created_by_name: 'Auto-reorder sweep',
        metadata: {
          vendorId: p.auto_reorder_vendor_id || null,
          vendorSku: pricing?.vendor_sku || null,
          vendorProductUrl: pricing?.vendor_product_url || null,
          lowStockThreshold: threshold,
        },
        created_at: now,
        updated_at: now,
      }).returning('*');
      result.created.push({ productId: p.id, name: p.name, requestId: request.id, requestedQuantity: reorderQty, vendor: p.vendor_name || null });

      // One bell per request, deduped on the request id (a re-run after a
      // partial failure must not ring twice). Green-path silence is not
      // possible here: with no order adapter, a human has to click.
      try {
        const notifyAdmin = notify || ((...args) => require('../notification-service').notifyAdmin(...args));
        const where = p.vendor_name ? ` from ${p.vendor_name}` : '';
        const link = pricing?.vendor_product_url ? ` Order link: ${pricing.vendor_product_url}` : '';
        await notifyAdmin(
          'system',
          `Restock: ${p.name} is low (${onHand} ${p.inventory_unit})`,
          `Reorder ${reorderQty} ${p.inventory_unit}${where} — order manually, then mark the restock request ordered.${link}`,
          {
            link: '/admin/inventory?tab=restock',
            dedupeKey: `auto-reorder:${request.id}`,
            metadata: { restockRequestId: request.id, productId: p.id, vendorId: p.auto_reorder_vendor_id || null, vendorSku: pricing?.vendor_sku || null, vendorProductUrl: pricing?.vendor_product_url || null },
          },
        );
      } catch (notifyErr) {
        logger.warn(`[auto-reorder] bell failed for ${p.name} (request ${request.id}): ${notifyErr.message}`);
      }
    } catch (err) {
      logger.error(`[auto-reorder] ${p.name}: ${err.message}`);
      result.errors.push({ productId: p.id, name: p.name, message: err.message });
    }
  }
  logger.info(`[auto-reorder] sweep: ${result.created.length} created, ${result.deduped.length} deduped, ${result.unconfigured.length} unconfigured, ${result.errors.length} errors`);
  return result;
}

module.exports = { runSuppliesAutoReorderSweep, findLowStockCandidates, AUTO_REORDER_GATE: GATE, AUTO_REORDER_SOURCE: SOURCE };
