/**
 * procurement/adapters/stickermule.js — Sticker Mule REORDER adapter.
 *
 * The Sticker Mule API (stickermule.com/api, read 2026-09-03) is reorder-only:
 * every order is a re-run of an item the account already bought by hand
 * (GET /api/items lists them by id). Bearer key = STICKERMULE_API_KEY.
 * Endpoints used: GET /api/items, GET /api/addresses, GET /api/payments,
 * POST /api/orders {items:[{id,quantity}], addressId, paymentId} →
 * {order:{number}}, GET /api/orders (list, carries the priced total).
 *
 * Contract with order-dispatch.js:
 *   bindingQuote({ vendorSku, quantity }) → { cents, source } | null
 *     The account's most recent order containing exactly this item at
 *     exactly this quantity — the vendor's own charged total (tax + shipping
 *     included), the only binding pre-POST number the reorder API offers.
 *     null = no identical prior order → the dispatcher refuses.
 *   place({ vendorSku, quantity, quoteCents }) →
 *       { externalOrderNumber, amountCents, response, evidence }
 *     Throws RefusedError (err.refuse = reason) BEFORE anything is sent when
 *     the item / address / payment cannot be resolved unambiguously — the
 *     dispatcher parks the request as needs_review, no order exists.
 *     Throws with err.ambiguous = true for ANY failure after the POST was
 *     dispatched (timeout, 5xx, bad body): the order may exist, so the
 *     dispatcher parks needs_review and never re-POSTs.
 *
 * Money moves through the account's saved payment method — the adapter never
 * sees card data. Timeout 30 s per call, no retry.
 */
// The production origin is FIXED: the bearer key is only ever sent here. No
// env override — a typo'd or compromised value would exfiltrate the vendor
// credential (Codex r4 P1); tests inject fetchImpl instead.
const BASE_URL = 'https://api.stickermule.com';
const TIMEOUT_MS = 30000;

class RefusedError extends Error {
  constructor(reason, message) { super(message || reason); this.refuse = reason; }
}

function apiKey() { return String(process.env.STICKERMULE_API_KEY || '').trim(); }
function configured() { return !!apiKey(); }

async function call(method, path, body, { fetchImpl = fetch } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${BASE_URL}${path}`, {
      method,
      headers: { Authorization: `Bearer ${apiKey()}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (!res.ok) {
      const err = new Error(`Sticker Mule ${method} ${path} → HTTP ${res.status}${json?.message ? `: ${json.message}` : ''}`);
      err.status = res.status;
      err.body = json;
      throw err;
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

function orderItems(order) {
  const items = Array.isArray(order?.items) ? order.items : Array.isArray(order?.lineItems) ? order.lineItems : [];
  return items.map((i) => ({ id: i?.id ?? i?.itemId ?? i?.item?.id ?? null, quantity: Number(i?.quantity) }));
}

// The only binding pre-POST total the API offers: what the account was
// charged the last time it ordered exactly this item at exactly this count
// (single-item orders only — a bundle total would over-state this line).
// Fail-closed: no match, a shape we cannot read, or no positive total → null.
async function bindingQuote({ vendorSku, quantity }, { fetchImpl = fetch } = {}) {
  if (!configured()) return null;
  const qty = Math.round(Number(quantity));
  if (!Number.isFinite(qty) || qty <= 0) return null;
  const orders = listOf(await call('GET', '/api/orders', null, { fetchImpl }), 'orders');
  const matches = orders.filter((o) => {
    const items = orderItems(o);
    return items.length === 1 && String(items[0].id) === String(vendorSku) && items[0].quantity === qty && orderTotalCents(o) != null;
  });
  if (!matches.length) return null;
  const ts = (o) => Date.parse(o?.createdAt || o?.created_at || o?.date || '') || 0;
  matches.sort((a, b) => ts(b) - ts(a));
  const last = matches[0];
  return { cents: orderTotalCents(last), source: `order ${last.number ?? '?'}` };
}

function listOf(payload, key) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload[key])) return payload[key];
  if (payload && Array.isArray(payload.data)) return payload.data;
  return [];
}

function orderTotalCents(order) {
  const candidates = [order?.total, order?.amount, order?.totals?.total, order?.price?.total];
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n) && n > 0) return Math.round(n * 100);
  }
  return null;
}

// Account prerequisites, all read-only: the saved item that IS this SKU, and
// exactly one address + one payment method. A refusal here leaves no order.
async function resolveAccountPrerequisites({ vendorSku, fetchImpl }) {
  const items = listOf(await call('GET', '/api/items', null, { fetchImpl }), 'items');
  const item = items.find((i) => String(i?.id) === String(vendorSku));
  if (!item) throw new RefusedError('item_not_found', `Sticker Mule item ${vendorSku} is not on the account (reorder-only API: place the first order by hand)`);
  const addresses = listOf(await call('GET', '/api/addresses', null, { fetchImpl }), 'addresses');
  if (addresses.length !== 1) throw new RefusedError(addresses.length ? 'multiple_addresses' : 'no_address', `account has ${addresses.length} shipping addresses; exactly one is required`);
  const payments = listOf(await call('GET', '/api/payments', null, { fetchImpl }), 'payments');
  if (payments.length !== 1) throw new RefusedError(payments.length ? 'multiple_payments' : 'no_payment', `account has ${payments.length} payment methods; exactly one is required`);
  return { item, address: addresses[0], payment: payments[0] };
}

// The POST and its order number. The POST left the process: a timeout, a 5xx,
// or a missing number may still mean an order exists — `ambiguous`, never
// re-POSTed; the dispatcher parks it for a human.
async function submitOrder(request, { fetchImpl }) {
  let response;
  try {
    response = await call('POST', '/api/orders', request, { fetchImpl });
  } catch (err) {
    err.ambiguous = true;
    throw err;
  }
  const number = response?.order?.number ?? response?.number ?? null;
  if (!number) {
    const err = new Error('Sticker Mule accepted the order but returned no order number');
    err.ambiguous = true;
    err.body = response;
    throw err;
  }
  return { response, number: String(number) };
}

// What the vendor actually charged, from the order list. A failed read-back
// is not an order failure — { amountCents: null } and the caller falls back
// to the quote, flagged in evidence.
async function readBackTotal(number, { fetchImpl }) {
  try {
    const orders = listOf(await call('GET', '/api/orders', null, { fetchImpl }), 'orders');
    const readBack = orders.find((o) => String(o?.number) === String(number)) || null;
    return { readBack, amountCents: orderTotalCents(readBack) };
  } catch { return { readBack: null, amountCents: null }; }
}

async function place({ vendorSku, quantity, quoteCents = null }, { fetchImpl = fetch } = {}) {
  if (!configured()) throw new RefusedError('no_api_key', 'STICKERMULE_API_KEY is not set');
  const qty = Math.round(Number(quantity));
  if (!Number.isFinite(qty) || qty <= 0) throw new RefusedError('bad_quantity', `quantity ${quantity} is not a positive count`);
  const { item, address, payment } = await resolveAccountPrerequisites({ vendorSku, fetchImpl });
  const { response, number } = await submitOrder({ items: [{ id: item.id, quantity: qty }], addressId: address.id, paymentId: payment.id }, { fetchImpl });
  const { readBack, amountCents } = await readBackTotal(number, { fetchImpl });
  return {
    externalOrderNumber: number,
    amountCents: amountCents ?? quoteCents ?? null,
    response,
    evidence: { itemId: item.id, addressId: address.id, paymentId: payment.id, totalSource: amountCents != null ? 'vendor' : 'quote', readBack },
  };
}

// preSubmitTotal 'history': the API confirms no current total before the
// POST — bindingQuote is the last identical charge, not a live quote. The
// dispatcher does not auto-place for this class (parks with the figure) unless
// the owner accepts that residual risk — see order-dispatch.js.
// packagedQuantity false: `quantity` is the sticker COUNT (the request must be
// stocked in each) — never a package count.
module.exports = { key: 'stickermule', configured, preSubmitTotal: 'history', packagedQuantity: false, bindingQuote, place, RefusedError, _internals: { call, orderTotalCents, orderItems, listOf, BASE_URL } };
