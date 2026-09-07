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
const { startOfETMonth, addETDays } = require('../../utils/datetime-et');
const { getVendorLoginCredentials } = require('../vendor-credentials');
const { auditVendorOrder } = require('../audit-log');
const { parsePackSize, parsePackCount, countUnitsCompatible, convertToOz } = require('../product-costing');
const { normalizeInventoryUnit, unitDefinition } = require('../inventory-units');

const GATE = 'GATE_AUTO_ORDER';
const RESTOCK_TAB = '/admin/inventory?tab=restock';
// Advisory-lock key for the cap reservation (hashtext of this string).
const CAPS_LOCK_KEY = 'vendor-order-caps';
// Ledger outcomes AFTER the vendor call was dispatched: the order may or does
// exist, so the bell must never say "order manually".
// Every reason a row can park AFTER the vendor call went out: placed_at is
// stamped, the bell says do-not-reorder, the spend and duplicate-order
// guards cover it. no_final_total = placed, no positive total anywhere
// (pre-push P0).
// placed_on_received_request = the order landed after an OLDER pod (pre-guard,
// rolling deploy) received the request by hand: the ledger carries
// evidence.landedAfterReceive, which keeps the live-order guards closed on a
// received request until the revoke CLI records a revoke or the request is
// received once more — its own receipt (Codex r27 P1, owner ruling).
const POST_SUBMIT_REASONS = new Set(['ambiguous_after_submit', 'persist_after_placement', 'over_cap_after_placement', 'stale_placing', 'no_final_total', 'placed_on_received_request']);
// A received request settles its ledger row — unless the order landed after
// that receipt (evidence.landedAfterReceive), or the claim is still
// 'placing' (an older pod received while the call is out: the marker is
// stamped only when the call returns, and the claim must stay live until
// then — Codex r29 P1): those rows stay live.
const RECEIVED_SETTLES_SQL = "(vo.status = 'placing' OR prr.status <> 'received' OR NULLIF(vo.evidence->>'landedAfterReceive', '') IS NOT NULL)";

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
// Every bell carries a version (`v`): the dedupe key and the delivery stamp
// are bound to it, so an obsolete in-flight delivery (a stale-park bell
// re-ringing while the delayed vendor call replaces it) can neither refresh
// the admin notification back to old copy nor acknowledge its replacement
// (Codex r3 P1).
const versioned = (bell) => ({ ...bell, v: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}` });
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
  const adapter = key ? loadAdapters()[key] : null;
  // An adapter without its credential must not own requests: the sweep would
  // stand down its manual bell and the dispatcher would park every claim as
  // "no prior order" — a misleading, non-reclaimable needs_review (Codex r20
  // P2). Unconfigured = not auto-orderable = the sweep bells the office.
  const configured = !!adapter && (typeof adapter.configured !== 'function' || adapter.configured() === true);
  if (!configured || !gateEnvValue(VENDOR_GATE[key])) return false;
  if (!adapter.loginRequired) return true;
  // Configured by the vendor row (the SiteOne login + account number): a row
  // without it is not auto-orderable — the sweep bells the office rather
  // than standing down (Codex #3853 r12 P2). A lookup that THROWS (the
  // infrastructure failures vendor-credentials distinguishes from a wrong
  // key) is NOT "unconfigured": read as such, the sweep would ring "order
  // manually" while the dispatcher's next lookup may succeed and place the
  // same order (Codex #3853 r17 P1). It propagates — the sweep records the
  // product as an error and bells nothing.
  try { return adapter.loginConfigured(await getVendorLoginCredentials(conn, row.id)) === true; }
  catch (e) { const err = new Error(`canAutoOrder: credential lookup for ${row.name || row.id} failed: ${e.message}`); err.cause = e; throw err; }
}

// Pack-size count for count-based stock: "100", "100 each", "50 ct", "1 pc".

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
const measurable = (d) => d === 'volume' || d === 'weight';

// Count-ordering vendors (Sticker Mule): the vendor quantity IS the item
// count, so the request must be stocked in each.
function countOrderQuantity({ adapter, requested, unit, requestUnit }) {
  if (unit !== 'each') return { error: 'count_unit_required', message: `${adapter.key || 'this vendor'} orders by item count, but the request is in ${requestUnit}; set the product's inventory unit to each` };
  const quantity = Math.ceil(requested);
  return { quantity, packSize: null, orderedQuantity: quantity };
}

// Package-ordering vendors (SiteOne): packages = ceil(requested / pack size),
// same dimension only. orderedQuantity is what those packages hold in the
// request's unit — the receive default (Codex r2 P1: 130 fl oz asked of a
// 128 fl oz jug orders 2 jugs = 256 fl oz, and THAT is what arrives).
function packagedOrderQuantity({ requested, unit, requestUnit, packRaw }) {
  if (unit === 'each') {
    // The ONE count-pack parser (product-costing.parsePackCount — the same
    // one the best-price recalculation scales by, Codex #3974 r6 P1): a
    // pack the catalog prices as "10 stations" or "20 tablets" is orderable
    // as that many items. A container noun ("1 case") is not a count of
    // items — countUnitsCompatible('each', …) refuses it — so it still
    // parks no_pack_size rather than ordering one item per case.
    const pack = parsePackCount(packRaw);
    const per = pack && countUnitsCompatible('each', pack.unit) ? pack.count : null;
    if (!per || per <= 0) return { error: 'no_pack_size', message: `price row pack size "${packRaw || '—'}" is not a count for a product stocked in each` };
    const quantity = Math.ceil(requested / per - 1e-9);
    return { quantity, packSize: `${per} each`, orderedQuantity: quantity * per };
  }
  const pack = parsePackSize(packRaw);
  const requestedOz = convertToOz(requested, unit);
  const packOz = pack ? convertToOz(pack.amount, pack.unit) : null;
  if (!requestedOz || !packOz) return { error: 'no_pack_size', message: `price row pack size "${packRaw || '—'}" cannot be read against a request in ${requestUnit}` };
  const reqDim = unitDefinition(unit)?.dimension;
  const packDim = unitDefinition(pack.unit)?.dimension;
  // The bare ounce family (oz / ounce) is deliberately unresolved — weight or
  // volume is a human's call (inventory-unit-review.js) — so it never
  // becomes a package count sent to a vendor (Codex r4 P1).
  if (reqDim === 'ambiguous' || packDim === 'ambiguous') return { error: 'ambiguous_unit', message: `${reqDim === 'ambiguous' ? `request unit ${requestUnit}` : `price row pack size "${packRaw}"`} is an unresolved ounce (weight or volume?) — resolve it in Unit Review first` };
  if (measurable(reqDim) && measurable(packDim) && reqDim !== packDim) return { error: 'pack_unit_mismatch', message: `price row pack size "${packRaw}" (${packDim}) does not match a request in ${requestUnit} (${reqDim})` };
  const quantity = Math.ceil(requestedOz / packOz - 1e-9);
  const orderedQuantity = Number(((quantity * packOz) / convertToOz(1, unit)).toFixed(4));
  return { quantity, packSize: `${pack.amount} ${pack.unit}`, orderedQuantity };
}

/**
 * The quantity typed into the VENDOR's order field, derived from the request
 * (inventory unit) and the eligible price row's pack size — see
 * countOrderQuantity / packagedOrderQuantity. Returns { quantity, packSize,
 * orderedQuantity } or { error, message }: an unreadable or cross-dimension
 * pack size never becomes a number in a cart (Codex r1 P1).
 */
function vendorOrderQuantity({ adapter, request, pricing }) {
  const requested = num(request.requested_quantity);
  const unit = normalizeInventoryUnit(request.unit);
  if (!requested || requested <= 0 || !unit) return { error: 'no_quantity', message: `request has no positive quantity/unit (${request.requested_quantity} ${request.unit || ''})` };
  const args = { adapter, requested, unit, requestUnit: request.unit, packRaw: String(pricing?.quantity || '').trim() };
  return adapter.packagedQuantity ? packagedOrderQuantity(args) : countOrderQuantity(args);
}

/**
 * Refuse a staff / forecast / Intelligence Bar restock request while an
 * AUTOMATIC order for the product is live: a vendor_orders row that is
 * 'placing' or was dispatched (placed_at set — placed, and the post-submit
 * parks whose money may have moved) and is neither received nor revoked —
 * whatever the request's status now says: an order that landed after its
 * request was cancelled is still coming (Codex r22 P1; mirrors
 * lockedProductGuards). Call under
 * the products_catalog row lock, in the same transaction as the insert. The
 * dispatcher's own lock is released when its claim commits, BEFORE the vendor
 * call, so the claim row — not the lock — is what carries the exclusion
 * through dispatch (pre-push P0). Throws { statusCode: 409, code:
 * 'auto_order_live' } with a message that points at the Restock tab.
 */
// The product's unreconciled automatic order, if any: a claim being placed,
// or a dispatched order (placed_at set — placed, or any post-submit park)
// not yet received or revoked. The one read behind the manual-action guard
// below and the sweep's stand-down (hook r27 P0: a gate closing must not
// turn an outstanding order into an "order manually" bell).
function findLiveAutoOrder(conn, productId) {
  return conn('product_restock_requests as prr')
    .join('vendor_orders as vo', 'vo.restock_request_id', 'prr.id')
    .leftJoin('vendors as v', 'v.id', 'vo.vendor_id')
    .where('prr.product_id', productId)
    .whereRaw(RECEIVED_SETTLES_SQL)
    .whereRaw("(vo.status = 'placing' OR vo.placed_at IS NOT NULL)")
    .whereRaw("NULLIF(vo.evidence->>'revokedAt', '') IS NULL")
    .first('vo.status', 'vo.external_order_number', 'v.name as vendor_name');
}

async function assertNoLiveAutoOrder(trx, productId) {
  const live = await findLiveAutoOrder(trx, productId);
  if (!live) return;
  const vendor = live.vendor_name || 'vendor';
  const err = new Error(live.status === 'placing'
    ? `An automatic ${vendor} order for this product is being placed right now — check the Restock tab before ordering more.`
    : `An automatic ${vendor} order${live.external_order_number ? ` (${live.external_order_number})` : ''} for this product is already out — receive it or revoke it on the Restock tab before requesting more.`);
  err.statusCode = 409;
  err.code = 'auto_order_live';
  throw err;
}

/**
 * Manual transitions (mark ordered / cancel / receive) against a request's
 * automatic order (pre-push P0s):
 *   - 'placing' → every action refuses: marking ordered would double the
 *     purchase, cancelling would hide the in-flight order, receiving is
 *     premature. Placed / parked claims are what the actions reconcile.
 *   - dispatched (placed_at set: placed, or a post-submit park whose money
 *     may have moved) → 'cancel' refuses until the operator has RECORDED a
 *     revoke (evidence.revokedAt, ops/agents/auto-order-revoke.js). A
 *     cancelled request drops out of the sweep's dedupe and the next tick
 *     would raise a fresh request and order AGAIN on top of an order that
 *     may already be on its way. Receive stays open (the stock arrived);
 *     mark ordered stays open (it is already ordered).
 * Call under the request row lock. Throws { statusCode: 409, code:
 * 'auto_order_placing' | 'auto_order_out' }.
 */
async function assertManualActionAllowed(trx, requestId, action) {
  const row = await trx('vendor_orders').where({ restock_request_id: requestId }).first('id', 'status', 'placed_at', 'external_order_number', 'evidence');
  if (!row) return {};
  const refuse = (code, message) => { const err = new Error(message); err.statusCode = 409; err.code = code; throw err; };
  if (row.status === 'placing') refuse('auto_order_placing', 'An automatic order for this request is being placed right now — wait for it to place or park (Restock tab), then act.');
  if (action === 'cancel' && row.placed_at && !meta(row.evidence).revokedAt) {
    refuse('auto_order_out', `An automatic order for this request${row.external_order_number ? ` (#${row.external_order_number})` : ''} may already have gone out. Receive it when it arrives, or cancel it with the vendor and record the revoke (ops/agents/auto-order-revoke.js --order=${row.id}) — only then cancel the request.`);
  }
  // Returned so both receive paths can admit ONE more receive on a received
  // request whose automatic order landed after that receipt (Codex r27 P1).
  return { landedAfterReceive: !!meta(row.evidence).landedAfterReceive };
}

// A manual transition the guard admitted (mark ordered / cancel / receive)
// resolves whatever the request's ledger bell asked for — a pre-submit
// park's "order manually", a post-submit park's "receive or revoke" — so
// the delivered, unread bell is retired in the same transaction; another
// admin must not follow it into a duplicate purchase (Codex r28 P2). The
// revoke CLI retires the same keys on a revoke.
// The persisted copy (evidence.bell / bellAt) goes too, as the revoke CLI
// strips it: a delivery in flight (park / re-ring) that lands afterwards
// fails deliverBell's version check instead of resurrecting the
// instruction (hook P1).
// The ledger row is LOCKED before its notifications — the order deliverBell
// and the manual restock actions take, so a caller that holds no ledger lock
// yet (the sweep's hand-off) cannot deadlock against them (hook r31 P1).
async function settleRequestLedgerBells(trx, requestId) {
  const row = await trx('vendor_orders').where({ restock_request_id: requestId }).forUpdate().first('id');
  if (!row) return;
  await retireLedgerBells(trx, row.id);
  await trx('vendor_orders').where({ id: row.id }).update({ evidence: trx.raw("COALESCE(evidence, '{}'::jsonb) - 'bell' - 'bellAt'"), updated_at: new Date() });
}

// Unlocked read for a pre-check (the IB tool's confirmation card); the
// locked guard above is what a receive transaction relies on.
async function landedAfterReceiveFor(conn, requestId) {
  const row = await conn('vendor_orders').where({ restock_request_id: requestId }).first('evidence');
  return !!(row && meta(row.evidence).landedAfterReceive);
}

// The second receive is the late order's own receipt: the marker that kept
// the guards closed comes off in the receive transaction.
function settleLandedAfterReceive(trx, requestId) {
  return trx('vendor_orders').where({ restock_request_id: requestId }).update({
    evidence: trx.raw("(COALESCE(evidence, '{}'::jsonb) - 'landedAfterReceive') || ?::jsonb", [JSON.stringify({ secondReceiveAt: new Date().toISOString() })]),
    updated_at: new Date(),
  });
}

/**
 * The inventory quantity the automatic order actually bought, in the
 * request's unit — the receive default (Codex r2 P1). Packages round UP, so
 * what arrives can exceed requested_quantity (130 fl oz asked of a 128 fl oz
 * jug = 2 jugs = 256 fl oz); receiving the requested figure would understate
 * stock and could trigger another order. null when there is no dispatched
 * automatic order for the request, or its claim recorded no conversion.
 */
async function orderedQuantityFor(conn, requestId) {
  // A REVOKED order (cancelled with the vendor) is not what arrives — the
  // manual replacement is; its packaged figure must not become the default.
  const row = await conn('vendor_orders').where({ restock_request_id: requestId }).whereNotNull('placed_at').whereRaw("NULLIF(evidence->>'revokedAt', '') IS NULL").first('request_payload');
  const q = num(meta(row?.request_payload).orderedQuantity);
  return q && q > 0 ? q : null;
}

// Month-to-date money that is spent OR may be: live reservations (placing)
// and every row whose vendor call was dispatched (placed_at set — placed,
// and the post-submit needs_review parks). A row parked BEFORE submission
// (over cap, no binding total, dry run, refusal) keeps its amount for the
// tab but has no placed_at and must not consume headroom (Codex hook P1).
// The accounting month is FIXED at reservation: reserveUnderCaps re-stamps
// the row's created_at when it reserves headroom, and that stamp — never
// placed_at — is the bucket. A reservation made just before ET midnight
// stays in the old month even when the vendor call lands after it, so the
// in-flight amount cannot vacate one month and land in the next on top of
// headroom another dispatcher reserved there meanwhile (pre-push P0, Codex
// r14 P1).
// Spend of ONE ET accounting month: [start of the month `now` is in, start
// of the next). Bounded above so an anchored re-check of an earlier month
// (a placement that crossed the boundary) never sums later months' rows
// (pre-push P1).
async function monthlySpentCents(conn, { now = new Date(), excludeId = null } = {}) {
  const monthStart = startOfETMonth(now);
  const nextMonthStart = startOfETMonth(addETDays(monthStart, 32));
  // A revoked order (evidence.revokedAt — cancelled with the vendor) no longer
  // consumes headroom, matching the live-order guards: its replacement must
  // be able to dispatch (pre-push P1).
  let q = conn('vendor_orders')
    .whereNot('status', 'failed')
    .whereRaw("NULLIF(evidence->>'revokedAt', '') IS NULL")
    .where('created_at', '>=', monthStart)
    .where('created_at', '<', nextMonthStart)
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
 * any process, sees it. The write is conditional on the row still being
 * 'placing': a claim recoverStalePlacing has already parked is no longer
 * this worker's to spend on, so the reservation REFUSES (claim_lost) and the
 * adapter — which only ever submits on { ok: true } — never clicks after
 * ownership is gone (pre-push P0). Returns { ok } | { ok:false, reason,
 * message }.
 */
// `now` is evaluated HERE, per reservation — never a run-start clock passed
// through: a run that crosses the ET month boundary reserves against the
// month it is in (pre-push P0). The reservation re-stamps the row's
// created_at (its cap-accounting month) at the same instant. A post-placement
// re-check of a higher confirmed total passes `accountingAt` — the month the
// order was reserved in stays its month (the documented fixed-at-reservation
// policy): the increase is checked against THAT month's headroom and
// created_at is left alone (Codex r19 P2).
async function reserveUnderCaps(conn, ledgerId, cents, { env = process.env, accountingAt = null, postPlacement = false } = {}) {
  const now = new Date();
  const monthAnchor = accountingAt || now;
  const { perOrder, monthly } = caps(env);
  if (perOrder == null || monthly == null) return { ok: false, reason: 'caps_unconfigured', message: 'AUTO_ORDER_MAX_PER_ORDER_CENTS and AUTO_ORDER_MAX_MONTHLY_CENTS must both be set' };
  if (!Number.isFinite(cents) || cents <= 0) return { ok: false, reason: 'no_binding_total', message: 'no positive vendor total to reserve' };
  const overPerOrder = cents > perOrder ? { ok: false, reason: 'over_per_order_cap', message: `${dollars(cents)} exceeds the per-order cap ${dollars(perOrder)}` } : null;
  // Before the vendor call an over-cap figure is simply refused. After it
  // (postPlacement) the money has MOVED: the actual charge is written under
  // the cap lock whatever the verdict, so no concurrent reservation can read
  // the stale lower amount in the gap before the park (pre-push P0).
  if (overPerOrder && !postPlacement) return overPerOrder;
  return conn.transaction(async (trx) => {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [CAPS_LOCK_KEY]);
    const spent = await monthlySpentCents(trx, { now: monthAnchor, excludeId: ledgerId });
    const overMonthly = spent + cents > monthly ? { ok: false, reason: 'over_monthly_cap', message: `${dollars(cents)} would take this month to ${dollars(spent + cents)}, over the monthly cap ${dollars(monthly)}` } : null;
    if (overMonthly && !postPlacement) return overMonthly;
    const n = await trx('vendor_orders').where({ id: ledgerId, status: 'placing' }).update({ amount_cents: cents, ...(accountingAt ? {} : { created_at: now }), updated_at: now });
    if (n !== 1) return { ok: false, reason: 'claim_lost', message: 'this order\'s claim was parked by stale recovery while the vendor call ran — nothing submitted; see the Restock tab' };
    return overPerOrder || overMonthly || { ok: true };
  });
}

// Open auto requests with no claim — or whose only claim is an adapter DRY
// RUN park (needs_review, error 'dry_run:…'): nothing was submitted, and the
// bell says "turn dry run off to order for real", so the request
// stays eligible and insertClaim re-arms that row (Codex r4 P1).
const DRY_RUN_RECLAIMABLE_SQL = "(vendor_orders.status = 'needs_review' AND vendor_orders.error LIKE 'dry_run:%')";
async function findDispatchable(conn = db) {
  return conn('product_restock_requests as prr')
    .leftJoin('vendor_orders as vo', 'vo.restock_request_id', 'prr.id')
    .where('prr.status', 'open')
    .where('prr.source', 'auto_reorder')
    .where((q) => q.whereNull('vo.id').orWhereRaw("(vo.status = 'needs_review' AND vo.error LIKE 'dry_run:%')"))
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
async function deliverBell(conn, { notify, ledgerId, requestId, productName, vendorName, title, body, v = null }) {
  const notifyAdmin = notify || ((...args) => require('../notification-service').notifyAdmin(...args));
  // notifyAdmin swallows its own insert/dedupe failures and returns null
  // (notification-service.js) — a resolved promise is not a landed bell,
  // only a truthy notification row is (Codex r2 P1).
  let landed = null;
  try {
    landed = await notifyAdmin('system', title, body, {
      bell: true,
      link: RESTOCK_TAB,
      dedupeKey: v ? `auto-order:${ledgerId}:${v}` : `auto-order:${ledgerId}`,
      refreshOnDedupe: true,
      metadata: { vendorOrderId: ledgerId, restockRequestId: requestId, productName, vendorName },
    });
  } catch (err) {
    logger.warn(`[order-dispatch] bell failed for ledger ${ledgerId} (re-rung next run): ${err.message}`);
    return false;
  }
  if (!landed) {
    logger.warn(`[order-dispatch] bell for ledger ${ledgerId} was not persisted (re-rung next run)`);
    return false;
  }
  // Retire-and-stamp is ONE transaction under the ledger row lock, and the
  // delivered version is verified against the row FIRST (hook r31 P1): a
  // delayed delivery of an earlier version resuming after its replacement
  // was delivered and stamped must retire only ITSELF, never the current
  // bell — a current bell already stamped would otherwise never re-ring.
  //   current  → every OTHER version of this row's bell (an earlier park's
  //              copy, the unversioned key) is retired, then bellAt lands:
  //              an obsolete reconcile / dry-run instruction is never left
  //              unread beside its replacement (Codex r31 P1);
  //   replaced → the notification just inserted (the stale copy) is
  //              retired; the replacement stays pending for the re-ring
  //              (Codex r23 P1, hook P1).
  // A failed transaction leaves bellAt null: the next run re-rings this
  // version (a dedupe refresh, never a double) and retries the retire.
  const key = (ver) => (ver ? `auto-order:${ledgerId}:${ver}` : `auto-order:${ledgerId}`);
  let outcome;
  try {
    outcome = await conn.transaction(async (trx) => {
      const row = await trx('vendor_orders').where({ id: ledgerId }).forUpdate().first('id', 'evidence');
      const current = meta(row?.evidence).bell?.v || null;
      if (!row || current !== (v || null)) {
        await trx('notifications').whereRaw("metadata->>'dedupeKey' = ?", [key(v)]).whereNull('read_at').update({ read_at: new Date() });
        return 'superseded';
      }
      await trx('notifications')
        .whereRaw("(metadata->>'dedupeKey' = ? OR metadata->>'dedupeKey' LIKE ?)", [key(null), `${key(null)}:%`])
        .whereRaw("metadata->>'dedupeKey' <> ?", [key(v)])
        .whereNull('read_at')
        .update({ read_at: new Date() });
      await trx('vendor_orders').where({ id: ledgerId }).update({
        evidence: trx.raw("COALESCE(evidence, '{}'::jsonb) || ?::jsonb", [JSON.stringify({ bellAt: new Date().toISOString() })]),
        updated_at: new Date(),
      });
      return 'stamped';
    });
  } catch (err) {
    logger.warn(`[order-dispatch] bell v${v || '?'} for ledger ${ledgerId} landed but could not be stamped (re-rung next run): ${err.message}`);
    return false;
  }
  if (outcome === 'stamped') return true;
  logger.warn(`[order-dispatch] bell v${v || '?'} for ledger ${ledgerId} was superseded before its stamp — retired; replacement re-rung next run`);
  return false;
}

/** Re-ring every terminal ledger row whose persisted bell never landed. */
async function reringPendingBells({ conn = db, notify = null } = {}) {
  const rows = await conn('vendor_orders as vo')
    .join('product_restock_requests as prr', 'prr.id', 'vo.restock_request_id')
    .leftJoin('products_catalog as pc', 'pc.id', 'prr.product_id')
    .leftJoin('vendors as v', 'v.id', 'vo.vendor_id')
    .whereIn('vo.status', ['needs_review', 'failed', 'placed'])
    // A request received meanwhile settled the order — unless the order
    // landed AFTER that receipt (landedAfterReceive: still to reconcile) —
    // and one staff cancelled after a pre-submit park withdrew the need:
    // either way the stored instruction is obsolete, never re-rung (Codex
    // r24 P2, r25 P2, hook r27 P1). jsonb_exists, not the ? operator: Knex
    // reads a bare ? as a binding placeholder (hook r27 P1).
    .whereRaw("prr.status <> 'cancelled'")
    .whereRaw(RECEIVED_SETTLES_SQL)
    // A pre-submit park's bell ("order manually") is re-rung only while the
    // request is still open: staff who ordered by hand and marked it ordered
    // must not be told again (hook r27 P1). Dispatched rows (placed_at set)
    // carry reconciliation bells, re-rung in any live state.
    .whereRaw("(vo.placed_at IS NOT NULL OR prr.status = 'open')")
    .whereRaw("jsonb_exists(vo.evidence, 'bell')")
    .whereRaw("NULLIF(vo.evidence->>'bellAt', '') IS NULL")
    .select('vo.id', 'vo.evidence', 'prr.id as request_id', 'pc.name as product_name', 'v.name as vendor_name');
  const rung = [];
  const pending = [];
  for (const row of rows) {
    const bell = meta(row.evidence).bell;
    if (!bell?.title) continue;
    const ok = await deliverBell(conn, { notify, ledgerId: row.id, requestId: row.request_id, productName: row.product_name || '?', vendorName: row.vendor_name || '?', title: bell.title, body: bell.body || '', v: bell.v || null });
    (ok ? rung : pending).push(row.id);
  }
  return { rung, pending };
}

// The bell a park rings — persisted with the outcome (evidence.bell) so a
// failed send is re-rung, never lost. Post-submit reasons say do-NOT-re-order.
function parkBell(args) { return versioned(parkBellText(args)); }
function parkBellText({ reason, status, product, vendor, request, amountCents, message, placed }) {
  if (reason === 'dry_run') {
    return {
      title: `Auto-order dry run: ${product.name} (${vendor.name})`,
      body: `${vendor.name} dry run filled the cart for ${request.requested_quantity} ${request.unit || ''} — total ${dollars(amountCents)}. Nothing was submitted; turn the adapter's dry run off to order for real.`,
    };
  }
  const title = `Auto-order ${status === 'failed' ? 'failed' : 'needs review'}: ${product.name} (${vendor.name})`;
  if (POST_SUBMIT_REASONS.has(reason)) {
    return { title, body: `${message} Do NOT re-order: check the ${vendor.name} account${placed?.externalOrderNumber ? ` (order ${placed.externalOrderNumber})` : ''} and reconcile by hand — cancel with the vendor or receive the stock; ops/agents/auto-order-revoke.js records the revoke.` };
  }
  return { title, body: `${message} The restock request stays open — order manually, then mark it ordered.` };
}

// The ledger row's parked state. placed_at = when the vendor call was
// DISPATCHED (every post-submit park): the marker monthlySpentCents counts.
// A placed order's number/total stay on the row even though it needs a human.
function parkPatch({ status, reason, message, evidence, bell, amountCents, postSubmit, placed }) {
  const patch = { status, error: `${reason}: ${message}`.slice(0, 400), evidence: JSON.stringify({ ...(evidence || {}), bell }), updated_at: new Date() };
  if (amountCents != null) patch.amount_cents = amountCents;
  if (postSubmit) patch.placed_at = new Date();
  if (placed) {
    patch.external_order_number = placed.externalOrderNumber || null;
    if (placed.response) patch.response_payload = JSON.stringify(placed.response);
  }
  return patch;
}

/**
 * Park a live claim as needs_review / failed: ledger, request transition
 * (when the order exists) and the critical audit row commit together — the
 * green path's shape; a crash leaves either all three or none. The ledger
 * write is CONDITIONAL on the row still being 'placing': a row another
 * dispatcher or pod already settled keeps that outcome — no overwrite, no
 * second audit (pre-push P1). Then the bell.
 */
async function park(conn, { ledger, request, product, vendor, adapterKey, reason, message, amountCents = null, evidence = null, status = 'needs_review', notify, placed = null, markRequestOrdered = false, staleBefore = null }) {
  const postSubmit = POST_SUBMIT_REASONS.has(reason);
  if (postSubmit && status !== 'needs_review') throw new Error(`post-submit reason ${reason} must park as needs_review`);
  const bell = parkBell({ reason, status, product, vendor, request, amountCents, message, placed });
  const patch = parkPatch({ status, reason, message, evidence, bell, amountCents, postSubmit, placed });
  const transitioned = await conn.transaction(async (trx) => {
    let rowPatch = patch;
    let reopen = false;
    if (staleBefore) {
      // Stale recovery: the request's status is read HERE, under the ledger →
      // request locks (the scan's snapshot is unlocked): received by an older
      // pod meanwhile ⇒ the park carries landedAfterReceive so every
      // live-order guard keeps the possibly-placed order live (Codex r30 P1).
      await trx('vendor_orders').where({ id: ledger.id }).forUpdate().first('id');
      const fresh = await trx('product_restock_requests').where({ id: request.id }).forUpdate().first('status');
      if (fresh?.status === 'received') rowPatch = { ...patch, evidence: JSON.stringify({ ...JSON.parse(patch.evidence), landedAfterReceive: new Date().toISOString() }) };
      // Cancelled by an older pod while the claim was placing: the order may
      // have gone out, and a cancelled request can be neither received nor
      // revoked (both refuse) while the live-order guard blocks a
      // replacement — restore it to ordered, as a late placement does
      // (Codex r31 P1).
      if (fresh?.status === 'cancelled') { reopen = true; rowPatch = { ...rowPatch, evidence: JSON.stringify({ ...JSON.parse(rowPatch.evidence), reopenedFromCancelledAt: new Date().toISOString() }) }; }
    }
    const transition = trx('vendor_orders').where({ id: ledger.id, status: 'placing' });
    // Stale recovery: the heartbeat observed at scan time must STILL be old —
    // a run that resumed beating between the scan and this write keeps its
    // claim (Codex r5 P1).
    if (staleBefore) transition.where('updated_at', '<', staleBefore);
    const n = await transition.update(rowPatch);
    if (!n) return false;
    if (markRequestOrdered || reopen) await requestToOrdered(trx, request.id);
    // The vendor order number rides into the audit row when the park knows it (Codex r30 P2).
    await auditVendorOrder({ vendor_order_id: ledger.id, restock_request_id: request.id, vendor_id: vendor.id, adapter: adapterKey, outcome: status, amount_cents: amountCents, external_order_number: placed?.externalOrderNumber || null, reason: `${reason}: ${message}`.slice(0, 400), trx });
    return true;
  });
  if (!transitioned) {
    logger.warn(`[order-dispatch] ledger ${ledger.id} already left 'placing' — ${reason} park skipped, the settled outcome stands`);
    return { requestId: request.id, ledgerId: ledger.id, skipped: 'already_settled' };
  }
  const bellDelivered = await deliverBell(conn, { notify, ledgerId: ledger.id, requestId: request.id, productName: product.name, vendorName: vendor.name, ...bell });
  return { requestId: request.id, ledgerId: ledger.id, status, reason, ...(bellDelivered ? {} : { bellPending: true }) };
}

// Why the sweep's own request is no longer authorized NOW, or null. The
// request may be days old (a gated run raised it); since then a receive may
// have landed, automation may be off, the product retired, or its vendor /
// reorder quantity / unit edited — money is never spent on a superseded
// configuration (Codex r1 P1 + pre-push P0).
function claimIneligibility({ product, request, vendor }) {
  const onHand = num(product.inventory_on_hand);
  const threshold = num(product.low_stock_threshold);
  if (product.active === false) return 'product_inactive';
  if (product.auto_reorder_enabled !== true) return 'auto_reorder_disabled';
  if (onHand == null || threshold == null) return 'stock_untracked';
  if (onHand > threshold) return 'stock_no_longer_low';
  if ((product.auto_reorder_vendor_id || null) !== vendor.id) return 'vendor_changed';
  if (num(product.reorder_quantity) !== num(request.requested_quantity) || normalizeInventoryUnit(product.inventory_unit) !== normalizeInventoryUnit(request.unit)) return 'quantity_changed';
  return null;
}

/**
 * CLAIM under the request lock + the product row lock: state re-checked,
 * ledger row inserted 'placing', commit. Returns { skipped[, cancelled] } or
 * the claim ({ request, vendor, adapterKey, product, ledger, pricing, order }).
 */
// The request's vendor must be active, have an adapter, and be gated on.
async function resolveClaimVendor(trx, { request, registry, deadAdapters = null, login = null }) {
  const m = meta(request.metadata);
  if (!m.vendorId) return { skipped: 'no_vendor' };
  // Locked: a vendor edit (password rotation, account change) between the
  // login prefetch and this claim commits after it, and the version check
  // below sees the prefetch's row (Codex #3853 r15 P1).
  const vendor = await trx('vendors').where({ id: m.vendorId }).forUpdate().first('id', 'name', 'code', 'active', 'updated_at');
  const adapterKey = adapterKeyFor(vendor);
  if (!vendor || vendor.active === false || !adapterKey || !registry[adapterKey]) return { skipped: 'no_adapter' };
  if (!gateEnvValue(VENDOR_GATE[adapterKey])) return { skipped: 'vendor_gated' };
  // An adapter that already failed run-level THIS run (its DNS, browser or
  // credential store is down) gets no further claims this run — the request
  // stays open for tomorrow, no ledger row is written (Codex r8 P1).
  if (deadAdapters && deadAdapters.has(adapterKey)) return { skipped: 'adapter_down' };
  // The same credential check canAutoOrder makes: an adapter without its key
  // must not claim (and retire the manual bell) only to park every request as
  // "no prior order" — hand it back instead (Codex r21 P2).
  const adapter = registry[adapterKey];
  if (typeof adapter.configured === 'function' && adapter.configured() !== true) return { skipped: 'adapter_unconfigured' };
  // A login-driven adapter (the SiteOne bot) is configured by the vendor row,
  // not env: its stored login is read HERE, before the one-shot ledger claim,
  // so a missing login hands the request back (retryable once the owner
  // stores it) instead of parking a claim as no_credentials (Codex #3853 r12
  // P2). The login was read by prefetchVendorLogin BEFORE this transaction
  // opened (see there); a login read for another vendor OR an older version
  // of this row (its password / account changed in between) is not claimed
  // on — skipped without a bell, the next run re-reads it.
  if (!adapter.loginRequired) return { vendor, adapterKey, m };
  if (!login || login.vendorId !== vendor.id || login.version !== rowVersion(vendor)) return { skipped: 'vendor_changed_at_claim' };
  if (adapter.loginConfigured(login.credentials) !== true) return { skipped: 'adapter_unconfigured' };
  return { vendor, adapterKey, m, credentials: login.credentials };
}

// The stored login of a login-driven vendor, read BEFORE the claim
// transaction opens and on the POOL connection: (1) the decrypt tries the
// promoted key first and a wrong-key failure would abort a transaction
// (39000 → 25P02), stranding every row still under the fallback key (Codex
// #3853 r13 P0); (2) the scheduled path already holds the lease connection
// plus the claim transaction's, and the pool floor is 2 — a third connection
// from inside the transaction would wait forever (pre-push P1). A lookup that
// THROWS is run-level for this adapter: nothing written. Null when the
// request's vendor needs no login (the claim re-resolves the vendor under
// lock) — or when the adapter is already dead this run: the claim will skip
// it adapter_down, and a credential store that IS the failure must not be
// hit again once per remaining request (Codex #3853 r24 P2).
const rowVersion = (row) => (row && row.updated_at != null ? new Date(row.updated_at).toISOString() : null);

async function prefetchVendorLogin(conn, requestId, registry, deadAdapters = null) {
  const request = await conn('product_restock_requests').where({ id: requestId }).first('metadata');
  const vendorId = request ? meta(request.metadata).vendorId : null;
  const vendor = vendorId ? await conn('vendors').where({ id: vendorId }).first('id', 'name', 'code', 'active', 'updated_at') : null;
  const adapterKey = adapterKeyFor(vendor);
  const adapter = adapterKey ? registry[adapterKey] : null;
  if (!adapter || !adapter.loginRequired || (deadAdapters && deadAdapters.has(adapterKey))) return null;
  // version = the vendor row's updated_at at read time: the claim re-reads it
  // under lock and refuses a login read from an older row (Codex #3853 r15 P1).
  try { return { vendorId: vendor.id, version: rowVersion(vendor), credentials: await getVendorLoginCredentials(conn, vendor.id) }; }
  catch (e) { const err = new Error(`vendor credential lookup failed: ${e.message}`); err.runLevel = true; err.adapterKey = adapterKey; throw err; }
}

// Withdraw a request the catalog no longer authorizes — the owner's own
// action or a receive made it moot, no bell. closed_by stays null: a system
// cancel, not a technician's (the FK is technicians.id).
// The sweep's own manual-order bell for a request (auto-reorder:<request>,
// rung by a gated sweep) — retired in the claim transaction, and when the
// claim CANCELS the request: a bell telling staff to buy a need that is gone
// is an unnecessary purchase (Codex r20 P1, r24 P1).
function retireRequestBell(trx, requestId) {
  return trx('notifications').whereRaw("metadata->>'dedupeKey' = ?", [`auto-reorder:${requestId}`]).whereNull('read_at').update({ read_at: new Date() });
}

async function cancelAtClaim(trx, { request, product, m, ineligible }) {
  await retireRequestBell(trx, request.id);
  // A re-claimable dry-run row's own versioned bell ("turn dry run off to
  // order for real") is withdrawn with the need (Codex r30 P1).
  await settleRequestLedgerBells(trx, request.id);
  await trx('product_restock_requests').where({ id: request.id, status: 'open' }).update({
    status: 'cancelled',
    closed_at: new Date(),
    metadata: JSON.stringify({ ...m, autoOrderCancelled: ineligible, autoOrderCancelledAt: new Date().toISOString() }),
    updated_at: new Date(),
  });
  logger.info(`[order-dispatch] ${product.name}: request ${request.id} cancelled at claim (${ineligible})`);
  return { skipped: ineligible, cancelled: true };
}

/**
 * Under the product row lock: no other live request for the product, and no
 * prior dispatched order that is neither received nor revoked.
 *
 * Sibling check: a manual / forecast request for the same product raised
 * alongside the auto row (the partial unique index only spans auto rows)
 * means staff are ordering — never auto-order on top of it (pre-push
 * audit P0). CONTRACT: every path that creates a restock request (the
 * readiness exception in admin-protocols.js, the WaveGuard forecast in
 * admin-inventory.js, the Intelligence Bar tool, the sweep) inserts
 * inside a transaction that first locks this products_catalog row FOR
 * UPDATE, so a staff request either commits before this read or waits
 * for this claim to commit — the read is serialized, not advisory
 * (pre-push P0). And once this claim commits, those same paths call
 * assertNoLiveAutoOrder under that lock and REFUSE (409) while the claim
 * row is placing or dispatched: the lock covers the read, the claim row
 * covers the vendor call — never both orders.
 *
 * Prior-order belt (pre-push P0): a PRIOR automatic order for this product
 * that was dispatched (placed_at set) and is neither received nor revoked is
 * stock that may be on its way — never claim a second order on top of it,
 * however the earlier request was closed. Its park's bell already asked for
 * the reconciliation.
 */
async function lockedProductGuards(trx, { request }) {
  const sibling = await trx('product_restock_requests').where({ product_id: request.product_id }).whereIn('status', ['open', 'ordered']).whereNot('id', request.id).first('id', 'source', 'status');
  if (sibling) return { skipped: 'sibling_live_request', sibling };
  const unreconciled = await trx('vendor_orders as vo')
    .join('product_restock_requests as prr', 'prr.id', 'vo.restock_request_id')
    .where('prr.product_id', request.product_id)
    .whereNot('prr.id', request.id)
    // A sibling claim still placing counts too (its request may already be received — Codex r29 P1).
    .whereRaw("(vo.status = 'placing' OR vo.placed_at IS NOT NULL)")
    .whereRaw(RECEIVED_SETTLES_SQL)
    .whereRaw("NULLIF(vo.evidence->>'revokedAt', '') IS NULL")
    .first('vo.id');
  if (unreconciled) return { skipped: 'prior_order_unreconciled', ledgerId: unreconciled.id };
  return null;
}

// A re-armed dry-run row still has its "nothing was submitted — turn dry run
// off to order for real" bell out: retire it in the claim's own transaction,
// before this claim can submit, or staff act on it beside a real order
// (pre-push P0). The versioned key is auto-order:<ledger>[:<v>].
function retireLedgerBells(trx, ledgerId) {
  return trx('notifications').whereRaw("(metadata->>'dedupeKey' = ? OR metadata->>'dedupeKey' LIKE ?)", [`auto-order:${ledgerId}`, `auto-order:${ledgerId}:%`]).whereNull('read_at').update({ read_at: new Date() });
}

// The Restock tab renders the request's OWN vendorSku / vendorProductUrl as
// the order link: when the eligible price row changed between the request
// and the claim, stamp what the claim actually authorized so the tab (and a
// pre-submit park's "order by hand" link) shows the SKU being bought
// (Codex r21 P2). The link is the CURRENT row's — null included: a row with
// no URL must not keep sending staff to the previous SKU's page (Codex r22
// P2). Unchanged = no write.
async function stampAuthorizedSku(trx, { request, pricing }) {
  if (!pricing?.vendor_sku) return;
  const m = meta(request.metadata);
  const learned = { vendorSku: pricing.vendor_sku, vendorProductUrl: pricing.vendor_product_url || null };
  if (m.vendorSku === learned.vendorSku && (m.vendorProductUrl || null) === learned.vendorProductUrl) return;
  await trx('product_restock_requests').where({ id: request.id, status: 'open' }).update({ metadata: JSON.stringify({ ...m, ...learned }), updated_at: new Date() });
}

// The eligible price row is read under the same lock so the claim's payload
// records the SKU + vendor quantity the order will carry.
async function insertClaim(trx, { request, product, vendor, adapterKey, registry, quantity }) {
  const { vendorPricingFor } = require('./auto-reorder');
  const pricing = await vendorPricingFor(trx, product.id, vendor.id);
  const order = pricing?.vendor_sku ? vendorOrderQuantity({ adapter: registry[adapterKey], request, pricing }) : null;
  const payload = { productId: product.id, quantity, unit: request.unit || null, vendorSku: pricing?.vendor_sku || null, vendorQuantity: order?.quantity ?? null, packSize: order?.packSize ?? null, orderedQuantity: order?.orderedQuantity ?? null };
  const claimRow = { restock_request_id: request.id, vendor_id: vendor.id, adapter: adapterKey, status: 'placing', request_payload: JSON.stringify(payload) };
  // The unique claim is re-armed ONLY over a dry-run park (nothing was ever
  // submitted); every other existing row wins the conflict (at-most-once).
  const inserted = await trx('vendor_orders').insert(claimRow)
    .onConflict('restock_request_id')
    // evidence is NOT NULL: reset to {}. created_at is the cap-accounting
    // month (monthlySpentCents): a re-armed claim counts against THIS month.
    .merge({ ...claimRow, error: null, evidence: JSON.stringify({}), amount_cents: null, placed_at: null, external_order_number: null, response_payload: null, created_at: new Date(), updated_at: new Date() })
    .whereRaw(DRY_RUN_RECLAIMABLE_SQL)
    .returning('*');
  const ledger = inserted && inserted[0];
  if (ledger) {
    await retireLedgerBells(trx, ledger.id);
    await stampAuthorizedSku(trx, { request, pricing });
  }
  return { ledger, pricing, order };
}

async function claimRequest(trx, { requestId, registry, deadAdapters = null, login = null }) {
  // The product's pricing advisory lock FIRST — the lock every
  // vendor_pricing writer holds to commit — then the request row, then the
  // product row: the sweep's order (auto-reorder.js lockProductPricing), so
  // insertClaim reads one committed pricing configuration and no inverse
  // order can deadlock (Codex r10 P1). The product id is peeked unlocked
  // only to name the lock; the row itself is read again FOR UPDATE.
  const peek = await trx('product_restock_requests').where({ id: requestId }).first('product_id');
  if (!peek) return { skipped: 'not_found' };
  await require('./auto-reorder').lockProductPricing(trx, peek.product_id);
  // LOCK ORDER: any existing ledger row (a re-claimable dry-run park) BEFORE
  // the request — the order every manual action and the revoke CLI use, so a
  // reclaim racing a manual action waits instead of deadlocking (hook P1).
  await trx('vendor_orders').where({ restock_request_id: requestId }).forUpdate().first('id');
  const request = await trx('product_restock_requests').where({ id: requestId }).forUpdate().first();
  if (!request) return { skipped: 'not_found' };
  if (request.status !== 'open' || request.source !== 'auto_reorder') return { skipped: 'not_open_auto_request' };
  const resolved = await resolveClaimVendor(trx, { request, registry, deadAdapters, login });
  if (resolved.skipped) return resolved;
  const { vendor, adapterKey, m, credentials = null } = resolved;
  const product = await trx('products_catalog').where({ id: request.product_id }).forUpdate().first('id', 'name', 'active', 'auto_reorder_enabled', 'inventory_on_hand', 'low_stock_threshold', 'auto_reorder_vendor_id', 'reorder_quantity', 'inventory_unit');
  if (!product) return { skipped: 'no_product' };
  const ineligible = claimIneligibility({ product, request, vendor });
  if (ineligible) return cancelAtClaim(trx, { request, product, m, ineligible });
  const guarded = await lockedProductGuards(trx, { request });
  if (guarded) return guarded;
  const quantity = Number(request.requested_quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) return { skipped: 'no_quantity' };
  // A manual-order bell an earlier (gated) sweep rang for this request is
  // retired IN the claim transaction: the claim exists only if the bell is
  // gone, so staff are never told to buy what the dispatcher is ordering. A
  // failed retire aborts the claim — nothing is ordered (Codex r20 P1).
  await retireRequestBell(trx, request.id);
  const { ledger, pricing, order } = await insertClaim(trx, { request, product, vendor, adapterKey, registry, quantity });
  if (!ledger) return { skipped: 'already_claimed' };
  return { request, vendor, adapterKey, product, quantity, ledger, pricing, order, credentials };
}

/**
 * Binding total BEFORE anything is sent, for adapters that do not quote at
 * placement (Sticker Mule): the vendor's own figure for this exact order
 * from history, cap-reserved atomically. Returns { quoteCents } to proceed or
 * { parked } — the park result to return as this request's outcome.
 */
async function resolveBindingTotal(conn, { adapter, ctx, vendor, vendorSku, quantity, now, env }) {
  let bq;
  try { bq = await adapter.bindingQuote({ vendorSku, quantity }); }
  catch (err) { return { parked: await park(conn, { ...ctx, status: 'failed', reason: 'adapter_error', message: `binding total lookup failed: ${err.message}` }) }; }
  if (!bq || !Number.isFinite(bq.cents) || bq.cents <= 0) return { parked: await park(conn, { ...ctx, reason: 'no_binding_total', message: `${vendor.name} has no prior order of item ${vendorSku} at ${quantity} on the account, so there is no binding total to cap; place one identical order by hand first.` }) };
  const quoteCents = bq.cents;
  const cap = await reserveUnderCaps(conn, ctx.ledger.id, quoteCents, { env });
  if (!cap.ok) return { parked: await park(conn, { ...ctx, reason: cap.reason, message: `${cap.message} (${vendor.name} total for the last identical order${bq.source ? `, ${bq.source}` : ''})`, amountCents: quoteCents }) };
  if (adapter.preSubmitTotal !== 'vendor') {
    // A historical charge is not a vendor-confirmed current total: price,
    // tax or shipping may have moved since, and a cap can only be
    // enforced BEFORE money moves. Park with everything the office needs
    // for a one-minute manual reorder (pre-push audit P0; owner ruling
    // pending on accepting history-total placement).
    return { parked: await park(conn, { ...ctx, reason: 'no_vendor_confirmed_total', message: `${vendor.name}'s API confirms no current total before ordering; the last identical order (${bq.source || 'history'}) was ${dollars(quoteCents)}, which fits the caps. Reorder item ${vendorSku} × ${quantity} by hand.`, amountCents: quoteCents }) };
  }
  return { quoteCents };
}

// What an adapter.place() rejection means. Run-level errors are the caller's
// (claim released, batch aborts); everything else is this request's park.
// A post-submit park with NO positive total anywhere (nothing confirmed, no
// quote, nothing reserved) is counted at the per-order cap: a placed_at row
// with a null amount would count as $0 against the monthly cap while the
// money may have moved (pre-push P0 / P1, Codex r23 P1). Fail closed; the
// receive or revoke corrects the figure.
function unconfirmedAmount(env) {
  const amountCents = caps(env).perOrder ?? null;
  return { amountCents, counted: amountCents != null ? ` No total was confirmed or reserved, so it is counted against the monthly cap at the per-order cap (${dollars(amountCents)}) until received or revoked.` : '' };
}
// EVERY post-submit figure — the vendor's, a quote, or that fallback —
// reaches the row UNDER the cap lock before the park: the park itself holds
// no lock, and a concurrent dispatcher summing the month in the gap would
// read this placing row at its stale or null amount (Codex r24 P1, hook P0).
// The row's cap-accounting month is kept. claim_lost = the row already left
// placing; the caller settles that as a late placement.
async function reservePostSubmitAmount(conn, ledger, cents, env) {
  if (cents == null) return { ok: false, reason: 'caps_unconfigured' };
  const reservation = await ledgerReservation(conn, ledger);
  return reserveUnderCaps(conn, ledger.id, cents, { env, accountingAt: reservation.createdAt, postPlacement: true });
}

async function parkForPlaceError(conn, err, { ctx, vendor, quoteCents, env }) {
  // A refusal that names the vendor total it was decided on (SiteOne's cap
  // refusal at the cart or checkout stage) parks with THAT amount — the
  // ledger must show the binding total, not an earlier quote (Codex #3853 r4 P2).
  if (err.refuse) return park(conn, { ...ctx, reason: err.refuse, message: err.message, amountCents: err.cents ?? quoteCents, evidence: err.evidence || null });
  // An ambiguous submit (the click happened) parks with the best figure
  // known: the total the adapter had at the click, else the binding quote,
  // else what beforeSubmit reserved on the ledger — else the per-order cap.
  // The vendor's response body (err.body: Sticker Mule accepted the POST but
  // returned no recognizable number) is persisted as response_payload — it
  // is what staff locate the possibly-placed order with (Codex r23 P2).
  if (err.ambiguous) {
    const known = positiveCents(err.cents) ?? positiveCents(quoteCents) ?? (await ledgerReservation(conn, ctx.ledger)).cents;
    const { amountCents, counted } = known == null ? unconfirmedAmount(env) : { amountCents: known, counted: '' };
    const reserved = await reservePostSubmitAmount(conn, ctx.ledger, amountCents, env);
    // The row left placing while the call ran (stale park, maybe a revoke on
    // top): a skipped park would leave the revoke marker standing beside an
    // order that MAY exist — a replacement purchase. Attach it as a late
    // placement (marker replaced, request ordered, reconcile bell) that
    // blocks a replacement until reconciled (hook P0).
    if (reserved.reason === 'claim_lost') return recordPlaced(conn, { ctx, placed: { externalOrderNumber: null, amountCents, response: err.body || null, evidence: err.evidence || null, ambiguous: true }, finalCents: amountCents, quoteCents });
    return park(conn, { ...ctx, reason: 'ambiguous_after_submit', message: `${err.message} — the order MAY exist at ${vendor.name}.${counted}`, amountCents, evidence: err.evidence || null, placed: err.body ? { response: err.body } : null });
  }
  return park(conn, { ...ctx, status: 'failed', reason: 'adapter_error', message: err.message, amountCents: quoteCents, evidence: err.evidence || null });
}

/**
 * A vendor call that finished AFTER stale recovery parked its row — and
 * possibly after the operator revoked that park and cancelled the request.
 * The order EXISTS now, so (pre-push P0): the revoke marker is REPLACED by a
 * distinct late-placement state (a revoked marker would let the prior-order
 * guard wave a fresh request through — a second purchase), the request goes
 * back to 'ordered' from open OR cancelled (stock is coming; receive is the
 * way to close it), the earlier park's bell is superseded by one saying so,
 * and the outcome is audited placed_after_stale_park. Status stays
 * needs_review: a human still has to look.
 */
// The order exists now: the request goes to 'ordered' from open — and from
// cancelled, when it was closed while the vendor call was in flight (stock is
// coming; receive or revoke is the way to close it — a cancelled request with
// an unreceived, unrevoked ledger row could be reconciled by neither: both
// receive endpoints and the revoke CLI refuse it while the live-order guard
// blocks a replacement, Codex r23 P1). Any other status is left alone.
function requestToOrdered(trx, requestId) {
  return trx('product_restock_requests').where({ id: requestId }).whereIn('status', ['open', 'cancelled']).update({ status: 'ordered', closed_at: null, updated_at: new Date() });
}

async function attachLatePlacement(trx, conn, { ctx, placed, orderFacts, quoteCents, fresh }) {
  const { ledger, request, product, vendor, adapterKey } = ctx;
  const parked = await trx('vendor_orders').where({ id: ledger.id }).first('evidence');
  const wasRevoked = !!meta(parked?.evidence).revokedAt;
  const after = wasRevoked ? 'the operator revoked it' : `it was parked and the request marked ${fresh?.status || 'missing'}`;
  const receivedMeanwhile = fresh?.status === 'received';
  // An ambiguous submit (the call left the process, outcome unknown) is
  // attached the same way — conservatively, as an order that MAY exist.
  const landed = placed.ambiguous ? 'MAY have been placed (the submit outcome is unknown — check the account)' : 'was confirmed';
  const bell = versioned({
    title: `Auto-order ${placed.ambiguous ? 'may have landed' : 'landed'} after ${wasRevoked ? 'revoke' : 'stale recovery'}: ${product.name}`,
    body: `${vendor.name} order ${placed.externalOrderNumber || '(number unknown)'} (${dollars(orderFacts.amount_cents ?? quoteCents)}) ${landed} after ${after}. ${receivedMeanwhile ? 'The stock counted at that receipt was not this order: receive the request once more when it arrives (the tab allows it for this order), or cancel with the vendor and record the revoke; new requests for the product are blocked until then.' : 'The request is back to ordered — receive the stock when it arrives, or cancel with the vendor and record the revoke again.'}`,
  });
  await trx('vendor_orders').where({ id: ledger.id }).update({
    ...orderFacts,
    // The adapter's confirmed facts (item / address / payment / read-back)
    // are kept for the reconciliation, as the green path keeps them (Codex r24 P2).
    // A request received meanwhile keeps this row live too (landedAfterReceive — Codex r27 P1).
    evidence: conn.raw("(COALESCE(evidence, '{}'::jsonb) - 'revokedAt' - 'bellAt') || ?::jsonb", [JSON.stringify({ ...(placed.evidence || {}), bell, latePlacementAt: new Date().toISOString(), latePlacementAfterRevoke: wasRevoked, ...(receivedMeanwhile ? { landedAfterReceive: new Date().toISOString() } : {}) })]),
    error: conn.raw("COALESCE(error, '') || ?", [` | order ${placed.ambiguous ? 'MAY have been placed' : 'confirmed placed'} after stale recovery${wasRevoked ? ' and revoke' : ''}: ${placed.externalOrderNumber || '?'}`]),
  });
  // A received request stays received (its stock was counted) — the marker above keeps its row live.
  if (!receivedMeanwhile) await requestToOrdered(trx, request.id);
  await auditVendorOrder({ vendor_order_id: ledger.id, restock_request_id: request.id, vendor_id: vendor.id, adapter: adapterKey, outcome: 'placed_after_stale_park', amount_cents: orderFacts.amount_cents, external_order_number: placed.externalOrderNumber || null, reason: `the row was parked by stale recovery${wasRevoked ? ' and revoked' : ''} while the vendor call ran; the order ${placed.ambiguous ? 'may exist (ambiguous submit)' : 'exists'}`, trx });
  return { bell, settledElsewhere: true };
}

// The order landed on a request an older pod received by hand while the
// call ran and the row is still 'placing': park it placed_on_received_request
// inside the record transaction (cap + row locks held) with
// evidence.landedAfterReceive, which keeps every live-order guard closed
// until the revoke CLI records a revoke or the request is received once
// more — the late order's own receipt (Codex r27 P1). The request is not
// touched: its stock was counted. Returns the bell for delivery.
async function parkOnReceivedLocked(trx, { ctx, placed, finalCents }) {
  const { ledger, request, product, vendor, adapterKey } = ctx;
  const reason = 'placed_on_received_request';
  const message = `${vendor.name} order ${placed.externalOrderNumber || '?'} (${dollars(finalCents)}) landed after the restock request was received by hand — the stock counted was not this order. Receive the request once more when it arrives (the tab allows it for this order), or cancel with the vendor and record the revoke; new requests for the product are blocked until then.`;
  const bell = parkBell({ reason, status: 'needs_review', product, vendor, request, amountCents: finalCents, message, placed });
  const patch = parkPatch({ status: 'needs_review', reason, message, evidence: { ...(placed.evidence || {}), landedAfterReceive: new Date().toISOString() }, bell, amountCents: finalCents, postSubmit: true, placed });
  await trx('vendor_orders').where({ id: ledger.id, status: 'placing' }).update(patch);
  await auditVendorOrder({ vendor_order_id: ledger.id, restock_request_id: request.id, vendor_id: vendor.id, adapter: adapterKey, outcome: 'needs_review', amount_cents: finalCents, external_order_number: placed.externalOrderNumber || null, reason: `${reason}: ${message}`.slice(0, 400), trx });
  return { bell, parkedOnReceived: true };
}

/**
 * Green path: ledger placed + request ordered + audit in ONE transaction, no
 * bell — unless the office closed the request mid-flight (back to ordered,
 * one reconcile bell) or stale recovery already parked the row
 * (attachLatePlacement).
 */
async function recordPlaced(conn, { ctx, placed, finalCents, quoteCents }) {
  const { ledger, request, product, vendor, adapterKey, notify } = ctx;
  const orderFacts = {
    external_order_number: placed.externalOrderNumber || null,
    amount_cents: finalCents,
    response_payload: placed.response ? JSON.stringify(placed.response) : null,
    placed_at: new Date(),
    updated_at: new Date(),
  };
  // The office closed the request while the vendor call was in flight: an
  // order exists that the tab no longer expects — say so once. A cancelled
  // request is put back to ordered (requestToOrdered).
  const closedMidFlightBell = (freshStatus) => versioned({ title: `Auto-order placed on a ${freshStatus || 'missing'} request: ${product.name}`, body: `${vendor.name} order ${placed.externalOrderNumber || ''} (${dollars(finalCents)}) landed after the restock request was marked ${freshStatus || 'missing'}. ${freshStatus === 'cancelled' ? 'The request is back to ordered — receive the stock when it arrives, or cancel with the vendor and record the revoke.' : 'Reconcile by hand.'}` });
  const outcome = await conn.transaction(async (trx) => {
    // The cap lock FIRST — the reservation's own order (cap lock → ledger
    // row): the amount this commit records lands while no concurrent
    // reservation can sum the month against the row's old figure or its
    // revoked marker. That matters for a late placement whose higher final
    // total the post-placement re-check could not write (claim_lost: stale
    // recovery had parked the row) — attachLatePlacement restores it here,
    // under the same lock (Codex r23 P1).
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [CAPS_LOCK_KEY]);
    // LOCK ORDER: ledger row next, then the request — the same order the
    // revoke script and every park use, so a late placement racing an
    // operator revoke waits instead of deadlocking (Codex r3 P1).
    const row = await trx('vendor_orders').where({ id: ledger.id }).forUpdate().first('id', 'status');
    const fresh = await trx('product_restock_requests').where({ id: request.id }).forUpdate().first('status');
    // Received by hand while the call ran (an older, pre-guard pod): that
    // receipt counted stock that was not this order, and a received request
    // would settle the row in every guard. Not a green placement: the row
    // parks placed_on_received_request HERE, under the same locks, with the
    // marker that keeps the guards closed (Codex r27 P1) — or, when stale
    // recovery already parked it, the late facts attach with that same
    // marker (hook r27 P0). Either way the request stays received.
    if (fresh?.status === 'received') {
      if (row?.status !== 'placing') return attachLatePlacement(trx, conn, { ctx, placed, orderFacts, quoteCents, fresh });
      return parkOnReceivedLocked(trx, { ctx, placed, finalCents });
    }
    const stillOpen = fresh?.status === 'open';
    const bell = stillOpen ? null : closedMidFlightBell(fresh?.status);
    // Green transition only from a row still 'placing' (pre-push P1).
    const n = await trx('vendor_orders').where({ id: ledger.id, status: 'placing' }).update({
      ...orderFacts,
      status: 'placed',
      evidence: JSON.stringify({ ...(placed.evidence || {}), ...(bell ? { bell } : {}) }),
      error: stillOpen ? null : `request_state_changed: request was ${fresh?.status || 'missing'} when the order landed`,
    });
    if (!n) return attachLatePlacement(trx, conn, { ctx, placed, orderFacts, quoteCents, fresh });
    await requestToOrdered(trx, request.id);
    await auditVendorOrder({ vendor_order_id: ledger.id, restock_request_id: request.id, vendor_id: vendor.id, adapter: adapterKey, outcome: 'placed', amount_cents: finalCents, external_order_number: placed.externalOrderNumber || null, trx });
    return { bell };
  });
  const bellDelivered = outcome.bell ? await deliverBell(conn, { notify, ledgerId: ledger.id, requestId: request.id, productName: product.name, vendorName: vendor.name, ...outcome.bell }) : true;
  logger.info(`[order-dispatch] ${placed.ambiguous ? 'ambiguous submit attached for' : 'placed'} ${vendor.name} order ${placed.externalOrderNumber || '?'} for ${product.name} (${dollars(placed.amountCents ?? quoteCents)})`);
  return {
    requestId: request.id,
    ledgerId: ledger.id,
    status: outcome.settledElsewhere || outcome.parkedOnReceived ? 'needs_review' : 'placed',
    ...(outcome.parkedOnReceived ? { reason: 'placed_on_received_request' } : outcome.settledElsewhere ? { reason: 'placed_after_stale_park' } : {}),
    externalOrderNumber: placed.externalOrderNumber || null,
    amountCents: finalCents,
    ...(bellDelivered ? {} : { bellPending: true }),
  };
}

/**
 * An unexpected error after the claim. After the vendor call the order
 * exists (or may): a failed ledger / request / audit write is a
 * reconciliation, NEVER a "failed — order manually" (that is the
 * double-purchase path). Before it, park as a definite failure rather than
 * leave a silent 'placing' row. If even the park fails, the outcome is
 * 'unrecorded' — the run turns red on it (Codex r2 P1) and stale recovery
 * parks the row next tick.
 */
async function settleAfterError(conn, err, { ctx, vendor, submitted, placed, quoteCents, env }) {
  const { ledger, request, product } = ctx;
  logger.error(`[order-dispatch] ${product.name}: ${err.message}`);
  try {
    if (submitted) {
      // The figure this park records reaches the row under the cap lock
      // first, like every other post-submit amount (Codex r27 P1); a claim
      // lost meanwhile is attached as a late placement instead.
      // The figure is the positive one — the vendor's, the quote, or what
      // beforeSubmit reserved on the row — never a zero that would overwrite
      // the reservation and drop the order from the month (Codex r31 P1);
      // with no positive figure anywhere, the per-order cap, as every other
      // post-submit park counts it.
      const known = await settledFinalCents(conn, { ledger, placed, quoteCents });
      const { amountCents, counted } = known == null ? unconfirmedAmount(env) : { amountCents: known, counted: '' };
      const reserved = await reservePostSubmitAmount(conn, ledger, amountCents, env);
      if (reserved.reason === 'claim_lost') return await recordPlaced(conn, { ctx, placed: placed || { externalOrderNumber: null, amountCents, evidence: null }, finalCents: amountCents, quoteCents });
      const parked = await park(conn, { ...ctx, markRequestOrdered: true, reason: 'persist_after_placement', message: `${vendor.name} order ${placed?.externalOrderNumber || '(number unknown)'}${known != null ? ` (${dollars(known)})` : ''} was placed but recording it failed: ${err.message}.${counted}`, amountCents, evidence: placed?.evidence || null, placed });
      // The row had already left 'placing' (stale recovery / revoke while
      // the vendor call ran) and the late-placement attachment itself
      // failed: a skipped park would read as harmless while the confirmed
      // number and amount are unrecorded and a revokedAt marker may still
      // admit a replacement purchase. That is UNRECORDED — the run goes
      // red on it (Codex r17 P1).
      if (parked.skipped === 'already_settled') return { requestId: request.id, ledgerId: ledger.id, status: 'unrecorded', reason: 'persist_after_placement', externalOrderNumber: placed?.externalOrderNumber || null, error: `${err.message}; the row had already left placing and the late placement was not attached` };
      return parked;
    }
    return await park(conn, { ...ctx, status: 'failed', reason: 'dispatch_error', message: err.message });
  } catch (parkErr) {
    logger.error(`[order-dispatch] could not park ledger ${ledger.id}: ${parkErr.message}`);
    return { requestId: request.id, ledgerId: ledger.id, status: 'unrecorded', reason: submitted ? 'persist_after_placement' : 'dispatch_error', externalOrderNumber: placed?.externalOrderNumber || null, error: `${err.message}; park failed: ${parkErr.message}` };
  }
}

/**
 * Dispatch ONE open auto_reorder request. Returns { requestId, status,
 * reason } and never throws for a per-request outcome; throws only a
 * run-level error (err.runLevel) after releasing the claim.
 */
// Every adapter needs the eligible price row: it is the vendor/SKU
// authorization the sweep used, and the pack size the quantity needs. A
// catalog siteone_sku or the request's cached SKU is not eligibility. Returns
// the park result, or null when the order is priced and sized.
function parkIfUnpriced(conn, { ctx, pricing, order, vendor, product }) {
  if (!pricing?.vendor_sku) return park(conn, { ...ctx, reason: 'no_price', message: `${vendor.name} has no eligible price row (vendor SKU) for ${product.name}; the dispatcher never orders blind.` });
  if (order.error) return park(conn, { ...ctx, reason: order.error, message: `${order.message}; fix the ${vendor.name} price row's pack size.` });
  return null;
}

// Detector: the vendor's read-back total should equal the reserved one. If it
// came out higher and breaks a cap, the order exists but parks for the owner
// (cancel with the vendor / revoke); the request is ordered. Returns the park
// result, or null when the final total fits.
// The baseline is whatever the caps already admitted: the pre-submit binding
// quote, or — for a quotesAtPlace adapter — the amount beforeSubmit reserved
// on the ledger row. A checkout-quoting vendor whose confirmation comes back
// higher than the reserved checkout figure is re-checked exactly like a
// quoted one (pre-push P0): no adapter kind skips the detector.
async function parkIfOverCapAfterPlacement(conn, { ctx, vendor, ledger, placed, finalCents, quoteCents, env }) {
  if (finalCents == null) return null;
  const reservation = await ledgerReservation(conn, ledger);
  const admitted = positiveCents(quoteCents) ?? reservation.cents;
  if (finalCents <= (admitted ?? 0)) return null;
  const finalCap = await reserveUnderCaps(conn, ledger.id, finalCents, { env, accountingAt: reservation.createdAt, postPlacement: true });
  if (finalCap.ok) return null;
  // The row already left 'placing' (stale recovery parked or the operator
  // revoked it while the vendor call ran): the order still EXISTS at this
  // higher total, so it must land as a late placement — number, amount,
  // request back to ordered, revoke marker replaced — exactly as the green
  // path does, never dropped by a skipped park (pre-push P0).
  const late = () => recordPlaced(conn, { ctx, placed, finalCents, quoteCents });
  if (finalCap.reason === 'claim_lost') return late();
  const parked = await park(conn, { ...ctx, markRequestOrdered: true, reason: 'over_cap_after_placement', message: `${vendor.name} charged ${dollars(finalCents)} for order ${placed.externalOrderNumber || '?'}: ${finalCap.message}.`, amountCents: finalCents, evidence: placed.evidence || null, placed });
  return parked.skipped === 'already_settled' ? late() : parked;
}

// The amount a PLACED order is recorded and cap-counted at: the vendor's
// confirmed total, else the pre-submit quote, else the amount beforeSubmit
// reserved on the ledger row — never null or non-positive, which would
// overwrite the reservation and drop the order from the monthly cap
// (pre-push P0). null = nothing positive anywhere: the caller parks.
const positiveCents = (v) => (Number.isInteger(v) && v > 0 ? v : null);
// What the ledger row holds from the reservation: the amount beforeSubmit
// reserved (null = nothing reserved) and the cap-accounting month stamp.
async function ledgerReservation(conn, ledger) {
  const row = await conn('vendor_orders').where({ id: ledger.id }).first('amount_cents', 'created_at');
  return { cents: positiveCents(row?.amount_cents == null ? null : Number(row.amount_cents)), createdAt: row?.created_at ? new Date(row.created_at) : null };
}
async function settledFinalCents(conn, { ledger, placed, quoteCents }) {
  return positiveCents(placed?.amountCents) ?? positiveCents(quoteCents) ?? (await ledgerReservation(conn, ledger)).cents;
}

// Stages after a committed claim: price → binding total → vendor call →
// post-submit detector → record. Every exit is a park, a record, or a
// run-level throw after releasing the claim.
async function dispatchClaimed(conn, claim, { registry, notify, now, env }) {
  const { request, vendor, adapterKey, product, ledger, pricing, order, credentials } = claim;
  const adapter = registry[adapterKey];
  const ctx = { ledger, request, product, vendor, adapterKey, notify };
  const releaseClaim = () => conn('vendor_orders').where({ id: ledger.id, status: 'placing' }).delete();
  let submitted = false; // true once the vendor call left the process
  let placed = null;
  let quoteCents = null;
  try {
    const unpriced = await parkIfUnpriced(conn, { ctx, pricing, order, vendor, product });
    if (unpriced) return unpriced;
    const vendorSku = pricing.vendor_sku;
    const quantity = order.quantity;
    if (!adapter.quotesAtPlace) {
      const binding = await resolveBindingTotal(conn, { adapter, ctx, vendor, vendorSku, quantity, now, env });
      if (binding.parked) return binding.parked;
      quoteCents = binding.quoteCents;
    }
    // `credentials` is the login the claim looked up for a login-driven
    // adapter (undefined for every other — the claim already decided which).
    const base = { vendorSku, quantity, quoteCents, credentials };
    // An adapter with no static quote reads the vendor's total at the point of
    // sale and runs the cap reservation through beforeSubmit right before it
    // submits (the binding total is the vendor's, never a local estimate).
    // An adapter that gates more than once (SiteOne: cart total, checkout
    // total, the total at the click) keeps the FIRST reservation's accounting
    // month: later gates pass that stamp as accountingAt, so a checkout that
    // crosses a month boundary is neither moved into the new month nor frees
    // old-month headroom (Codex #3876 r3 P1).
    let accountingAt = null;
    const beforeSubmit = async (cents) => {
      const verdict = await reserveUnderCaps(conn, ledger.id, cents, { env, accountingAt });
      if (verdict.ok === true && !accountingAt) accountingAt = (await ledgerReservation(conn, ledger)).createdAt;
      return verdict;
    };
    const placeArgs = adapter.quotesAtPlace ? { ...base, beforeSubmit } : base;
    const stopHeartbeat = startClaimHeartbeat(conn, ledger.id);
    try {
      placed = await adapter.place(placeArgs);
    } catch (err) {
      if (err.runLevel) { await releaseClaim(); throw err; }
      if (err.ambiguous) submitted = true;
      // A refusal the adapter marks adapterDown (SiteOne rejected the stored
      // login) parks THIS request as usual and takes the adapter out of the
      // run: its remaining requests stay unclaimed instead of resubmitting
      // the same rejected credential once each (Codex #3853 r21 P1). The
      // adapter's boolean becomes the key ONCE, here; the marker rides on
      // the park's failure too (into the outer settlement), so a transient
      // DB error while parking cannot revive the adapter for the run (r22 P2).
      if (err.adapterDown) err.adapterDown = adapterKey;
      let parked;
      try { parked = await parkForPlaceError(conn, err, { ctx, vendor, quoteCents, env }); }
      catch (parkErr) { parkErr.adapterDown = err.adapterDown; throw parkErr; }
      return withAdapterDown(parked, err);
    } finally { stopHeartbeat(); }
    if (placed.dryRun) return await park(conn, { ...ctx, reason: 'dry_run', message: 'dry run', amountCents: placed.amountCents, evidence: placed.evidence || null });
    submitted = true; // from here every failure is post-placement: needs_review, never "order manually"
    const finalCents = await settledFinalCents(conn, { ledger, placed, quoteCents });
    if (finalCents == null) {
      const { amountCents, counted } = unconfirmedAmount(env);
      const reserved = await reservePostSubmitAmount(conn, ledger, amountCents, env);
      // The row left placing while the vendor call ran: the order exists at
      // (at least) the fallback figure — attach it as a late placement.
      if (reserved.reason === 'claim_lost') return await recordPlaced(conn, { ctx, placed, finalCents: amountCents, quoteCents });
      return await park(conn, { ...ctx, markRequestOrdered: true, reason: 'no_final_total', message: `${vendor.name} order ${placed.externalOrderNumber || '?'} was placed but no positive total was confirmed or reserved — verify the charge with the vendor and record it.${counted}`, amountCents, evidence: placed.evidence || null, placed });
    }
    const overCap = await parkIfOverCapAfterPlacement(conn, { ctx, vendor, ledger, placed, finalCents, quoteCents, env });
    if (overCap) return overCap;
    return await recordPlaced(conn, { ctx, placed, finalCents, quoteCents });
  } catch (err) {
    // Run-level failures are scoped to THIS adapter for the batch loop: the
    // other vendors' requests still dispatch (Codex r8 P1).
    if (err.runLevel) { err.adapterKey = adapterKey; throw err; }
    return withAdapterDown(await settleAfterError(conn, err, { ctx, vendor, submitted, placed, quoteCents, env }), err);
  }
}
// The per-request result carries the adapter-down marker (the adapter key)
// when the error that settled it did — the batch loop reads it once.
const withAdapterDown = (result, err) => (err.adapterDown ? { ...result, adapterDown: err.adapterDown } : result);

// A request the sweep left to the dispatcher (its vendor auto-ordered at
// sweep time) that the claim now finds undispatchable — vendor deactivated
// or its gate flipped in between — would otherwise have neither bell: hand
// it to the office with the sweep's own request-id-deduped bell (Codex r12
// P2). Idempotent: a bell the sweep already rang is a no-op. Returns the
// run's bell state: { belled } (delivered), { bellLost } (not persisted —
// the run goes red, re-rung next run), or { requestClosed } — the request
// was received or cancelled since it was scanned / claimed, so no bell:
// staff must never be told to buy a closed need (Codex r26 P2).
const HANDOFF_SKIPS = new Set(['no_adapter', 'vendor_gated', 'adapter_unconfigured']);
async function bellUndispatchable(conn, requestId, notify) {
  const request = await conn('product_restock_requests').where({ id: requestId }).first();
  if (!request || request.status !== 'open' || request.source !== 'auto_reorder') return { requestClosed: true };
  // An automatic order already out for the product (this request's own
  // ambiguous / stale park, or a late order on a received sibling): the
  // ledger bell says do-not-reorder; a gate closed since must not hand the
  // office an "order manually" bell beside it (hook r27 P0/P1).
  if (await findLiveAutoOrder(conn, request.product_id)) return { autoOrderLive: true };
  const product = await conn('products_catalog').where({ id: request.product_id }).first('id', 'name', 'inventory_unit', 'inventory_on_hand');
  if (!product) return { bellLost: true };
  // notifyAdmin resolves null when it could not persist the row: a null
  // hand-off is NOT a delivered bell (Codex r17 P2).
  const rung = await require('./auto-reorder').ringRestockBell({ notify, product, request });
  if (!rung) return { bellLost: true };
  // The request-id dedupe returns the EXISTING row unchanged when the text
  // is the same — and the dispatcher's claim marked that row read on the
  // hand-off. A handback must be visible again: reopen it (Codex r20 P2).
  await conn('notifications').whereRaw("metadata->>'dedupeKey' = ?", [`auto-reorder:${requestId}`]).whereNotNull('read_at').update({ read_at: null }); // notifications has no updated_at (hook r27 P1)
  // Closed while the bell was being written (received / cancelled): retire
  // what was just rung — staff must not be told to buy it (Codex r27 P2).
  const after = await conn('product_restock_requests').where({ id: requestId }).first('status', 'source');
  if (!after || after.status !== 'open' || after.source !== 'auto_reorder') {
    await retireRequestBell(conn, requestId);
    return { requestClosed: true };
  }
  // Another pod claimed it meanwhile (rolling gate change): its claim
  // retired a bell that did not exist yet — retire this one (Codex r29 P1).
  if (await findLiveAutoOrder(conn, request.product_id)) {
    await retireRequestBell(conn, requestId);
    return { autoOrderLive: true };
  }
  return { belled: true };
}

async function dispatchRestockOrder(requestId, { conn = db, notify = null, adapters = null, now = new Date(), env = process.env, deadAdapters = null } = {}) {
  // The master gate closing between the 6:10 sweep (which stood down its own
  // bell because this lane would order) and the dispatch is the same
  // hand-off as a vendor gate: the request gets the sweep's deduped bell
  // now, not after another silent day (Codex r18 P2).
  if (!gateEnvValue(GATE)) return { requestId, skipped: 'gated', ...(await bellUndispatchable(conn, requestId, notify)) };
  const registry = adapters || loadAdapters();
  const login = await prefetchVendorLogin(conn, requestId, registry, deadAdapters);
  const claim = await conn.transaction((trx) => claimRequest(trx, { requestId, registry, deadAdapters, login }));
  if (claim.skipped) {
    // A lost hand-off bell is reported, not swallowed: the request stays open
    // and unclaimed, so the next run re-rings it — and this run goes red.
    const bellState = HANDOFF_SKIPS.has(claim.skipped) ? await bellUndispatchable(conn, requestId, notify) : {};
    return { requestId, skipped: claim.skipped, ...(claim.cancelled ? { cancelled: true } : {}), ...bellState };
  }
  return dispatchClaimed(conn, claim, { registry, notify, now, env });
}

// Ownership lease (pre-push P0): while the vendor call is out, the owning
// dispatcher touches the claim's updated_at every HEARTBEAT_MS. Stale
// recovery parks a `placing` row only when its LAST heartbeat is older than
// STALE_PLACING_MS — a slow but live SiteOne run (still able to click) is
// never parked out from under itself, so the prior-order exclusion its claim
// row provides cannot be released (revoked, cancelled) while it can still
// submit. A dead process stops heartbeating and is parked after 30 minutes
// of silence, post-submit wording (never re-order), never retried.
const STALE_PLACING_MS = 30 * 60 * 1000;
const HEARTBEAT_MS = 60 * 1000;

function startClaimHeartbeat(conn, ledgerId) {
  const beat = () => conn('vendor_orders').where({ id: ledgerId, status: 'placing' }).update({ updated_at: new Date() }).catch((err) => logger.warn(`[order-dispatch] heartbeat for ledger ${ledgerId} failed: ${err.message}`));
  const timer = setInterval(beat, HEARTBEAT_MS);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}

async function recoverStalePlacing({ conn = db, notify = null, now = new Date() } = {}) {
  const cutoff = new Date(now.getTime() - STALE_PLACING_MS);
  const stale = await conn('vendor_orders as vo')
    .join('product_restock_requests as prr', 'prr.id', 'vo.restock_request_id')
    .leftJoin('products_catalog as pc', 'pc.id', 'prr.product_id')
    .leftJoin('vendors as v', 'v.id', 'vo.vendor_id')
    .where('vo.status', 'placing')
    .where('vo.updated_at', '<', cutoff) // last heartbeat, not creation time
    .select('vo.id', 'vo.adapter', 'vo.amount_cents', 'vo.created_at', 'vo.updated_at', 'prr.id as request_id', 'pc.name as product_name', 'v.id as vendor_id', 'v.name as vendor_name');
  const recovered = [];
  const bellPending = [];
  const unrecovered = [];
  for (const row of stale) {
    try {
      const parked = await park(conn, {
        ledger: { id: row.id }, request: { id: row.request_id }, product: { name: row.product_name || '?' }, vendor: { id: row.vendor_id, name: row.vendor_name || '?' }, adapterKey: row.adapter, notify,
        staleBefore: cutoff,
        reason: 'stale_placing', message: `the dispatcher died mid-order (claimed ${new Date(row.created_at).toISOString()}, last heartbeat ${new Date(row.updated_at || row.created_at).toISOString()}); the ${row.vendor_name || 'vendor'} call may or may not have gone out.`, amountCents: row.amount_cents,
      });
      if (parked.skipped) continue; // settled by its own dispatcher between the scan and the park
      recovered.push(row.id);
      if (parked.bellPending) bellPending.push(row.id);
    } catch (err) {
      // A possibly-submitted order still sitting 'placing' with no bell: the
      // run must go red on it, not report success (Codex r2 P1).
      logger.error(`[order-dispatch] stale placing ${row.id} not recovered: ${err.message}`);
      unrecovered.push(row.id);
    }
  }
  return { recovered, bellPending, unrecovered };
}

// The bounded dispatch passes (Codex r3 P2): a request another replica's
// sweep raised while a slow vendor order was in flight is picked up now, not
// tomorrow; a pass that finds nothing new ends. A run-level error (the
// environment is broken for every remaining request) stops the batch with
// its claims released — job_health records it, tomorrow retries.
async function dispatchPasses({ conn, notify, adapters, now, env }) {
  const seen = new Set();
  const results = [];
  let runLevelError = null;
  // A run-level failure is scoped to the adapter that raised it (err.adapterKey
  // — SiteOne's DNS / Chromium / credential store): that adapter gets no more
  // claims this run, the OTHER vendors' requests still dispatch, and the run
  // still goes red at the end (Codex #3853 r8 P1). A run-level error with no
  // adapter (the registry itself) aborts the batch as before.
  const deadAdapters = new Set();
  // Rescan before releasing the lease (Codex r3 P2): a request another
  // replica's sweep raised while a slow vendor order was in flight is
  // picked up now, not tomorrow. Bounded; a pass that finds nothing new ends.
  for (let pass = 0; pass < 3 && !(runLevelError && !runLevelError.adapterKey); pass += 1) {
    const rows = (await findDispatchable(conn)).filter((r) => !seen.has(r.id));
    if (!rows.length) break;
    for (const row of rows) {
      seen.add(row.id);
      try {
        const result = await dispatchRestockOrder(row.id, { conn, notify, adapters, now, env, deadAdapters });
        results.push(result);
        // Not a run-level error — the request parked with its bell — but the
        // adapter is done for this run (a rejected login: Codex #3853 r21 P1).
        if (result && result.adapterDown) { deadAdapters.add(result.adapterDown); logger.warn(`[order-dispatch] ${result.adapterDown} is down for this run after request ${row.id} (${result.reason}); its remaining requests wait for the next run`); }
      } catch (err) {
        // An unscoped error (the registry, a transaction) is batch-wide and must
        // not be masked by an earlier adapter-scoped one still held in
        // runLevelError — the outer loop would see an adapterKey and keep
        // dispatching (Codex #3853 r11 P2).
        if (!err.adapterKey) { runLevelError = err; logger.error(`[order-dispatch] run-level failure, batch aborted: ${err.message}`); break; }
        runLevelError = runLevelError || err;
        deadAdapters.add(err.adapterKey);
        logger.error(`[order-dispatch] run-level failure for ${err.adapterKey}, its remaining requests wait for the next run: ${err.message}`);
      }
    }
    if (runLevelError && !runLevelError.adapterKey) break;
  }
  return { results, seen, runLevelError };
}

// What turns the run red after every request settled: failures, outcomes a
// vendor call left unrecorded (Codex r2 P1), stale rows that could not be
// parked, and bells — a parked order or a hand-off nobody was told about.
function runProblems({ results, recovered, bellsPending }) {
  const problems = [];
  const failed = results.filter((r) => r.status === 'failed');
  if (failed.length) problems.push(`${failed.length} order(s) failed (${failed.map((f) => f.reason).join(', ')})`);
  const unrecorded = results.filter((r) => r.status === 'unrecorded');
  if (unrecorded.length) problems.push(`${unrecorded.length} outcome(s) UNRECORDED — reconcile by hand (ledger ${unrecorded.map((r) => r.ledgerId).join(', ')})`);
  if (recovered.unrecovered.length) problems.push(`${recovered.unrecovered.length} stale placing row(s) could not be parked (ledger ${recovered.unrecovered.join(', ')})`);
  if (bellsPending.length) problems.push(`${bellsPending.length} bell(s) not delivered, re-rung next run (ledger ${bellsPending.join(', ')})`);
  const bellLost = results.filter((r) => r.bellLost);
  if (bellLost.length) problems.push(`${bellLost.length} hand-off bell(s) not persisted, re-rung next run (request ${bellLost.map((r) => r.requestId).join(', ')})`);
  return problems;
}

async function runVendorOrderDispatch({ conn = db, notify = null, adapters = null, now = new Date(), env = process.env } = {}) {
  // Reconciliation runs BEFORE and REGARDLESS of the gate: a 'placing' claim
  // the dispatcher died on, or a park whose bell never sent, is an order that
  // may already exist at the vendor — killing the lane must surface it, not
  // bury it (pre-push P0). Bells first: the one outcome that must not wait
  // another day. A gated run still walks the dispatchable requests: each is
  // handed off with its bell instead of ordered (Codex r18 P2).
  const bells = await reringPendingBells({ conn, notify });
  const recovered = await recoverStalePlacing({ conn, notify, now });
  const gated = !gateEnvValue(GATE);
  const { results, seen, runLevelError } = await dispatchPasses({ conn, notify, adapters, now, env });
  const bellsPending = [...bells.pending, ...recovered.bellPending, ...results.filter((r) => r.bellPending).map((r) => r.ledgerId)];
  logger.info(`[order-dispatch] ${results.filter((r) => r.status === 'placed').length} placed, ${results.filter((r) => r.status === 'needs_review').length} parked, ${results.filter((r) => r.status === 'failed').length} failed, ${results.filter((r) => r.skipped).length} skipped of ${seen.size}; ${bells.rung.length} bells re-rung, ${bellsPending.length} pending`);
  if (runLevelError) throw runLevelError;
  const problems = runProblems({ results, recovered, bellsPending });
  if (problems.length) throw new Error(`vendor order dispatch: ${problems.join('; ')}`);
  return { ...(gated ? { skipped: 'gated' } : {}), results, recovered: recovered.recovered, bells };
}

module.exports = {
  RECEIVED_SETTLES_SQL,
  settleRequestLedgerBells,
  findLiveAutoOrder,
  landedAfterReceiveFor,
  settleLandedAfterReceive,
  runVendorOrderDispatch,
  recoverStalePlacing,
  reringPendingBells,
  dispatchRestockOrder,
  canAutoOrder,
  reserveUnderCaps,
  monthlySpentCents,
  findDispatchable,
  vendorOrderQuantity,
  assertNoLiveAutoOrder,
  assertManualActionAllowed,
  orderedQuantityFor,
  AUTO_ORDER_GATE: GATE,
  _internals: { adapterKeyFor, caps, parseCents, VENDOR_GATE, ADAPTER_BY_CODE, CAPS_LOCK_KEY, POST_SUBMIT_REASONS, STALE_PLACING_MS, HEARTBEAT_MS, startClaimHeartbeat },
};
