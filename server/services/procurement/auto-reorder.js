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
 *
 * Staleness: the insert runs in a transaction that first re-reads the
 * product FOR UPDATE and re-checks enabled / active / stock <= threshold, so
 * a receive or a disable that landed after the candidate scan raises no
 * request (result.deduped reason no_longer_low).
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
    .where('pc.active', true)
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

// Same eligibility as recalcBestPriceLocked (admin-inventory.js): a
// deactivated, unapproved or expired row must not steer an order (Codex r4
// P2). Any query failure (older schema) degrades to "no link", never throws.
async function vendorPricingFor(conn, productId, vendorId) {
  if (!vendorId) return null;
  try {
    return await conn('vendor_pricing')
      .where({ product_id: productId, vendor_id: vendorId })
      .where('is_active', true)
      .whereIn('approval_status', ['approved', 'auto_approved'])
      .where(function unexpired() { this.whereNull('expires_at').orWhere('expires_at', '>', new Date()); })
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
      // bell: true — required handoff: under GATE_ADMIN_BELL_POLICY a bare
      // 'system' category is suppressed, and a suppressed restock alert is
      // a silently unworked reorder (Codex r1 P1).
      bell: true,
      link: '/admin/inventory?tab=restock',
      dedupeKey: `auto-reorder:${request.id}`,
      // A later sweep that learned the vendor/price rewrites the standing
      // bell (title/body/metadata) instead of leaving the linkless original.
      refreshOnDedupe: true,
      metadata: { restockRequestId: request.id, productId: product.id, vendorId: product.auto_reorder_vendor_id || null, vendorSku: pricing?.vendor_sku || null, vendorProductUrl: pricing?.vendor_product_url || null },
    },
  );
}

async function runSuppliesAutoReorderSweep({ conn = db, notify = null } = {}) {
  if (!gateEnvValue(GATE)) return { skipped: 'gated', created: [], deduped: [], unconfigured: [] };
  const result = { created: [], deduped: [], unconfigured: [], errors: [], renotified: [], refreshed: [] };

  const candidates = await findLowStockCandidates(conn);
  for (const p of candidates) {
    try {
      const reorderQty = num(p.reorder_quantity);
      if (!reorderQty || reorderQty <= 0 || !p.inventory_unit) {
        result.unconfigured.push({ productId: p.id, name: p.name, reason: !p.inventory_unit ? 'no_unit' : 'no_reorder_quantity' });
        continue;
      }
      const pricing = await vendorPricingFor(conn, p.id, p.auto_reorder_vendor_id);
      // PR 2: when the dispatcher will order from this vendor (master +
      // vendor gate on, adapter exists) the "order manually" bell is wrong —
      // the green path is silent and every exception bells from the ledger.
      const autoOrder = await require('./order-dispatch').canAutoOrder({ conn, vendorId: p.auto_reorder_vendor_id });
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
          // Vendor configured after the request was raised (the seeded
          // sticker starts unpriced): carry the new vendor/SKU/URL onto the
          // open request so the tab and the refreshed bell show it.
          const meta = (typeof existing.metadata === 'string' ? (() => { try { return JSON.parse(existing.metadata); } catch { return {}; } })() : existing.metadata) || {};
          const learned = (pricing?.vendor_sku && !meta.vendorSku) || (pricing?.vendor_product_url && !meta.vendorProductUrl) || (p.vendor_name && !existing.vendor);
          if (learned) {
            await conn('product_restock_requests').where({ id: existing.id }).update({
              vendor: p.vendor_name || existing.vendor || null,
              metadata: JSON.stringify({ ...meta, vendorId: p.auto_reorder_vendor_id || meta.vendorId || null, vendorSku: pricing?.vendor_sku || meta.vendorSku || null, vendorProductUrl: pricing?.vendor_product_url || meta.vendorProductUrl || null }),
              updated_at: new Date(),
            });
            result.refreshed.push({ productId: p.id, requestId: existing.id });
          }
          if (autoOrder) continue;
          try {
            await ringRestockBell({ notify, product: p, request: existing, pricing, onHand, reorderQty });
            result.renotified.push({ productId: p.id, requestId: existing.id });
          } catch (notifyErr) {
            logger.warn(`[auto-reorder] re-bell failed for ${p.name} (request ${existing.id}): ${notifyErr.message}`);
          }
        }
        continue;
      }

      // Re-read the product under a row lock right before the insert: a
      // receive / count correction / disable between the candidate scan and
      // here must not raise a stale request that no later sweep would
      // revisit (Codex r3 P2). Runs in one transaction with the insert so a
      // concurrent receive waits on the lock rather than racing past it.
      const outcome = await conn.transaction(async (trx) => {
        const fresh = await trx('products_catalog').where({ id: p.id }).forUpdate()
          .first('inventory_on_hand', 'low_stock_threshold', 'auto_reorder_enabled', 'active', 'reorder_quantity', 'auto_reorder_vendor_id', 'inventory_unit');
        const freshOnHand = num(fresh?.inventory_on_hand);
        const freshThreshold = num(fresh?.low_stock_threshold);
        const stillLow = !!fresh && fresh.auto_reorder_enabled === true && fresh.active !== false
          && freshOnHand != null && freshThreshold != null && freshOnHand <= freshThreshold;
        if (!stillLow) return { stale: true };
        // The live-request check again, UNDER the lock (pre-push P1): every
        // creation path (staff, forecast, Intelligence Bar, the dispatcher's
        // claim) locks this row first, so a request that committed between
        // the scan and this lock is visible here — the partial unique index
        // only spans auto rows, so without this read two live requests would
        // survive.
        const live = await trx('product_restock_requests').where({ product_id: p.id }).whereIn('status', ['open', 'ordered']).first('id', 'source');
        if (live) return { conflict: true, reason: live.source === SOURCE ? 'concurrent_auto_request' : 'concurrent_staff_request' };
        // The request is derived from the LOCKED configuration, not the scan
        // snapshot: a reorder-quantity or vendor edit between the two must
        // not send the office to the old vendor for the old count (Codex r4
        // P2). Later sweeps never overwrite populated request metadata.
        const lockedQty = num(fresh.reorder_quantity);
        const lockedUnit = fresh.inventory_unit || p.inventory_unit;
        if (!lockedQty || lockedQty <= 0 || !lockedUnit) return { unconfigured: !lockedUnit ? 'no_unit' : 'no_reorder_quantity' };
        const lockedVendorId = fresh.auto_reorder_vendor_id || null;
        const vendorChanged = lockedVendorId !== (p.auto_reorder_vendor_id || null);
        const lockedPricing = vendorChanged ? await vendorPricingFor(trx, p.id, lockedVendorId) : pricing;
        let vendorName = p.vendor_name || null;
        if (vendorChanged) {
          const v = lockedVendorId ? await trx('vendors').where({ id: lockedVendorId }).first('name') : null;
          vendorName = v?.name || null;
        }
        const now = new Date();
        const inserted = await trx('product_restock_requests').insert({
          product_id: p.id,
          status: 'open',
          priority: 'normal',
          requested_quantity: lockedQty,
          unit: lockedUnit,
          current_stock: freshOnHand,
          target_stock: Number((freshThreshold + lockedQty).toFixed(4)),
          vendor: vendorName,
          reason: `Auto-reorder: ${p.name} at ${freshOnHand} ${lockedUnit} (low-stock threshold ${freshThreshold} ${lockedUnit})`,
          source: SOURCE,
          created_by_name: 'Auto-reorder sweep',
          metadata: {
            vendorId: lockedVendorId,
            vendorSku: lockedPricing?.vendor_sku || null,
            vendorProductUrl: lockedPricing?.vendor_product_url || null,
            lowStockThreshold: freshThreshold,
          },
          created_at: now,
          updated_at: now,
        })
          .onConflict(trx.raw("(product_id) WHERE status IN ('open', 'ordered') AND source = 'auto_reorder'"))
          .ignore()
          .returning('*');
        const row = inserted && inserted[0];
        return row ? { request: row, pricing: lockedPricing, vendorName, vendorId: lockedVendorId, reorderQty: lockedQty } : { conflict: true };
      });
      if (outcome.stale) { result.deduped.push({ productId: p.id, name: p.name, requestId: null, reason: 'no_longer_low' }); continue; }
      if (outcome.unconfigured) { result.unconfigured.push({ productId: p.id, name: p.name, reason: outcome.unconfigured }); continue; }
      if (outcome.conflict) { result.deduped.push({ productId: p.id, name: p.name, requestId: null, reason: outcome.reason || 'concurrent_auto_request' }); continue; }
      const { request } = outcome;
      result.created.push({ productId: p.id, name: p.name, requestId: request.id, requestedQuantity: outcome.reorderQty, vendor: outcome.vendorName });

      // One bell per request, deduped on the request id, unless the
      // dispatcher orders from this vendor (then it owns the outcome bell).
      // A failure here is retried by the next sweep (existing branch above).
      // The request was built from the LOCKED vendor, which may differ from
      // the scan's: re-decide the bell from that vendor (Codex hook P1).
      const lockedVendorId = outcome.vendorId ?? null;
      const willAutoOrder = lockedVendorId === (p.auto_reorder_vendor_id || null) ? autoOrder : await require('./order-dispatch').canAutoOrder({ conn, vendorId: lockedVendorId });
      if (willAutoOrder) { result.autoOrder = [...(result.autoOrder || []), request.id]; continue; }
      try {
        await ringRestockBell({ notify, product: { ...p, vendor_name: outcome.vendorName, auto_reorder_vendor_id: request.metadata?.vendorId ?? p.auto_reorder_vendor_id }, request, pricing: outcome.pricing, onHand: num(request.current_stock) ?? onHand, reorderQty: outcome.reorderQty });
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

module.exports = { runSuppliesAutoReorderSweep, findLowStockCandidates, vendorPricingFor, AUTO_REORDER_GATE: GATE, AUTO_REORDER_SOURCE: SOURCE };
