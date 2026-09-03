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
 * Dedupe: a live (open|ordered) request of ANY source for the product skips
 * the insert (a manual request the office already raised must not get an
 * automatic twin); for the sweep's OWN requests the invariant is enforced by
 * the DB (partial unique index product_restock_requests_auto_reorder_live_uniq,
 * ON CONFLICT DO NOTHING here), so a concurrent writer cannot slip a second
 * auto row in between the read and the insert. The bell is re-attempted on
 * every sweep while an auto request stays open — its dedupeKey is the
 * request id, so a bell that failed once is retried and one that landed is
 * never doubled.
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

async function ringRestockBell({ notify, product, request, pricing, onHand, reorderQty }) {
  const notifyAdmin = notify || ((...args) => require('../notification-service').notifyAdmin(...args));
  const where = product.vendor_name ? ` from ${product.vendor_name}` : '';
  const link = pricing?.vendor_product_url ? ` Order link: ${pricing.vendor_product_url}` : '';
  return notifyAdmin(
    'system',
    `Restock: ${product.name} is low (${onHand} ${product.inventory_unit})`,
    `Reorder ${reorderQty} ${product.inventory_unit}${where} — order manually, then mark the restock request ordered.${link}`,
    {
      link: '/admin/inventory?tab=restock',
      dedupeKey: `auto-reorder:${request.id}`,
      metadata: { restockRequestId: request.id, productId: product.id, vendorId: product.auto_reorder_vendor_id || null, vendorSku: pricing?.vendor_sku || null, vendorProductUrl: pricing?.vendor_product_url || null },
    },
  );
}

async function runSuppliesAutoReorderSweep({ conn = db, notify = null } = {}) {
  if (!gateEnvValue(GATE)) return { skipped: 'gated', created: [], deduped: [], unconfigured: [] };
  const result = { created: [], deduped: [], unconfigured: [], errors: [], renotified: [] };

  const candidates = await findLowStockCandidates(conn);
  for (const p of candidates) {
    try {
      const reorderQty = num(p.reorder_quantity);
      if (!reorderQty || reorderQty <= 0 || !p.inventory_unit) {
        result.unconfigured.push({ productId: p.id, name: p.name, reason: !p.inventory_unit ? 'no_unit' : 'no_reorder_quantity' });
        continue;
      }
      const pricing = await vendorPricingFor(conn, p.id, p.auto_reorder_vendor_id);
      const onHand = num(p.inventory_on_hand);
      const threshold = num(p.low_stock_threshold);
      const existing = await conn('product_restock_requests')
        .where({ product_id: p.id })
        .whereIn('status', ['open', 'ordered'])
        .first();
      if (existing) {
        result.deduped.push({ productId: p.id, name: p.name, requestId: existing.id });
        // A still-open auto request whose bell failed earlier would otherwise
        // sit unworked forever: re-ring (the request-id dedupeKey makes a
        // landed bell a no-op).
        if (existing.source === SOURCE && existing.status === 'open') {
          try {
            await ringRestockBell({ notify, product: p, request: existing, pricing, onHand, reorderQty });
            result.renotified.push({ productId: p.id, requestId: existing.id });
          } catch (notifyErr) {
            logger.warn(`[auto-reorder] re-bell failed for ${p.name} (request ${existing.id}): ${notifyErr.message}`);
          }
        }
        continue;
      }

      const now = new Date();
      const inserted = await conn('product_restock_requests').insert({
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
      })
        .onConflict(conn.raw("(product_id) WHERE status IN ('open', 'ordered') AND source = 'auto_reorder'"))
        .ignore()
        .returning('*');
      const request = inserted && inserted[0];
      if (!request) { result.deduped.push({ productId: p.id, name: p.name, requestId: null, reason: 'concurrent_auto_request' }); continue; }
      result.created.push({ productId: p.id, name: p.name, requestId: request.id, requestedQuantity: reorderQty, vendor: p.vendor_name || null });

      // One bell per request, deduped on the request id. Green-path silence
      // is not possible here: with no order adapter, a human has to click.
      // A failure here is retried by the next sweep (existing branch above).
      try {
        await ringRestockBell({ notify, product: p, request, pricing, onHand, reorderQty });
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
