/**
 * procurement/adapters/stickermule.js — Sticker Mule REORDER adapter.
 *
 * The Sticker Mule API (https://www.stickermule.com/api — the documented and
 * only resolving host; `api.stickermule.com` is a dead CNAME, verified live
 * 2026-09-06) is reorder-only:
 * every order is a re-run of an item the account already bought by hand
 * (GET /api/items lists them by id). Bearer key = STICKERMULE_API_KEY.
 * Endpoints used: GET /api/items?limit=50[&offset=n], GET /api/addresses, GET /api/payments,
 * POST /api/orders {items:[{id,quantity}], addressId, paymentId} →
 * {order:{number}} (the POST takes no price ceiling and no idempotency key),
 * GET /api/orders?limit=50 and GET /api/orders/<number>.
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
 *     outstanding ({ number, why }; cents may then be null) = a listed order
 *     holding this item (any count, any age on the page, every one read in
 *     full), not canceled or an unclaimed gift, that is not complete +
 *     delivered by the list or its detail ('coming'), or was placed since the
 *     request was raised (`since`, 'since'); one whose list entry and detail
 *     disagree on its state ('conflict'); one that cannot be read
 *     ('unreadable'); or a page with more orders to load ('unchecked') → the
 *     dispatcher parks, never buys.
 *   place({ vendorSku, quantity, beforeSubmit }) →  (beforeSubmit: the dispatcher's last claim check, run right before the POST)
 *       { externalOrderNumber, amountCents: null, response, evidence }
 *     The order exists and no charge is claimed for it (evidence.totalSource
 *     'none'), never the quote: the dispatcher saves the number, then asks
 *     readCharge.
 *     Throws RefusedError (err.refuse = reason) BEFORE anything is sent when
 *     the item / address / payment cannot be resolved unambiguously — the
 *     dispatcher parks the request as needs_review, no order exists.
 *     Throws with err.ambiguous = true for ANY failure after the POST was
 *     dispatched (timeout, 5xx, bad body): the order may exist, so the
 *     dispatcher parks needs_review and never re-POSTs.
 *   readCharge(number) → cents | null
 *     The vendor's own charge for that order, read by its number: the USD
 *     total of an order the vendor shows PAID in a known placed state; null
 *     until then. Asked once right after the number is saved, and on later
 *     runs while there is none. Throws when the read fails.
 *
 * Money moves through the account's saved payment method — the adapter never
 * sees card data. Timeout 30 s per call, no retry; one bindingQuote lookup
 * (the list + every order on it, up to 51 GETs) has 90 s in all.
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

async function call(method, path, body, { fetchImpl = fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
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

// One order as the vendor has it now, by its number, read with `get` (path → body). null = the
// answer is not that order; a failed read throws.
async function readOrder(number, get) {
  const order = await get(`/api/orders/${encodeURIComponent(String(number))}`);
  return order && String(order.number) === String(number) ? order : null;
}

// The GETs of one lookup share ONE deadline (the list and every order read, up to 51 calls). The
// dispatcher works one request at a time: without it a slow vendor could hold every other restock
// for 51 full timeouts. Past the deadline nothing more is read and the lookup throws — the
// dispatcher parks it as a failed lookup, nothing is ordered. A read still running then is cut off.
const LOOKUP_MS = 90000;
function lookupReader({ fetchImpl, now }) {
  const deadline = now() + LOOKUP_MS;
  const expired = () => new Error(`Sticker Mule order history lookup did not finish in ${LOOKUP_MS / 1000} s`);
  return async (path) => {
    const left = deadline - now();
    if (left <= 0) throw expired();
    try { return await call('GET', path, null, { fetchImpl, timeoutMs: Math.min(TIMEOUT_MS, left) }); }
    catch (err) { throw now() >= deadline ? expired() : err; }
  };
}

// The only binding pre-POST total the API offers: what the account was
// charged the last time it ordered exactly this item at exactly this count
// (single-item orders only — a bundle total would over-state this line).
// The list has no item lines, so the orders are read one by one, newest
// first, up to the latest identical order. Fail-closed: no match in the
// newest PAGE_MAX orders, a shape we cannot read, a latest identical order
// that was not charged, or a tie for latest that may go on past the page →
// null. A failed read, or the lookup deadline, throws: nothing is ordered.
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
async function readListedOrder(listed, get) {
  if (!listed?.number) return null;
  const order = await readOrder(listed.number, get);
  const lines = orderLines(order);
  return lines ? { number: order.number, lines, cents: chargedCents(order), state: order.state, shipmentState: order.shipmentState, paymentState: order.paymentState, deliveredAt: order.deliveredAt } : null;
}
// An order of this item that may still be on its way covers the need it was bought for: staff may
// have placed it on the vendor's site while the portal request stayed open. Only an order the vendor
// shows complete AND delivered has arrived, and only a canceled order or an unclaimed gift will
// never come. Every other answer (in production, shipped, a state or shipment value this does not
// know, none at all) may still be coming.
const CLOSED_STATES = new Set(['canceled', 'gift_unclaimed']);
const mayBeComing = (order) => !(order?.state === 'complete' && order?.shipmentState === 'delivered') && !CLOSED_STATES.has(order?.state);
const hasItem = (lines, sku) => lines.some((l) => String(l.id) === String(sku));
const isOnlyLine = (lines, sku, qty) => lines.length === 1 && String(lines[0].id) === String(sku) && lines[0].quantity === qty;

// The latest order of exactly this item and count among the listed orders (newest first), each
// read in full: { number, cents, at }. null = there is none, or it cannot be told.
async function latestIdentical(orders, { vendorSku, qty, read }) {
  let last = null;
  for (const listed of orders) {
    if (last && placedMs(listed) !== last.at) break; // older than the latest identical order
    const order = await read(listed);
    // Every order up to the match must be readable: behind an unreadable one a newer identical
    // order could hide. Refuse.
    if (!order) return null;
    if (!isOnlyLine(order.lines, vendorSku, qty)) continue;
    // The list and the detail of the binding order must name the same charge (USD, the same total
    // in cents): on any disagreement neither binds.
    if (chargedCents(listed) !== order.cents) return null;
    // A tie for latest binds only when every tied order carries the same total.
    if (last && order.cents !== last.cents) return null;
    last = last || { number: order.number, cents: order.cents, at: placedMs(listed) };
  }
  return last;
}

// The newest listed order, at any age on the page, that holds this item in any line and may already
// cover the request, else null: { number, why } for the alert. why 'coming' = it may still be on its
// way; 'arrived' = delivered and not shown in the stock count (countedDelivery); 'since' = it was placed since the request was raised (`since`) and shows delivered: staff may
// have bought it by hand and not yet received the request; 'unreadable' = an order that could not be
// read in full could be one of this item; 'unchecked' = more orders to load past this page. A canceled
// order or an unclaimed gift never covers it. EVERY listed order is read in full (once: `read` keeps
// what the price walk read) — the list's own fields are never trusted alone — and an order is still
// coming when its list entry OR its detail says so; it is closed only when both say so.
// A delivered order covers the request unless the stock count already holds it: the portal's own
// order whose request was received (`receivedOrders`, by number), or one that arrived before the
// product's last physical count (`countedAt`). The request's age proves nothing: the sweep can raise
// a request from the old low balance after an unrecorded delivery. Arrived after the last count, no
// readable delivery time (deliveredAt, on the list; the detail, when it carries one, must name the
// same moment), or never counted: staff may not have recorded it, and inventory still reads low.
function countedDelivery(listed, order, { countedAt, receivedOrders }) {
  if ((receivedOrders || []).includes(String(order?.number))) return true;
  const countedMs = Date.parse(countedAt || '');
  const arrived = Date.parse(listed?.deliveredAt || '');
  const detailArrived = order?.deliveredAt == null ? arrived : Date.parse(order.deliveredAt);
  return Number.isFinite(arrived) && detailArrived === arrived && Number.isFinite(countedMs) && arrived < countedMs;
}
async function outstandingOrder(page, orders, { vendorSku, since, counted, read }) {
  const sinceMs = Date.parse(since || '') || null;
  const closed = (o, listed) => CLOSED_STATES.has(o?.state) && CLOSED_STATES.has(listed?.state);
  for (const listed of orders) {
    const order = await read(listed);
    if (!order) return { number: listed?.number ? String(listed.number) : null, why: 'unreadable' };
    if (!hasItem(order.lines, vendorSku)) continue;
    // The list and the detail of an order of this item must agree on where it stands: on any
    // disagreement neither can be trusted, and that order's total never authorizes a purchase.
    if (listed.state !== order.state || listed.shipmentState !== order.shipmentState || listed.paymentState !== order.paymentState) return { number: String(order.number), why: 'conflict' };
    if (mayBeComing(order) || mayBeComing(listed)) return { number: String(order.number), why: 'coming' };
    if (closed(order, listed)) continue;
    // A delivered order already proven in the stock count (portal-placed receipt or physical count
    // after delivery) must never ask staff to receive it again — check countedDelivery BEFORE `since`.
    if (countedDelivery(listed, order, counted)) continue;
    if (sinceMs != null && placedMs(listed) >= sinceMs) return { number: String(order.number), why: 'since' };
    return { number: String(order.number), why: 'arrived' };
  }
  return page?.canLoadMore === false ? null : { number: null, why: 'unchecked' };
}

function resolvedLast(last, page, stamps) {
  if (!last) return null;
  // The tie for latest ran to the end of a page that is not known to be the last one: an order of
  // the same moment with another total could sit on the next page. Withhold price and source.
  if (page?.canLoadMore !== false && stamps[stamps.length - 1] === last.at) return null;
  return last;
}

async function bindingQuote({ vendorSku, quantity, since = null, countedAt = null, receivedOrders = [] }, { fetchImpl = fetch, now = Date.now } = {}) {
  if (!configured()) return null;
  const qty = Math.round(Number(quantity));
  if (!Number.isFinite(qty) || qty <= 0) return null;
  const get = lookupReader({ fetchImpl, now });
  const page = await get(`/api/orders?limit=${PAGE_MAX}`);
  const orders = listOf(page, 'orders');
  // Newest first is the documented order. It is verified, because the walk stops at the first
  // match: an undated order, or one out of order, means the latest cannot be told apart.
  const stamps = orders.map(placedMs);
  if (stamps.some((t, i) => !t || (i > 0 && t > stamps[i - 1]))) return null;
  const readOrders = new Map();
  const read = async (listed) => {
    if (!readOrders.has(listed?.number)) readOrders.set(listed?.number, await readListedOrder(listed, get));
    return readOrders.get(listed?.number);
  };
  const last = resolvedLast(await latestIdentical(orders, { vendorSku, qty, read }), page, stamps);
  // An order of this item that may already cover the request is returned whatever the price match
  // found (cents null when none binds): the dispatcher parks it, never buys, and its alert names it.
  const outstanding = await outstandingOrder(page, orders, { vendorSku, since, counted: { countedAt, receivedOrders }, read });
  if (outstanding) return { cents: last?.cents ?? null, source: last ? `order ${last.number}` : null, outstanding };
  return last?.cents == null ? null : { cents: last.cents, source: `order ${last.number}` };
}

// Right before the POST: the order list as it is now. Defense-in-depth check: Sticker Mule's API
// accepts no idempotency key or conditional submit, so exclusivity is guaranteed by the owner's
// 2026-11-27 sole-buyer operating rule ("i dont think anybody would be ordering these stickers other
// than the bit" — while auto-reorder is on for an approved Sticker Mule item, the robot is the ONLY
// buyer; staff never order approved items by hand unless an alert says the request parked or they
// turn auto-reorder off first). If an unexpected order placed since the request was raised (`since`),
// or an undated one, is already on the account, this still refuses unsent (RefusedError) and attaches
// `evidence.outstandingOrder` so the sweep never replaces the account-check warning with a plain
// manual hand-off if a gate later closes. A list that cannot be read throws.
// Only the documented shape is read: { orders: [...] } with an object for every entry. Anything else
// (no orders array, a null or non-object entry) cannot show there is no new order: refused.
async function refuseOnNewOrder(since, vendorSku, { fetchImpl, now = Date.now }) {
  const refuseWith = (message, outstandingOrder) => {
    const err = new RefusedError('vendor_order_new', message);
    err.evidence = { outstandingOrder };
    return err;
  };
  const sinceMs = Date.parse(since || '');
  if (!Number.isFinite(sinceMs)) throw refuseWith('the restock request has no start time to check new Sticker Mule orders against, so nothing was sent', { number: null, why: 'unreadable' });
  // One deadline for the list and every order read (lookupReader): past it nothing more is read, the
  // lookup throws, and nothing is sent.
  const get = lookupReader({ fetchImpl, now });
  const payload = await get(`/api/orders?limit=${PAGE_MAX}`);
  const orders = Array.isArray(payload?.orders) ? payload.orders : null;
  if (!orders || orders.some((o) => !o || typeof o !== 'object')) throw refuseWith('the Sticker Mule order list could not be read before the order, so nothing was sent', { number: null, why: 'unreadable' });
  // Only a complete list shows there is no new order: more to load past this page refuses.
  // Persist the same unchecked marker used by bindingQuote so the sweep keeps the account-check warning.
  if (payload.canLoadMore !== false) throw refuseWith('Sticker Mule has more orders than the newest 50 the robot reads, so a new one could not be ruled out before the order; nothing was sent', { number: null, why: 'unchecked' });
  // Each order placed since (or undated) is read in full: one that holds this item, or cannot be
  // read as one order with its item lines, refuses. One of other items only (the robot's own order
  // of another item in the same run), or one canceled in both its list entry and its detail, does not.
  for (const o of orders.filter((x) => !placedMs(x) || placedMs(x) >= sinceMs)) {
    const detail = o.number ? await readOrder(o.number, get).catch(() => null) : null;
    const lines = orderLines(detail);
    // Canceled (or an unclaimed gift) in the list AND the detail: it will never come. Skipped.
    if (lines && CLOSED_STATES.has(o.state) && CLOSED_STATES.has(detail.state) && o.state === detail.state) continue;
    if (!lines || hasItem(lines, vendorSku)) {
      throw refuseWith(
        `Sticker Mule order ${o.number || '(no number)'} was placed after this request was raised and holds item ${vendorSku}, or could not be read in full; it may be one placed by hand for this need, so nothing was sent`,
        { number: o.number ? String(o.number) : null, why: lines ? 'since' : 'unreadable' }
      );
    }
  }
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

// The saved item that IS this SKU, wherever it sits: full pages (limit + offset, as the live API
// serves them) until it is found or the vendor says there is no more (canLoadMore false). Only then
// is the item "not on the account"; a list that cannot be read to its end is its own refusal.
const ITEM_PAGES_MAX = 20;
async function findSavedItem(vendorSku, { fetchImpl }) {
  let offset = 0;
  for (let pages = 0; pages < ITEM_PAGES_MAX; pages += 1) {
    const page = await call('GET', `/api/items?limit=${PAGE_MAX}${offset ? `&offset=${offset}` : ''}`, null, { fetchImpl });
    const items = listOf(page, 'items');
    const item = items.find((i) => String(i?.id) === String(vendorSku));
    if (item) return item;
    if (page?.canLoadMore === false) throw new RefusedError('item_not_found', `Sticker Mule item ${vendorSku} is not on the account (reorder-only API: place the first order by hand)`);
    if (!items.length) break; // more is promised, nothing is served
    offset += items.length;
  }
  throw new RefusedError('item_lookup_incomplete', `Sticker Mule's saved items could not be read to the end, so item ${vendorSku} could not be confirmed on the account`);
}

// Account prerequisites, all read-only: the saved item that IS this SKU, and
// exactly one address + one payment method. A refusal here leaves no order.
async function resolveAccountPrerequisites({ vendorSku, fetchImpl }) {
  const item = await findSavedItem(vendorSku, { fetchImpl });
  const addresses = listOf(await call('GET', '/api/addresses', null, { fetchImpl }), 'addresses');
  if (addresses.length !== 1) throw new RefusedError(addresses.length ? 'multiple_addresses' : 'no_address', `account has ${addresses.length} shipping addresses; exactly one is required`);
  const payments = listOf(await call('GET', '/api/payments', null, { fetchImpl }), 'payments');
  if (payments.length !== 1) throw new RefusedError(payments.length ? 'multiple_payments' : 'no_payment', `account has ${payments.length} payment methods; exactly one is required`);
  // The one address and the one payment method must each carry an id: the POST names both, and one
  // without them is malformed account data, refused before anything is sent.
  const hasId = (r) => (typeof r?.id === 'string' && r.id.trim() !== '') || Number.isFinite(r?.id);
  if (!hasId(addresses[0])) throw new RefusedError('no_address', 'the account\'s shipping address has no id');
  if (!hasId(payments[0])) throw new RefusedError('no_payment', 'the account\'s payment method has no id');
  return { item, address: addresses[0], payment: payments[0] };
}

// The saved item's own reorder rules, checked before anything is sent (a vendor validation error
// after the POST would read as an order that may exist). Only a non-apparel item (isSizeRequired
// exactly false: the POST names no size) with buyingOptions (null = the product is unavailable)
// whose quantity min, max and increment are whole numbers this count fits — the min plus a whole
// number of increments, up to the max.
function refuseUnorderable(item, qty) {
  if (item?.isSizeRequired !== false) throw new RefusedError('item_needs_size', `Sticker Mule item ${item?.id} needs a size (apparel), or does not say it does not; order it by hand`);
  const q = item?.buyingOptions?.quantity;
  if (!item?.buyingOptions) throw new RefusedError('item_unavailable', `Sticker Mule item ${item?.id} is not available to reorder (no buying options)`);
  const whole = (v) => Number.isSafeInteger(v) && v > 0;
  if (!whole(q?.min) || !whole(q?.max) || !whole(q?.increment)) throw new RefusedError('item_unavailable', `Sticker Mule item ${item?.id} has no readable quantity limits`);
  if (qty < q.min || qty > q.max || (qty - q.min) % q.increment !== 0) throw new RefusedError('bad_quantity', `${qty} is not an allowed reorder count for Sticker Mule item ${item.id} (${q.min} to ${q.max}, in steps of ${q.increment})`);
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

async function place({ vendorSku, quantity, beforeSubmit = null, since }, { fetchImpl = fetch, now = Date.now } = {}) {
  if (!configured()) throw new RefusedError('no_api_key', 'STICKERMULE_API_KEY is not set');
  const qty = Math.round(Number(quantity));
  if (!Number.isFinite(qty) || qty <= 0) throw new RefusedError('bad_quantity', `quantity ${quantity} is not a positive count`);
  const { item, address, payment } = await resolveAccountPrerequisites({ vendorSku, fetchImpl });
  refuseUnorderable(item, qty);
  // The last vendor read before the POST. Only a caller that passes `since` gets it (the dispatcher
  // always does for a history-total order).
  if (since !== undefined) await refuseOnNewOrder(since, vendorSku, { fetchImpl, now });
  // The dispatcher's last check (history-total orders: its approval and its claim), after every vendor
  // read and right before the POST: refused = nothing is sent.
  if (beforeSubmit) {
    const verdict = await beforeSubmit();
    if (!verdict || verdict.ok !== true) throw new RefusedError(verdict?.reason || 'claim_lost', verdict?.message || 'the order claim is no longer placing');
  }
  const { response, number } = await submitOrder({ items: [{ id: item.id, quantity: qty }], addressId: address.id, paymentId: payment.id }, { fetchImpl });
  // The order exists and this is all place() knows of it. The charge is NOT read here: the
  // dispatcher saves the number first, then asks readCharge — so a worker that dies during that
  // read leaves the number on record, not only in memory. No charge is ever taken from the quote.
  return { externalOrderNumber: number, amountCents: null, response, evidence: { itemId: item.id, addressId: address.id, paymentId: payment.id, totalSource: 'none' } };
}

// The charge of an order, read by its number so it is found however many orders came after it:
// cents, or null while the vendor shows no charge (chargedCents: paid, a known placed state, USD).
// The dispatcher asks once right after it saved a new order's number, and again on later runs
// while there is none. A failed read throws; the dispatcher logs it and keeps the cap hold.
async function readCharge(number, { fetchImpl = fetch } = {}) {
  if (!configured() || !number) return null;
  return chargedCents(await readOrder(number, (path) => call('GET', path, null, { fetchImpl })));
}

// preSubmitTotal 'history': the API confirms no current total before the
// POST — bindingQuote is the last identical charge, not a live quote. The
// dispatcher does not auto-place for this class (parks with the figure) unless
// the owner accepts that residual risk — see order-dispatch.js.
// packagedQuantity false: `quantity` is the sticker COUNT (the request must be
// stocked in each) — never a package count.
module.exports = { key: 'stickermule', configured, preSubmitTotal: 'history', packagedQuantity: false, bindingQuote, place, readCharge, RefusedError, _internals: { call, orderTotalCents, orderLines, listOf, BASE_URL } };
