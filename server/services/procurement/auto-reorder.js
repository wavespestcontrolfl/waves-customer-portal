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
 *
 * Every bell is derived from the REQUEST row, never from the product's
 * current configuration: an admin edit to the vendor, reorder quantity or
 * unit after the request was raised must not send the office to order
 * goods the Restock queue does not show (Codex r6 P2).
 */
const db = require('../../models/db');
const logger = require('../logger');
const { gateEnvValue } = require('../../config/feature-gates');

const GATE = 'GATE_AUTO_REORDER';
const SOURCE = 'auto_reorder';
const LIVE_STATUSES = ['open', 'ordered'];

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseMeta(raw) {
  if (!raw) return {};
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw) || {}; } catch { return {}; }
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

// The bell says exactly what the request row says (see the header).
async function ringRestockBell({ notify, product, request }) {
  const notifyAdmin = notify || ((...args) => require('../notification-service').notifyAdmin(...args));
  const meta = parseMeta(request.metadata);
  const unit = request.unit || product.inventory_unit;
  const onHand = num(request.current_stock) ?? num(product.inventory_on_hand);
  const where = request.vendor ? ` from ${request.vendor}` : '';
  const link = meta.vendorProductUrl ? ` Order link: ${meta.vendorProductUrl}` : '';
  return notifyAdmin(
    'system',
    `Restock: ${product.name} is low (${onHand} ${unit})`,
    `Reorder ${num(request.requested_quantity)} ${unit}${where} — order manually, then mark the restock request ordered.${link}`,
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
      metadata: { restockRequestId: request.id, productId: product.id, vendorId: meta.vendorId || null, vendorSku: meta.vendorSku || null, vendorProductUrl: meta.vendorProductUrl || null },
    },
  );
}

async function bellOrWarn(ctx, product, request, bucket) {
  try {
    await ringRestockBell({ notify: ctx.notify, product, request });
    ctx.result[bucket].push({ productId: product.id, requestId: request.id });
  } catch (notifyErr) {
    logger.warn(`[auto-reorder] bell failed for ${product.name} (request ${request.id}): ${notifyErr.message}`);
  }
}

// Vendor configured after the request was raised (the seeded sticker starts
// unpriced): carry the new vendor/SKU/URL onto the open request so the tab
// and the refreshed bell show it. Only NULL fields are filled — a populated
// request is never rewritten from the product's current configuration.
// Returns the request as the bell must see it.
async function refreshOpenRequest(ctx, p, existing, pricing) {
  const meta = parseMeta(existing.metadata);
  const learned = {
    vendorId: meta.vendorId || p.auto_reorder_vendor_id || null,
    vendorSku: meta.vendorSku || pricing?.vendor_sku || null,
    vendorProductUrl: meta.vendorProductUrl || pricing?.vendor_product_url || null,
  };
  const vendor = existing.vendor || p.vendor_name || null;
  const changed = vendor !== (existing.vendor || null)
    || learned.vendorSku !== (meta.vendorSku || null)
    || learned.vendorProductUrl !== (meta.vendorProductUrl || null);
  if (!changed) return existing;
  const metadata = { ...meta, ...learned };
  await ctx.conn('product_restock_requests').where({ id: existing.id }).update({ vendor, metadata: JSON.stringify(metadata), updated_at: new Date() });
  ctx.result.refreshed.push({ productId: p.id, requestId: existing.id });
  return { ...existing, vendor, metadata };
}

// A still-open auto request whose bell failed earlier would otherwise sit
// unworked forever: re-ring (the request-id dedupeKey makes a landed bell a
// no-op). Requests of other sources, and ordered ones, are left alone.
async function handleLiveRequest(ctx, p, existing, pricing) {
  ctx.result.deduped.push({ productId: p.id, name: p.name, requestId: existing.id });
  if (existing.source !== SOURCE || existing.status !== 'open') return;
  const request = await refreshOpenRequest(ctx, p, existing, pricing);
  await bellOrWarn(ctx, p, request, 'renotified');
}

function stillLow(fresh) {
  const onHand = num(fresh.inventory_on_hand);
  const threshold = num(fresh.low_stock_threshold);
  return fresh.auto_reorder_enabled === true && fresh.active !== false && onHand != null && threshold != null && onHand <= threshold;
}

// The request is derived from the LOCKED configuration, not the scan
// snapshot: a reorder-quantity or vendor edit between the two must not send
// the office to the old vendor for the old count (Codex r4 P2).
async function lockedVendor(trx, p, fresh, scanPricing) {
  const vendorId = fresh.auto_reorder_vendor_id || null;
  if (vendorId === (p.auto_reorder_vendor_id || null)) return { vendorId, vendorName: p.vendor_name || null, pricing: scanPricing };
  const v = vendorId ? await trx('vendors').where({ id: vendorId }).first('name') : null;
  return { vendorId, vendorName: v?.name || null, pricing: await vendorPricingFor(trx, p.id, vendorId) };
}

// Re-read the product under a row lock right before the insert: a receive /
// count correction / disable between the candidate scan and here must not
// raise a stale request that no later sweep would revisit (Codex r3 P2).
// Runs in one transaction with the insert so a concurrent receive waits on
// the lock rather than racing past it.
async function createRequestLocked(conn, p, scanPricing) {
  return conn.transaction(async (trx) => {
    const fresh = await trx('products_catalog').where({ id: p.id }).forUpdate()
      .first('inventory_on_hand', 'low_stock_threshold', 'auto_reorder_enabled', 'active', 'reorder_quantity', 'auto_reorder_vendor_id', 'inventory_unit');
    if (!fresh || !stillLow(fresh)) return { deduped: 'no_longer_low' };
    const qty = num(fresh.reorder_quantity);
    const unit = fresh.inventory_unit || p.inventory_unit;
    if (!unit) return { unconfigured: 'no_unit' };
    if (!qty || qty <= 0) return { unconfigured: 'no_reorder_quantity' };
    const vendor = await lockedVendor(trx, p, fresh, scanPricing);
    const onHand = num(fresh.inventory_on_hand);
    const threshold = num(fresh.low_stock_threshold);
    const now = new Date();
    const inserted = await trx('product_restock_requests').insert({
      product_id: p.id,
      status: 'open',
      priority: 'normal',
      requested_quantity: qty,
      unit,
      current_stock: onHand,
      target_stock: Number((threshold + qty).toFixed(4)),
      vendor: vendor.vendorName,
      reason: `Auto-reorder: ${p.name} at ${onHand} ${unit} (low-stock threshold ${threshold} ${unit})`,
      source: SOURCE,
      created_by_name: 'Auto-reorder sweep',
      metadata: {
        vendorId: vendor.vendorId,
        vendorSku: vendor.pricing?.vendor_sku || null,
        vendorProductUrl: vendor.pricing?.vendor_product_url || null,
        lowStockThreshold: threshold,
      },
      created_at: now,
      updated_at: now,
    })
      .onConflict(trx.raw("(product_id) WHERE status IN ('open', 'ordered') AND source = 'auto_reorder'"))
      .ignore()
      .returning('*');
    const request = inserted?.[0];
    return request ? { request } : { deduped: 'concurrent_auto_request' };
  });
}

async function sweepProduct(ctx, p) {
  const { conn, result } = ctx;
  if (!p.inventory_unit) { result.unconfigured.push({ productId: p.id, name: p.name, reason: 'no_unit' }); return; }
  const reorderQty = num(p.reorder_quantity);
  if (!reorderQty || reorderQty <= 0) { result.unconfigured.push({ productId: p.id, name: p.name, reason: 'no_reorder_quantity' }); return; }
  const pricing = await vendorPricingFor(conn, p.id, p.auto_reorder_vendor_id);
  const existing = await conn('product_restock_requests').where({ product_id: p.id }).whereIn('status', LIVE_STATUSES).first();
  if (existing) { await handleLiveRequest(ctx, p, existing, pricing); return; }

  const outcome = await createRequestLocked(conn, p, pricing);
  if (outcome.deduped) { result.deduped.push({ productId: p.id, name: p.name, requestId: null, reason: outcome.deduped }); return; }
  if (outcome.unconfigured) { result.unconfigured.push({ productId: p.id, name: p.name, reason: outcome.unconfigured }); return; }
  const { request } = outcome;
  result.created.push({ productId: p.id, name: p.name, requestId: request.id, requestedQuantity: num(request.requested_quantity), vendor: request.vendor });
  // One bell per request, deduped on the request id. Green-path silence is
  // not possible here: with no order adapter, a human has to click. A
  // failure here is retried by the next sweep (handleLiveRequest).
  await bellOrWarn(ctx, p, request, 'bells');
}

async function runSuppliesAutoReorderSweep({ conn = db, notify = null } = {}) {
  if (!gateEnvValue(GATE)) return { skipped: 'gated', created: [], deduped: [], unconfigured: [] };
  const result = { created: [], deduped: [], unconfigured: [], errors: [], renotified: [], refreshed: [], bells: [] };
  const ctx = { conn, notify, result };

  const candidates = await findLowStockCandidates(conn);
  for (const p of candidates) {
    try {
      await sweepProduct(ctx, p);
    } catch (err) {
      logger.error(`[auto-reorder] ${p.name}: ${err.message}`);
      result.errors.push({ productId: p.id, name: p.name, message: err.message });
    }
  }
  logger.info(`[auto-reorder] sweep: ${result.created.length} created, ${result.deduped.length} deduped, ${result.unconfigured.length} unconfigured, ${result.errors.length} errors`);
  return result;
}

module.exports = { runSuppliesAutoReorderSweep, findLowStockCandidates, AUTO_REORDER_GATE: GATE, AUTO_REORDER_SOURCE: SOURCE };
