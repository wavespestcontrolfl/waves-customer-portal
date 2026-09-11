/** Synthetic integration: scripted model -> real auth/routes/shared domain ->
 * isolated Postgres -> durable receipt. No model/provider/vendor network calls. */
const crypto = require('crypto');
const mockModel = jest.fn();
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({ messages: { create: mockModel } })));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const databaseUrl = process.env.IB_TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
suite('inventory UI and Intelligence Bar through shared operations', () => {
  let db, server, origin, token, actor, viewedCustomer;
  const sessionId = crypto.randomUUID();
  const originalEnv = { ...process.env };
  const toolCall = (name, input, id) => ({ content: [{ type: 'tool_use', name, input, id }], usage: {} });
  async function api(path, body, method = body ? 'POST' : 'GET') {
    const response = await fetch(`${origin}${path}`, { method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  }
  async function product(overrides = {}) {
    const id = crypto.randomUUID();
    const [row] = await db('products_catalog').insert({ id, name: `CatalogQA${id.slice(0, 8)} SC`, category: 'insecticide',
      sku: `QA-${id.slice(0, 8)}`, formulation: 'SC', container_size: '2 lb', inventory_unit: 'lb',
      inventory_on_hand: 10, best_vendor: 'Synthetic supplier', ...overrides }).returning('*');
    return row;
  }
  async function propose(name, input, prompt, options = {}) {
    mockModel.mockReset();
    mockModel.mockResolvedValueOnce(toolCall('discover_capabilities', { query: name.replaceAll('_', ' ') }, 'discover'))
      .mockResolvedValueOnce(toolCall(name, input, 'inventory'))
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'Review the saved action preview.' }], usage: {} });
    return api('/api/admin/intelligence-bar/query', { prompt, context: 'estimates', session_id: sessionId,
      request_key: crypto.randomUUID(), pageData: { route: '/admin/estimates', customerId: viewedCustomer }, ...options });
  }
  async function confirm(proposed) {
    expect(proposed.body.pendingActions).toHaveLength(1);
    const card = proposed.body.pendingActions[0];
    return api('/api/admin/intelligence-bar/confirm-action', { pending_action_id: card.id, contract_hash: card.contract_hash });
  }
  const onHand = async id => Number((await db('products_catalog').where({ id }).first()).inventory_on_hand);
  async function requestFor(row, overrides = {}) {
    const [request] = await db('product_restock_requests').insert({ id: crypto.randomUUID(), product_id: row.id,
      status: 'open', priority: 'normal', requested_quantity: 6, unit: row.inventory_unit || 'lb', source: 'test_fixture', ...overrides }).returning('*');
    return request;
  }
  beforeAll(async () => {
    const parsed = new URL(databaseUrl);
    const ciDatabase = process.env.CI === 'true' && parsed.hostname === 'localhost' && parsed.pathname === '/waves_test';
    if (!ciDatabase && !/^\/waves_ib_platform_[a-z0-9_]+$/.test(parsed.pathname)) throw new Error('An isolated IB development database is required');
    Object.assign(process.env, { DATABASE_URL: databaseUrl, NODE_ENV: 'test', JWT_SECRET: crypto.randomBytes(32).toString('hex'),
      ANTHROPIC_API_KEY: 'scripted-model-only', GATE_IB_PLATFORM: 'true', GATE_IB_THREADS: 'false', GATE_IB_WRITES_DISABLED: 'false' });
    db = require('../models/db'); actor = crypto.randomUUID(); viewedCustomer = crypto.randomUUID();
    await db('technicians').insert({ id: actor, name: 'Synthetic inventory operator', role: 'admin', active: true, auth_token_version: 1 });
    await db('customers').insert({ id: viewedCustomer, first_name: 'Inventory', last_name: `Bystander${viewedCustomer.slice(0, 8)}`,
      phone: `+15550${Math.floor(Math.random() * 1000000).toString().padStart(6, '0')}`, address_line1: '200 Example Grove' });
    token = require('jsonwebtoken').sign({ type: 'access', tokenVersion: 1, technicianId: actor }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const express = require('express'); const app = express(); app.use(express.json());
    app.use('/api/admin/intelligence-bar', require('../routes/admin-intelligence-bar'));
    app.use('/api/admin/inventory', require('../routes/admin-inventory'));
    app.use((err, req, res, next) => res.status(err.statusCode || err.status || 500).json({ error: err.message, code: err.code }));
    server = await new Promise(resolve => { const running = app.listen(0, '127.0.0.1', () => resolve(running)); });
    origin = `http://127.0.0.1:${server.address().port}`;
  }, 30000);
  afterAll(async () => {
    jest.restoreAllMocks();
    if (server) await new Promise(resolve => server.close(resolve));
    if (db) await db.destroy();
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
  });

  test('catalog dispatch accepts an ID-only vendor comparison and reads that actual product', async () => {
    const row = await product();
    const result = await require('../services/intelligence-bar/action-registry').execute('compare_vendor_pricing',
      { product_id: row.id }, { role: 'admin', context: 'estimates' });
    expect(result).toMatchObject({ product: { id: row.id, name: row.name }, vendor_prices: [] });
    expect(result.error).toBeUndefined();
  });

  test('a reorder from Estimates saves one real open request, with actor and truthful receipt, without ordering or adding stock', async () => {
    const row = await product();
    const customerBefore = await db('customers').where({ id: viewedCustomer }).first();
    const proposed = await propose('create_restock_request', { product_name: row.name, quantity: 2, unit: 'lb' },
      `Add 2 lb of ${row.name} to the restock list`);
    expect(proposed.body.pendingActions[0].contract.preview_fingerprint).toBeTruthy();
    expect(await db('product_restock_requests').where({ product_id: row.id })).toHaveLength(0);
    const saved = await confirm(proposed);
    expect(saved.body).toMatchObject({ success: true, outcome: 'completed', result: {
      request: { product_id: row.id, status: 'open', requested_quantity: 2, unit: 'lb' },
      verification: { persisted: true }, receipt: { label: 'Restock request saved', href: expect.stringContaining('/admin/inventory?tab=restock&requestId=') },
    } });
    const persisted = await db('product_restock_requests').where({ id: saved.body.result.request.id }).first();
    expect(persisted).toMatchObject({ product_id: row.id, created_by: actor, source: 'intelligence_bar', status: 'open' });
    expect(Number(persisted.requested_quantity)).toBe(2);
    expect(await onHand(row.id)).toBe(10);
    expect(await db('vendor_orders').where({ restock_request_id: persisted.id })).toHaveLength(0);
    expect(await db('customers').where({ id: viewedCustomer }).first()).toEqual(customerBefore);
    const receipt = await api(`/api/admin/intelligence-bar/actions/${proposed.body.pendingActions[0].id}`);
    expect(receipt.body.result.request.id).toBe(persisted.id);
    const replay = await confirm(proposed);
    expect(replay.status).toBe(409);
    expect(await db('product_restock_requests').where({ product_id: row.id })).toHaveLength(1);
  }, 30000);

  test.each(['before Tuesday', 'by 2026-09-15', 'by tomorrow'])('a restock deadline %s preserves the exact formulation and saved date', async suffix => {
    const prefix = `DeadlineQA${crypto.randomUUID().slice(0, 8)}`;
    const base = await product({ name: `${prefix} 10% SC` });
    const intended = await product({ name: `${prefix} 20% SC` });
    const { etDateString, addETDays } = require('../utils/datetime-et');
    const fields = { quantity: 2, unit: 'lb', needed_by: suffix === 'by tomorrow' ? etDateString(addETDays(new Date(), 1)) : '2026-09-15' };
    const prompt = `Request 2 lb of ${intended.name} ${suffix}`;
    const wrong = await propose('create_restock_request', { ...fields, product_id: base.id }, prompt);
    expect(wrong.body.pendingActions || []).toHaveLength(0);
    const proposed = await propose('create_restock_request', { ...fields, product_id: intended.id }, prompt);
    expect(proposed.body.pendingActions).toHaveLength(1);
    expect(JSON.stringify(proposed.body.pendingActions[0].contract)).toContain(fields.needed_by);
    const saved = await confirm(proposed);
    expect(saved.body).toMatchObject({ success: true, result: { request: { product_id: intended.id } } });
    expect(saved.body.result.request.needed_by).toBe(fields.needed_by);
    const persisted = await db('product_restock_requests').where({ id: saved.body.result.request.id })
      .select('id', db.raw('needed_by::text as needed_by')).first();
    expect(persisted.needed_by).toBe(fields.needed_by);
    expect(await db('product_restock_requests').where({ product_id: base.id })).toHaveLength(0);
    expect(await onHand(intended.id)).toBe(10);
    expect(await db('vendor_orders').where({ restock_request_id: persisted.id })).toHaveLength(0);
  }, 40000);

  test('a restock deadline cannot disappear from the model preview', async () => {
    const row = await product();
    const proposed = await propose('create_restock_request', { product_id: row.id, quantity: 2 },
      `Request 2 lb of ${row.name} before Tuesday`);
    expect(proposed.body.pendingActions || []).toHaveLength(0);
    expect(await db('product_restock_requests').where({ product_id: row.id })).toHaveLength(0);
  });

  test('a literal catalog name ending in a deadline phrase never collapses to its shorter product', async () => {
    const base = await product();
    const intended = await product({ name: `${base.name} before Tuesday` });
    const prompt = `Request 2 lb of ${intended.name}`;
    const wrong = await propose('create_restock_request', { product_id: base.id, quantity: 2, needed_by: '2026-09-15' }, prompt);
    expect(wrong.body.pendingActions || []).toHaveLength(0);
    const saved = await confirm(await propose('create_restock_request', { product_id: intended.id, quantity: 2 }, prompt));
    expect(saved.body).toMatchObject({ success: true, result: { request: { product_id: intended.id, needed_by: null } } });
    expect(await db('product_restock_requests').where({ product_id: base.id })).toHaveLength(0);
  }, 30000);

  test('ambiguous catalog names ending in a deadline phrase do not fall back to a shorter match', async () => {
    const base = await product();
    await product({ name: `${base.name} before Tuesday` });
    await product({ name: `${base.name} before Tuesday` });
    const proposed = await propose('create_restock_request', { product_id: base.id, quantity: 2, needed_by: '2026-09-15' },
      `Request 2 lb of ${base.name} before Tuesday`);
    expect(proposed.body.pendingActions || []).toHaveLength(0);
    expect(await db('product_restock_requests').where({ product_id: base.id })).toHaveLength(0);
  });

  test('portal and bar adjustments/requests/receipts agree on saved quantities, units, status and actor', async () => {
    const ui = await product(), bar = await product();
    const uiAdjust = await api(`/api/admin/inventory/${ui.id}/adjust`, { movementType: 'restock', quantity: 2, unit: 'lb', reason: 'Physical receipt' });
    expect(uiAdjust.status).toBe(200);
    const barAdjust = await confirm(await propose('adjust_stock', { product_id: bar.id, movement_type: 'restock', quantity: 2, unit: 'lb', reason: 'Physical receipt' },
      `Record the 2 lb of ${bar.name} that physically arrived`));
    expect(barAdjust.body.success).toBe(true);
    expect(await onHand(ui.id)).toBe(await onHand(bar.id));
    const uiMovement = (await db('product_inventory_movements').where({ product_id: ui.id }))[0];
    const barMovement = (await db('product_inventory_movements').where({ product_id: bar.id }))[0];
    for (const key of ['movement_type', 'quantity', 'unit', 'stock_before', 'stock_after']) expect(uiMovement[key]).toBe(barMovement[key]);
    expect(uiMovement.metadata.adjustedBy).toBe(actor); expect(barMovement.metadata.adjustedBy).toBe(actor);
    const uiRequest = await api(`/api/admin/inventory/waveguard-forecast/${ui.id}/restock-request`, { requestedQuantity: 3, unit: 'lb', priority: 'normal', reason: 'Projected demand' });
    expect(uiRequest.status).toBe(200);
    const barRequest = await confirm(await propose('create_restock_request', { product_id: bar.id, quantity: 3, unit: 'lb', priority: 'normal', reason: 'Projected demand' },
      `Save a request for 3 lb of ${bar.name}`));
    expect(barRequest.body.success).toBe(true);
    const uiId = uiRequest.body.restockRequest.id, barId = barRequest.body.result.request.id;
    const uiRow = await db('product_restock_requests').where({ id: uiId }).first();
    const barRow = await db('product_restock_requests').where({ id: barId }).first();
    for (const key of ['requested_quantity', 'unit', 'status', 'vendor', 'priority', 'created_by']) expect(uiRow[key]).toBe(barRow[key]);
    const rejected = await api(`/api/admin/inventory/restock-requests/${uiId}/action`, { action: 'receive', quantity: 'not a quantity', unit: null });
    expect(rejected.status).toBe(400); expect(await onHand(ui.id)).toBe(12);
    const received = await api(`/api/admin/inventory/restock-requests/${uiId}/action`, { action: 'receive', quantity: '2', unit: 'lb' });
    expect(received.status).toBe(200);
    const barReceived = await confirm(await propose('update_restock_request', { request_id: barId, action: 'receive', quantity: 2, unit: 'lb' },
      `Receive the 2 lb that arrived for restock request ${barId}`));
    expect(barReceived.body).toMatchObject({ success: true, result: { status: 'received', stock_after: 14, receipt: { label: 'Stock received' } } });
    expect(await onHand(ui.id)).toBe(await onHand(bar.id));
    for (const id of [uiId, barId]) expect(await db('product_restock_requests').where({ id }).first()).toMatchObject({ status: 'received', closed_by: actor });
  }, 40000);

  test.each(['mark_ordered', 'cancel'])('%s from Estimates matches the portal without submitting an order or changing stock', async action => {
    const ui = await product(), bar = await product();
    const uiRequest = await requestFor(ui), barRequest = await requestFor(bar);
    const uiResult = await api(`/api/admin/inventory/restock-requests/${uiRequest.id}/action`, { action, note: 'Recorded by staff' });
    expect(uiResult.status).toBe(200);
    const proposed = await propose('update_restock_request', { request_id: barRequest.id, action, note: 'Recorded by staff' },
      action === 'mark_ordered' ? `Mark restock request ${barRequest.id} as ordered; the supplier order was already placed by staff` : `Cancel restock request ${barRequest.id}`);
    expect((await db('product_restock_requests').where({ id: barRequest.id }).first()).status).toBe('open');
    const result = await confirm(proposed);
    const expectedStatus = action === 'mark_ordered' ? 'ordered' : 'cancelled';
    expect(result.body).toMatchObject({ success: true, outcome: 'completed', result: { status: expectedStatus, verification: { persisted: true } } });
    const uiSaved = await db('product_restock_requests').where({ id: uiRequest.id }).first();
    const barSaved = await db('product_restock_requests').where({ id: barRequest.id }).first();
    for (const key of ['status', 'closed_by']) expect(barSaved[key]).toEqual(uiSaved[key]);
    expect(barSaved.metadata.lastManualAction).toMatchObject({ action, note: 'Recorded by staff', actorId: actor });
    for (const row of [ui, bar]) {
      expect(await onHand(row.id)).toBe(10);
      expect(await db('product_inventory_movements').where({ product_id: row.id })).toHaveLength(0);
    }
    expect(await db('vendor_orders').whereIn('restock_request_id', [uiRequest.id, barRequest.id])).toHaveLength(0);
    expect((await confirm(proposed)).status).toBe(409);
    const receipt = await api(`/api/admin/intelligence-bar/actions/${proposed.body.pendingActions[0].id}`);
    expect(receipt.body).toMatchObject({ outcome: 'completed', result: { status: expectedStatus } });
  }, 40000);

  test('an inventory confirmation rechecks a revoked admin role before any stock mutation', async () => {
    const row = await product();
    const proposed = await propose('adjust_stock', { product_id: row.id, movement_type: 'restock', quantity: 2, unit: 'lb' },
      `Record the 2 lb of ${row.name} that arrived`);
    await db('technicians').where({ id: actor }).update({ role: 'technician' });
    try {
      const denied = await confirm(proposed);
      expect(denied.status).toBe(403);
      expect(await onHand(row.id)).toBe(10);
      expect(await db('product_inventory_movements').where({ product_id: row.id })).toHaveLength(0);
    } finally { await db('technicians').where({ id: actor }).update({ role: 'admin' }); }
    expect((await confirm(proposed)).status).toBe(409);
    const receipt = await api(`/api/admin/intelligence-bar/actions/${proposed.body.pendingActions[0].id}`);
    expect(receipt.body).toMatchObject({ outcome: 'blocked', result: { code: 'permission_denied' } });
    const renewed = await propose('adjust_stock', { product_id: row.id, movement_type: 'restock', quantity: 2, unit: 'lb' },
      `Record the 2 lb of ${row.name} that arrived`);
    expect((await confirm(renewed)).body.success).toBe(true);
    expect(await onHand(row.id)).toBe(12);
  }, 30000);

  test('zero initialization, conversions and invalid receive quantities preserve physical stock semantics', async () => {
    const inventory = require('../services/inventory-operations');
    const untracked = await product({ inventory_on_hand: null, inventory_unit: null });
    const zero = await confirm(await propose('adjust_stock', { product_id: untracked.id, movement_type: 'correction', set_total: 0, unit: 'each' },
      `The shelf count for ${untracked.name} is zero items`));
    expect(zero.body.success).toBe(true); expect(await onHand(untracked.id)).toBe(0);
    expect((await db('product_inventory_movements').where({ product_id: untracked.id }))[0]).toMatchObject({ unit: 'each', quantity: '0.0000' });
    const volume = await product({ inventory_unit: 'fl_oz', inventory_on_hand: 64 });
    const converted = await confirm(await propose('adjust_stock', { product_id: volume.id, movement_type: 'restock', quantity: 2, unit: 'gal' },
      `Add the two gallons of ${volume.name} that arrived`));
    expect(converted.body.result.stock_after).toBe(320);
    await expect(inventory.previewStockAdjustment(volume.id, { movementType: 'restock', quantity: 2, unit: 'lb' })).rejects.toThrow(/Cannot convert/);
    await expect(inventory.previewStockAdjustment(untracked.id, { movementType: 'correction', setTotal: 0, unit: 'lb' })).rejects.toThrow(/Cannot convert/);
    const request = await requestFor(volume);
    const badDeadline = await api(`/api/admin/inventory/waveguard-forecast/${volume.id}/restock-request`, {
      requestedQuantity: 1, unit: 'fl_oz', neededBy: '2031-02-31',
    });
    expect(badDeadline.status).toBe(400);
    for (const quantity of [false, [], {}, 'invalid', 0, -1]) {
      const response = await api(`/api/admin/inventory/restock-requests/${request.id}/action`, { action: 'receive', quantity });
      expect([quantity, response.status]).toEqual([quantity, 400]);
    }
    expect(await onHand(volume.id)).toBe(320);
    const unknown = await product({ inventory_unit: 'unknown-unit', inventory_on_hand: null });
    const unknownRequest = await requestFor(unknown);
    const response = await api(`/api/admin/inventory/restock-requests/${unknownRequest.id}/action`, { action: 'receive', quantity: 1 });
    expect(response.status).toBe(400);
    expect((await db('products_catalog').where({ id: unknown.id }).first()).inventory_on_hand).toBeNull();
    const defaults = await api(`/api/admin/inventory/restock-requests/${request.id}/action`, { action: 'receive', quantity: null, unit: null, note: null });
    expect(defaults.status).toBe(200); expect(await onHand(volume.id)).toBe(326);
  }, 40000);

  test('concurrent requests dedupe under the product lock; intentional staff duplicates never duplicate automatic requests', async () => {
    const row = await product();
    const first = await propose('create_restock_request', { product_id: row.id, quantity: 2 }, `Request 2 lb of ${row.name}`);
    const second = await propose('create_restock_request', { product_id: row.id, quantity: 2 }, `Request 2 lb of ${row.name}`);
    const results = await Promise.all([confirm(first), confirm(second)]);
    expect(results.filter(r => r.body.success)).toHaveLength(1);
    expect(results.find(r => !r.body.success).body).toMatchObject({ outcome: 'blocked', result: { code: 'request_exists' } });
    expect(await db('product_restock_requests').where({ product_id: row.id })).toHaveLength(1);
    const duplicate = await api(`/api/admin/inventory/waveguard-forecast/${row.id}/restock-request`, { requestedQuantity: 1, unit: 'lb', allowDuplicate: true });
    expect(duplicate.body.existing).toBe(false);
    expect(await db('product_restock_requests').where({ product_id: row.id })).toHaveLength(2);
    const automatic = await product();
    const existing = await requestFor(automatic, { source: require('../services/procurement/auto-reorder').AUTO_REORDER_SOURCE });
    const refused = await api(`/api/admin/inventory/waveguard-forecast/${automatic.id}/restock-request`, { requestedQuantity: 1, unit: 'lb', allowDuplicate: true });
    expect(refused.body).toMatchObject({ existing: true, restockRequest: { id: existing.id } });
    expect(await db('product_restock_requests').where({ product_id: automatic.id })).toHaveLength(1);
  }, 40000);

  test('a stock change after confirm preflight is refused under the product lock', async () => {
    const row = await product();
    const proposed = await propose('adjust_stock', { product_id: row.id, movement_type: 'restock', quantity: 2 }, `Add 2 lb of ${row.name} that arrived`);
    const inventory = require('../services/inventory-operations');
    const preview = inventory.previewStockAdjustment;
    const spy = jest.spyOn(inventory, 'previewStockAdjustment').mockImplementationOnce(async (...args) => {
      const result = await preview(...args);
      await db('products_catalog').where({ id: row.id }).update({ inventory_on_hand: 20, updated_at: db.fn.now() });
      return result;
    });
    let result;
    try { result = await confirm(proposed); } finally { spy.mockRestore(); }
    expect(result.body).toMatchObject({ success: false, result: { preview_changed: true, code: 'preview_changed' } });
    expect(await onHand(row.id)).toBe(20);
    expect(await db('product_inventory_movements').where({ product_id: row.id })).toHaveLength(0);
  }, 30000);

  test('a product-name reassignment after preflight cannot redirect the approved request to another SKU', async () => {
    const intended = await product(), other = await product();
    const proposed = await propose('create_restock_request', { product_name: intended.name, quantity: 2 }, `Request 2 lb of ${intended.name}`);
    const inventory = require('../services/inventory-operations');
    const preview = inventory.previewRestockRequest;
    const spy = jest.spyOn(inventory, 'previewRestockRequest').mockImplementationOnce(async (...args) => {
      const result = await preview(...args);
      await db('products_catalog').where({ id: intended.id }).update({ name: `${intended.name} renamed`, updated_at: db.fn.now() });
      await db('products_catalog').where({ id: other.id }).update({ name: intended.name, updated_at: db.fn.now() });
      return result;
    });
    let result;
    try { result = await confirm(proposed); } finally { spy.mockRestore(); }
    expect(result.body).toMatchObject({ success: false, result: { code: 'preview_changed' } });
    expect(await db('product_restock_requests').whereIn('product_id', [intended.id, other.id])).toHaveLength(0);
    expect(await onHand(other.id)).toBe(10);
  }, 30000);

  test('receiving is atomic across stale tabs; terminal and already-ordered requests cannot reopen', async () => {
    const row = await product();
    const request = await requestFor(row);
    const results = await Promise.all([
      api(`/api/admin/inventory/restock-requests/${request.id}/action`, { action: 'receive', quantity: null, unit: null }),
      api(`/api/admin/inventory/restock-requests/${request.id}/action`, { action: 'receive', quantity: null, unit: null }),
    ]);
    expect(results.map(r => r.status).sort()).toEqual([200, 409]);
    expect(await onHand(row.id)).toBe(16);
    expect(await db('product_inventory_movements').where({ product_id: row.id })).toHaveLength(1);
    const reopen = await api(`/api/admin/inventory/restock-requests/${request.id}/action`, { action: 'mark_ordered', quantity: null, unit: null });
    expect(reopen.status).toBe(409);
    const ordered = await requestFor(await product(), { status: 'ordered' });
    await expect(require('../services/inventory-operations').previewRestockAction(ordered.id, { action: 'mark_ordered' })).rejects.toThrow(/Only an open request/);
    const canceled = await api(`/api/admin/inventory/restock-requests/${ordered.id}/action`, { action: 'cancel', quantity: null, unit: null, note: 'No longer needed' });
    expect(canceled.body.request).toMatchObject({ status: 'cancelled', closed_by: actor });
    expect((await db('product_restock_requests').where({ id: ordered.id }).first()).metadata.lastManualAction)
      .toMatchObject({ action: 'cancel', note: 'No longer needed', actorId: actor });
  }, 30000);

  test('packaged order quantities and late-order receipts agree in the UI and bar queue without duplicate stock', async () => {
    const row = await product();
    const request = await requestFor(row);
    const orderId = crypto.randomUUID();
    await db('vendor_orders').insert({ id: orderId, restock_request_id: request.id, adapter: 'synthetic', status: 'placed',
      placed_at: new Date(), external_order_number: `QA-${orderId.slice(0, 8)}`, amount_cents: 1234,
      request_payload: { orderedQuantity: 10 }, evidence: {} });
    const received = await confirm(await propose('update_restock_request', { request_id: request.id, action: 'receive' },
      `Receive the actual packaged shipment for restock request ${request.id}`));
    expect(received.body).toMatchObject({ success: true, result: { added: 10, stock_after: 20 } });
    await db('vendor_orders').where({ id: orderId }).update({ evidence: { landedAfterReceive: new Date().toISOString() } });
    const uiQueue = await api(`/api/admin/inventory/restock-requests?status=active&requestId=${request.id}`);
    expect(uiQueue.body.requests).toHaveLength(1);
    const barQueue = await require('../services/intelligence-bar/procurement-tools').executeProcurementTool('get_restock_queue',
      { status: 'active', request_id: request.id }, { isAdmin: true });
    expect(JSON.parse(JSON.stringify(barQueue.requests[0].order))).toEqual(uiQueue.body.requests[0].order);
    expect(barQueue.requests[0].order).toMatchObject({ status: 'placed', orderedQuantity: 10, landedAfterReceive: true, amountCents: 1234 });
    const second = await confirm(await propose('update_restock_request', { request_id: request.id, action: 'receive' },
      `Receive the restock request for ${row.name}`));
    expect(second.body.success).toBe(true); expect(await onHand(row.id)).toBe(30);
    expect((await db('vendor_orders').where({ id: orderId }).first()).evidence.landedAfterReceive).toBeUndefined();
    const replay = await api(`/api/admin/inventory/restock-requests/${request.id}/action`, { action: 'receive' });
    expect(replay.status).toBe(409);
    expect(await db('product_inventory_movements').where({ product_id: row.id })).toHaveLength(2);
  }, 40000);

  test('a model-selected product cannot replace the product/formulation in the current request', async () => {
    const intended = await product(), wrong = await product();
    for (const selector of [{ product_id: wrong.id }, { product_name: wrong.name }]) {
      const rejected = await propose('create_restock_request', { ...selector, quantity: 2, unit: 'lb' },
        `Add 2 lb of ${intended.name} to the restock list`);
      expect(rejected.body.pendingActions || []).toHaveLength(0);
    }
    const prefix = `FormulaQA${crypto.randomUUID().slice(0, 8)}`;
    const ten = await product({ name: `${prefix} 10% SC` });
    const twenty = await product({ name: `${prefix} 20% SC` });
    const wrongFormula = await propose('create_restock_request', { product_id: ten.id, quantity: 2 },
      `Request 2 lb of ${twenty.name}`);
    expect(wrongFormula.body.pendingActions || []).toHaveLength(0);
    const valid = await confirm(await propose('create_restock_request', { product_name: twenty.name, quantity: 2 },
      `Request 2 lb of ${twenty.name}`));
    expect(valid.body).toMatchObject({ success: true, result: { request: { product_id: twenty.id } } });
    expect(await db('product_restock_requests').whereIn('product_id', [intended.id, wrong.id, ten.id])).toHaveLength(0);
  }, 60000);

  test('duplicate exact products beyond partial-search limits refuse IDs until the operator names an exact UUID', async () => {
    const row = await product();
    for (let i = 0; i < 7; i++) await product({ name: `${row.name} variant ${i}` });
    const duplicate = await product({ name: row.name });
    for (const id of [row.id, duplicate.id]) {
      const ambiguous = await propose('create_restock_request', { product_id: id, quantity: 2 }, `Request 2 lb of ${row.name}`);
      expect(ambiguous.body.pendingActions || []).toHaveLength(0);
    }
    const explicit = await confirm(await propose('create_restock_request', { product_id: duplicate.id, quantity: 2 },
      `Request 2 lb of product ${duplicate.id}`));
    expect(explicit.body).toMatchObject({ success: true, result: { request: { product_id: duplicate.id } } });
    expect(await db('product_restock_requests').where({ product_id: row.id })).toHaveLength(0);
  }, 50000);

  test.each([': 20% SC', ' "20% SC"', '; 20% SC'])('qualified product identity %s cannot collapse into the base product', async suffix => {
    const base = await product();
    const qualified = await product({ name: `${base.name}${suffix}` });
    const prompt = `Request 2 lb of ${qualified.name}`;
    const wrong = await propose('create_restock_request', { product_id: base.id, quantity: 2 }, prompt);
    expect(wrong.body.pendingActions || []).toHaveLength(0);
    const saved = await confirm(await propose('create_restock_request', { product_id: qualified.id, quantity: 2 }, prompt));
    expect(saved.body).toMatchObject({ success: true, result: { request: { product_id: qualified.id } } });
    expect(await db('product_restock_requests').where({ product_id: base.id })).toHaveLength(0);
  }, 40000);

  test('a named restock request uses the current active queue and refuses a duplicate without copying an ID', async () => {
    const row = await product();
    await requestFor(row, { status: 'received' });
    const one = await requestFor(row);
    const prompt = `Cancel the restock request for ${row.name}`;
    const proposed = await propose('update_restock_request', { request_id: one.id, action: 'cancel' }, prompt);
    expect(proposed.body.pendingActions).toHaveLength(1);
    const second = await requestFor(row);
    for (const id of [one.id, second.id]) {
      const ambiguous = await propose('update_restock_request', { request_id: id, action: 'cancel' }, prompt);
      expect(ambiguous.body.pendingActions || []).toHaveLength(0);
    }
    const saved = await confirm(proposed);
    expect(saved.body).toMatchObject({ success: true, result: { request_id: one.id, status: 'cancelled' } });
    expect((await db('product_restock_requests').where({ id: second.id }).first()).status).toBe('open');
  }, 50000);

  test.each([
    ['mark_ordered', name => `I ordered the ${name}`],
    ['cancel', name => `cancel that ${name} request`],
  ])('documented %s wording requires one exact active product request', async (action, wording) => {
    const row = await product(), other = await product();
    const request = await requestFor(row), wrong = await requestFor(other);
    const prompt = wording(row.name);
    const rejected = await propose('update_restock_request', { request_id: wrong.id, action }, prompt);
    expect(rejected.body.pendingActions || []).toHaveLength(0);
    const proposed = await propose('update_restock_request', { request_id: request.id, action }, prompt);
    expect((await confirm(proposed)).body.success).toBe(true);
    await requestFor(row);
    await requestFor(row);
    const ambiguous = await propose('update_restock_request', { request_id: request.id, action }, prompt);
    expect(ambiguous.body.pendingActions || []).toHaveLength(0);
  }, 40000);

  test('spilled-bag wording binds the whole product and retains low-stock warnings', async () => {
    const row = await product({ low_stock_threshold: 8 });
    const fields = { product_id: row.id, movement_type: 'damaged_lost', quantity: 2, unit: 'lb' };
    const preview = await require('../services/inventory-operations').previewStockAdjustment(row.id,
      { movementType: 'damaged_lost', quantity: 2, unit: 'lb' });
    expect(preview).toMatchObject({ stock_after: 8, low_stock_after: true });
    expect(preview.warning).toContain('low-stock');
    const proposed = await propose('adjust_stock', fields, `write off the spilled bag of ${row.name}`);
    expect((await confirm(proposed)).body.success).toBe(true);
    expect(await onHand(row.id)).toBe(8);
  }, 30000);

  test('model duplicate override requires explicit operator intent', async () => {
    const row = await product();
    await requestFor(row);
    const fields = { product_id: row.id, quantity: 2, unit: 'lb', allow_duplicate: true };
    for (const prompt of [`Request 2 lb of ${row.name}`, `Do not create another request for 2 lb of ${row.name}`]) {
      const rejected = await propose('create_restock_request', fields, prompt);
      expect(rejected.body.pendingActions || []).toHaveLength(0);
    }
    expect(await db('product_restock_requests').where({ product_id: row.id })).toHaveLength(1);
    const proposed = await propose('create_restock_request', fields, `Create another restock request for 2 lb of ${row.name}`);
    expect((await confirm(proposed)).body.success).toBe(true);
    expect(await db('product_restock_requests').where({ product_id: row.id })).toHaveLength(2);
  }, 40000);

  test('product IDs inside notes and message data never authorize a stock write', async () => {
    const row = await product();
    for (const prompt of [
      `Add notes for this customer: Request 2 lb of product ${row.id}`,
      `Email this customer a message that says Request 2 lb of product ${row.id}`,
      `Save a message about product ${row.id}`,
    ]) {
      const rejected = await propose('adjust_stock', { product_id: row.id, movement_type: 'restock', quantity: 2 }, prompt);
      expect(rejected.body.pendingActions || []).toHaveLength(0);
    }
    expect(await onHand(row.id)).toBe(10);
    expect(await db('product_inventory_movements').where({ product_id: row.id })).toHaveLength(0);
  }, 50000);

  test('a deictic inventory product is reread and pinned without inheriting an unrelated page or product', async () => {
    const row = await product(), other = await product();
    const pageData = { route: '/admin/inventory', productId: row.id };
    const prompt = 'Add 2 lb of this product to the restock list';
    const wrong = await propose('create_restock_request', { product_id: other.id, quantity: 2 }, prompt, { pageData });
    expect(wrong.body.pendingActions || []).toHaveLength(0);
    const unrelated = await propose('create_restock_request', { product_id: row.id, quantity: 2 }, prompt,
      { pageData: { route: '/admin/estimates', productId: row.id } });
    expect(unrelated.body.pendingActions || []).toHaveLength(0);
    const saved = await confirm(await propose('create_restock_request', { product_id: row.id, quantity: 2 }, prompt, { pageData }));
    expect(saved.body).toMatchObject({ success: true, result: { request: { product_id: row.id } } });
    expect(await db('product_restock_requests').where({ product_id: other.id })).toHaveLength(0);
  }, 50000);

  test('an explicit or viewed restock request cannot be substituted with another request for the same product', async () => {
    const row = await product();
    const one = await requestFor(row), two = await requestFor(row);
    const wrong = await propose('update_restock_request', { request_id: two.id, action: 'cancel' }, `Cancel restock request ${one.id}`);
    expect(wrong.body.pendingActions || []).toHaveLength(0);
    const note = await propose('update_restock_request', { request_id: two.id, action: 'cancel' },
      `Record a note for this customer with restock request ${two.id}`);
    expect(note.body.pendingActions || []).toHaveLength(0);
    const pageData = { route: '/admin/inventory', search: `?tab=restock&requestId=${one.id}` };
    const viewedWrong = await propose('update_restock_request', { request_id: two.id, action: 'cancel' }, 'Cancel this restock request', { pageData });
    expect(viewedWrong.body.pendingActions || []).toHaveLength(0);
    const saved = await confirm(await propose('update_restock_request', { request_id: one.id, action: 'cancel' }, 'Cancel this restock request', { pageData }));
    expect(saved.body).toMatchObject({ success: true, result: { request_id: one.id, status: 'cancelled' } });
    expect((await db('product_restock_requests').where({ id: two.id }).first()).status).toBe('open');
    expect(await onHand(row.id)).toBe(10);
  }, 50000);

  test('supplied approval fields never authorize an executor and duplicate product names require selection', async () => {
    const row = await product();
    await product({ name: row.name, sku: 'QA-OTHER-SKU' });
    const tools = require('../services/intelligence-bar/procurement-tools');
    const ambiguous = await tools.executeProcurementTool('create_restock_request', { product_name: row.name, quantity: 2 });
    expect(ambiguous.candidates).toHaveLength(2);
    expect(ambiguous.candidates.map(c => c.sku)).toEqual(expect.arrayContaining([row.sku, 'QA-OTHER-SKU']));
    const forged = await tools.executeProcurementTool('adjust_stock', {
      product_id: row.id, movement_type: 'restock', quantity: 3, confirmed: true, _verified_inventory_version: 'forged',
    });
    expect(forged.preview).toBe(true); expect(await onHand(row.id)).toBe(10);
    expect(await db('product_inventory_movements').where({ product_id: row.id })).toHaveLength(0);
    const registry = require('../services/intelligence-bar/action-registry');
    expect(registry.validateInput('adjust_stock', { product_id: row.id, movement_type: 'restock', quantity: 3, _verified_inventory_version: 'forged' },
      { role: 'admin', context: 'inventory' })).toMatchObject({ code: 'invalid_input' });
    const denied = registry.validateInput('create_restock_request', { product_id: row.id, quantity: 2 }, { role: 'technician', context: 'tech' });
    expect(denied.code).toBe('permission_denied');
  }, 30000);
});
