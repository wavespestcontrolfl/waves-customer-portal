/**
 * procurement/adapters/stickermule.js — Sticker Mule REORDER adapter.
 *
 * The Sticker Mule API (https://www.stickermule.com/api — the documented and
 * only resolving host; `api.stickermule.com` is a dead CNAME, verified live
 * 2026-09-06) is reorder-only:
 * every order is a re-run of an item the account already bought by hand
 * (GET /api/items lists them by id). Bearer key = STICKERMULE_API_KEY.
 * Endpoints used: GET /api/items, GET /api/addresses, GET /api/payments,
 * POST /api/orders {items:[{id,quantity}], addressId, paymentId} →
 * {order:{number}}, GET /api/orders (list) and GET /api/orders/<number>.
 * Live shapes (read 2026-11-26, GET only):
 *   list  → { orders: [{ number, state, paymentState, shipmentState, placedAt,
 *             currency, itemTotal, total, … }], canLoadMore } — newest first,
 *             at most 50 a page, and NO item lines;
 *   order → the same fields plus items: [{ id (text), quantity (whole
 *             number), total, … }]. The single-order GET is not in the public
 *             reference; if it goes away bindingQuote throws and nothing is
 *             ordered.
 *   total is dollars as a number (318.4): the "grand total charged, including
 *   shipping and tax, less discounts". The reference lists the values of
 *   state (complete, canceled, gift_unclaimed, ready_for_production,
 *   in_production, ready_to_proof, awaiting_scheduled_date) and of
 *   paymentState (paid, credit_owed, balance_due, failed, checkout, completed,
 *   pending, processing, void, null) without defining them. Live, every charged
 *   order reads 'paid' and the one never paid reads 'balance_due' + 'canceled'.
 *
 * Contract with order-dispatch.js:
 *   bindingQuote({ vendorSku, quantity }) → { cents, source } | null
 *     The account's most recent order of exactly this item at exactly this
 *     quantity, and nothing else — the vendor's own charged total (tax +
 *     shipping included), the only binding pre-POST number the reorder API
 *     offers. That order must be paid, in a known placed state, in USD. null =
 *     no such order among the newest 50 → the dispatcher refuses.
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
const BASE_URL = 'https://www.stickermule.com';
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

// An order's item lines, read strictly: null unless it has at least one line and EVERY line names
// its item and a whole positive count. Nothing is coerced: a null count must never read as 0 and
// let the order pass for "some other item" (pre-push audit P0).
const isLine = (l) => ((typeof l?.id === 'string' && l.id.trim() !== '') || Number.isFinite(l?.id)) && Number.isInteger(l.quantity) && l.quantity > 0;
function orderLines(order) {
  const lines = Array.isArray(order?.items) ? order.items : null;
  return lines?.length && lines.every(isLine) ? lines.map((l) => ({ id: l.id, quantity: l.quantity })) : null;
}

// One order as the vendor has it now, by its number. null = the answer is not that order; a
// failed read throws.
async function readOrder(number, { fetchImpl }) {
  const order = await call('GET', `/api/orders/${encodeURIComponent(String(number))}`, null, { fetchImpl });
  return order && String(order.number) === String(number) ? order : null;
}

// The only binding pre-POST total the API offers: what the account was
// charged the last time it ordered exactly this item at exactly this count
// (single-item orders only — a bundle total would over-state this line).
// The list has no item lines, so the orders are read one by one, newest
// first, up to the latest identical order. Fail-closed: no match in the
// newest PAGE_MAX orders, a shape we cannot read, a latest identical order
// that was not charged, or a tie for latest that may go on past the page →
// null. A failed read throws: nothing is ordered.
const PAGE_MAX = 50; // the largest page the API serves
// The live list stamps `placedAt`; the other keys are kept for older shapes.
const placedMs = (o) => Date.parse(o?.placedAt || o?.createdAt || o?.created_at || o?.date || '') || 0;
// The documented states of an order that stands as placed. 'canceled' and 'gift_unclaimed' are
// left out, and so is any value the reference does not list (a missing state included).
const PLACED_STATES = new Set(['complete', 'ready_for_production', 'in_production', 'ready_to_proof', 'awaiting_scheduled_date']);
// What the account was really charged for an order: its USD total, only when the vendor shows the
// order paid ('paid', the one value seen live on a charged order) AND in a known placed state.
// Payment still pending, canceled, a state or payment value this does not know, another currency
// or no readable total is no charge: null.
const chargedCents = (order) => (order?.paymentState === 'paid' && PLACED_STATES.has(order?.state) && order?.currency === 'USD' ? orderTotalCents(order) : null);

// One order of the list, read in full: its item lines and what it was charged. null = not readable
// as THIS order with its item and count on every line.
async function readListedOrder(listed, { fetchImpl }) {
  if (!listed?.number) return null;
  const order = await readOrder(listed.number, { fetchImpl });
  const lines = orderLines(order);
  return lines ? { number: order.number, lines, cents: chargedCents(order) } : null;
}
const isOnlyLine = (lines, sku, qty) => lines.length === 1 && String(lines[0].id) === String(sku) && lines[0].quantity === qty;

// The latest order of exactly this item and count among the listed orders (newest first), each
// read in full: { number, cents, at }. null = there is none, or it cannot be told.
async function latestIdentical(orders, { vendorSku, qty, fetchImpl }) {
  let last = null;
  for (const listed of orders) {
    if (last && placedMs(listed) !== last.at) break; // older than the latest identical order
    const order = await readListedOrder(listed, { fetchImpl });
    // Every order up to the match must be readable: behind an unreadable one a newer identical
    // order could hide. Refuse.
    if (!order) return null;
    if (!isOnlyLine(order.lines, vendorSku, qty)) continue;
    // A tie for latest binds only when every tied order carries the same total.
    if (last && order.cents !== last.cents) return null;
    last = last || { number: order.number, cents: order.cents, at: placedMs(listed) };
  }
  return last;
}

async function bindingQuote({ vendorSku, quantity }, { fetchImpl = fetch } = {}) {
  if (!configured()) return null;
  const qty = Math.round(Number(quantity));
  if (!Number.isFinite(qty) || qty <= 0) return null;
  const page = await call('GET', `/api/orders?limit=${PAGE_MAX}`, null, { fetchImpl });
  const orders = listOf(page, 'orders');
  // Newest first is the documented order. It is verified, because the walk stops at the first
  // match: an undated order, or one out of order, means the latest cannot be told apart.
  const stamps = orders.map(placedMs);
  if (stamps.some((t, i) => !t || (i > 0 && t > stamps[i - 1]))) return null;
  const last = await latestIdentical(orders, { vendorSku, qty, fetchImpl });
  if (!last) return null;
  // The tie for latest ran to the end of a page that is not known to be the last one: an order of
  // the same moment with another total could sit on the next page. Refuse.
  if (page?.canLoadMore !== false && stamps[stamps.length - 1] === last.at) return null;
  // The LATEST identical order binds: canceled, unpaid or unreadable refuses (null), never an older one.
  return last.cents == null ? null : { cents: last.cents, source: `order ${last.number}` };
}

function listOf(payload, key) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload[key])) return payload[key];
  if (payload && Array.isArray(payload.data)) return payload.data;
  return [];
}

// The order's grand total in cents: the documented `total` field and nothing else ("grand total
// charged, including shipping and tax, less discounts"). No other field stands in for it: a
// subtotal or an `amount` beside a missing total is not what was charged.
// Only a real money value counts: a finite number, or a plain decimal string ("318.40"), in whole
// cents. true, [], '1e3', '', 318.405 and the like are unreadable, never a charge.
function orderTotalCents(order) {
  const c = order?.total;
  const ok = (typeof c === 'number' && Number.isFinite(c)) || (typeof c === 'string' && /^\d+(\.\d{1,2})?$/.test(c.trim()));
  if (!ok) return null;
  const cents = Math.round(Number(c) * 100);
  return cents > 0 && Number.isSafeInteger(cents) && Math.abs(Number(c) * 100 - cents) < 1e-6 ? cents : null;
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
module.exports = { key: 'stickermule', configured, preSubmitTotal: 'history', packagedQuantity: false, bindingQuote, place, RefusedError, _internals: { call, orderTotalCents, orderLines, listOf, BASE_URL } };
