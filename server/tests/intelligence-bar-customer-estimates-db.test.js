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
    const publicPricing = await require('../routes/estimate-public').buildPricingBundle(saved);
    const optionEffects = proposed.body.pendingActions[0].contract.effects.filter(effect => effect.label.startsWith('Customer option'));
    expect(optionEffects).toHaveLength(publicPricing.frequencies.length);
    for (const frequency of publicPricing.frequencies) {
      expect(optionEffects).toContainEqual({ kind: 'billing', label:
        `Customer option${frequency.visitsPerYear === 9 ? ' (selected)' : ''}: ${frequency.visitsPerYear} applications per year at $${Number(frequency.perTreatment).toFixed(2)} per application` });
    }
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

  test('a cadence revision preserves the naming audit and customer-facing service name on the same live link', async () => {
    const fixture = await customerFixture();
    const created = await confirm(await propose(fixture));
    const estimateId = created.body.result.estimate_id;
    await db('estimates').where({ id: estimateId }).update({ status: 'sent', sent_at: new Date() });
    const before = await db('estimates').where({ id: estimateId }).first();
    const renamed = await require('../services/intelligence-bar/estimate-tools').executeEstimateTool('set_estimate_presentation', {
      estimate_identifier: estimateId, service: before.estimate_data.engineResult.lineItems[0].service,
      display_name: 'Custom Lawn Program', reason: 'Synthetic presentation regression',
    }, { confirmed: true, isAdmin: true, technicianId: actor });
    expect(renamed.success).toBe(true);
    const relabeled = await db('estimates').where({ id: estimateId }).first();
    const publicPricing = require('../routes/estimate-public').buildPricingBundle;
    expect((await publicPricing(relabeled)).services).toContainEqual(expect.objectContaining({ label: 'Custom Lawn Program' }));
    const revised = await confirm(await propose(fixture, { estimate_id: estimateId, lawn_applications: 12 }));
    expect(revised.body).toMatchObject({ success: true, result: { estimate_id: estimateId } });
    const saved = await db('estimates').where({ id: estimateId }).first();
    expect(saved.token).toBe(before.token);
    expect(saved.estimate_data.presentationOverrides).toEqual(relabeled.estimate_data.presentationOverrides);
    expect(saved.estimate_data.engineResult.lineItems[0].frequency).toBe(12);
    expect((await publicPricing(saved)).services).toContainEqual(expect.objectContaining({ label: 'Custom Lawn Program' }));
  }, 60000);

  test('unordered service rows preserve the context version and confirmation while real spend changes still invalidate it', async () => {
    const fixture = await customerFixture();
    const visitIds = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    await db('scheduled_services').insert([
      { id: visitIds[0], service_type: 'General Pest Control', service_address_line1: fixture.property.address_line1, estimated_price: 89 },
      { id: visitIds[2], service_type: 'General Pest Control', service_address_line1: '200 Example Grove', estimated_price: 99 },
      { id: visitIds[1], service_type: 'Mosquito Control', service_address_line1: fixture.property.address_line1, estimated_price: 75 },
    ].map(row => ({ customer_id: fixture.customer.id, status: 'confirmed', is_recurring: true, recurring_pattern: 'quarterly',
      scheduled_date: require('../utils/datetime-et').etDateString(new Date(Date.now() + 7 * 86400000)), ...row })));
    const { executeCustomerEstimateTool } = require('../services/intelligence-bar/customer-estimate-tools');
    const input = { customer_id: fixture.customer.id, property_id: fixture.property.id };
    const rowOrder = new Map([visitIds[0], visitIds[2], visitIds[1]].map((id, index) => [id, index]));
    let reversed = false, reordered = 0;
    const reorderUnorderedRows = (rows, query) => {
      if (Array.isArray(rows) && rows.length > 1 && rows.every(row => rowOrder.has(row.id))
          && /from "scheduled_services"/.test(query.sql) && !/order by/i.test(query.sql)) {
        rows.sort((a, b) => (rowOrder.get(a.id) - rowOrder.get(b.id)) * (reversed ? -1 : 1));
        if (reversed) reordered += 1;
      }
    };
    db.on('query-response', reorderUnorderedRows);
    try {
      const before = await executeCustomerEstimateTool('get_customer_estimate_context', input);
      expect(before.current_services.length).toBeGreaterThan(1);
      const proposed = await propose(fixture);
      reversed = true;
      const after = await executeCustomerEstimateTool('get_customer_estimate_context', input);
      expect(reordered).toBeGreaterThan(0);
      expect(after.current_services.map(service => service.key)).not.toEqual(before.current_services.map(service => service.key));
      expect(after._version).toBe(before._version);
      expect((await confirm(proposed)).body.success).toBe(true);
      await db('scheduled_services').where({ id: visitIds[0] }).update({ estimated_price: 119 });
      expect((await executeCustomerEstimateTool('get_customer_estimate_context', input))._version).not.toBe(before._version);
    } finally { db.removeListener('query-response', reorderUnorderedRows); }
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
    // A sent revision changes the existing link. Prime the real pricing cache
    // first so the proposed revision must not reuse or overwrite its prices.
    await db('estimates').where({ id: estimateId }).update({ status: 'sent', sent_at: db.fn.now() });
    const sent = await db('estimates').where({ id: estimateId }).first();
    const publicRoute = require('../routes/estimate-public');
    await publicRoute.buildPricingBundle(sent);
    const cache = require('../services/estimate-pricing-cache');
    const cachedBefore = structuredClone(cache.getEstimatePricingCache(sent));
    const proposed = await propose(fixture, { estimate_id: estimateId, lawn_applications: 12 });
    expect(cache.getEstimatePricingCache(sent)).toEqual(cachedBefore);
    const revised = await confirm(proposed);
    expect(revised.body).toMatchObject({ success: true, result: { estimate_id: estimateId } });
    const saved = await db('estimates').where({ id: estimateId }).first();
    expect(saved.estimate_data.engineInputs.manualDiscount).toMatchObject({ type: 'PERCENT', value: 10 });
    expect(saved.estimate_data.engineResult.lineItems[0].frequency).toBe(12);
    expect(saved.estimate_data.engineResult.summary.manualDiscount).toMatchObject({ type: 'PERCENT', value: 10 });
    expect(saved.token).toBe(before.token);
    const offered = (await publicRoute.buildPricingBundle(saved)).frequencies;
    const effects = proposed.body.pendingActions[0].contract.effects.map(effect => effect.label);
    expect(offered.length).toBeGreaterThan(1);
    for (const frequency of offered) {
      expect(effects).toContain(`Customer option${frequency.visitsPerYear === 12 ? ' (selected)' : ''}: ${frequency.visitsPerYear} applications per year at $${Number(frequency.perTreatment).toFixed(2)} per application`);
    }
    expect(effects).toContain('Updates the saved estimate and its existing customer link. No message is sent.');
  }, 60000);

  test('a change to an alternate offered cadence invalidates confirmation before saving', async () => {
    const fixture = await customerFixture();
    const proposed = await propose(fixture);
    expect(proposed.body.pendingActions).toHaveLength(1);
    const publicRoute = require('../routes/estimate-public'), build = publicRoute.buildPricingBundle;
    jest.spyOn(publicRoute, 'buildPricingBundle').mockImplementation(async (...args) => {
      const pricing = await build(...args);
      return { ...pricing, frequencies: pricing.frequencies.map(frequency => frequency.visitsPerYear === 9
        ? frequency : { ...frequency, perTreatment: Number(frequency.perTreatment) + 1 }) };
    });
    const response = await confirm(proposed);
    expect(response.status).toBe(409);
    expect(await db('estimates').where({ customer_id: fixture.customer.id })).toHaveLength(0);
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

  test.each(['unknown', 'mixed'])('canonical %s grass cannot fall back to a stale property grass type', async grass_type => {
    const fixture = await customerFixture();
    await db('customer_turf_profiles').insert({ id: crypto.randomUUID(), customer_id: fixture.customer.id,
      active: true, grass_type, track_key: null, lawn_sqft: 5000 });
    const proposed = await propose(fixture);
    expect(proposed.body.pendingActions || []).toHaveLength(0);
    const results = mockModel.mock.calls.at(-1)[0].messages.flatMap(message => Array.isArray(message.content) ? message.content : []);
    const lookup = JSON.parse(results.find(block => block.type === 'tool_result' && block.tool_use_id === 'lookup').content);
    const save = JSON.parse(results.find(block => block.type === 'tool_result' && block.tool_use_id === 'save').content);
    expect(lookup.property).toMatchObject({ grass_type, track: null });
    expect(save).toMatchObject({ code: 'missing_information' });
    expect(await db('estimates').where({ customer_id: fixture.customer.id })).toHaveLength(0);
  }, 60000);

  test('a saved condo prices as residential, a street-less property refuses, and uppercase identifiers save', async () => {
    const condo = await customerFixture({ property_type: 'condo' });
    expect((await propose(condo)).body.pendingActions).toHaveLength(1);
    const streetless = await customerFixture({ address_line1: '', address_line2: null, city: '' });
    const refused = await propose(streetless);
    expect(refused.body.pendingActions || []).toHaveLength(0);
    const result = mockModel.mock.calls.at(-1)[0].messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
      .find(block => block.type === 'tool_result' && block.tool_use_id === 'save');
    expect(JSON.parse(result.content)).toMatchObject({ code: 'missing_information' });
    const upper = await customerFixture();
    const saved = await confirm(await propose(upper, { customer_id: upper.customer.id.toUpperCase(), property_id: upper.property.id.toUpperCase() }));
    expect(saved.body).toMatchObject({ success: true });
    expect(await db('estimates').where({ customer_id: upper.customer.id, property_id: upper.property.id })).toHaveLength(1);
  }, 60000);

  test('a property with active lawn service never receives a second lawn estimate', async () => {
    const fixture = await customerFixture();
    await db('scheduled_services').insert({ id: crypto.randomUUID(), customer_id: fixture.customer.id, service_type: 'Lawn Care', status: 'confirmed',
      scheduled_date: require('../utils/datetime-et').etDateString(new Date(Date.now() + 7 * 86400000)), is_recurring: true, recurring_pattern: 'monthly',
      service_address_line1: fixture.property.address_line1 });
    const proposed = await propose(fixture);
    expect(proposed.body.pendingActions || []).toHaveLength(0);
    const result = mockModel.mock.calls.at(-1)[0].messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
      .find(block => block.type === 'tool_result' && block.tool_use_id === 'save');
    expect(JSON.parse(result.content)).toMatchObject({ code: 'duplicate_service' });
    expect(await db('estimates').where({ customer_id: fixture.customer.id })).toHaveLength(0);
  }, 60000);

  test('an oversize lawn requiring field review never produces an ordinary price confirmation', async () => {
    const fixture = await customerFixture({ property_sqft: 25000, lot_sqft: 50000 });
    await db('customer_turf_profiles').insert({ id: crypto.randomUUID(), customer_id: fixture.customer.id,
      active: true, grass_type: 'st_augustine', track_key: 'st_augustine', lawn_sqft: 25000 });
    const proposed = await propose(fixture);
    expect(proposed.body.pendingActions || []).toHaveLength(0);
    const result = mockModel.mock.calls.at(-1)[0].messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
      .find(block => block.type === 'tool_result' && block.tool_use_id === 'save');
    expect(JSON.parse(result.content)).toMatchObject({ code: 'pricing_unavailable' });
    expect(await db('estimates').where({ customer_id: fixture.customer.id })).toHaveLength(0);
  }, 60000);

  test.each(['before preview', 'after preview', 'after authorization'])('queued delivery blocks an IB revision %s', async timing => {
    const fixture = await customerFixture();
    const created = await confirm(await propose(fixture));
    const estimateId = created.body.result.estimate_id;
    const queue = () => db('estimates').where({ id: estimateId }).update({
      status: 'scheduled', scheduled_at: new Date(Date.now() + 86400000),
    });
    if (timing === 'before preview') await queue();
    const proposed = await propose(fixture, { estimate_id: estimateId, lawn_applications: 12 });
    if (timing === 'before preview') {
      expect(proposed.body.pendingActions || []).toHaveLength(0);
    } else {
      let before;
      if (timing === 'after authorization') {
        const persistence = require('../services/admin-estimate-persistence');
        const original = persistence.lockEstimateGroupAddressRevision;
        jest.spyOn(persistence, 'lockEstimateGroupAddressRevision').mockImplementation(async (...args) => {
          await queue();
          before = await db('estimates').where({ id: estimateId }).first();
          return original(...args);
        });
      } else {
        await queue();
        before = await db('estimates').where({ id: estimateId }).first();
      }
      const refused = await confirm(proposed);
      if (timing === 'after authorization') {
        expect(refused.body).toMatchObject({ success: false, result: { code: 'estimate_send_scheduled' } });
      } else {
        expect(refused.status).toBe(409);
      }
      expect(await db('estimates').where({ id: estimateId }).first()).toEqual(before);
    }
    const refused = await require('../services/intelligence-bar/customer-estimate-tools')
      .executeCustomerEstimateTool('save_customer_estimate', {
        customer_id: fixture.customer.id, property_id: fixture.property.id, estimate_id: estimateId,
      });
    expect(refused).toMatchObject({ success: false, code: 'estimate_send_scheduled' });
  }, 60000);

  test.each(['before preview', 'after preview'])('a scheduled group sibling blocks an IB revision of an unscheduled member %s', async timing => {
    const fixture = await customerFixture();
    const created = await confirm(await propose(fixture));
    const estimateId = created.body.result.estimate_id, groupId = crypto.randomUUID();
    await db('estimates').where({ id: estimateId }).update({ estimate_group_id: groupId });
    const member = await db('estimates').where({ id: estimateId }).first();
    // The scheduled anchor: a second property's row in the same group.
    const anchor = { ...member, id: crypto.randomUUID(), property_id: null, estimate_group_id: groupId,
      status: 'scheduled', scheduled_at: new Date(Date.now() + 86400000),
      estimate_data: JSON.stringify(member.estimate_data), address: `${member.address} Unit B`,
      token: crypto.randomBytes(16).toString('hex'), estimate_slug: member.estimate_slug ? `${member.estimate_slug}-b` : null };
    const queue = () => db('estimates').insert(anchor);
    if (timing === 'before preview') await queue();
    const proposed = await propose(fixture, { estimate_id: estimateId, lawn_applications: 12 });
    if (timing === 'before preview') {
      expect(proposed.body.pendingActions || []).toHaveLength(0);
    } else {
      expect(proposed.body.pendingActions).toHaveLength(1);
      await queue();
      const before = await db('estimates').where({ id: estimateId }).first();
      const refused = await confirm(proposed);
      expect(refused.status).toBe(409);
      expect(await db('estimates').where({ id: estimateId }).first()).toEqual(before);
    }
    const refused = await require('../services/intelligence-bar/customer-estimate-tools')
      .executeCustomerEstimateTool('save_customer_estimate', {
        customer_id: fixture.customer.id, property_id: fixture.property.id, estimate_id: estimateId,
      });
    expect(refused).toMatchObject({ success: false, code: 'estimate_send_scheduled' });
    expect(refused.error || refused.message || JSON.stringify(refused)).toMatch(/multi-property group/);
  }, 60000);

  test.each([false, true])('revision cache invalidation waits for durable commit (rollback=%s)', async rollback => {
    const fixture = await customerFixture();
    const created = await confirm(await propose(fixture));
    const estimateId = created.body.result.estimate_id;
    const before = await db('estimates').where({ id: estimateId }).first();
    await db('customer_properties').where({ id: fixture.property.id }).update({ address_line1: '200 Example Grove' });
    const proposed = await propose(fixture, { estimate_id: estimateId, lawn_applications: 12 });
    const slots = require('../services/estimate-slot-availability');
    const invalidate = jest.spyOn(slots, 'invalidateEstimate');
    const pricing = require('../services/estimate-pricing-cache');
    pricing.setEstimatePricingCache(estimateId, { oldAddress: before.address });
    const audit = require('../services/audit-log'), original = audit.recordAuditEvent;
    let checked = false;
    jest.spyOn(audit, 'recordAuditEvent').mockImplementation(async options => {
      if (options.action === 'estimate_revised') {
        // The savepoint has completed but another connection still sees the old address.
        expect((await db('estimates').where({ id: estimateId }).first()).address).toBe(before.address);
        expect(invalidate).not.toHaveBeenCalled();
        expect(pricing.getEstimatePricingCache(estimateId)).toEqual({ oldAddress: before.address });
        checked = true;
        if (rollback) throw new Error('Synthetic audit failure before commit');
      }
      return original(options);
    });
    const revised = await confirm(proposed);
    expect(checked).toBe(true);
    expect(revised.body.success).toBe(!rollback);
    const saved = await db('estimates').where({ id: estimateId }).first();
    if (rollback) {
      expect(saved).toEqual(before);
      expect(invalidate).not.toHaveBeenCalled();
    } else {
      expect(saved.address).toContain('200 Example Grove');
      expect(invalidate).toHaveBeenCalledWith(estimateId);
      expect(pricing.getEstimatePricingCache(estimateId)).toBeNull();
    }
    pricing.clearEstimatePricingCache(estimateId);
  }, 60000);

  test('a draft deleted between the preview and the row lock refuses deterministically', async () => {
    const fixture = await customerFixture();
    const created = await confirm(await propose(fixture));
    const estimateId = created.body.result.estimate_id;
    const proposed = await propose(fixture, { estimate_id: estimateId, lawn_applications: 12 });
    expect(proposed.body.pendingActions).toHaveLength(1);
    const persistence = require('../services/admin-estimate-persistence');
    const original = persistence.lockEstimateGroupAddressRevision;
    jest.spyOn(persistence, 'lockEstimateGroupAddressRevision').mockImplementation(async (...args) => {
      // Another admin deletes the draft after the observed read, before FOR UPDATE.
      await db('estimates').where({ id: estimateId }).del();
      return original(...args);
    });
    try {
      const confirmed = await confirm(proposed);
      expect(confirmed.body).toMatchObject({ success: false, result: { code: 'target_not_found' } });
      expect(confirmed.body.result.error).not.toMatch(/Cannot read properties/);
    } finally {
      persistence.lockEstimateGroupAddressRevision = original;
    }
  }, 60000);

  test('a confirmed revision locks the customer before the estimate, matching the profile-edit fanout order', async () => {
    const fixture = await customerFixture();
    const created = await confirm(await propose(fixture));
    const estimateId = created.body.result.estimate_id;
    const proposed = await propose(fixture, { estimate_id: estimateId, lawn_applications: 12 });
    const persistence = require('../services/admin-estimate-persistence');
    const original = persistence.lockEstimateGroupAddressRevision;
    let customerLockedFirst = null;
    jest.spyOn(persistence, 'lockEstimateGroupAddressRevision').mockImplementation(async (trx, ...rest) => {
      // Probe from OUTSIDE the confirming transaction: the customer row must already be locked at this point.
      const probe = await db.raw('SELECT id FROM customers WHERE id = ? FOR UPDATE SKIP LOCKED', [fixture.customer.id]);
      customerLockedFirst = probe.rows.length === 0;
      return original(trx, ...rest);
    });
    try {
      const revised = await confirm(proposed);
      expect(revised.body).toMatchObject({ success: true, result: { estimate_id: estimateId } });
      expect(customerLockedFirst).toBe(true);
    } finally {
      persistence.lockEstimateGroupAddressRevision = original;
    }
  }, 60000);

  test('a revision refuses acceptance row-lock contention with a known failure and releases its customer lock', async () => {
    const fixture = await customerFixture();
    const created = await confirm(await propose(fixture));
    const estimateId = created.body.result.estimate_id;
    await db('estimates').where({ id: estimateId }).update({ status: 'sent', sent_at: new Date() });
    const before = await db('estimates').where({ id: estimateId }).first();
    const proposed = await propose(fixture, { estimate_id: estimateId, lawn_applications: 12 });
    const acceptance = await db.transaction();
    try {
      // Independent connection reproduces accept's estimate -> customer order.
      await acceptance('estimates').where({ id: estimateId }).forUpdate().first();
      const refused = await confirm(proposed);
      expect(refused.body).toMatchObject({ success: false, outcome: 'failed', result: { code: 'estimate_busy' } });
      const receipt = await require('../services/intelligence-bar/pending-actions').getActionReceipt(proposed.body.pendingActions[0].id, actor);
      expect(receipt).toMatchObject({ outcome: 'failed', result: { code: 'estimate_busy' } });
      await acceptance.raw("SET LOCAL lock_timeout = '2s'");
      await acceptance('customers').where({ id: fixture.customer.id }).forUpdate().first();
      expect(await acceptance('estimates').where({ id: estimateId }).first()).toEqual(before);
    } finally { await acceptance.rollback(); }
    const retried = await confirm(await propose(fixture, { estimate_id: estimateId, lawn_applications: 12 }));
    expect(retried.body).toMatchObject({ success: true, result: { estimate_id: estimateId } });
    expect((await db('estimates').where({ id: estimateId }).first()).estimate_data.engineResult.lineItems[0].frequency).toBe(12);
  }, 60000);

  test('grouped address revision refuses the busy editor address lock before taking its send lock', async () => {
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
        expect((await confirming).body).toMatchObject({ success: false, result: { code: 'estimate_busy' } });
      });
    } finally {
      if (confirming) expect((await confirming).body).toMatchObject({ success: false, result: { code: 'estimate_busy' } });
    }
    const retried = await confirm(await propose(fixture, { estimate_id: estimateId, lawn_applications: 12 }));
    expect(retried.body.success).toBe(true);
    const saved = await db('estimates').where({ id: estimateId }).first();
    expect(saved.estimate_group_id).toBe(groupId);
    expect(saved.estimate_data.engineResult.lineItems[0].frequency).toBe(12);
    expect(saved.address).toBe(before.address);
  }, 60000);

  test.each(['estimate-group-revise', 'estimate-group-send'])('group contention on %s releases the customer for acceptance without a deadlock', async namespace => {
    const fixture = await customerFixture();
    const created = await confirm(await propose(fixture));
    const estimateId = created.body.result.estimate_id, groupId = crypto.randomUUID();
    await db('estimates').where({ id: estimateId }).update({ estimate_group_id: groupId, status: 'sent', sent_at: new Date() });
    const before = await db('estimates').where({ id: estimateId }).first();
    const proposed = await propose(fixture, { estimate_id: estimateId, lawn_applications: 12 });
    const acceptance = await db.transaction(), editor = await db.transaction();
    let editorRow, customerRow, editorResult;
    const persistence = require('../services/admin-estimate-persistence');
    const original = persistence.lockEstimateGroupAddressRevision;
    const waitForBlocker = async (waiting, blocking) => {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const result = await db.raw('SELECT ?::int = ANY(pg_blocking_pids(?::int)) AS blocked', [blocking, waiting]);
        if (result.rows[0].blocked) return;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      throw new Error('Expected transaction contention did not form');
    };
    try {
      const acceptPid = (await acceptance.raw('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const editorPid = (await editor.raw('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await acceptance('estimates').where({ id: estimateId }).forUpdate().first();
      await editor.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))', [namespace, groupId]);
      editorRow = editor('estimates').where({ id: estimateId }).forUpdate().first()
        .then(row => ({ row }), error => ({ error }));
      await waitForBlocker(editorPid, acceptPid);
      jest.spyOn(persistence, 'lockEstimateGroupAddressRevision').mockImplementation(async (trx, ...rest) => {
        await trx.raw("SET LOCAL lock_timeout = '3s'");
        const barPid = (await trx.raw('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        customerRow = acceptance('customers').where({ id: fixture.customer.id }).forUpdate().first()
          .then(row => ({ row }), error => ({ error }));
        await waitForBlocker(acceptPid, barPid);
        return original(trx, ...rest);
      });
      const refused = await confirm(proposed);
      expect(refused.body).toMatchObject({ success: false, outcome: 'failed', result: { code: 'estimate_busy' } });
      const accepted = await customerRow;
      expect(accepted.error).toBeUndefined();
      expect(accepted.row.id).toBe(fixture.customer.id);
      expect(await acceptance('estimates').where({ id: estimateId }).first()).toEqual(before);
    } finally {
      await acceptance.rollback();
      if (editorRow) editorResult = await editorRow;
      await editor.rollback();
    }
    expect(editorResult.error).toBeUndefined();
    expect((await db('estimates').where({ id: estimateId }).first()).estimate_data).toEqual(before.estimate_data);
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
    const receipt = await api(`/api/admin/intelligence-bar/actions/${proposal.body.pendingActions[0].id}`);
    expect(receipt.body.result).toMatchObject({ outcome_unknown: true, code: 'execution_interrupted' });
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

  test('a recovery read failure cannot overwrite the committed receipt with an unknown outcome', async () => {
    const fixture = await customerFixture(), proposal = await propose(fixture);
    const pending = require('../services/intelligence-bar/pending-actions'), original = pending.recordResult;
    jest.spyOn(pending, 'recordResult').mockImplementation((id, result, options) => {
      if (!options) throw new Error('Synthetic runner stopped after commit');
      return original(id, result, options);
    });
    jest.spyOn(pending, 'getActionReceipt').mockRejectedValueOnce(new Error('Synthetic recovery read unavailable'));
    const response = await confirm(proposal);
    expect(response.body).toMatchObject({ success: false, outcome: 'outcome_unknown' });
    const receipt = await api(`/api/admin/intelligence-bar/actions/${proposal.body.pendingActions[0].id}`);
    expect(receipt.body).toMatchObject({ success: true, outcome: 'completed' });
    expect(receipt.body.result.estimate_id).toBe(proposal.body.pendingActions[0].id);
    expect((await confirm(proposal)).status).toBe(409);
    expect(await db('estimates').where({ customer_id: fixture.customer.id })).toHaveLength(1);
  }, 60000);
});
