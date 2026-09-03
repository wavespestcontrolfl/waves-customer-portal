/**
 * procurement/order-dispatch.js — places the orders the auto-reorder sweep
 * raised, hands-off under spend caps (owner ruling 2026-09-03, rule 14).
 *
 * Runs right after runSuppliesAutoReorderSweep in the same 6:10 ET tick.
 * For each OPEN `auto_reorder` restock request whose vendor has an adapter
 * (SiteOne → browser bot, Sticker Mule → reorder API) and no ledger row:
 *
 *   1. Gates, at CALL time: GATE_AUTO_ORDER AND the vendor's gate
 *      (GATE_AUTO_ORDER_STICKERMULE / GATE_AUTO_ORDER_SITEONE). Unset = kill
 *      for NEW orders only: reconciliation (stale 'placing' claims, bells
 *      that never landed) runs on every tick regardless, because an order
 *      that may already have been submitted does not stop existing when the
 *      switch is flipped (pre-push P0).
 *   2. CLAIM: insert vendor_orders (status 'placing') BEFORE any outbound
 *      call. restock_request_id is UNIQUE, so a request is dispatched at most
 *      once ever — a deploy overlap sees the row and skips. The claim
 *      re-reads the product under its row lock and re-checks what the sweep
 *      checked when it raised the request — active, auto_reorder_enabled,
 *      stock still at or under the threshold. A request the current catalog
 *      no longer authorizes (a receive landed, automation was turned off, the
 *      product was retired) is CANCELLED with the reason in its metadata and
 *      never claimed (Codex r1 P1): the need is gone, no bell. The same
 *      goes for a request whose vendor or quantity/unit no longer match the
 *      product's auto_reorder_vendor_id / reorder_quantity / inventory_unit
 *      (pre-push P0): money is never spent on a superseded configuration —
 *      the request is cancelled and the next sweep raises a current one.
 *   3. Binding total BEFORE anything is sent. The eligible vendor_pricing
 *      row (active, approved, unexpired) supplies the vendor SKU for EVERY
 *      adapter — SiteOne included, even though its money comes from checkout
 *      (none → needs_review 'no_price'; Codex r1 P1). Its `quantity` (pack
 *      size) converts the request's inventory-unit amount into the vendor's
 *      order unit: SiteOne's cart quantity is PACKAGES (ceil(requested /
 *      pack size), same dimension only — 256 fl oz of a "1 gal" jug = 2);
 *      Sticker Mule's is the item COUNT (the request must be in 'each').
 *      Unreadable or mismatched pack size → needs_review 'no_pack_size',
 *      never a quantity typed into the vendor's field (Codex r1 P1). The
 *      amount comes from the VENDOR, never a local estimate: Sticker Mule =
 *      the account's most recent order of the identical item at the identical
 *      quantity (its reorder API has no quote endpoint; same item + same count
 *      + same account = same charge) — no such order → needs_review
 *      'no_binding_total'; SiteOne = the CHECKOUT total (tax + shipping) the
 *      bot reads immediately before the place-order click (the cart total is
 *      only a screen + dry-run stop). The vendor's read-back total is
 *      re-checked after placement as a detector: over cap → needs_review
 *      'over_cap_after_placement' + bell, request ordered, counted.
 *   4. Caps: AUTO_ORDER_MAX_PER_ORDER_CENTS and AUTO_ORDER_MAX_MONTHLY_CENTS
 *      — BOTH required (unset = no order ever fires, needs_review
 *      'caps_unconfigured'). The check is an atomic RESERVATION: one
 *      transaction takes pg_advisory_xact_lock(CAPS_LOCK_KEY), sums this ET
 *      calendar month over the rows whose money is live — placing
 *      reservations and every row whose vendor call was dispatched
 *      (placed_at set: placed + post-submit parks); a pre-submit park keeps
 *      its amount for the tab but frees the headroom — compares, and writes
 *      amount_cents on this row before the vendor call, so two dispatchers
 *      cannot both see the same headroom. Over → needs_review, request
 *      stays open, bell.
 *   5. Place. Success → ledger 'placed' + request 'ordered' (the same
 *      transition the Restock tab's mark_ordered takes, re-checked under
 *      FOR UPDATE) + critical audit row, NO bell (green path is silent).
 *      Refusal / ambiguous outcome → 'needs_review' + bell. Definite
 *      pre-submit failure → 'failed' + bell + the sweep's job_health goes
 *      red (rethrown at the end). Run-level error (no browser, login
 *      failed) → the claim is RELEASED (row deleted, nothing was sent) and
 *      the batch aborts so tomorrow's tick retries.
 *   6. Bells are durable. The bell's title/body are written into the ledger
 *      row's evidence (`evidence.bell`) in the same transaction as the park,
 *      and `evidence.bellAt` is stamped only after notifyAdmin returned. A
 *      bell that failed to send leaves bellAt null: the run reports it (the
 *      job goes red) and every later run re-rings pending bells first
 *      (dedupeKey = the ledger id, so a landed bell is never doubled). A
 *      parked order — above all a post-submit one whose money may have
 *      moved — therefore never sits silent (Codex r1 P1).
 *
 * Only an adapter whose pre-submit total is VENDOR-CONFIRMED (preSubmitTotal
 * 'vendor': SiteOne reads the checkout total live) auto-places. Sticker Mule
 * ('history') is fully prepared — SKU, quantity, last identical charge,
 * cap reservation — but parks needs_review 'no_vendor_confirmed_total' with
 * that figure in the bell; accepting history-total placement is an owner
 * ruling, not a code default.
 *
 * The sweep consults canAutoOrder() and skips its "order manually" bell for
 * a vendor this module will order from, so every request ends either
 * silently ordered or with exactly one bell naming why it parked.
 * Revoke = ops/agents/auto-order-revoke.js (ledger → needs_review, request →
 * open; the unique claim keeps it from ever re-dispatching — a fresh request
 * is the way back in).
 */
const db = require('../../models/db');
const logger = require('../logger');
const { gateEnvValue } = require('../../config/feature-gates');
const { startOfETMonth } = require('../../utils/datetime-et');
const { getVendorLoginCredentials } = require('../vendor-credentials');
const { auditVendorOrder } = require('../audit-log');
const { parsePackSize, convertToOz } = require('../product-costing');
const { normalizeInventoryUnit, unitDefinition } = require('../inventory-units');

const GATE = 'GATE_AUTO_ORDER';
const RESTOCK_TAB = '/admin/inventory?tab=restock';
// Advisory-lock key for the cap reservation (hashtext of this string).
const CAPS_LOCK_KEY = 'vendor-order-caps';
// Ledger outcomes AFTER the vendor call was dispatched: the order may or does
// exist, so the bell must never say "order manually".
const POST_SUBMIT_REASONS = new Set(['ambiguous_after_submit', 'persist_after_placement', 'over_cap_after_placement', 'stale_placing']);

// vendors.code → adapter (.claude/vendor-codes.md). Name is the fallback for
// a row that predates the code column.
const ADAPTER_BY_CODE = { 1: 'siteone', 25: 'stickermule' };
const ADAPTER_BY_NAME = { siteone: 'siteone', 'sticker mule': 'stickermule' };
const VENDOR_GATE = { siteone: 'GATE_AUTO_ORDER_SITEONE', stickermule: 'GATE_AUTO_ORDER_STICKERMULE' };

function loadAdapters() {
  return { siteone: require('./adapters/siteone'), stickermule: require('./adapters/stickermule') };
}

function adapterKeyFor(vendor) {
  if (!vendor) return null;
  if (vendor.code != null && ADAPTER_BY_CODE[Number(vendor.code)]) return ADAPTER_BY_CODE[Number(vendor.code)];
  return ADAPTER_BY_NAME[String(vendor.name || '').trim().toLowerCase()] || null;
}

function parseCents(v) {
  if (v == null || String(v).trim() === '') return null;
  const n = Number(String(v).trim());
  return Number.isInteger(n) && n >= 0 ? n : null;
}
function caps(env = process.env) {
  return { perOrder: parseCents(env.AUTO_ORDER_MAX_PER_ORDER_CENTS), monthly: parseCents(env.AUTO_ORDER_MAX_MONTHLY_CENTS) };
}

function meta(raw) {
  if (!raw) return {};
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw) || {}; } catch { return {}; }
}
const dollars = (cents) => `$${(Number(cents || 0) / 100).toFixed(2)}`;
const num = (v) => { const n = Number(v); return v == null || v === '' || !Number.isFinite(n) ? null : n; };

/**
 * true when the dispatcher WILL try to order from this vendor (gates +
 * adapter + the vendor row is active). Mirrors dispatchRestockOrder's own
 * vendor check so the sweep never suppresses its manual bell for a request
 * the dispatcher will then refuse (Codex r1 P2).
 */
async function canAutoOrder({ conn = db, vendorId, vendor = null } = {}) {
  if (!gateEnvValue(GATE)) return false;
  const row = vendor || (vendorId ? await conn('vendors').where({ id: vendorId }).first('id', 'name', 'code', 'active') : null);
  if (!row || row.active === false) return false;
  const key = adapterKeyFor(row);
  return !!key && gateEnvValue(VENDOR_GATE[key]);
}

// Pack-size count for count-based stock: "100", "100 each", "50 ct", "1 pc".
const COUNT_PACK_RE = /^(\d+(?:\.\d+)?)\s*(?:each|ea|ct|count|pcs?|pieces?|units?)?\.?$/i;

/**
 * The quantity typed into the VENDOR's order field, derived from the request
 * (inventory unit) and the eligible price row's pack size.
 *   adapter.packagedQuantity = true  (SiteOne: cart qty = packages) →
 *     ceil(requested / pack size), pack size from vendor_pricing.quantity in
 *     the same dimension as the inventory unit.
 *   adapter.packagedQuantity = false (Sticker Mule: item count) → the
 *     request count itself; the request must be in 'each'.
 * Returns { quantity, packSize } or { error, message } — an unreadable or
 * cross-dimension pack size never becomes a number in a cart (Codex r1 P1).
 */
function vendorOrderQuantity({ adapter, request, pricing }) {
  const requested = num(request.requested_quantity);
  const unit = normalizeInventoryUnit(request.unit);
  if (!requested || requested <= 0 || !unit) return { error: 'no_quantity', message: `request has no positive quantity/unit (${request.requested_quantity} ${request.unit || ''})` };
  if (!adapter.packagedQuantity) {
    if (unit !== 'each') return { error: 'count_unit_required', message: `${adapter.key || 'this vendor'} orders by item count, but the request is in ${request.unit}; set the product's inventory unit to each` };
    return { quantity: Math.ceil(requested), packSize: null };
  }
  const packRaw = String(pricing?.quantity || '').trim();
  if (unit === 'each') {
    const m = packRaw.match(COUNT_PACK_RE);
    const per = m ? Number(m[1]) : null;
    if (!per || per <= 0) return { error: 'no_pack_size', message: `price row pack size "${packRaw || '—'}" is not a count for a product stocked in each` };
    return { quantity: Math.ceil(requested / per - 1e-9), packSize: `${per} each` };
  }
  const pack = parsePackSize(packRaw);
  const requestedOz = convertToOz(requested, unit);
  const packOz = pack ? convertToOz(pack.amount, pack.unit) : null;
  if (!requestedOz || !packOz) return { error: 'no_pack_size', message: `price row pack size "${packRaw || '—'}" cannot be read against a request in ${request.unit}` };
  const reqDim = unitDefinition(unit)?.dimension;
  const packDim = unitDefinition(pack.unit)?.dimension;
  const measurable = (d) => d === 'volume' || d === 'weight';
  if (measurable(reqDim) && measurable(packDim) && reqDim !== packDim) return { error: 'pack_unit_mismatch', message: `price row pack size "${packRaw}" (${packDim}) does not match a request in ${request.unit} (${reqDim})` };
  return { quantity: Math.ceil(requestedOz / packOz - 1e-9), packSize: `${pack.amount} ${pack.unit}` };
}

// Month-to-date money that is spent OR may be: live reservations (placing)
// and every row whose vendor call was dispatched (placed_at set — placed,
// and the post-submit needs_review parks). A row parked BEFORE submission
// (over cap, no binding total, dry run, refusal) keeps its amount for the
// tab but has no placed_at and must not consume headroom (Codex hook P1).
async function monthlySpentCents(conn, { now = new Date(), excludeId = null } = {}) {
  let q = conn('vendor_orders')
    .whereNot('status', 'failed')
    .where('created_at', '>=', startOfETMonth(now))
    .where(function dispatched() { this.where('status', 'placing').orWhereNotNull('placed_at'); });
  if (excludeId) q = q.whereNot('id', excludeId);
  const row = await q.sum({ total: 'amount_cents' }).first();
  return Number(row?.total || 0);
}

/**
 * Atomic cap check + reservation for ONE ledger row: under a transaction-
 * scoped advisory lock, sum the month (every non-failed row except this one,
 * reserved `placing` amounts included), compare, and on success write this
 * row's amount_cents in the same transaction — so the next reservation, in
 * any process, sees it. Returns { ok } | { ok:false, reason, message }.
 */
async function reserveUnderCaps(conn, ledgerId, cents, { now = new Date(), env = process.env } = {}) {
  const { perOrder, monthly } = caps(env);
  if (perOrder == null || monthly == null) return { ok: false, reason: 'caps_unconfigured', message: 'AUTO_ORDER_MAX_PER_ORDER_CENTS and AUTO_ORDER_MAX_MONTHLY_CENTS must both be set' };
  if (!Number.isFinite(cents) || cents <= 0) return { ok: false, reason: 'no_binding_total', message: 'no positive vendor total to reserve' };
  if (cents > perOrder) return { ok: false, reason: 'over_per_order_cap', message: `${dollars(cents)} exceeds the per-order cap ${dollars(perOrder)}` };
  return conn.transaction(async (trx) => {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [CAPS_LOCK_KEY]);
    const spent = await monthlySpentCents(trx, { now, excludeId: ledgerId });
    if (spent + cents > monthly) return { ok: false, reason: 'over_monthly_cap', message: `${dollars(cents)} would take this month to ${dollars(spent + cents)}, over the monthly cap ${dollars(monthly)}` };
    await trx('vendor_orders').where({ id: ledgerId }).update({ amount_cents: cents, updated_at: new Date() });
    return { ok: true };
  });
}

async function findDispatchable(conn = db) {
  return conn('product_restock_requests as prr')
    .leftJoin('vendor_orders as vo', 'vo.restock_request_id', 'prr.id')
    .where('prr.status', 'open')
    .where('prr.source', 'auto_reorder')
    .whereNull('vo.id')
    .whereRaw("NULLIF(prr.metadata->>'vendorId', '') IS NOT NULL")
    .select('prr.id')
    .orderBy('prr.created_at');
}

/**
 * Ring the ledger row's bell and stamp evidence.bellAt on success. The
 * title/body were persisted as evidence.bell by the caller's transaction, so
 * a failed send (bellAt stays null) is re-rung by reringPendingBells on the
 * next run. Returns true when the bell landed.
 */
async function deliverBell(conn, { notify, ledgerId, requestId, productName, vendorName, title, body }) {
  const notifyAdmin = notify || ((...args) => require('../notification-service').notifyAdmin(...args));
  try {
    await notifyAdmin('system', title, body, {
      bell: true,
      link: RESTOCK_TAB,
      dedupeKey: `auto-order:${ledgerId}`,
      refreshOnDedupe: true,
      metadata: { vendorOrderId: ledgerId, restockRequestId: requestId, productName, vendorName },
    });
  } catch (err) {
    logger.warn(`[order-dispatch] bell failed for ledger ${ledgerId} (re-rung next run): ${err.message}`);
    return false;
  }
  try {
    await conn('vendor_orders').where({ id: ledgerId }).update({
      evidence: conn.raw("COALESCE(evidence, '{}'::jsonb) || ?::jsonb", [JSON.stringify({ bellAt: new Date().toISOString() })]),
      updated_at: new Date(),
    });
  } catch (err) {
    // The bell landed; the dedupeKey makes the re-ring a refresh, not a double.
    logger.warn(`[order-dispatch] bell stamp failed for ledger ${ledgerId}: ${err.message}`);
  }
  return true;
}

/** Re-ring every terminal ledger row whose persisted bell never landed. */
async function reringPendingBells({ conn = db, notify = null } = {}) {
  const rows = await conn('vendor_orders as vo')
    .join('product_restock_requests as prr', 'prr.id', 'vo.restock_request_id')
    .leftJoin('products_catalog as pc', 'pc.id', 'prr.product_id')
    .leftJoin('vendors as v', 'v.id', 'vo.vendor_id')
    .whereIn('vo.status', ['needs_review', 'failed', 'placed'])
    .whereRaw("vo.evidence ? 'bell'")
    .whereRaw("NULLIF(vo.evidence->>'bellAt', '') IS NULL")
    .select('vo.id', 'vo.evidence', 'prr.id as request_id', 'pc.name as product_name', 'v.name as vendor_name');
  const rung = [];
  const pending = [];
  for (const row of rows) {
    const bell = meta(row.evidence).bell;
    if (!bell?.title) continue;
    const ok = await deliverBell(conn, { notify, ledgerId: row.id, requestId: row.request_id, productName: row.product_name || '?', vendorName: row.vendor_name || '?', title: bell.title, body: bell.body || '' });
    (ok ? rung : pending).push(row.id);
  }
  return { rung, pending };
}

async function park(conn, { ledger, request, product, vendor, adapterKey, reason, message, amountCents = null, evidence = null, status = 'needs_review', notify, placed = null, markRequestOrdered = false }) {
  const postSubmit = POST_SUBMIT_REASONS.has(reason);
  if (postSubmit && status !== 'needs_review') throw new Error(`post-submit reason ${reason} must park as needs_review`);
  const dry = reason === 'dry_run';
  const bell = {
    title: dry ? `Auto-order dry run: ${product.name} (${vendor.name})` : `Auto-order ${status === 'failed' ? 'failed' : 'needs review'}: ${product.name} (${vendor.name})`,
    body: dry
      ? `SiteOne dry run filled the cart for ${request.requested_quantity} ${request.unit || ''} — total ${dollars(amountCents)}. Nothing was submitted; unset SITEONE_BOT_DRY_RUN to order for real.`
      : postSubmit
        ? `${message} Do NOT re-order: check the ${vendor.name} account${placed?.externalOrderNumber ? ` (order ${placed.externalOrderNumber})` : ''} and reconcile by hand — cancel with the vendor or receive the stock; ops/agents/auto-order-revoke.js records the revoke.`
        : `${message} The restock request stays open — order manually, then mark it ordered.`,
  };
  // The bell text is part of the park: persisted with the outcome so a
  // failed send is re-rung, never lost.
  const patch = { status, error: `${reason}: ${message}`.slice(0, 400), evidence: JSON.stringify({ ...(evidence || {}), bell }), updated_at: new Date() };
  if (amountCents != null) patch.amount_cents = amountCents;
  // placed_at = when the vendor call was DISPATCHED (placed rows and every
  // post-submit park): it is the marker monthlySpentCents counts.
  if (postSubmit) patch.placed_at = new Date();
  if (placed) {
    // The vendor order EXISTS: keep its number/total on the row even though
    // the outcome needs a human.
    patch.external_order_number = placed.externalOrderNumber || null;
    if (placed.response) patch.response_payload = JSON.stringify(placed.response);
  }
  // Ledger, request transition (when the order exists) and the critical
  // audit row commit together — the green path's shape; a crash leaves
  // either all three or none.
  await conn.transaction(async (trx) => {
    await trx('vendor_orders').where({ id: ledger.id }).update(patch);
    if (markRequestOrdered) await trx('product_restock_requests').where({ id: request.id, status: 'open' }).update({ status: 'ordered', updated_at: new Date() });
    await auditVendorOrder({ vendor_order_id: ledger.id, restock_request_id: request.id, vendor_id: vendor.id, adapter: adapterKey, outcome: status, amount_cents: amountCents, reason: `${reason}: ${message}`.slice(0, 400), trx });
  });
  const bellDelivered = await deliverBell(conn, { notify, ledgerId: ledger.id, requestId: request.id, productName: product.name, vendorName: vendor.name, ...bell });
  return { requestId: request.id, ledgerId: ledger.id, status, reason, ...(bellDelivered ? {} : { bellPending: true }) };
}

/**
 * Dispatch ONE open auto_reorder request. Returns { requestId, status,
 * reason } and never throws for a per-request outcome; throws only a
 * run-level error (err.runLevel) after releasing the claim.
 */
async function dispatchRestockOrder(requestId, { conn = db, notify = null, adapters = null, now = new Date(), env = process.env } = {}) {
  if (!gateEnvValue(GATE)) return { requestId, skipped: 'gated' };
  const registry = adapters || loadAdapters();

  // Claim under the request lock: state re-checked, ledger row inserted, commit.
  const claim = await conn.transaction(async (trx) => {
    const request = await trx('product_restock_requests').where({ id: requestId }).forUpdate().first();
    if (!request) return { skipped: 'not_found' };
    if (request.status !== 'open' || request.source !== 'auto_reorder') return { skipped: 'not_open_auto_request' };
    const m = meta(request.metadata);
    if (!m.vendorId) return { skipped: 'no_vendor' };
    const vendor = await trx('vendors').where({ id: m.vendorId }).first('id', 'name', 'code', 'active');
    const adapterKey = adapterKeyFor(vendor);
    if (!vendor || vendor.active === false || !adapterKey || !registry[adapterKey]) return { skipped: 'no_adapter' };
    if (!gateEnvValue(VENDOR_GATE[adapterKey])) return { skipped: 'vendor_gated' };
    // Product row lock + the sweep's own eligibility, re-checked NOW: the
    // request may be days old (a gated run raised it), and since then a
    // receive may have landed, auto-reorder may have been switched off, or
    // the product retired. Ordering on that request is buying stock nobody
    // asked for — withdraw it instead, reason on the row, no bell (the
    // owner's own action or a receive made it moot). (Codex r1 P1)
    const product = await trx('products_catalog').where({ id: request.product_id }).forUpdate().first('id', 'name', 'active', 'auto_reorder_enabled', 'inventory_on_hand', 'low_stock_threshold', 'auto_reorder_vendor_id', 'reorder_quantity', 'inventory_unit');
    if (!product) return { skipped: 'no_product' };
    const onHand = num(product.inventory_on_hand);
    const threshold = num(product.low_stock_threshold);
    // The request's cached vendor + quantity must still be the product's
    // CURRENT configuration: an edit since the sweep (new vendor, new
    // reorder quantity or unit) supersedes the request, it does not travel
    // with it.
    const configChanged = (product.auto_reorder_vendor_id || null) !== vendor.id ? 'vendor_changed'
      : num(product.reorder_quantity) !== num(request.requested_quantity) || normalizeInventoryUnit(product.inventory_unit) !== normalizeInventoryUnit(request.unit) ? 'quantity_changed'
        : null;
    const ineligible = product.active === false ? 'product_inactive'
      : product.auto_reorder_enabled !== true ? 'auto_reorder_disabled'
        : onHand == null || threshold == null ? 'stock_untracked'
          : onHand > threshold ? 'stock_no_longer_low'
            : configChanged;
    if (ineligible) {
      await trx('product_restock_requests').where({ id: request.id, status: 'open' }).update({
        status: 'cancelled',
        closed_at: new Date(), // closed_by stays null: a system cancel, not a technician's (the FK is technicians.id)
        metadata: JSON.stringify({ ...m, autoOrderCancelled: ineligible, autoOrderCancelledAt: new Date().toISOString() }),
        updated_at: new Date(),
      });
      logger.info(`[order-dispatch] ${product.name}: request ${request.id} cancelled at claim (${ineligible})`);
      return { skipped: ineligible, cancelled: true };
    }
    // Sibling check: a manual / forecast request for the same product raised
    // alongside the auto row (the partial unique index only spans auto rows)
    // means staff are ordering — never auto-order on top of it (pre-push
    // audit P0). A sibling that lands after this commit is the office's to
    // reconcile via the tab's order line.
    const sibling = await trx('product_restock_requests').where({ product_id: request.product_id }).whereIn('status', ['open', 'ordered']).whereNot('id', request.id).first('id', 'source', 'status');
    if (sibling) return { skipped: 'sibling_live_request', sibling };
    const quantity = Number(request.requested_quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) return { skipped: 'no_quantity' };
    // The eligible price row is read under the same lock so the claim's
    // payload records the SKU + vendor quantity the order will carry.
    const { vendorPricingFor } = require('./auto-reorder');
    const pricing = await vendorPricingFor(trx, product.id, vendor.id);
    const order = pricing?.vendor_sku ? vendorOrderQuantity({ adapter: registry[adapterKey], request, pricing }) : null;
    const inserted = await trx('vendor_orders').insert({
      restock_request_id: request.id,
      vendor_id: vendor.id,
      adapter: adapterKey,
      status: 'placing',
      request_payload: JSON.stringify({ productId: product.id, quantity, unit: request.unit || null, vendorSku: pricing?.vendor_sku || null, vendorQuantity: order?.quantity ?? null, packSize: order?.packSize ?? null }),
    }).onConflict('restock_request_id').ignore().returning('*');
    const ledger = inserted && inserted[0];
    if (!ledger) return { skipped: 'already_claimed' };
    return { request, vendor, adapterKey, product, quantity, ledger, pricing, order };
  });
  if (claim.skipped) return { requestId, skipped: claim.skipped, ...(claim.cancelled ? { cancelled: true } : {}) };

  const { request, vendor, adapterKey, product, ledger, pricing, order } = claim;
  const adapter = registry[adapterKey];
  const ctx = { ledger, request, product, vendor, adapterKey, notify };
  const releaseClaim = () => conn('vendor_orders').where({ id: ledger.id, status: 'placing' }).delete();
  let submitted = false; // true once the vendor call left the process
  let placed = null;
  let quoteCents = null;

  try {
    // Every adapter needs the eligible price row: it is the vendor/SKU
    // authorization the sweep used, and the pack size the quantity needs.
    // A catalog siteone_sku or the request's cached SKU is not eligibility.
    if (!pricing?.vendor_sku) return await park(conn, { ...ctx, reason: 'no_price', message: `${vendor.name} has no eligible price row (vendor SKU) for ${product.name}; the dispatcher never orders blind.` });
    if (order.error) return await park(conn, { ...ctx, reason: order.error, message: `${order.message}; fix the ${vendor.name} price row's pack size.` });
    const vendorSku = pricing.vendor_sku;
    const quantity = order.quantity;

    if (!adapter.quotesAtPlace) {
      // The vendor's OWN total for this exact order, read before anything is
      // sent. A missing match refuses; a read failure is a definite
      // pre-submit failure (nothing was ordered).
      let bq;
      try { bq = await adapter.bindingQuote({ vendorSku, quantity }); }
      catch (err) { return await park(conn, { ...ctx, status: 'failed', reason: 'adapter_error', message: `binding total lookup failed: ${err.message}` }); }
      if (!bq || !Number.isFinite(bq.cents) || bq.cents <= 0) return await park(conn, { ...ctx, reason: 'no_binding_total', message: `${vendor.name} has no prior order of item ${vendorSku} at ${quantity} on the account, so there is no binding total to cap; place one identical order by hand first.` });
      quoteCents = bq.cents;
      const cap = await reserveUnderCaps(conn, ledger.id, quoteCents, { now, env });
      if (!cap.ok) return await park(conn, { ...ctx, reason: cap.reason, message: `${cap.message} (${vendor.name} total for the last identical order${bq.source ? `, ${bq.source}` : ''})`, amountCents: quoteCents });
      if (adapter.preSubmitTotal !== 'vendor') {
        // A historical charge is not a vendor-confirmed current total: price,
        // tax or shipping may have moved since, and a cap can only be
        // enforced BEFORE money moves. Park with everything the office needs
        // for a one-minute manual reorder (pre-push audit P0; owner ruling
        // pending on accepting history-total placement).
        return await park(conn, { ...ctx, reason: 'no_vendor_confirmed_total', message: `${vendor.name}'s API confirms no current total before ordering; the last identical order (${bq.source || 'history'}) was ${dollars(quoteCents)}, which fits the caps. Reorder item ${vendorSku} × ${quantity} by hand.`, amountCents: quoteCents });
      }
    }

    const placeArgs = { vendorSku, quantity, quoteCents };
    if (adapterKey === 'siteone') {
      placeArgs.credentials = await getVendorLoginCredentials(conn, vendor.id);
      // Cart total = screen; checkout total = the binding reservation.
      placeArgs.beforeSubmit = (cents) => reserveUnderCaps(conn, ledger.id, cents, { now, env });
    }

    try {
      placed = await adapter.place(placeArgs);
    } catch (err) {
      if (err.runLevel) { await releaseClaim(); throw err; }
      if (err.refuse) return await park(conn, { ...ctx, reason: err.refuse, message: err.message, amountCents: quoteCents, evidence: err.evidence || null });
      if (err.ambiguous) {
        submitted = true;
        return await park(conn, { ...ctx, reason: 'ambiguous_after_submit', message: `${err.message} — the order MAY exist at ${vendor.name}.`, amountCents: quoteCents, evidence: err.evidence || null });
      }
      return await park(conn, { ...ctx, status: 'failed', reason: 'adapter_error', message: err.message, amountCents: quoteCents, evidence: err.evidence || null });
    }
    if (placed.dryRun) return await park(conn, { ...ctx, reason: 'dry_run', message: 'dry run', amountCents: placed.amountCents, evidence: placed.evidence || null });
    submitted = true; // from here every failure is post-placement: needs_review, never "order manually"
    const finalCents = placed.amountCents ?? quoteCents ?? null;

    // Detector: the vendor's read-back total should equal the reserved one.
    // If it came out higher and breaks a cap, the order exists but parks for
    // the owner (cancel with the vendor / revoke); the request is ordered.
    if (!adapter.quotesAtPlace && finalCents != null && finalCents > (quoteCents ?? 0)) {
      const finalCap = await reserveUnderCaps(conn, ledger.id, finalCents, { now, env });
      if (!finalCap.ok) {
        return await park(conn, { ...ctx, markRequestOrdered: true, reason: 'over_cap_after_placement', message: `${vendor.name} charged ${dollars(finalCents)} for order ${placed.externalOrderNumber || '?'}: ${finalCap.message}.`, amountCents: finalCents, evidence: placed.evidence || null, placed });
      }
    }

    // Green path: ledger placed + request ordered + audit, one transaction, no bell.
    const outcome = await conn.transaction(async (trx) => {
      const fresh = await trx('product_restock_requests').where({ id: request.id }).forUpdate().first('status');
      const stillOpen = fresh?.status === 'open';
      // The office closed the request while the vendor call was in flight:
      // an order exists that the tab no longer expects — say so once (the
      // bell is persisted with the outcome, like a park's).
      const bell = stillOpen ? null : { title: `Auto-order placed on a ${fresh?.status || 'missing'} request: ${product.name}`, body: `${vendor.name} order ${placed.externalOrderNumber || ''} (${dollars(placed.amountCents ?? quoteCents)}) landed after the restock request was marked ${fresh?.status || 'missing'}. Reconcile by hand.` };
      await trx('vendor_orders').where({ id: ledger.id }).update({
        status: 'placed',
        external_order_number: placed.externalOrderNumber || null,
        amount_cents: finalCents,
        response_payload: placed.response ? JSON.stringify(placed.response) : null,
        evidence: JSON.stringify({ ...(placed.evidence || {}), ...(bell ? { bell } : {}) }),
        error: stillOpen ? null : `request_state_changed: request was ${fresh?.status || 'missing'} when the order landed`,
        placed_at: new Date(),
        updated_at: new Date(),
      });
      if (stillOpen) await trx('product_restock_requests').where({ id: request.id }).update({ status: 'ordered', updated_at: new Date() });
      await auditVendorOrder({ vendor_order_id: ledger.id, restock_request_id: request.id, vendor_id: vendor.id, adapter: adapterKey, outcome: 'placed', amount_cents: finalCents, external_order_number: placed.externalOrderNumber || null, trx });
      return { stillOpen, bell };
    });
    const bellDelivered = outcome.bell ? await deliverBell(conn, { notify, ledgerId: ledger.id, requestId: request.id, productName: product.name, vendorName: vendor.name, ...outcome.bell }) : true;
    logger.info(`[order-dispatch] placed ${vendor.name} order ${placed.externalOrderNumber || '?'} for ${product.name} (${dollars(placed.amountCents ?? quoteCents)})`);
    return { requestId: request.id, ledgerId: ledger.id, status: 'placed', externalOrderNumber: placed.externalOrderNumber || null, amountCents: finalCents, ...(bellDelivered ? {} : { bellPending: true }) };
  } catch (err) {
    if (err.runLevel) throw err;
    logger.error(`[order-dispatch] ${product.name}: ${err.message}`);
    try {
      // After the vendor call the order exists (or may): a failed ledger /
      // request / audit write is a reconciliation, NEVER a "failed — order
      // manually" (that is the double-purchase path). Before it, park as a
      // definite failure rather than leave a silent 'placing' row.
      if (submitted) {
        return await park(conn, { ...ctx, reason: 'persist_after_placement', message: `${vendor.name} order ${placed?.externalOrderNumber || '(number unknown)'}${placed?.amountCents != null ? ` (${dollars(placed.amountCents)})` : ''} was placed but recording it failed: ${err.message}.`, amountCents: placed?.amountCents ?? quoteCents ?? null, evidence: placed?.evidence || null, placed });
      }
      return await park(conn, { ...ctx, status: 'failed', reason: 'dispatch_error', message: err.message });
    } catch (parkErr) {
      logger.error(`[order-dispatch] could not park ledger ${ledger.id}: ${parkErr.message}`);
      return { requestId: request.id, ledgerId: ledger.id, status: 'placing', reason: 'dispatch_error', error: err.message };
    }
  }
}

// A `placing` row older than this had its process die mid-dispatch: the
// vendor call may or may not have gone out. Park it for a human (post-submit
// wording: never re-order), never retry the vendor call automatically.
const STALE_PLACING_MS = 30 * 60 * 1000;

async function recoverStalePlacing({ conn = db, notify = null, now = new Date() } = {}) {
  const cutoff = new Date(now.getTime() - STALE_PLACING_MS);
  const stale = await conn('vendor_orders as vo')
    .join('product_restock_requests as prr', 'prr.id', 'vo.restock_request_id')
    .leftJoin('products_catalog as pc', 'pc.id', 'prr.product_id')
    .leftJoin('vendors as v', 'v.id', 'vo.vendor_id')
    .where('vo.status', 'placing')
    .where('vo.created_at', '<', cutoff)
    .select('vo.id', 'vo.adapter', 'vo.amount_cents', 'vo.created_at', 'prr.id as request_id', 'pc.name as product_name', 'v.id as vendor_id', 'v.name as vendor_name');
  const recovered = [];
  const bellPending = [];
  for (const row of stale) {
    try {
      const parked = await park(conn, {
        ledger: { id: row.id }, request: { id: row.request_id }, product: { name: row.product_name || '?' }, vendor: { id: row.vendor_id, name: row.vendor_name || '?' }, adapterKey: row.adapter, notify,
        reason: 'stale_placing', message: `the dispatcher died mid-order at ${new Date(row.created_at).toISOString()}; the ${row.vendor_name || 'vendor'} call may or may not have gone out.`, amountCents: row.amount_cents,
      });
      recovered.push(row.id);
      if (parked.bellPending) bellPending.push(row.id);
    } catch (err) {
      logger.error(`[order-dispatch] stale placing ${row.id} not recovered: ${err.message}`);
    }
  }
  return { recovered, bellPending };
}

async function runVendorOrderDispatch({ conn = db, notify = null, adapters = null, now = new Date(), env = process.env } = {}) {
  // Reconciliation runs BEFORE and REGARDLESS of the gate: a 'placing' claim
  // the dispatcher died on, or a park whose bell never sent, is an order that
  // may already exist at the vendor — killing the lane must surface it, not
  // bury it (pre-push P0). Bells first: the one outcome that must not wait
  // another day.
  const bells = await reringPendingBells({ conn, notify });
  const recovered = await recoverStalePlacing({ conn, notify, now });
  const gated = !gateEnvValue(GATE);
  const rows = gated ? [] : await findDispatchable(conn);
  const results = [];
  let runLevelError = null;
  for (const row of rows) {
    try {
      results.push(await dispatchRestockOrder(row.id, { conn, notify, adapters, now, env }));
    } catch (err) {
      // Run-level: the environment is broken for every remaining request —
      // stop here (claims released), let job_health record it, retry tomorrow.
      runLevelError = err;
      logger.error(`[order-dispatch] run-level failure, batch aborted: ${err.message}`);
      break;
    }
  }
  const failed = results.filter((r) => r.status === 'failed');
  const bellsPending = [...bells.pending, ...recovered.bellPending, ...results.filter((r) => r.bellPending).map((r) => r.ledgerId)];
  logger.info(`[order-dispatch] ${results.filter((r) => r.status === 'placed').length} placed, ${results.filter((r) => r.status === 'needs_review').length} parked, ${failed.length} failed, ${results.filter((r) => r.skipped).length} skipped of ${rows.length}; ${bells.rung.length} bells re-rung, ${bellsPending.length} pending`);
  if (runLevelError) throw runLevelError;
  const problems = [];
  if (failed.length) problems.push(`${failed.length} order(s) failed (${failed.map((f) => f.reason).join(', ')})`);
  // An undelivered bell is a parked order nobody knows about: red until it lands.
  if (bellsPending.length) problems.push(`${bellsPending.length} bell(s) not delivered, re-rung next run (ledger ${bellsPending.join(', ')})`);
  if (problems.length) throw new Error(`vendor order dispatch: ${problems.join('; ')}`);
  return { ...(gated ? { skipped: 'gated' } : {}), results, recovered: recovered.recovered, bells };
}

module.exports = {
  runVendorOrderDispatch,
  recoverStalePlacing,
  reringPendingBells,
  dispatchRestockOrder,
  canAutoOrder,
  reserveUnderCaps,
  monthlySpentCents,
  findDispatchable,
  vendorOrderQuantity,
  AUTO_ORDER_GATE: GATE,
  _internals: { adapterKeyFor, caps, parseCents, VENDOR_GATE, ADAPTER_BY_CODE, CAPS_LOCK_KEY, POST_SUBMIT_REASONS, STALE_PLACING_MS },
};
