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
 * PR 2: when the dispatcher will order from the request's vendor (master +
 * vendor gate on, adapter exists — order-dispatch.canAutoOrder) the "order
 * manually" bell is wrong: the green path is silent and every exception
 * bells from the ledger. The decision follows the vendor the REQUEST was
 * built from (the locked one), never the scan snapshot.
 *
 * Every bell is derived from the REQUEST row, never from the product's
 * current configuration: an admin edit to the vendor, reorder quantity or
 * unit after the request was raised must not send the office to order
 * goods the Restock queue does not show (Codex r6 P2).
 *
 * The live-request check is the SHARED one in live-restock-request.js —
 * the staff readiness route, the forecast route and the Intelligence Bar
 * tool run the same read under the same product row lock (Codex r9 P1).
 */
const db = require('../../models/db');
const logger = require('../logger');
const { gateEnvValue } = require('../../config/feature-gates');
const { eligibleVendorPricing } = require('../vendor-pricing-eligibility');
const { findLiveRestockRequest, LIVE_RESTOCK_STATUSES } = require('./live-restock-request');

const GATE = 'GATE_AUTO_REORDER';
const SOURCE = 'auto_reorder';

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

// Every auto-reorder product PLUS every product that still carries a live
// auto request — NOT only the low, enabled ones: an open request must be
// found and re-belled even after the threshold, the count or "reorder when
// low" itself was cleared; creation eligibility (stillLow: enabled, active,
// low) is decided per product after the live-request check, then again
// under the lock (Codex r15 P2, r16 P2).
async function findLowStockCandidates(conn = db) {
  return conn('products_catalog as pc')
    .leftJoin('vendors as v', 'v.id', 'pc.auto_reorder_vendor_id')
    .where((q) => q.where('pc.auto_reorder_enabled', true).orWhereExists(function liveAutoRequest() {
      this.select(1).from('product_restock_requests as prr').whereRaw('prr.product_id = pc.id').whereIn('prr.status', LIVE_RESTOCK_STATUSES).where('prr.source', SOURCE);
    }))
    .select(
      'pc.id', 'pc.name', 'pc.inventory_on_hand', 'pc.inventory_unit', 'pc.low_stock_threshold',
      'pc.reorder_quantity', 'pc.auto_reorder_vendor_id', 'pc.auto_reorder_enabled', 'pc.active',
      'v.name as vendor_name',
    )
    .orderBy('pc.name');
}

// THE eligibility predicate recalcBestPriceLocked uses (shared module):
// a zero-priced, deactivated, unapproved or expired row must not steer an
// order (Codex r4 P2, r8 P1). Runs inside the caller's transaction, so a
// failure propagates — swallowing it would leave the transaction aborted
// and the next write failing anyway (Codex r10 P2); the sweep's per-product
// catch records it.
async function vendorPricingFor(conn, productId, vendorId) {
  if (!vendorId) return null;
  return eligibleVendorPricing(conn('vendor_pricing').where({ product_id: productId, vendor_id: vendorId }))
    .orderBy('is_best_price', 'desc')
    .first();
}

// The product's pricing advisory lock — the one every vendor_pricing writer
// (manual price edit, approval, Hermes report, recalcBestPrice) takes FIRST
// and holds to commit. Taken here BEFORE the product row lock, in the
// repository's lock order (advisory, then rows), so the pricing row read
// under it is the committed state no in-flight edit can still change
// (Codex r10 P1): a writer holding this lock has not touched the product
// row yet, and a writer waiting on it sees our request committed first.
async function lockProductPricing(trx, productId) {
  await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?))', ['inventory.best_price', String(productId)]);
}

async function dispatcherOrders(conn, vendorId) {
  return require('./order-dispatch').canAutoOrder({ conn, vendorId });
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

// The bell is the only handoff to staff, so a bell that did not land is a
// sweep ERROR (job_health red via sweepFailureError), not a warning:
// notifyAdmin resolves NULL when it could not persist the notification
// (its own catch), so the resolved row is checked like a rejection (Codex
// r13 P2). The request row stays; the next sweep re-rings it.
async function bellOrWarn(ctx, product, request, bucket) {
  try {
    const row = await ringRestockBell({ notify: ctx.notify, product, request });
    if (!row) throw new Error('notification not persisted');
    ctx.result[bucket].push({ productId: product.id, requestId: request.id });
  } catch (notifyErr) {
    logger.error(`[auto-reorder] bell NOT delivered for ${product.name} (request ${request.id}): ${notifyErr.message}`);
    ctx.result.errors.push({ productId: product.id, name: product.name, requestId: request.id, message: `bell: ${notifyErr.message}` });
  }
}

// What an open request still has to learn from ITS vendor (SKU, URL, the
// vendor id when it predates ids; the name when it has none): only NULL
// fields are filled, and everything comes from ONE vendor — a request pinned
// to a vendor the product has since left keeps its identity and gets no
// mixed SKU/link (Codex r8 P2). Null = nothing to write.
function requestOwnsVendor(request, meta, vendor) {
  if (meta.vendorId) return meta.vendorId === vendor.vendorId;
  return !request.vendor || request.vendor === vendor.vendorName;
}
function learnedVendorFields(request, vendor) {
  const meta = parseMeta(request.metadata);
  if (!requestOwnsVendor(request, meta, vendor)) return null;
  const name = request.vendor || vendor.vendorName || null;
  const learned = {
    vendorId: meta.vendorId || vendor.vendorId || null,
    vendorSku: meta.vendorSku || vendor.pricing?.vendor_sku || null,
    vendorProductUrl: meta.vendorProductUrl || vendor.pricing?.vendor_product_url || null,
  };
  const changed = name !== (request.vendor || null) || Object.keys(learned).some((k) => learned[k] !== (meta[k] || null));
  return changed ? { vendor: name, metadata: { ...meta, ...learned } } : null;
}

// Vendor configured after the request was raised (the seeded sticker starts
// unpriced): carry the vendor/SKU/URL onto the open request so the tab and
// the refreshed bell show it. Request AND product are locked in one
// transaction — the pricing advisory lock, then request, then product: the
// repository's lock order (advisory before rows; the Restock action route,
// the Intelligence Bar tool and the dispatcher all take the request row
// before the product row), so this cannot deadlock against them (pre-push
// P1, Codex r10 P1). The vendor is re-derived from the locked
// product (an admin edit between the scan and here must not pin the request
// to the old vendor), and a request that left 'open' meanwhile is neither
// updated nor re-belled. Returns the request as the bell must see it, or
// null when it is no longer an open auto request.
async function refreshOpenRequest(ctx, p, existing) {
  return ctx.conn.transaction(async (trx) => {
    await lockProductPricing(trx, p.id);
    const request = await trx('product_restock_requests').where({ id: existing.id }).forUpdate().first();
    if (!request || request.status !== 'open' || request.source !== SOURCE) return null;
    const fresh = await trx('products_catalog').where({ id: p.id }).forUpdate().first('auto_reorder_vendor_id');
    if (!fresh) return null;
    const learned = learnedVendorFields(request, await lockedVendor(trx, p, fresh));
    if (!learned) return request;
    await trx('product_restock_requests').where({ id: request.id, status: 'open' }).update({ vendor: learned.vendor, metadata: JSON.stringify(learned.metadata), updated_at: new Date() });
    ctx.result.refreshed.push({ productId: p.id, requestId: request.id });
    return { ...request, ...learned };
  });
}

// A still-open auto request whose bell failed earlier would otherwise sit
// unworked forever: re-ring (the request-id dedupeKey makes a landed bell a
// no-op). Requests of other sources, and ordered ones, are left alone.
async function handleLiveRequest(ctx, p, existing) {
  ctx.result.deduped.push({ productId: p.id, name: p.name, requestId: existing.id });
  if (existing.source !== SOURCE || existing.status !== 'open') return;
  const request = await refreshOpenRequest(ctx, p, existing);
  if (!request) return;
  // The dispatcher only ever claims a request whose OWN metadata names an
  // auto-orderable vendor (findDispatchable). A request that could not
  // establish a vendor id (pinned to a vendor the product has since left)
  // is nobody's — ring so a human works it (Codex r10 P1).
  const { vendorId } = parseMeta(request.metadata);
  // The dispatcher's CLAIM retires any manual bell an earlier sweep rang, in
  // the same transaction that creates the claim (Codex r19 P1 / r20 P1) —
  // the sweep only stands down here.
  if (vendorId && await dispatcherOrders(ctx.conn, vendorId)) return;
  // An automatic order already out for this product (an ambiguous submit or
  // stale recovery leaves the request OPEN with the ledger dispatched):
  // the ledger's own bell says do-not-reorder; a gate closed or a vendor
  // retired since must not ring "order manually" on top of it (hook r27
  // P0). Reconciliation — receive or revoke — is what reopens the lane.
  if (await require('./order-dispatch').findLiveAutoOrder(ctx.conn, p.id)) { ctx.result.deduped.push({ productId: p.id, name: p.name, requestId: request.id, reason: 'auto_order_live' }); return; }
  // A pre-submit park (no_price, dry_run, …) left this request a versioned
  // ledger bell that already says "order manually": the generic hand-off
  // must not ring beside it. Settle the ledger's bell first; when that
  // fails, stand down — the ledger bell, re-rung by the dispatcher, still
  // owns the request (Codex r31 P2).
  if (!(await settleParkedLedgerBell(ctx, p, request))) return;
  await bellOrWarn(ctx, p, request, 'renotified');
}

async function settleParkedLedgerBell(ctx, product, request) {
  try {
    await ctx.conn.transaction((trx) => require('./order-dispatch').settleRequestLedgerBells(trx, request.id));
    return true;
  } catch (err) {
    logger.error(`[auto-reorder] parked ledger bell for ${product.name} (request ${request.id}) NOT settled — hand-off bell withheld: ${err.message}`);
    ctx.result.errors.push({ productId: product.id, name: product.name, requestId: request.id, message: `ledger bell: ${err.message}` });
    return false;
  }
}

function stillLow(fresh) {
  const onHand = num(fresh.inventory_on_hand);
  const threshold = num(fresh.low_stock_threshold);
  return fresh.auto_reorder_enabled === true && fresh.active !== false && onHand != null && threshold != null && onHand <= threshold;
}

// The request is derived from the LOCKED configuration, not the scan
// snapshot: a reorder-quantity or vendor edit between the two must not send
// the office to the old vendor for the old count (Codex r4 P2). The vendor's
// pricing row (SKU, URL, eligibility) is read here too, under the lock,
// even when the vendor id did not change — the pricing writer recalculates
// the product before it commits, so the lock can carry a newer SKU/link
// than any unlocked read, and populated request metadata is never replaced
// by a later sweep (Codex r9 P2).
// A vendor that has been DEACTIVATED is no vendor: the request gets no
// name, SKU or link from it and the bell says "order manually" — an
// eligible price row under a retired vendor must not steer staff to buy
// from it (Codex r15 P2).
async function lockedVendor(trx, p, fresh) {
  const vendorId = fresh.auto_reorder_vendor_id || null;
  const v = vendorId ? await trx('vendors').where({ id: vendorId }).first('name', 'active') : null;
  if (!v || v.active === false) return { vendorId: null, vendorName: null, pricing: null };
  return { vendorId, vendorName: v.name || p.vendor_name || null, pricing: await vendorPricingFor(trx, p.id, vendorId) };
}

// Re-read the product under a row lock right before the insert: a receive /
// count correction / disable between the candidate scan and here must not
// raise a stale request that no later sweep would revisit (Codex r3 P2).
// Runs in one transaction with the insert so a concurrent receive waits on
// the lock rather than racing past it.
async function createRequestLocked(conn, p) {
  return conn.transaction(async (trx) => {
    await lockProductPricing(trx, p.id);
    const fresh = await trx('products_catalog').where({ id: p.id }).forUpdate()
      .first('inventory_on_hand', 'low_stock_threshold', 'auto_reorder_enabled', 'active', 'reorder_quantity', 'auto_reorder_vendor_id', 'inventory_unit');
    if (!fresh || !stillLow(fresh)) return { deduped: 'no_longer_low' };
    // The SHARED live-request check again, UNDER the lock (pre-push P1,
    // Codex r9 P1): every creation path (staff, forecast, Intelligence Bar,
    // the dispatcher's claim) locks this row first and runs this same read,
    // so a request that committed between the scan and this lock is visible
    // here — the partial unique index only spans auto rows, so without this
    // read two live requests would survive.
    const live = await findLiveRestockRequest(trx, p.id);
    if (live) return { deduped: live.source === SOURCE ? 'concurrent_auto_request' : 'concurrent_staff_request' };
    // The same belt every staff creation path wears (assertNoLiveAutoOrder):
    // an automatic order still out — including one that landed after its
    // request was received by hand (evidence.landedAfterReceive), which the
    // live-request read above cannot see — must not get a fresh request and
    // an "order manually" bell beside it (hook r27 P1).
    if (await require('./order-dispatch').findLiveAutoOrder(trx, p.id)) return { deduped: 'auto_order_live' };
    const qty = num(fresh.reorder_quantity);
    const unit = fresh.inventory_unit || p.inventory_unit;
    if (!unit) return { unconfigured: 'no_unit' };
    if (!qty || qty <= 0) return { unconfigured: 'no_reorder_quantity' };
    const vendor = await lockedVendor(trx, p, fresh);
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
      // The level receiving this request produces (Codex r15 P2).
      target_stock: Number((onHand + qty).toFixed(4)),
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
  // A live request comes FIRST: it carries its own quantity and unit, so a
  // reorder quantity cleared after it was raised must not stop its bell
  // from being retried (Codex r14 P2). Creation-only configuration is
  // checked only when there is something to create.
  const existing = await findLiveRestockRequest(conn, p.id);
  if (existing) { await handleLiveRequest(ctx, p, existing); return; }
  if (!stillLow(p)) return;
  if (!p.inventory_unit) { result.unconfigured.push({ productId: p.id, name: p.name, reason: 'no_unit' }); return; }
  const reorderQty = num(p.reorder_quantity);
  if (!reorderQty || reorderQty <= 0) { result.unconfigured.push({ productId: p.id, name: p.name, reason: 'no_reorder_quantity' }); return; }

  const outcome = await createRequestLocked(conn, p);
  if (outcome.deduped) { result.deduped.push({ productId: p.id, name: p.name, requestId: null, reason: outcome.deduped }); return; }
  if (outcome.unconfigured) { result.unconfigured.push({ productId: p.id, name: p.name, reason: outcome.unconfigured }); return; }
  const { request } = outcome;
  result.created.push({ productId: p.id, name: p.name, requestId: request.id, requestedQuantity: num(request.requested_quantity), vendor: request.vendor });
  // One bell per request, deduped on the request id, unless the dispatcher
  // orders from the request's (locked) vendor — then it owns the outcome
  // bell. A failure here is retried by the next sweep (handleLiveRequest).
  if (await dispatcherOrders(conn, parseMeta(request.metadata).vendorId)) { result.autoOrder = [...(result.autoOrder || []), request.id]; return; }
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

// What the scheduler throws after a sweep whose per-product failures were
// contained: the sweep keeps going past one bad product (and returns the
// full result for its callers), but a run with ANY failed product must go
// red on its job_health row, not be recorded as a success (pre-push P1).
// Same contract as the attribution-transfer sweep's scheduler block.
function sweepFailureError(result) {
  const failed = result?.errors || [];
  if (!failed.length) return null;
  return new Error(`[auto-reorder] ${failed.length} product(s) failed: ${failed.map((e) => `${e.name} (${e.message})`).join('; ')}`);
}

module.exports = { runSuppliesAutoReorderSweep, sweepFailureError, findLowStockCandidates, vendorPricingFor, lockProductPricing, ringRestockBell, AUTO_REORDER_GATE: GATE, AUTO_REORDER_SOURCE: SOURCE };
