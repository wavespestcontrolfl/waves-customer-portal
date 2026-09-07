/** Synthetic Postgres acceptance: scripted model -> real auth/route/domain ->
 * persisted property/audit/receipt. Never uses production or live providers. */
const crypto = require('crypto');
const mockModel = jest.fn();
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({ messages: { create: mockModel } })));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const databaseUrl = process.env.IB_TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
suite('property UI and Intelligence Bar against isolated Postgres', () => {
  let db, server, origin, token, actor, customerA, customerB, nameA;
  const sessionId = crypto.randomUUID();
  const originalEnv = { ...process.env };
  const call = (name, input, id) => ({ content: [{ type: 'tool_use', name, input, id }], usage: {} });
  async function api(path, body, method = body ? 'POST' : 'GET') {
    const response = await fetch(`${origin}${path}`, { method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  }
  async function propose(name, input, prompt) {
    mockModel.mockReset();
    mockModel.mockResolvedValueOnce(call('discover_capabilities', { query: name.replaceAll('_', ' ') }, 'discover'))
      .mockResolvedValueOnce(call(name, input, 'property'))
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'The property change is ready for confirmation.' }], usage: {} });
    return api('/api/admin/intelligence-bar/query', { prompt: `${prompt} for ${nameA}`, context: 'estimates', session_id: sessionId,
      request_key: crypto.randomUUID(), pageData: { route: '/admin/estimates', customerId: customerB } });
  }
  async function confirm(proposed) {
    expect(proposed.body.pendingActions).toHaveLength(1);
    const card = proposed.body.pendingActions[0];
    return api('/api/admin/intelligence-bar/confirm-action', { pending_action_id: card.id, contract_hash: card.contract_hash });
  }
  const address = (number, label = null) => ({ address_line1: `${number} Example Grove`, address_line2: null,
    city: 'Sarasota', state: 'FL', zip: '34201', occupancy_type: 'unknown', label });
  beforeAll(async () => {
    const parsed = new URL(databaseUrl);
    const ciDatabase = process.env.CI === 'true' && parsed.hostname === 'localhost' && parsed.pathname === '/waves_test';
    if (!ciDatabase && !/^\/waves_ib_platform_[a-z0-9_]+$/.test(parsed.pathname)) throw new Error('An isolated IB development database is required');
    Object.assign(process.env, { DATABASE_URL: databaseUrl, NODE_ENV: 'test', JWT_SECRET: crypto.randomBytes(32).toString('hex'),
      ANTHROPIC_API_KEY: 'scripted-model-only', GATE_IB_PLATFORM: 'true', GATE_IB_THREADS: 'false', GATE_IB_WRITES_DISABLED: 'false' });
    db = require('../models/db');
    if (!await db.schema.hasColumn('invoices', 'customer_address_snapshot')) throw new Error('Apply the invoice address migration to the isolated database first');
    actor = crypto.randomUUID(); customerA = crypto.randomUUID(); customerB = crypto.randomUUID();
    nameA = `Fixture Alder${customerA.slice(0, 8)}`;
    await db('technicians').insert({ id: actor, name: 'Synthetic property operator', role: 'admin', active: true, auth_token_version: 1 });
    await db('customers').insert([
      { id: customerA, first_name: 'Fixture', last_name: `Alder${customerA.slice(0, 8)}`, ...address(100) },
      { id: customerB, first_name: 'Fixture', last_name: `Birch${customerB.slice(0, 8)}`, ...address(200) },
    ].map(({ label, occupancy_type, ...customer }) => ({ ...customer, phone: `+15550${Math.floor(Math.random() * 1000000).toString().padStart(6, '0')}` })));
    await require('../services/customer-properties').ensurePrimaryProperty(customerA);
    await require('../services/customer-properties').ensurePrimaryProperty(customerB);
    token = require('jsonwebtoken').sign({ type: 'access', tokenVersion: 1, technicianId: actor }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const express = require('express'); const app = express(); app.use(express.json());
    app.use('/api/admin/intelligence-bar', require('../routes/admin-intelligence-bar'));
    app.use('/api/admin/customers', require('../routes/admin-customers'));
    app.use('/api/receipt', require('../routes/receipt-v2'));
    app.use((err, req, res, next) => res.status(err.statusCode || err.status || 500).json({ error: err.message, code: err.code }));
    server = await new Promise(resolve => { const running = app.listen(0, '127.0.0.1', () => resolve(running)); });
    origin = `http://127.0.0.1:${server.address().port}`;
  }, 30000);
  afterAll(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    if (db) await db.destroy();
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
  });

  test('two properties, relabel, primary change preserve billing and service locations; B is untouched', async () => {
    const beforeB = await db('customers').where({ id: customerB }).first();
    const beforeBProperties = await db('customer_properties').where({ customer_id: customerB });
    const oldPrimary = await db('customer_properties').where({ customer_id: customerA, is_primary: true }).first();
    const visits = [crypto.randomUUID(), crypto.randomUUID()];
    const historyId = crypto.randomUUID(), invoiceId = crypto.randomUUID(), invoiceToken = crypto.randomBytes(32).toString('hex');
    const date = require('../utils/datetime-et').etDateString(new Date());
    await db('scheduled_services').insert([
      { id: visits[0], customer_id: customerA, scheduled_date: date, service_type: 'General Pest Control', status: 'pending' },
      { id: visits[1], customer_id: customerA, scheduled_date: date, service_type: 'General Pest Control', status: 'completed', is_recurring: true, recurring_ongoing: true },
    ]);
    await db('service_records').insert({ id: historyId, customer_id: customerA, service_date: date, service_type: 'General Pest Control' });
    await db('invoices').insert({ id: invoiceId, customer_id: customerA, token: invoiceToken,
      invoice_number: `QA-${invoiceId.slice(0, 8)}`, status: 'paid', total: 89, subtotal: 89, paid_at: new Date(), line_items: JSON.stringify([]) });
    const historyBefore = await db('service_records').where({ id: historyId }).first();
    const invoiceBefore = await db('invoices').where({ id: invoiceId }).first();
    const first = await propose('add_customer_property', { customer_id: customerA, ...address(300, 'Family') }, 'Add a saved property at 300 Example Grove, Sarasota FL 34201');
    expect(first.body.taskTarget.customer_id).toBe(customerA);
    expect((await db('customer_properties').where({ customer_id: customerA })).length).toBe(1);
    const added = await confirm(first);
    expect(added.body).toMatchObject({ success: true, outcome: 'completed', result: { verification: { persisted: true } } });
    const propertyId = added.body.result.propertyId;
    const second = await confirm(await propose('add_customer_property', { customer_id: customerA, ...address(400, 'Rental') }, 'Add a saved property at 400 Example Grove, Sarasota FL 34201'));
    expect(second.body.success).toBe(true);
    expect((await db('customer_properties').where({ customer_id: customerA })).length).toBe(3);
    const relabeled = await confirm(await propose('update_customer_property', { customer_id: customerA, property_id: oldPrimary.id, label: 'Former residence' }, 'Relabel the current primary Former residence'));
    expect(relabeled.body.success).toBe(true);
    const primary = await propose('set_primary_property', { customer_id: customerA, property_id: propertyId }, 'Make the saved 300 Example Grove property primary');
    const changed = await confirm(primary);
    expect(changed.body).toMatchObject({ success: true, outcome: 'completed' });
    expect(await db('customers').where({ id: customerA }).first('address_line1')).toEqual({ address_line1: '300 Example Grove' });
    expect(await db('customer_properties').where({ id: oldPrimary.id }).first('label', 'is_primary')).toEqual({ label: 'Former residence', is_primary: false });
    for (const id of visits) expect(await db('scheduled_services').where({ id }).first('property_id', 'service_address_line1'))
      .toEqual({ property_id: oldPrimary.id, service_address_line1: '100 Example Grove' });
    expect(await db('service_records').where({ id: historyId }).first()).toEqual(historyBefore);
    const invoiceAfter = await db('invoices').where({ id: invoiceId }).first();
    expect(invoiceAfter).toEqual({ ...invoiceBefore, customer_address_snapshot: expect.objectContaining({ address_line1: '100 Example Grove' }) });
    const Invoice = require('../services/invoice');
    expect((await Invoice.getById(invoiceId)).customer.address_line1).toBe('100 Example Grove');
    expect((await Invoice.getByToken(invoiceToken)).customer.address_line1).toBe('100 Example Grove');
    const receipt = await api(`/api/receipt/${invoiceToken}`);
    expect(receipt.status).toBe(200);
    expect(JSON.stringify(receipt.body)).toContain('100 Example Grove');
    expect(JSON.stringify(receipt.body)).not.toContain('300 Example Grove');
    expect(await db('customers').where({ id: customerB }).first()).toEqual(beforeB);
    expect(await db('customer_properties').where({ customer_id: customerB })).toEqual(beforeBProperties);
    const replay = await confirm(primary);
    expect(replay.status).toBe(409);
    expect(await db('audit_log').where({ action: 'customer_property_primary', resource_id: propertyId }).count('* as count').first()).toEqual({ count: '1' });
  }, 60000);

  test('primary change refuses invoice-lock contention without waiting on a billing customer lock', async () => {
    const service = require('../services/customer-properties');
    const invoiceId = crypto.randomUUID();
    await db('invoices').insert({ id: invoiceId, customer_id: customerB, token: crypto.randomBytes(32).toString('hex'), invoice_number: `QA-${invoiceId.slice(0, 8)}` });
    const saved = await service.addManualProperty(customerB, address(600), { actorId: actor });
    const preview = await service.previewManualPropertyChange(customerB, 'primary', {}, saved.propertyId);
    const billing = await db.transaction();
    try {
      await billing('invoices').where('id', invoiceId).forUpdate().first();
      // Independent connection: this used to hold customers while blocking on
      // the locked invoice. NOWAIT must refuse before billing needs customers.
      await expect(service.changePrimaryProperty(customerB, saved.propertyId, { actorId: actor, expectedVersion: preview._version }))
        .rejects.toMatchObject({ code: 'property_busy' });
      await billing.raw("SET LOCAL lock_timeout = '2s'");
      await billing('customers').where('id', customerB).forUpdate().first();
      expect((await billing('customers').where('id', customerB).first()).address_line1).toBe('200 Example Grove');
    } finally { await billing.rollback(); }
    const changed = await service.changePrimaryProperty(customerB, saved.propertyId, { actorId: actor, expectedVersion: preview._version });
    expect(changed.verification.persisted).toBe(true);
  }, 30000);

  test('unregistered old account address is preserved; an addressless account gets an accurately verified first property', async () => {
    const service = require('../services/customer-properties');
    const customerId = crypto.randomUUID(), emptyCustomer = crypto.randomUUID(), propertyId = crypto.randomUUID(), visitId = crypto.randomUUID();
    await db('customers').insert([
      { id: customerId, first_name: 'Synthetic', last_name: 'Unregistered', phone: `+15551${Math.floor(Math.random() * 1000000).toString().padStart(6, '0')}`, address_line1: '700 Example Grove', city: 'Sarasota', state: 'FL', zip: '34201' },
      { id: emptyCustomer, first_name: 'Synthetic', last_name: 'Firstproperty', phone: `+15552${Math.floor(Math.random() * 1000000).toString().padStart(6, '0')}` },
    ]);
    await db('customer_properties').insert({ id: propertyId, customer_id: customerId, ...address(800), active: true, is_primary: false, address_key: service.addressKey(address(800)) });
    await db('scheduled_services').insert({ id: visitId, customer_id: customerId,
      scheduled_date: require('../utils/datetime-et').etDateString(new Date()), service_type: 'General Pest Control', status: 'pending' });
    const preview = await service.previewManualPropertyChange(customerId, 'primary', {}, propertyId);
    expect(preview.previous_primary).toMatchObject({ id: null, address: '700 Example Grove, Sarasota, FL, 34201' });
    expect(await db('customer_properties').where({ customer_id: customerId }).count('* as count').first()).toEqual({ count: '1' });
    await service.changePrimaryProperty(customerId, propertyId, { actorId: actor, expectedVersion: preview._version });
    const visit = await db('scheduled_services').where({ id: visitId }).first();
    expect(visit.service_address_line1).toBe('700 Example Grove');
    expect(visit.property_id).not.toBe(propertyId);
    const firstPreview = await service.previewManualPropertyChange(emptyCustomer, 'add', address(900));
    expect(firstPreview.changes.label).toBe('Primary');
    const first = await service.addManualProperty(emptyCustomer, address(900), { actorId: actor, expectedVersion: firstPreview._version });
    expect(first.verification).toMatchObject({ persisted: true, fields_match: true });
    expect(await db('customers').where({ id: emptyCustomer }).first('address_line1')).toEqual({ address_line1: '900 Example Grove' });
  }, 30000);

  test('portal and bar add/edit produce equivalent domain outcomes and audit; foreign property and stale approval refuse', async () => {
    const ui = await api(`/api/admin/customers/${customerB}/properties`, address(500, 'Family'));
    expect(ui.status).toBe(201);
    const ib = await confirm(await propose('add_customer_property', { customer_id: customerA, ...address(500, 'Family') }, 'Add 500 Example Grove, Sarasota FL 34201 as a saved property'));
    expect(ib.body.success).toBe(true);
    const fields = ['address_line1', 'city', 'state', 'zip', 'occupancy_type', 'label', 'is_primary', 'source'];
    expect(await db('customer_properties').where('id', ui.body.propertyId).first(fields))
      .toEqual(await db('customer_properties').where('id', ib.body.result.propertyId).first(fields));
    const uiEdit = await api(`/api/admin/customers/${customerB}/properties/${ui.body.propertyId}`, { label: 'Family home' }, 'PATCH');
    expect(uiEdit.status).toBe(200);
    const ibEdit = await confirm(await propose('update_customer_property', { customer_id: customerA, property_id: ib.body.result.propertyId, label: 'Family home' }, 'Relabel the saved 500 Example Grove property Family home'));
    expect(ibEdit.body.success).toBe(true);
    const audits = await db('audit_log').whereIn('resource_id', [ui.body.propertyId, ib.body.result.propertyId]).orderBy('action').select('actor_id', 'action', 'resource_id');
    expect(audits).toHaveLength(4);
    expect(new Set(audits.map(a => a.actor_id))).toEqual(new Set([actor]));
    const foreign = await propose('update_customer_property', { customer_id: customerA, property_id: ui.body.propertyId, label: 'Wrong target' }, 'Relabel the saved property');
    expect(foreign.body.pendingActions).toHaveLength(0);
    const stale = await propose('update_customer_property', { customer_id: customerA, property_id: ib.body.result.propertyId, label: 'Old instruction' }, 'Relabel the saved 500 Example Grove property Old instruction');
    await db('customer_properties').where('id', ib.body.result.propertyId).update({ label: 'New operator edit', updated_at: db.fn.now() });
    expect((await confirm(stale)).body.preview_changed).toBe(true);
    expect((await db('customer_properties').where('id', ib.body.result.propertyId).first()).label).toBe('New operator edit');
    const missingPreview = await api(`/api/admin/customers/${customerB}/properties/${ui.body.propertyId}/primary`, {});
    expect(missingPreview.status).toBe(409);
    const duplicate = await api(`/api/admin/customers/${customerB}/properties`, address(500));
    expect(duplicate.status).toBe(409);
  }, 60000);
});
