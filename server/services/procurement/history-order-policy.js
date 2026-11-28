/**
 * procurement/history-order-policy.js — DB-backed policy (on/off switch,
 * approved item list, per-order and monthly spend caps) for history-total
 * auto-order adapters whose API confirms no live price before submission
 * (Sticker Mule).
 *
 * Owner ruling 2026-11-28 ("move the switch"):
 *   - Replaces Railway env vars (GATE_AUTO_ORDER_HISTORY_TOTAL,
 *     AUTO_ORDER_HISTORY_TOTAL_ITEMS) and per-deployment heartbeat rows with
 *     one authoritative DB row in `system_settings`.
 *   - Every server reads this single row inside the CAPS_LOCK_KEY transaction
 *     right before placing a Sticker Mule order, so turning the switch OFF or
 *     lowering a cap takes effect immediately with zero deploy overlap.
 *   - Ships dark: missing or invalid row always fails closed (`enabled: false`).
 *   - Turning the switch OFF is never blocked by stale catalog/pricing rows.
 *   - Owner sole-buyer rule 2026-11-27 ("i dont think anybody would be ordering
 *     these stickers other than the bit"): while enabled for an approved item,
 *     the robot is the sole buyer; staff never order approved items by hand
 *     unless an alert says the request parked or auto-reorder is turned off.
 */
const db = require('../../models/db');
const { vendorPricingFor } = require('./auto-reorder');
const { auditHistoryOrderPolicyChange } = require('../audit-log');

const POLICY_KEY = 'procurement.history_total_auto_order';
// Shared advisory lock key with procurement/order-dispatch.js reserveUnderCaps:
// serializes policy updates against in-flight cap reservations & submissions.
const CAPS_LOCK_KEY = 'vendor-order-caps';
const MIN_CAP_CENTS = 100; // $1.00
const MAX_CAP_CENTS = 10000000; // $100,000.00
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ITEM_SKU_RE = /^[^\s,]+$/;

// Only history-total adapters are allowed in this policy.
const ALLOWED_ADAPTERS = Object.freeze({
  stickermule: Object.freeze({ vendorCode: 25, label: 'Sticker Mule' }),
});

const DEFAULT_POLICY = Object.freeze({
  enabled: false,
  approvedItems: Object.freeze([]),
  maxPerOrderCents: null,
  maxMonthlyCents: null,
  revision: 0,
  updatedAt: null,
  updatedBy: null,
  invalid: false,
});

function policyError(message, statusCode = 400, code = 'invalid_policy', extra = null) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  if (extra) Object.assign(err, extra);
  return err;
}

const validUuid = (v) => (typeof v === 'string' && UUID_RE.test(v.trim()) ? v.trim() : null);
const validCap = (v) => Number.isSafeInteger(v) && v >= MIN_CAP_CENTS && v <= MAX_CAP_CENTS;
const validRevision = (v) => Number.isSafeInteger(v) && v >= 0;

function parseItemKey(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  const idx = trimmed.indexOf(':');
  if (idx <= 0) return null;
  const adapterKey = trimmed.slice(0, idx).trim().toLowerCase();
  const sku = trimmed.slice(idx + 1).trim();
  if (!Object.prototype.hasOwnProperty.call(ALLOWED_ADAPTERS, adapterKey)) return null;
  if (!sku || !ITEM_SKU_RE.test(sku)) return null;
  return `${adapterKey}:${sku}`;
}

function normalizeApprovedItems(items) {
  if (!Array.isArray(items)) return null;
  const out = new Set();
  for (const raw of items) {
    const key = parseItemKey(raw);
    if (!key) return null;
    out.add(key);
  }
  return [...out].sort();
}

function capsConsistent(perOrder, monthly, enabled) {
  if (perOrder == null && monthly == null) return !enabled;
  if (!validCap(perOrder) || !validCap(monthly)) return false;
  return perOrder <= monthly;
}

function invalidPolicy() {
  return { ...DEFAULT_POLICY, approvedItems: [], invalid: true };
}

/**
 * Strict, fail-closed parser for the stored `system_settings.value` JSON.
 * Missing row = clean disabled default (invalid: false).
 * Corrupted or inconsistent JSON = disabled (invalid: true).
 */
function parsePolicy(raw) {
  if (raw == null || raw === '') return { ...DEFAULT_POLICY, approvedItems: [] };
  let obj;
  try {
    obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return invalidPolicy();
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return invalidPolicy();
  if (typeof obj.enabled !== 'boolean') return invalidPolicy();
  if (!validRevision(obj.revision)) return invalidPolicy();
  const approvedItems = normalizeApprovedItems(obj.approvedItems);
  if (!approvedItems) return invalidPolicy();
  const maxPerOrderCents = obj.maxPerOrderCents ?? null;
  const maxMonthlyCents = obj.maxMonthlyCents ?? null;
  if (!capsConsistent(maxPerOrderCents, maxMonthlyCents, obj.enabled)) return invalidPolicy();
  if (obj.enabled && approvedItems.length === 0) return invalidPolicy();
  return {
    enabled: obj.enabled,
    approvedItems,
    maxPerOrderCents,
    maxMonthlyCents,
    revision: obj.revision,
    updatedAt: typeof obj.updatedAt === 'string' && obj.updatedAt ? obj.updatedAt : null,
    updatedBy: validUuid(obj.updatedBy),
    invalid: false,
  };
}

/**
 * Pure check: is (adapterKey, vendorSku) currently approved to auto-order
 * under this DB policy?
 */
function isItemApproved(policy, adapterKey, vendorSku) {
  if (!policy || policy.invalid === true || policy.enabled !== true) return false;
  if (!capsConsistent(policy.maxPerOrderCents, policy.maxMonthlyCents, true)) return false;
  const key = parseItemKey(`${adapterKey || ''}:${vendorSku ?? ''}`);
  return !!key && Array.isArray(policy.approvedItems) && policy.approvedItems.includes(key);
}

async function readHistoryOrderPolicy(conn = db, { forShare = false, forUpdate = false, key = POLICY_KEY } = {}) {
  const q = conn('system_settings').where({ key });
  if (forUpdate) q.forUpdate();
  else if (forShare) q.forShare();
  const row = await q.first('value');
  return parsePolicy(row?.value ?? null);
}

function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Lists active catalog products wired to an active history-total vendor
 * (Sticker Mule, vendor code 25), together with each product's winning
 * eligible vendor_pricing row (same predicate as auto-reorder.js).
 * Admin-only read (carries unit prices).
 */
async function listEligibleHistoryItems(conn = db, { now = new Date() } = {}) {
  const codes = Object.values(ALLOWED_ADAPTERS).map((a) => a.vendorCode);
  const adapterByCode = Object.fromEntries(
    Object.entries(ALLOWED_ADAPTERS).map(([k, v]) => [v.vendorCode, k])
  );
  const rows = await conn('products_catalog as pc')
    .join('vendors as v', 'v.id', 'pc.auto_reorder_vendor_id')
    .where('pc.active', true)
    .where('v.active', true)
    .whereIn('v.code', codes)
    .select(
      'pc.id', 'pc.name', 'pc.auto_reorder_enabled', 'pc.inventory_on_hand',
      'pc.inventory_unit', 'pc.low_stock_threshold', 'pc.reorder_quantity',
      'v.id as vendor_id', 'v.name as vendor_name', 'v.code as vendor_code'
    )
    .orderBy('pc.name', 'asc');

  const items = [];
  for (const r of rows) {
    const adapterKey = adapterByCode[Number(r.vendor_code)];
    const pricing = await vendorPricingFor(conn, r.id, r.vendor_id, now);
    const vendorSku = pricing?.vendor_sku ? String(pricing.vendor_sku).trim() : null;
    const itemKey = vendorSku ? parseItemKey(`${adapterKey}:${vendorSku}`) : null;
    const unitPrice = numOrNull(pricing?.price_amount ?? pricing?.price);
    const eligible = r.auto_reorder_enabled === true && !!itemKey && unitPrice != null && unitPrice > 0;
    items.push({
      productId: r.id,
      name: r.name,
      autoReorderEnabled: r.auto_reorder_enabled === true,
      inventoryOnHand: numOrNull(r.inventory_on_hand),
      inventoryUnit: r.inventory_unit || null,
      lowStockThreshold: numOrNull(r.low_stock_threshold),
      reorderQuantity: numOrNull(r.reorder_quantity),
      vendorId: r.vendor_id,
      vendorName: r.vendor_name,
      adapterKey,
      vendorSku,
      itemKey,
      unitPrice,
      packSize: pricing?.quantity || null,
      packUnit: pricing?.unit || null,
      eligible,
    });
  }
  return items;
}

function validateSaveInput(input, expectedRevision) {
  if (!validRevision(expectedRevision)) {
    throw policyError('expectedRevision must be a non-negative whole number', 400, 'invalid_revision');
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw policyError('Policy payload must be an object', 400, 'invalid_policy');
  }
  if (typeof input.enabled !== 'boolean') {
    throw policyError('enabled must be true or false', 400, 'invalid_policy');
  }
  const enabled = input.enabled;
  const maxPerOrderCents = input.maxPerOrderCents ?? null;
  const maxMonthlyCents = input.maxMonthlyCents ?? null;
  if (!capsConsistent(maxPerOrderCents, maxMonthlyCents, enabled)) {
    const code = enabled && (maxPerOrderCents == null || maxMonthlyCents == null) ? 'caps_required' : 'invalid_caps';
    throw policyError(
      'Per-order and monthly limits must both be whole cents between $1.00 and $100,000.00, with per-order <= monthly',
      400,
      code
    );
  }
  const rawItems = input.approvedItems === undefined && !enabled ? [] : input.approvedItems;
  const approvedItems = normalizeApprovedItems(rawItems);
  if (!approvedItems) {
    throw policyError('approvedItems must be an array of valid adapter:sku entries (for example stickermule:71046032)', 400, 'invalid_items');
  }
  if (enabled && approvedItems.length === 0) {
    throw policyError('Select at least one eligible Sticker Mule item before turning auto-reorder on', 400, 'items_required');
  }
  return { enabled, approvedItems, maxPerOrderCents, maxMonthlyCents };
}

function parseJsonObj(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw) || {}; } catch { return {}; }
}

/**
 * Lists history-total auto-orders that have ALREADY passed their final pre-POST
 * authorization inside CAPS_LOCK_KEY (`evidence.postAuthorizedAt` set) and are
 * still `status = 'placing'`. Called inside saveHistoryOrderPolicy's lock so
 * turning the switch off immediately reports any already-authorized submission
 * that staff must wait for on the Restock tab before ordering by hand.
 */
async function listInFlightHistoryOrders(conn = db) {
  const adapters = Object.keys(ALLOWED_ADAPTERS);
  const rows = await conn('vendor_orders as vo')
    .leftJoin('product_restock_requests as prr', 'prr.id', 'vo.restock_request_id')
    .leftJoin('products_catalog as pc', 'pc.id', 'prr.product_id')
    .where('vo.status', 'placing')
    .whereIn('vo.adapter', adapters)
    .whereRaw("NULLIF(vo.evidence->>'postAuthorizedAt', '') IS NOT NULL")
    .select('vo.id', 'vo.restock_request_id', 'vo.adapter', 'vo.amount_cents', 'vo.request_payload', 'vo.created_at', 'vo.evidence', 'pc.name as product_name');
  return (rows || []).map((r) => {
    const payload = parseJsonObj(r.request_payload);
    const ev = parseJsonObj(r.evidence);
    return {
      ledgerId: r.id,
      requestId: r.restock_request_id || null,
      adapter: r.adapter,
      productName: r.product_name || null,
      vendorSku: payload.vendorSku || null,
      amountCents: r.amount_cents == null ? null : Number(r.amount_cents),
      postAuthorizedAt: ev.postAuthorizedAt || null,
      createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
    };
  });
}

/**
 * Finds any OTHER active auto-reorder product assigned to the same vendor whose
 * winning eligible vendor_pricing row maps to the exact same vendorSku.
 * Used inside CAPS_LOCK_KEY by authorizeHistoryOrder so a second product mapped
 * to an already-approved Sticker Mule SKU can never spend against it.
 */
async function findDuplicateSkuProducts(conn = db, { vendorId, vendorSku, excludeProductId, now = new Date() }) {
  const sku = String(vendorSku || '').trim();
  if (!vendorId || !sku) return [];
  const others = await conn('products_catalog')
    .where({ active: true, auto_reorder_enabled: true, auto_reorder_vendor_id: vendorId })
    .whereNot('id', excludeProductId)
    .select('id', 'name')
    .orderBy('name', 'asc');
  const conflicts = [];
  for (const other of others || []) {
    const pricing = await vendorPricingFor(conn, other.id, vendorId, now);
    const otherSku = pricing?.vendor_sku ? String(pricing.vendor_sku).trim() : null;
    if (otherSku === sku) conflicts.push({ productId: other.id, name: other.name });
  }
  return conflicts;
}

async function assertApprovedItemsEligible(trx, approvedItems, now) {
  const eligible = await listEligibleHistoryItems(trx, { now });
  const eligibleKeys = new Set();
  const activeAutoCounts = new Map();
  for (const item of eligible) {
    if (!item.itemKey) continue;
    if (item.eligible) eligibleKeys.add(item.itemKey);
    if (item.autoReorderEnabled) activeAutoCounts.set(item.itemKey, (activeAutoCounts.get(item.itemKey) || 0) + 1);
  }
  const bad = approvedItems.filter((k) => !eligibleKeys.has(k));
  if (bad.length > 0) {
    throw policyError(
      `Cannot enable auto-reorder for ineligible item(s): ${bad.join(', ')} (each item must be active, have Reorder when low enabled, and have an active approved Sticker Mule price row)`,
      400,
      'ineligible_item',
      { ineligibleItems: bad }
    );
  }
  const dup = approvedItems.filter((k) => (activeAutoCounts.get(k) || 0) > 1);
  if (dup.length > 0) {
    throw policyError(
      `Cannot enable auto-reorder for SKU(s) mapped to multiple active auto-reorder products: ${dup.join(', ')} (each approved Sticker Mule SKU may belong to only one auto-reorder product)`,
      400,
      'duplicate_sku_mapping',
      { duplicateItems: dup }
    );
  }
}

/**
 * Atomically updates the DB-backed history-total auto-order policy.
 *
 * Lock order matches order-dispatch.js:
 *   1. pg_advisory_xact_lock(hashtext(CAPS_LOCK_KEY))
 *   2. system_settings row FOR UPDATE
 *   3. (when enabling) catalog/pricing eligibility & single-SKU checks
 *   4. upsert system_settings + critical audit_log insert + in-flight check
 */
async function saveHistoryOrderPolicy(
  conn = db,
  input,
  { actorId = null, expectedRevision, ipAddress = null, userAgent = null, now = new Date(), key = POLICY_KEY } = {}
) {
  const validated = validateSaveInput(input, expectedRevision);
  const actorUuid = validUuid(actorId);

  return conn.transaction(async (trx) => {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [CAPS_LOCK_KEY]);
    const current = await readHistoryOrderPolicy(trx, { forUpdate: true, key });
    if (current.revision !== expectedRevision) {
      throw policyError(
        `Auto-order settings changed in another session (expected revision ${expectedRevision}, current is ${current.revision}); reload and try again`,
        409,
        'policy_revision_conflict',
        { currentRevision: current.revision }
      );
    }

    // Turning OFF is an emergency kill switch: never blocked by stale/expired catalog items.
    if (validated.enabled) await assertApprovedItemsEligible(trx, validated.approvedItems, now);

    const next = {
      enabled: validated.enabled,
      approvedItems: validated.approvedItems,
      maxPerOrderCents: validated.maxPerOrderCents,
      maxMonthlyCents: validated.maxMonthlyCents,
      revision: current.revision + 1,
      updatedAt: now.toISOString(),
      updatedBy: actorUuid,
      invalid: false,
    };
    const stored = {
      enabled: next.enabled,
      approvedItems: next.approvedItems,
      maxPerOrderCents: next.maxPerOrderCents,
      maxMonthlyCents: next.maxMonthlyCents,
      revision: next.revision,
      updatedAt: next.updatedAt,
      updatedBy: next.updatedBy,
    };

    await trx.raw(
      `INSERT INTO system_settings (key, value, category, description, created_at, updated_at)
       VALUES (?, ?, 'procurement', 'DB-backed switch, approved items, and spend caps for history-total auto-reorder (Sticker Mule)', ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [key, JSON.stringify(stored), now, now]
    );

    const inFlightOrders = await listInFlightHistoryOrders(trx);

    await auditHistoryOrderPolicyChange({
      actor_id: actorUuid,
      key,
      before: current,
      after: stored,
      ip_address: ipAddress,
      user_agent: userAgent,
      trx,
    });

    return { policy: next, previous: current, inFlightOrders };
  });
}

module.exports = {
  POLICY_KEY,
  CAPS_LOCK_KEY,
  MIN_CAP_CENTS,
  MAX_CAP_CENTS,
  ALLOWED_ADAPTERS,
  DEFAULT_POLICY,
  parsePolicy,
  parseItemKey,
  isItemApproved,
  readHistoryOrderPolicy,
  listEligibleHistoryItems,
  listInFlightHistoryOrders,
  findDuplicateSkuProducts,
  saveHistoryOrderPolicy,
};
