/** Synthetic NL -> existing dispatcher/auth -> shared estimate persistence ->
 * real isolated Postgres. Model scripted; no customer/provider sends. */
const crypto = require('crypto');
const mockModel = jest.fn();
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({ messages: { create: mockModel } })));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const databaseUrl = process.env.IB_TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
suite('existing-customer estimates from another workspace', () => {
  let db, server, origin, actor, token, viewedCustomer;
  const originalEnv = { ...process.env }, sessionId = crypto.randomUUID();
  async function api(path, body, method = body ? 'POST' : 'GET') {
    const response = await fetch(`${origin}${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  }
  async function customerFixture(overrides = {}) {
    const id = crypto.randomUUID(), propertyId = crypto.randomUUID();
    const customer = { id, first_name: `EstimateQA${id.replaceAll('-', '').slice(0, 8)}`, last_name: 'Fixture',
      phone: `+15550${Math.floor(Math.random() * 1000000).toString().padStart(6, '0')}`, email: `${id}@example.invalid`,
      address_line1: '100 Example Grove', city: 'Bradenton', state: 'FL', zip: '34208', pipeline_stage: 'active_customer',
      property_sqft: 5000, lot_sqft: 10000, lawn_type: 'St. Augustine' };
    await db('customers').insert(customer);
    const property = { id: propertyId, customer_id: id, active: true, is_primary: true,
      occupancy_type: 'owner_occupied', address_line1: customer.address_line1, city: customer.city, state: customer.state, zip: customer.zip,
      property_sqft: 5000, lot_sqft: 10000, lawn_type: 'St. Augustine', ...overrides };
    await db('customer_properties').insert(property);
    return { customer, property };
  }
  const tool = (name, input, id) => ({ content: [{ type: 'tool_use', name, input, id }], usage: {} });
  async function propose(fixture, extras = {}, requestedEstimate = extras.estimate_id, prompt = null) {
    const input = { customer_id: fixture.customer.id, property_id: fixture.property.id, ...extras };
    mockModel.mockReset();
    mockModel.mockResolvedValueOnce(tool('discover_capabilities', { query: 'customer estimate' }, 'discover'))
      .mockResolvedValueOnce(tool('get_customer_estimate_context', { customer_id: input.customer_id, property_id: input.property_id }, 'lookup'))
      .mockResolvedValueOnce(tool('save_customer_estimate', input, 'save'))
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'Review the estimate price before saving.' }], usage: {} });
    return api('/api/admin/intelligence-bar/query', { prompt: prompt || `${requestedEstimate ? `Revise estimate ${requestedEstimate}` : 'Create a lawn estimate'} for ${fixture.customer.first_name} ${fixture.customer.last_name} using the saved property measurements${extras.lawn_applications ? ` at ${extras.lawn_applications} applications per year` : ''}`,
      context: 'procurement', session_id: sessionId, request_key: crypto.randomUUID(), pageData: { route: '/admin/inventory', customerId: viewedCustomer } });
  }
  async function confirm(proposed) {
    expect(proposed.body.pendingActions).toHaveLength(1);
    const pending = proposed.body.pendingActions[0];
    return api('/api/admin/intelligence-bar/confirm-action', { pending_action_id: pending.id, contract_hash: pending.contract_hash });
  }
  beforeAll(async () => {
    const parsed = new URL(databaseUrl);
    const ciDatabase = process.env.CI === 'true' && parsed.hostname === 'localhost' && parsed.pathname === '/waves_test';
    if (!ciDatabase && !/^\/waves_ib_platform_[a-z0-9_]+$/.test(parsed.pathname)) throw Error('Isolated IB development database required');
    Object.assign(process.env, { DATABASE_URL: databaseUrl, NODE_ENV: 'test', JWT_SECRET: crypto.randomBytes(32).toString('hex'),
      ANTHROPIC_API_KEY: 'scripted-only', GATE_IB_PLATFORM: 'true', GATE_IB_THREADS: 'false', IB_WRITES_DISABLED: 'false' });
    db = require('../models/db'); actor = crypto.randomUUID();
    // Canonical code defaults seed this isolated DB; no production reads.
    const { PEST, LAWN_PRICING_V2, LAWN_BRACKETS } = require('../services/pricing-engine/constants');
    await db('pricing_config').insert([
      { config_key: 'pest_base', name: 'Synthetic pricing baseline', category: 'pest', data: JSON.stringify(PEST) },
      { config_key: 'lawn_pricing_v2', name: 'Synthetic lawn baseline', category: 'lawn', data: JSON.stringify(LAWN_PRICING_V2) },
    ]).onConflict('config_key').ignore();
    if (!(await db('lawn_pricing_brackets').first())) {
      const tiers = ['standard', 'enhanced', 'premium'];
      await db('lawn_pricing_brackets').insert(Object.entries(LAWN_BRACKETS).flatMap(([grass_track, brackets]) =>
        brackets.flatMap(row => tiers.map((tier, index) => ({ grass_track, sqft_bracket: row[0], tier, monthly_price: row[index + 1] })) )));
    }
    await db('technicians').insert({ id: actor, name: 'Synthetic estimate operator', active: true, role: 'admin', auth_token_version: 1 });
    viewedCustomer = (await customerFixture()).customer.id;
    token = require('jsonwebtoken').sign({ type: 'access', tokenVersion: 1, technicianId: actor }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const express = require('express'), app = express(); app.use(express.json());
    app.use('/api/admin/intelligence-bar', require('../routes/admin-intelligence-bar'));
    app.use('/api/admin/estimates', require('../routes/admin-estimates'));
    app.use((err, req, res, next) => res.status(err.statusCode || 500).json({ error: err.message, code: err.code }));
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
  afterEach(() => jest.restoreAllMocks());

  test('loads saved facts, prices and saves a draft for A from Inventory without a lead or changing B', async () => {
    const fixture = await customerFixture();
    const beforeB = await db('customers').where({ id: viewedCustomer }).first();
    const leadCount = await db('leads').count('* as count').first();
    const proposed = await propose(fixture);
    expect(proposed.body.pendingActions).toHaveLength(1);
    expect(await db('estimates').where({ customer_id: fixture.customer.id })).toHaveLength(0);
    const response = await confirm(proposed);
    expect(response.body).toMatchObject({ success: true, outcome: 'completed', result: {
      customer_id: fixture.customer.id, property_id: fixture.property.id, status: 'draft', verification: { persisted: true } } });
    const saved = await db('estimates').where({ id: response.body.result.estimate_id }).first();
    expect(saved.id).toBe(proposed.body.pendingActions[0].id);
    expect(saved).toMatchObject({ customer_id: fixture.customer.id, property_id: fixture.property.id,
      created_by_technician_id: actor, status: 'draft', pricing_authority: 'SERVER', sent_at: null });
    expect(saved.estimate_data.engineInputs).toMatchObject({ measuredTurfSf: 5000, services: { lawn: { track: 'st_augustine', lawnFreq: 9 } } });
    expect(saved.estimate_data.engineInputs.homeSqFt).toBeUndefined();
    expect(saved.estimate_data.engineResult.lineItems[0].frequency).toBe(9);
    expect(Number(saved.annual_total)).toBe(saved.estimate_data.engineResult.summary.recurringAnnualAfterDiscount);
    expect(await db('leads').count('* as count').first()).toEqual(leadCount);
    expect(await db('customers').where({ id: viewedCustomer }).first()).toEqual(beforeB);
    expect((await confirm(proposed)).status).toBe(409);
    expect(await db('estimates').where({ customer_id: fixture.customer.id })).toHaveLength(1);
    const receipt = await api(`/api/admin/intelligence-bar/actions/${proposed.body.pendingActions[0].id}`);
    expect(receipt.body.result.estimate_id).toBe(saved.id);
    const edit = await api(`/api/admin/estimates/${saved.id}/edit-source`);
    expect(edit.body).toMatchObject({ customerId: fixture.customer.id, propertyId: fixture.property.id,
      inputs: { svcLawn: true, measuredTurfSf: '5000', lawnFreq: '9' } });
  }, 60000);

  test('a secondary property never inherits primary lawn measurements and uses its own saved facts when complete', async () => {
    const fixture = await customerFixture();
    const id = crypto.randomUUID();
    await db('customer_properties').insert({ id, customer_id: fixture.customer.id, active: true, is_primary: false,
      address_line1: '200 Example Grove', city: 'Bradenton', state: 'FL', zip: '34208' });
    fixture.property.id = id;
    const missing = await propose(fixture);
    expect(missing.body.pendingActions || []).toHaveLength(0);
    expect(await db('estimates').where({ customer_id: fixture.customer.id })).toHaveLength(0);
    await db('customer_properties').where({ id }).update({ property_sqft: 3000, lawn_type: 'Zoysia' });
    const saved = await confirm(await propose(fixture));
    expect(saved.body.success).toBe(true);
    const row = await db('estimates').where({ id: saved.body.result.estimate_id }).first();
    expect(row.estimate_data.engineInputs).toMatchObject({ measuredTurfSf: 3000, services: { lawn: { track: 'zoysia' } } });
    expect(row.estimate_data.engineInputs.lotSqFt).toBeUndefined();
  }, 60000);

  test('tampered property and estimate parents cannot substitute the viewed or another customer', async () => {
    const a = await customerFixture(), b = await customerFixture();
    const wrongProperty = await propose(a, { property_id: b.property.id });
    expect(wrongProperty.body.pendingActions || []).toHaveLength(0);
    const bSaved = await confirm(await propose(b));
    const wrongEstimate = await propose(a, { estimate_id: bSaved.body.result.estimate_id });
    expect(wrongEstimate.body.pendingActions || []).toHaveLength(0);
    expect(await db('estimates').where({ customer_id: a.customer.id })).toHaveLength(0);
    expect(await db('estimates').where({ customer_id: b.customer.id })).toHaveLength(1);
  }, 60000);

  test('saved property changes invalidate approval before any estimate write', async () => {
    const fixture = await customerFixture(), proposal = await propose(fixture);
    await db('customers').where({ id: fixture.customer.id }).update({ property_sqft: 7000 });
    await db('customer_properties').where({ id: fixture.property.id }).update({ property_sqft: 7000 });
    const response = await confirm(proposal);
    expect(response.status).toBe(409);
    expect(await db('estimates').where({ customer_id: fixture.customer.id })).toHaveLength(0);
  }, 60000);

  test('the model cannot substitute another estimate on the same customer and property', async () => {
    const fixture = await customerFixture();
    const first = await confirm(await propose(fixture));
    const second = await confirm(await propose(fixture, { lawn_applications: 6 }));
    const ids = [first.body.result.estimate_id, second.body.result.estimate_id];
    const before = await db('estimates').whereIn('id', ids).orderBy('id');
    const wrong = await propose(fixture, { estimate_id: ids[1], lawn_applications: 12 }, ids[0]);
    expect(wrong.body.pendingActions || []).toHaveLength(0);
    expect(JSON.stringify(mockModel.mock.calls)).toContain('target_clarification_required');
    const bodySubstitution = await propose(fixture, { estimate_id: ids[1], lawn_applications: 12 }, ids[0],
      `Revise estimate ${ids[0]} for ${fixture.customer.first_name} ${fixture.customer.last_name} and add a note containing estimate ${ids[1]}`);
    expect(bodySubstitution.body.pendingActions || []).toHaveLength(0);
    expect(JSON.stringify(mockModel.mock.calls)).toContain('target_clarification_required');
    expect(await db('estimates').whereIn('id', ids).orderBy('id')).toEqual(before);
  }, 90000);

  test('revision preserves a six-application program unless the request changes cadence', async () => {
    const fixture = await customerFixture();
    const created = await confirm(await propose(fixture, { lawn_applications: 6 }));
    const estimateId = created.body.result.estimate_id;
    const before = await db('estimates').where({ id: estimateId }).first();
    const revised = await confirm(await propose(fixture, { estimate_id: estimateId }));
    expect(revised.body).toMatchObject({ success: true, result: { estimate_id: estimateId } });
    const saved = await db('estimates').where({ id: estimateId }).first();
    expect(saved.estimate_data.engineResult.lineItems[0].frequency).toBe(6);
    expect(saved.estimate_data.engineInputs.services.lawn.lawnFreq).toBe(6);
    expect(saved.estimate_data.inputs.lawnFreq).toBe('6');
    expect(saved.token).toBe(before.token);
    expect(saved.sent_at).toBeNull();
    expect(await db('estimates').where({ customer_id: fixture.customer.id })).toHaveLength(1);
  }, 60000);

  test('revision keeps an existing editor percentage discount while changing cadence', async () => {
    const fixture = await customerFixture();
    const created = await confirm(await propose(fixture));
    const estimateId = created.body.result.estimate_id;
    const before = await db('estimates').where({ id: estimateId }).first();
    const data = structuredClone(before.estimate_data);
    data.engineInputs.manualDiscount = { type: 'PERCENT', value: 10, label: 'Synthetic approved discount', eligibilityConfirmed: true };
    const native = await api(`/api/admin/estimates/${estimateId}`, {
      expectedEditVersion: require('../services/admin-estimate-persistence').estimateEditVersion(before),
      customerId: fixture.customer.id, propertyId: fixture.property.id, address: before.address,
      customerName: before.customer_name, customerPhone: before.customer_phone, customerEmail: before.customer_email,
      estimateData: data,
    }, 'PUT');
    expect(native.status).toBe(200);
    const revised = await confirm(await propose(fixture, { estimate_id: estimateId, lawn_applications: 12 }));
    expect(revised.body).toMatchObject({ success: true, result: { estimate_id: estimateId } });
    const saved = await db('estimates').where({ id: estimateId }).first();
    expect(saved.estimate_data.engineInputs.manualDiscount).toMatchObject({ type: 'PERCENT', value: 10 });
    expect(saved.estimate_data.engineResult.lineItems[0].frequency).toBe(12);
    expect(saved.estimate_data.engineResult.summary.manualDiscount).toMatchObject({ type: 'PERCENT', value: 10 });
    expect(saved.token).toBe(before.token);
  }, 60000);

  test('revision refuses a stored fixed discount whose allocation cannot be reconstructed', async () => {
    const fixture = await customerFixture();
    const created = await confirm(await propose(fixture));
    const estimateId = created.body.result.estimate_id;
    const before = await db('estimates').where({ id: estimateId }).first();
    const data = structuredClone(before.estimate_data);
    data.summary = { ...data.summary, manualDiscount: { type: 'FIXED', value: 50, label: 'Synthetic stored discount' } };
    await db('estimates').where({ id: estimateId }).update({ estimate_data: JSON.stringify(data) });
    const stamped = await db('estimates').where({ id: estimateId }).first();
    const proposed = await propose(fixture, { estimate_id: estimateId, lawn_applications: 12 });
    expect(proposed.body.pendingActions || []).toHaveLength(0);
    const result = mockModel.mock.calls.at(-1)[0].messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
      .find(block => block.type === 'tool_result' && block.tool_use_id === 'save');
    expect(JSON.parse(result.content)).toMatchObject({ code: 'discount_review_required' });
    expect(await db('estimates').where({ id: estimateId }).first()).toEqual(stamped);
  }, 60000);

  test('membership service changes invalidate approval and a fresh quote uses the current tier', async () => {
    const fixture = await customerFixture();
    await db('customers').where({ id: fixture.customer.id }).update({ waveguard_tier: 'Bronze' });
    const date = require('../utils/datetime-et').etDateString(new Date(Date.now() + 10 * 86400000));
    const addService = service_type => db('scheduled_services').insert({ id: crypto.randomUUID(), customer_id: fixture.customer.id,
      property_id: fixture.property.id, scheduled_date: date, service_type, status: 'pending', is_recurring: true, recurring_ongoing: true });
    await addService('General Pest Control');
    const proposed = await propose(fixture);
    await addService('Mosquito Control');
    expect((await confirm(proposed)).status).toBe(409);
    expect(await db('estimates').where({ customer_id: fixture.customer.id })).toHaveLength(0);
    const savedResponse = await confirm(await propose(fixture));
    expect(savedResponse.body.success).toBe(true);
    const saved = await db('estimates').where({ id: savedResponse.body.result.estimate_id }).first();
    expect(saved.estimate_data.priorQualifyingServices).toEqual(expect.arrayContaining(['pest_control', 'mosquito']));
    expect(saved.waveguard_tier).toBe('Gold');
  }, 60000);

  test('an explicitly measured zero-area primary lawn never falls back to a stale positive mirror', async () => {
    const fixture = await customerFixture();
    await db('customer_turf_profiles').insert({ id: crypto.randomUUID(), customer_id: fixture.customer.id,
      active: true, grass_type: 'st_augustine', track_key: 'st_augustine', lawn_sqft: 0 });
    const proposed = await propose(fixture);
    expect(proposed.body.pendingActions || []).toHaveLength(0);
    const result = mockModel.mock.calls.at(-1)[0].messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
      .find(block => block.type === 'tool_result' && block.tool_use_id === 'lookup');
    expect(JSON.parse(result.content).property.treatable_lawn_sqft).toBe(0);
    expect(await db('estimates').where({ customer_id: fixture.customer.id })).toHaveLength(0);
  }, 60000);

  test('grouped address revision waits for the editor address lock before taking its send lock', async () => {
    const fixture = await customerFixture();
    const created = await confirm(await propose(fixture));
    const estimateId = created.body.result.estimate_id, groupId = crypto.randomUUID();
    const before = await db('estimates').where({ id: estimateId }).first();
    await db('estimates').where({ id: estimateId }).update({ estimate_group_id: groupId, address: `${before.address} ` });
    const proposed = await propose(fixture, { estimate_id: estimateId, lawn_applications: 12 });
    expect(proposed.body.pendingActions).toHaveLength(1);
    const persistence = require('../services/admin-estimate-persistence');
    const original = persistence.lockEstimateGroupAddressRevision;
    let attempted, confirming;
    const atAddressLock = new Promise(resolve => { attempted = resolve; });
    jest.spyOn(persistence, 'lockEstimateGroupAddressRevision').mockImplementation((...args) => {
      attempted();
      return original(...args);
    });
    try {
      await db.transaction(async editor => {
        await original(editor, groupId);
        confirming = confirm(proposed);
        await atAddressLock;
        const acquired = await editor.raw('SELECT pg_try_advisory_xact_lock(hashtext(?), hashtext(?::text)) AS available',
          ['estimate-group-send', groupId]);
        expect(acquired.rows[0].available).toBe(true);
      });
    } finally {
      if (confirming) expect((await confirming).body.success).toBe(true);
    }
    const saved = await db('estimates').where({ id: estimateId }).first();
    expect(saved.estimate_group_id).toBe(groupId);
    expect(saved.estimate_data.engineResult.lineItems[0].frequency).toBe(12);
    expect(saved.address).toBe(before.address);
  }, 60000);

  test('a downward membership revision persists the newly priced tier instead of retaining Gold', async () => {
    const fixture = await customerFixture();
    await db('customers').where({ id: fixture.customer.id }).update({ waveguard_tier: 'Gold' });
    const date = require('../utils/datetime-et').etDateString(new Date(Date.now() + 10 * 86400000));
    await db('scheduled_services').insert(['General Pest Control', 'Mosquito Control'].map(service_type => ({ id: crypto.randomUUID(),
      customer_id: fixture.customer.id, property_id: fixture.property.id, scheduled_date: date, service_type,
      status: 'pending', is_recurring: true, recurring_ongoing: true })));
    const created = await confirm(await propose(fixture));
    const estimateId = created.body.result.estimate_id;
    expect((await db('estimates').where({ id: estimateId }).first()).waveguard_tier).toBe('Gold');
    await db('scheduled_services').where({ customer_id: fixture.customer.id }).update({ status: 'cancelled' });
    const revised = await confirm(await propose(fixture, { estimate_id: estimateId }));
    expect(revised.body.success).toBe(true);
    const saved = await db('estimates').where({ id: estimateId }).first();
    expect(saved.estimate_data.engineResult.waveGuard.tier).toBe('bronze');
    expect(saved.estimate_data.result.recurring.tier).toBe('Bronze');
    expect(saved.waveguard_tier).toBe('Bronze');
  }, 60000);

  test('warm cached pricing cannot authorize a draft when live DB configuration rejects sync', async () => {
    const fixture = await customerFixture();
    const engine = require('../services/pricing-engine');
    expect(await engine.syncConstantsFromDB(db)).toBe(true);
    const config = await db('pricing_config').where({ config_key: 'pest_base' }).first();
    try {
      await db('pricing_config').where({ config_key: config.config_key }).update({ data: JSON.stringify({ ...config.data, base: -1 }) });
      const proposed = await propose(fixture);
      expect(proposed.body.pendingActions || []).toHaveLength(0);
      expect(await db('estimates').where({ customer_id: fixture.customer.id })).toHaveLength(0);
    } finally {
      await db('pricing_config').where({ config_key: config.config_key }).update({ data: JSON.stringify(config.data) });
      await engine.syncConstantsFromDB(db);
    }
  }, 60000);

  test('live pricing failure after confirmation preflight rolls back the final persistence', async () => {
    const fixture = await customerFixture(), proposal = await propose(fixture);
    const persistence = require('../services/admin-estimate-persistence');
    const original = persistence.createOrReuseAdminEstimate;
    const config = await db('pricing_config').where({ config_key: 'pest_base' }).first();
    jest.spyOn(persistence, 'createOrReuseAdminEstimate').mockImplementation(async args => {
      if (!args.dryRun) await db('pricing_config').where({ config_key: config.config_key }).update({ data: JSON.stringify({ ...config.data, base: -1 }) });
      return original(args);
    });
    try {
      const response = await confirm(proposal);
      expect(response.body.success).toBe(false);
      expect(await db('estimates').where({ customer_id: fixture.customer.id })).toHaveLength(0);
    } finally {
      await db('pricing_config').where({ config_key: config.config_key }).update({ data: JSON.stringify(config.data) });
      await require('../services/pricing-engine').syncConstantsFromDB(db);
    }
  }, 60000);

  test('a receipt failure inside the transaction rolls back both the estimate and its audit', async () => {
    const fixture = await customerFixture(), proposal = await propose(fixture);
    const pending = require('../services/intelligence-bar/pending-actions'), original = pending.recordResult;
    jest.spyOn(pending, 'recordResult').mockImplementation((id, result, options) => {
      if (options?.critical) throw new Error('Synthetic receipt storage unavailable');
      return original(id, result, options);
    });
    const response = await confirm(proposal);
    expect(response.body.success).toBe(false);
    expect(await db('estimates').where({ customer_id: fixture.customer.id })).toHaveLength(0);
    expect(await db('audit_log').where({ resource_id: proposal.body.pendingActions[0].id })).toHaveLength(0);
  }, 60000);

  test('failure after commit recovers the atomic receipt without downgrading success or repeating the save', async () => {
    const fixture = await customerFixture(), proposal = await propose(fixture);
    const pending = require('../services/intelligence-bar/pending-actions'), original = pending.recordResult;
    jest.spyOn(pending, 'recordResult').mockImplementation((id, result, options) => {
      if (!options?.critical) throw new Error('Synthetic runner stopped after commit');
      return original(id, result, options);
    });
    const response = await confirm(proposal);
    expect(response.body).toMatchObject({ success: true, outcome: 'completed' });
    const receipt = await api(`/api/admin/intelligence-bar/actions/${proposal.body.pendingActions[0].id}`);
    expect(receipt.body.result.estimate_id).toBe(response.body.result.estimate_id);
    expect((await confirm(proposal)).status).toBe(409);
    expect(await db('estimates').where({ customer_id: fixture.customer.id })).toHaveLength(1);
  }, 60000);
});
