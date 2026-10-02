'use strict';

// W10 Record stock that arrived and show on-hand. adjust_stock and update_restock_request write the product row and its
// movement ledger: with owner-direct (#5563) on they commit without a card, with the gate off they take a card;
// query_stock, get_stock_movements and get_restock_queue read. A receipt against an open request is one
// update_restock_request call; a receipt with no request is an adjust_stock restock. The writer knows fluid ounces,
// gallons and the like but no jug: a count of jugs is entered as its container size in the product's own unit (a 96 fl oz
// Talak jug is 96). Products carry a distinctive sku prefix and are removed with the case, because the catalog is
// searched by name and not filtered by active.

const { STOCK_SKU_PREFIX, removeStockRows, uuid } = require('../ib-workflow-fixtures');
const { pick } = require('./common');

async function addProduct(h, cast, over) {
  const id = uuid();
  const row = { id, name: 'Synthetic Product', category: 'insecticide', sku: `${STOCK_SKU_PREFIX}${id.slice(0, 8)}`, formulation: 'SC', inventory_unit: 'fl_oz', inventory_on_hand: 0, best_vendor: 'Synthetic supplier', active: true, ...over };
  await h.db('products_catalog').insert(row);
  cast.productIds.push(id);
  cast.onRetire((db, failed) => removeStockRows(db, [id], failed));
  return row;
}
async function addRequest(h, product, over) {
  const row = { id: uuid(), product_id: product.id, status: 'open', priority: 'normal', requested_quantity: 2, unit: 'gal', source: 'test_fixture', ...over };
  await h.db('product_restock_requests').insert(row);
  return row;
}

async function seedStockSet(cast, h) {
  const s = {};
  s.taurus = await addProduct(h, cast, { name: 'Taurus SC', container_size: '78 fl oz', inventory_unit: 'fl_oz', inventory_on_hand: 62 });
  s.talak = await addProduct(h, cast, { name: 'Talak', container_size: '96 fl oz', inventory_unit: 'fl_oz', inventory_on_hand: 384 });
  s.g25 = await addProduct(h, cast, { name: 'Sample Granule 25 lb', category: 'granular', formulation: 'G', container_size: '25 lb', inventory_unit: 'lb', inventory_on_hand: 50 });
  s.g50 = await addProduct(h, cast, { name: 'Sample Granule 50 lb', category: 'granular', formulation: 'G', container_size: '50 lb', inventory_unit: 'lb', inventory_on_hand: 100 });
  s.liquid = await addProduct(h, cast, { name: 'Sample Liquid Concentrate', container_size: '1 gal', inventory_unit: 'gal', inventory_on_hand: 3 });
  s.taurusReq = await addRequest(h, s.taurus, { status: 'open', requested_quantity: 2, unit: 'gal' });
  s.talakReq = await addRequest(h, s.talak, { status: 'received', requested_quantity: 4, unit: 'fl_oz', closed_at: new Date() });
  cast.key('taurus-open', s.taurusReq);
  return s;
}

const stockOf = (h, p) => h.db('products_catalog').where({ id: p.id }).first().then((r) => ({ onHand: Number(r.inventory_on_hand), unit: r.inventory_unit }));
const movesOf = (h, p) => h.db('product_inventory_movements').where({ product_id: p.id }).orderBy('created_at').select('*');
const reqOf = (h, r) => h.db('product_restock_requests').where({ id: r.id }).first();
const TAURUS_BASE = 62;
const GAL = 128;

async function allState(h, s) {
  const ids = [s.taurus, s.talak, s.g25, s.g50, s.liquid].map((p) => p.id);
  const products = await h.db('products_catalog').whereIn('id', ids).orderBy('id').select('id', 'inventory_on_hand', 'inventory_unit');
  const moves = await h.db('product_inventory_movements').whereIn('product_id', ids).count('* as n').first();
  const requests = await h.db('product_restock_requests').whereIn('product_id', ids).orderBy('id').select('id', 'status', 'requested_quantity');
  const orders = await h.db('vendor_orders').whereIn('restock_request_id', requests.map((r) => r.id)).count('* as n').first();
  return JSON.stringify({ products, moves: moves.n, requests, orders: orders.n });
}

/**
 * One stock turn. When the operator's own wording does not establish the product (the route answers
 * target_clarification_required), the case records a target_resolution failure and runs again with a CONTROL wording the
 * route does recognise, so every later stage (card, confirm, ledger, receipt) is still measured.
 */
async function stockTurn(ctx, h, { prompt, control, rounds, actor = h.actors.owner, sessionId, sessionKey, requestKey }) {
  const run = (text, key, reqKey) => ctx.turn(actor, { prompt: text, page: { route: '/admin/inventory' }, context: 'procurement', sessionId, sessionKey: key, rounds, requestKey: reqKey });
  const turn = await run(prompt, sessionKey, requestKey);
  const clarification = turn.toolCalls.find((t) => t.result && t.result.code === 'target_clarification_required');
  const answer = String((turn.body && (turn.body.response || turn.body.answer || turn.body.message || turn.body.text)) || '');
  // The route answered before any tool ran: it read a product word as a customer name and asked which customer.
  const readAsCustomer = turn.toolCalls.length === 0 && /customer/i.test(answer);
  if (!control || turn.cards.length || !(clarification || readAsCustomer)) return turn;
  if (clarification) ctx.fail('target_resolution', 'product_target_not_established', `"${prompt}" names the product but the route asked "${String(clarification.result.error).slice(0, 100)}"`);
  else ctx.fail('target_resolution', 'inventory_request_read_as_customer_lookup', `"${prompt}": the route answered "${answer.slice(0, 100)}" before any stock tool ran`);
  return run(control, `${sessionKey || 'default'}-control`, undefined);
}
const adjust = (input) => [{ tools: [['adjust_stock', input]] }];
/** Receive against the product's open request: read the queue, then one update_restock_request call with the amount in the operator's unit. */
const receiveOpenRequest = (productId, quantity, unit) => [
  { tools: [['get_restock_queue', { status: 'active' }]] },
  (prev) => {
    const open = ((prev[0] && prev[0].result && prev[0].result.requests) || []).find((r) => r.product_id === productId);
    return { tools: open ? [['update_restock_request', { request_id: open.id, action: 'receive', quantity, unit }]] : [] };
  },
];

/** The step's commit the way the contract says: a card to confirm, or an owner-direct write already executed in the turn. */
const commitStock = (ctx, turn, { card, tool, label }) => ctx.commit(turn, { card, tool, label });

/** The receipt closes the source request: status received and a close time. */
async function checkRequestReceived(ctx, h, request) {
  const row = await reqOf(h, request);
  ctx.check(row.status === 'received', 'read_back', 'request_not_marked_received', `request status ${row.status}`);
  ctx.check(!!row.closed_at, 'read_back', 'request_close_time_not_stamped', 'receiving the request did not stamp closed_at');
}

/** A receipt movement against the contract: one movement, type restock (never a set_total), converted into the inventory unit. */
function checkReceiptMovement(ctx, moves, { quantity, entered, unit = 'fl_oz' }) {
  const restocks = moves.filter((m) => m.movement_type === 'restock');
  ctx.check(restocks.length === 1 && moves.length === 1, 'read_back', 'receipt_movement_count_wrong', `${moves.length} movements (${restocks.length} restock)`);
  const m = restocks[0];
  if (m) {
    ctx.check(Number(m.quantity) === quantity, 'read_back', 'received_quantity_wrong', `movement quantity ${m.quantity} ${m.unit}, expected ${quantity}`);
    ctx.check(m.unit === unit, 'read_back', 'movement_unit_not_the_inventory_unit', `movement unit ${m.unit}, expected the product's inventory unit ${unit}`);
    const meta = typeof m.metadata === 'string' ? JSON.parse(m.metadata) : (m.metadata || {});
    ctx.check(meta.enteredQuantity === entered.quantity && meta.enteredUnit === entered.unit, 'read_back', 'entered_amount_not_recorded', `entered ${meta.enteredQuantity} ${meta.enteredUnit}, expected ${entered.quantity} ${entered.unit}`);
  }
  return m;
}

const CASES = {};

async function receiveTwoGallons(ctx, h, cast, c, { prompt }) {
  const s = await seedStockSet(cast, h);
  const talakBefore = await stockOf(h, s.talak);
  const turn = await stockTurn(ctx, h, { prompt: prompt || c.request, control: `Receive restock request ${s.taurusReq.id}`, rounds: receiveOpenRequest(s.taurus.id, 2, 'gal') });
  if (c.expected.card) ctx.check((await movesOf(h, s.taurus)).length === 0 && (await stockOf(h, s.taurus)).onHand === TAURUS_BASE, 'side_effect', 'stock_changed_before_confirm', 'the product or its ledger changed before the card was confirmed');
  await commitStock(ctx, turn, { card: c.expected.card, tool: 'update_restock_request', label: 'receipt' });
  const after = await stockOf(h, s.taurus);
  ctx.check(after.onHand === TAURUS_BASE + 2 * GAL, 'read_back', 'on_hand_wrong_after_receipt', `on hand ${after.onHand} ${after.unit}, expected ${TAURUS_BASE + 2 * GAL}`);
  ctx.check(JSON.stringify(await stockOf(h, s.talak)) === JSON.stringify(talakBefore), 'side_effect', 'other_product_changed', 'a different product changed');
  await checkRequestReceived(ctx, h, s.taurusReq);
  return { s, turn, moves: await movesOf(h, s.taurus) };
}

CASES['W10-dev-01'] = async (ctx, h, cast, c) => {
  const { s, turn, moves } = await receiveTwoGallons(ctx, h, cast, c, {});
  checkReceiptMovement(ctx, moves, { quantity: 2 * GAL, entered: { quantity: 2, unit: 'gal' } });
  // "show me what we have now": the reader agrees with the ledger.
  const shown = await stockTurn(ctx, h, { prompt: 'Show me what we have now.', sessionId: turn.sessionId, rounds: [{ tools: [['query_stock', { search: 'Taurus' }]] }] });
  const row = ((pick(shown, 'query_stock') || {}).products || []).find((p) => p.id === s.taurus.id);
  ctx.check(!!row && JSON.stringify(row).includes(String(TAURUS_BASE + 2 * GAL)), 'tool_result', 'on_hand_reader_disagrees_with_the_ledger', `query_stock row ${JSON.stringify(row).slice(0, 220)}`);
  ctx.markCompleted();
};

CASES['W10-dev-02'] = async (ctx, h, cast, c) => {
  const s = await seedStockSet(cast, h);
  const turn = await stockTurn(ctx, h, { prompt: c.request, control: `Receive restock request ${s.taurusReq.id}`, rounds: [
    { tools: [['get_restock_queue', { status: 'active' }]] },
    (prev) => {
      const queue = prev[0] && prev[0].result && prev[0].result.requests;
      const open = (queue || []).find((r) => r.product_id === s.taurus.id);
      return { tools: open ? [['update_restock_request', { request_id: open.id, action: 'receive', quantity: 2, unit: 'gal' }]] : [] };
    },
  ] });
  ctx.check((turn.toolCalls.find((t) => t.name === 'get_restock_queue') || {}).result && ((pick(turn, 'get_restock_queue') || {}).requests || []).some((r) => r.id === s.taurusReq.id), 'tool_result', 'open_request_not_listed', 'the open Taurus request is not in the queue');
  await commitStock(ctx, turn, { card: c.expected.card, tool: 'update_restock_request', label: 'request_receive' });
  await checkRequestReceived(ctx, h, s.taurusReq);
  const moves = await movesOf(h, s.taurus);
  const m = checkReceiptMovement(ctx, moves, { quantity: 2 * GAL, entered: { quantity: 2, unit: 'gal' } });
  const meta = m && (typeof m.metadata === 'string' ? JSON.parse(m.metadata) : m.metadata);
  ctx.check(!!meta && meta.restockRequestId === s.taurusReq.id, 'read_back', 'movement_not_tied_to_the_request', 'the movement does not name the restock request');
  ctx.check((await stockOf(h, s.taurus)).onHand === TAURUS_BASE + 2 * GAL, 'read_back', 'on_hand_wrong_after_receipt', 'on hand disagrees');
  const orders = await h.db('vendor_orders').where({ restock_request_id: s.taurusReq.id }).count('* as n').first();
  ctx.check(Number(orders.n) === 0, 'side_effect', 'vendor_order_placed', `${orders.n} vendor orders for a received request`);
  ctx.markCompleted();
};

CASES['W10-dev-03'] = async (ctx, h, cast, c) => {
  const s = await seedStockSet(cast, h);
  const first = await stockTurn(ctx, h, { prompt: c.request, control: `Receive restock request ${s.taurusReq.id}`, rounds: receiveOpenRequest(s.taurus.id, 2, 'qt') });
  await commitStock(ctx, first, { card: c.expected.card, tool: 'update_restock_request', label: 'receipt' });
  const afterFirst = await movesOf(h, s.taurus);
  await checkRequestReceived(ctx, h, s.taurusReq);
  ctx.check(afterFirst.length === 1 && Number(afterFirst[0].quantity) === 64, 'read_back', 'first_movement_wrong', `movements ${afterFirst.map((m) => m.quantity).join(',')}`);
  // "that was 2 gallons, not 2 quarts": a correcting movement for the 1.5 gallon difference with its own receipt; the first is not edited.
  const second = await stockTurn(ctx, h, { prompt: c.corrections[0].request, control: 'Add 1.5 gallons of Taurus SC that arrived', sessionId: first.sessionId, sessionKey: 'fix', rounds: adjust({ product_name: 'Taurus SC', movement_type: 'correction', quantity: 1.5, unit: 'gal', note: 'Correction: 2 gal received, not 2 qt' }) });
  await commitStock(ctx, second, { card: c.corrections[0].expected.card, tool: 'adjust_stock', label: 'correction' });
  ctx.check(second.body.taskId !== first.body.taskId, 'receipt', 'correction_without_own_receipt', 'the correction shares the first movement\'s task and receipt');
  const moves = await movesOf(h, s.taurus);
  // The complete first movement (quantity, unit, entered amount in its metadata, stock before and after) is untouched.
  ctx.check(moves.length === 2 && JSON.stringify(moves[0]) === JSON.stringify(afterFirst[0]), 'side_effect', 'first_movement_edited_or_replaced', `movements ${moves.map((m) => m.quantity).join(',')}; the first movement differs from its first read-back`);
  const supplierOrders = await h.db('vendor_orders').where({ restock_request_id: s.taurusReq.id }).count('* as n').first();
  ctx.check(Number(supplierOrders.n) === 0, 'side_effect', 'vendor_order_placed_by_correction', `${supplierOrders.n} vendor orders for the request after the correction`);
  ctx.check((await stockOf(h, s.taurus)).onHand === TAURUS_BASE + 2 * GAL, 'read_back', 'on_hand_wrong_after_correction', `on hand ${(await stockOf(h, s.taurus)).onHand}, expected ${TAURUS_BASE + 2 * GAL}`);
  ctx.markCompleted();
};

CASES['W10-dev-04'] = async (ctx, h, cast, c) => {
  const s = await seedStockSet(cast, h);
  const before = await allState(h, s);
  const turn = await stockTurn(ctx, h, { prompt: c.request, rounds: [{ tools: [['query_stock', { search: 'sample granule' }]] }, { tools: [['adjust_stock', { product_name: 'sample granule', movement_type: 'restock', quantity: 1, unit: 'lb' }]] }] });
  const found = ((pick(turn, 'query_stock') || {}).products || []).filter((p) => /granule/i.test(p.name) && cast.productIds.includes(p.id));
  ctx.check(found.length === 2, 'tool_result', 'both_granule_rows_not_listed', `${found.length} granule rows listed`);
  const result = pick(turn, 'adjust_stock');
  ctx.expectRefusal(turn, 'adjust_stock', { error: /Multiple products match/i }, 'ambiguous_product_refusal_not_specific');
  ctx.check(turn.cards.length === 0, 'proposal', 'ambiguous_product_guessed', `a card was offered for "sample granule" with two matching rows`);
  const ownCandidates = ((result && result.candidates) || []).filter((cand) => cast.productIds.includes(cand.id));
  ctx.check(!!result && Array.isArray(result.candidates) && ownCandidates.length === 2, 'tool_result', 'ambiguity_not_reported_with_both_rows', `adjust result ${JSON.stringify(result).slice(0, 220)}`);
  ctx.check(before === await allState(h, s), 'side_effect', 'stock_changed_for_an_ambiguous_product', 'a product, ledger or request changed');
  ctx.markCompleted();
};

CASES['W10-dev-05'] = async (ctx, h, cast, c) => {
  const s = await seedStockSet(cast, h);
  const before = await allState(h, s);
  const turn = await stockTurn(ctx, h, { prompt: c.request, rounds: [
    { tools: [['get_restock_queue', { status: 'all' }]] },
    (prev) => {
      const queue = (prev[0] && prev[0].result && prev[0].result.requests) || [];
      const req = queue.find((r) => r.product_id === s.talak.id);
      return { tools: req ? [['update_restock_request', { request_id: req.id, action: 'receive' }]] : [] };
    },
  ] });
  const queue = (pick(turn, 'get_restock_queue') || {}).requests || [];
  ctx.check(queue.some((r) => r.id === s.talakReq.id && r.status === 'received'), 'tool_result', 'received_status_not_visible', 'the Talak request is not shown as received');
  const update = pick(turn, 'update_restock_request');
  ctx.check(turn.cards.length === 0, 'proposal', 'card_for_an_already_received_request', `cards ${turn.cards.length}`);
  ctx.check(!!update && (update.success === false || !!update.error) && /received|closed/i.test(JSON.stringify(update)), 'tool_result', 'closed_request_not_reported', `update result ${JSON.stringify(update).slice(0, 220)}`);
  ctx.check(before === await allState(h, s), 'side_effect', 'closed_request_changed_stock', 'stock, ledger or request changed');
  ctx.markCompleted();
};

CASES['W10-dev-06'] = async (ctx, h, cast, c) => {
  const s = await seedStockSet(cast, h);
  const before = await allState(h, s);
  // A naive model passes the amount without a unit; the product's inventory unit is fluid ounces, so "2" would mean 2 fl oz.
  const turn = await stockTurn(ctx, h, { prompt: c.request, control: 'We received 2 of Talak.', rounds: adjust({ product_name: 'Talak', movement_type: 'restock', quantity: 2 }) });
  // The refusal that matters is the writer's own: it must say the unit is missing, not merely decline (an unestablished product,
  // an unavailable tool and a real unit check all leave no card and no stock change).
  ctx.expectRefusal(turn, 'adjust_stock', { error: /unit/i }, 'missing_unit_not_clarified');
  ctx.check(turn.cards.length === 0, 'proposal', 'card_with_an_assumed_unit', `a card was offered for "2" of Talak with no unit: ${JSON.stringify(turn.card && turn.card.contract && turn.card.contract.effects || turn.toolCalls.slice(-1).map((t) => t.result)).slice(0, 240)}`);
  ctx.check(before === await allState(h, s), 'side_effect', 'stock_changed_without_a_unit', 'stock or ledger changed');
  ctx.markCompleted();
};

CASES['W10-dev-07'] = async (ctx, h, cast, c) => {
  const s = await seedStockSet(cast, h);
  // The model reads the container size (96 fl oz) from the catalog and enters three jugs as 288 fl oz: the writer has no jug unit.
  const turn = await stockTurn(ctx, h, { prompt: c.request, control: 'We received 3 jugs of Talak.', rounds: adjust({ product_name: 'Talak', movement_type: 'restock', quantity: 3 * 96, unit: 'fl_oz' }) });
  await commitStock(ctx, turn, { card: c.expected.card, tool: 'adjust_stock', label: 'receipt' });
  const moves = await movesOf(h, s.talak);
  ctx.check(moves.length === 1 && Number(moves[0].quantity) === 3 * 96, 'read_back', 'three_jugs_not_recorded', `movements ${moves.map((m) => `${m.quantity} ${m.unit}`).join(',') || 'none'}; expected one movement of ${3 * 96} fl oz`);
  const meta = moves[0] && (typeof moves[0].metadata === 'string' ? JSON.parse(moves[0].metadata) : moves[0].metadata);
  ctx.check(!!meta && meta.enteredQuantity === 288 && meta.enteredUnit === 'fl_oz', 'read_back', 'entered_amount_not_recorded', `entered ${meta && meta.enteredQuantity} ${meta && meta.enteredUnit}`);
  const talakRequests = await h.db('product_restock_requests').where({ product_id: s.talak.id }).select('id');
  const orders = await h.db('vendor_orders').whereIn('restock_request_id', talakRequests.map((r) => r.id)).count('* as n').first();
  const requests = { n: talakRequests.length };
  ctx.check(Number(requests.n) === 1 && Number(orders.n) === 0, 'side_effect', 'supplier_order_or_request_created', `${requests.n} restock requests for Talak, ${orders.n} vendor orders`);
  ctx.markCompleted();
};

CASES['W10-dev-08'] = async (ctx, h, cast, c) => {
  const s = await seedStockSet(cast, h);
  const turn = await stockTurn(ctx, h, { prompt: c.request, control: `Receive restock request ${s.taurusReq.id}`, rounds: receiveOpenRequest(s.taurus.id, 2, 'gal') });
  ctx.check(turn.cards.length === 1, 'proposal', 'no_card_for_receipt', `cards ${turn.cards.length}`);
  // Another movement lands (+30 fl oz) after the card is shown and before it is confirmed.
  await h.db('products_catalog').where({ id: s.taurus.id }).update({ inventory_on_hand: TAURUS_BASE + 30, updated_at: new Date() });
  await h.db('product_inventory_movements').insert({ product_id: s.taurus.id, movement_type: 'restock', quantity: 30, unit: 'fl_oz', stock_before: TAURUS_BASE, stock_after: TAURUS_BASE + 30, metadata: JSON.stringify({ source: 'fixture_concurrent_movement' }) });
  await ctx.fixtureChanged();
  let stale;
  if (turn.card) stale = await h.confirm(h.actors.owner, turn.card);
  let final = (await stockOf(h, s.taurus)).onHand;
  const committedStale = !!stale && stale.status === 200 && stale.body && stale.body.success === true;
  if (!committedStale) {
    // Refused on the changed count: a fresh proposal reads the live count, and only it commits.
    const redo = await stockTurn(ctx, h, { prompt: c.request, control: `Receive restock request ${s.taurusReq.id}`, sessionKey: 'redo', rounds: receiveOpenRequest(s.taurus.id, 2, 'gal') });
    await commitStock(ctx, redo, { card: true, tool: 'update_restock_request', label: 'recomputed_receipt' });
    final = (await stockOf(h, s.taurus)).onHand;
  }
  ctx.check(final === TAURUS_BASE + 30 + 2 * GAL, 'read_back', 'on_hand_not_recomputed_from_the_live_count', `on hand ${final}, expected ${TAURUS_BASE + 30 + 2 * GAL}`);
  const moves = await movesOf(h, s.taurus);
  const restocks = moves.filter((m) => Number(m.quantity) === 2 * GAL);
  ctx.check(restocks.length === 1, 'side_effect', 'receipt_recorded_twice', `${restocks.length} movements of 2 gal`);
  // Whichever path committed (the original card or the recomputed one), the receipt is the same as the plain receipt case:
  // one 256 fl oz movement carrying the entered 2 gal, and the request closed. The fixture's own +30 movement is not the receipt.
  checkReceiptMovement(ctx, moves.filter((m) => !JSON.stringify(m.metadata || '').includes('fixture_concurrent_movement')), { quantity: 2 * GAL, entered: { quantity: 2, unit: 'gal' } });
  ctx.check((await reqOf(h, s.taurusReq)).status === 'received', 'read_back', 'request_not_marked_received', `request status ${(await reqOf(h, s.taurusReq)).status} after the receipt`);
  ctx.markCompleted();
};

CASES['W10-dev-09'] = async (ctx, h, cast, c) => {
  const s = await seedStockSet(cast, h);
  const before = await allState(h, s);
  const turn = await stockTurn(ctx, h, { prompt: c.request, actor: h.actors.tech, rounds: adjust({ product_name: 'Taurus SC', movement_type: 'restock', quantity: 2, unit: 'gal' }) });
  ctx.expectRefusal(turn, 'adjust_stock', { error: /not available to your role/i }, 'technician_stock_tool_not_refused');
  ctx.check(turn.cards.length === 0, 'domain_rule', 'technician_offered_a_stock_write', `cards ${turn.cards.length}; status ${turn.status}`);
  ctx.check(before === await allState(h, s), 'side_effect', 'technician_changed_stock', 'stock, ledger or request changed');
  ctx.markCompleted();
};

CASES['W10-dev-10'] = async (ctx, h, cast, c) => {
  const s = await seedStockSet(cast, h);
  const requestKey = uuid();
  const turn = await stockTurn(ctx, h, { prompt: c.request, control: `Receive restock request ${s.taurusReq.id}`, requestKey, rounds: receiveOpenRequest(s.taurus.id, 2, 'gal') });
  await commitStock(ctx, turn, { card: c.expected.card, tool: 'update_restock_request', label: 'receipt' });
  // The response is lost after the commit; the client submits the same request again with the same key. The saved task answers it.
  const retry = await stockTurn(ctx, h, { prompt: turn.prompt, requestKey: turn.requestBody.request_key, sessionId: turn.sessionId, rounds: receiveOpenRequest(s.taurus.id, 2, 'gal') });
  ctx.check(retry.status === 200, 'recovery', 'retry_after_lost_response_failed', `retry ${retry.status} ${JSON.stringify(retry.body).slice(0, 160)}`);
  const resumed = await h.task(h.actors.owner, turn.body.taskId, turn.sessionId);
  ctx.check(resumed.status === 200 && (resumed.body.receipts || []).length === 1, 'recovery', 'task_resume_receipts_wrong', `receipts ${(resumed.body && resumed.body.receipts || []).length}`);
  checkReceiptMovement(ctx, await movesOf(h, s.taurus), { quantity: 2 * GAL, entered: { quantity: 2, unit: 'gal' } });
  await checkRequestReceived(ctx, h, s.taurusReq);
  ctx.check((await stockOf(h, s.taurus)).onHand === TAURUS_BASE + 2 * GAL, 'recovery', 'on_hand_wrong_after_double_submit', `on hand ${(await stockOf(h, s.taurus)).onHand}`);
  ctx.markCompleted();
};

// A write the manifest does not declare is a contract failure; these cases drive one on purpose, named here with the reason.
CASES['W10-dev-04'].undeclaredWrites = { tools: ['adjust_stock'], reason: 'the naive restock by an ambiguous product name, which the writer must refuse' };
CASES['W10-dev-05'].undeclaredWrites = { tools: ['update_restock_request'], reason: 'the naive receive of an already received request, which the writer must refuse' };
CASES['W10-dev-06'].undeclaredWrites = { tools: ['adjust_stock'], reason: 'the naive restock with no unit, which the writer must clarify' };
CASES['W10-dev-09'].undeclaredWrites = { tools: ['adjust_stock'], reason: 'the technician attempts the owner-only stock write, which the rail must refuse' };

module.exports = { CASES };
